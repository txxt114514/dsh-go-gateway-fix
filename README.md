# dsh-go-gateway-fix

> **这是绕过（workaround），不是修复。** OpenCode Go 网关把模型输出塞进 `reasoning_content`、让 `content` 变空或只剩碎片，是**服务端**的 bug
> （官方 issue [#37635](https://github.com/anomalyco/opencode/issues/37635)，已被机器人以「60 天无活动」自动关闭，至今未修）。
> 本代理挡在客户端前面，**必要时把 reasoning 当作正文补发**，让客户端至少不会拿到空正文。
> 「碎片合并」是启发式规则、**默认关闭**，开启后可能改变正常短回答，风险自担。

**一句话**：一个零依赖的本地小代理，专门修 OpenCode Go 网关把模型正文塞进
`reasoning_content`、让 `content` 变空或只剩碎片的问题——把它挡在客户端前面就行。

```
客户端  ──►  http://127.0.0.1:8899/zen/go/v1/...  ──►  https://opencode.ai/zen/go/v1/...
                    （本代理，必要时改写 content）
```

- 语言/依赖：**纯 Node（≥18）单文件，零第三方依赖**
- 监听：`127.0.0.1:8899`（只回环，不对外）
- 改动范围：**只有 `content` 字段**，请求头、状态码、响应头、其它字段一律原样透传

---

## 1. 问题现象

OpenCode Go 网关（`https://opencode.ai/zen/go/v1/...`）会把模型真正的回答大量塞进
`delta.reasoning_content`（思维链字段），而 `delta.content` 经常**完全为空**或只剩一点碎片。
Agent 循环拿到空正文，就会以为模型什么都没说，直接结束。

官方 issue：[opencode-ai/opencode#37635](https://github.com/opencode-ai/opencode/issues/37635)
原话引用：

> The opencode-go gateway wraps ALL model streaming responses in a Chain-of-Thought wrapper,
> putting the assistant's actual output in `delta.reasoning_content` instead of `delta.content`.
> This causes the agent loop to receive empty content and exit immediately.

该 issue 已被机器人以「60 天无活动」自动关闭，**至今未修**。

| 字段 | 正常情况 | Go 网关的情况 |
| --- | --- | --- |
| `delta.content` | 完整的回答正文 | 空、或只剩几十字碎片 |
| `delta.reasoning_content` | 思维链（通常很短） | 塞进了绝大部分正文，几千到上万字 |
| `finish_reason` | — | 多为 `stop`（网关认为一切正常，不报错） |

两种病灶形态，本项目两种都处理：

| 形态 | 表现 | 本项目对应能力 | 默认 |
| --- | --- | --- | --- |
| **A. 完全空** | 整条流一次非空 `content` 都没出现 | 「补发」backfill | **开** |
| **B. 严重碎片** | 出现过 `content`，但只有 25~68 字，`reasoning` 上千字 | 「碎片合并」merge | 关（需显式开启） |

---

## 2. 根因图解

```text
                        上游 Go 网关内部
   ┌──────────────────────────────────────────────────────────────┐
   │  模型真实输出                                                 │
   │  "好的，这是脚本：\nimport pandas as pd\n..."   ← 本该走 content │
   └───────────────────────────┬──────────────────────────────────┘
                               │  被网关包进 Chain-of-Thought 外壳
                               ▼
   ┌──────────────────────────────────────────────────────────────┐
   │  SSE 事件：                                                   │
   │    delta.reasoning_content = "好的，这是脚本：..."  ← 正文全在这 │
   │    delta.content           = "" 或 "好" "的" ...    ← 空/碎片   │
   │    finish_reason           = "stop"                ← 不报错！  │
   └───────────────────────────┬──────────────────────────────────┘
                               │
              ┌────────────────┴────────────────┐
              │                                 │
        （不经代理）                        （经本代理）
              │                                 │
              ▼                                 ▼
   ┌────────────────────┐         ┌────────────────────────────────┐
   │ agent loop 收到     │         │ 一边透传，一边统计：            │
   │ content=""         │         │   contentSeen / contentChars    │
   │ → 以为没输出        │         │   reasoning 全文                │
   │ → 直接退出          │         │   tool_calls 有无               │
   └────────────────────┘         └───────────────┬────────────────┘
                                                  │
                              ┌───────────────────┴───────────────────┐
                              │                                       │
                     content 一次都没出现                    content 出现过但极短
                     ﹢ reasoning 有货                      ﹢ reasoning ≫ content
                              │                                       │
                              ▼                                       ▼
                   ┌─────────────────────┐              ┌──────────────────────────┐
                   │ 模式 A：补发         │              │ 模式 B：碎片合并（默认关）│
                   │ 在 [DONE] /         │              │ 在 [DONE] / finish_reason │
                   │ finish_reason 之前   │              │ 之前「追加」一个 delta     │
                   │ 补一个合成 content   │              │ = 原有短正文 + '\n'       │
                   │ delta = reasoning    │              │   + reasoning 全文        │
                   └─────────────────────┘              └──────────────────────────┘
                              │                                       │
                              └───────────────────┬───────────────────┘
                                                  ▼
                                  客户端拿到完整正文，agent loop 正常继续
```

关键点：**合成内容一定插在终止事件之前**。若插在 `[DONE]` 之后，客户端已经收流结束，
补的内容会被丢弃——这是实现里最容易踩的坑。

---

## 3. 30 秒用法

```bash
# 1. 起代理（零依赖，不需要 npm install）
node proxy.js
#    → 2026-09-27T07:27:26.710Z | listening on http://127.0.0.1:8899 | upstream=https://opencode.ai:443 | merge_fragment=false

# 2. 把客户端的 base URL 从
#      https://opencode.ai/zen/go/v1
#    改成
#      http://127.0.0.1:8899/zen/go/v1
#    API Key、模型名、其它请求头都不用动。

# 3. 发一句话，然后看日志有没有新增行
tail -f proxy.log      # Windows: Get-Content proxy.log -Tail 5 -Wait
```

换端口 / 开碎片合并：

```bash
PORT=9000 DSH_MERGE_FRAGMENT=1 node proxy.js
```

Windows 用户可直接双击 [`scripts/start.cmd`](scripts/start.cmd)（带崩溃自动重启）。

---

## 4. 各客户端配置示例

### 4.1 DSH（`cordis.patch.yml`）

完整片段见 [`examples/dsh-cordis.patch.yml.snippet`](examples/dsh-cordis.patch.yml.snippet)。
核心就是 `opencode-go-ds41` 这条 provider 的 `baseURL`：

```yaml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      opencode-go-ds41:
        displayName: OpenCode Go · DeepSeek 4.1
        apiKeyEnv: OPENCODE_API_KEY
        api: openai-completions
        # ★ 只改这一行：原值 https://opencode.ai/zen/go/v1
        baseURL: http://127.0.0.1:8899/zen/go/v1
        headers:
          x-opencode-session: dsh-opencode-go
        compat:
          supportsStore: false
          supportsDeveloperRole: false
          maxTokensField: max_tokens
          requiresReasoningContentOnAssistantMessages: true
          thinkingFormat: deepseek
        models:
          - id: deepseek-v4.1-flash
            name: DeepSeek V4.1 Flash
            contextWindow: 1000000
            maxTokens: 384000
```

Windows 上一键接线（会自动备份、校验、并打印回滚方法）：

```powershell
pwsh -File scripts\dsh-wire.ps1 -DryRun    # 先预览
pwsh -File scripts\dsh-wire.ps1            # 正式接线
pwsh -File scripts\dsh-wire.ps1 -Restore   # 还原
```

> ⚠️ 该脚本会改 `~/.dsh/profiles/desktop/cordis.patch.yml`。它**只改 `baseURL` 一行**，
> 改前必定备份成 `cordis.patch.yml.bak-<时间戳>`。DSH 会自动热重载，无需重启。

### 4.2 OpenCode CLI

完整片段见 [`examples/opencode-config.json.snippet`](examples/opencode-config.json.snippet)
（位置 `~/.config/opencode/opencode.json`）：

```json
{
  "provider": {
    "opencode-go-fixed": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "OpenCode Go（经本地修复代理）",
      "options": {
        "baseURL": "http://127.0.0.1:8899/zen/go/v1",
        "apiKey": "{env:OPENCODE_API_KEY}",
        "headers": { "x-opencode-session": "opencode-cli" }
      },
      "models": { "deepseek-v4.1-flash": { "name": "DeepSeek V4.1 Flash" } }
    }
  },
  "model": "opencode-go-fixed/deepseek-v4.1-flash"
}
```

### 4.3 任意 OpenAI 兼容客户端

**改动永远只有一处**：把 base URL 里的 host 换掉，路径 `/zen/go/v1` 保留。

| | 原值 | 改成 |
| --- | --- | --- |
| base URL | `https://opencode.ai/zen/go/v1` | `http://127.0.0.1:8899/zen/go/v1` |
| API Key | 你的 `OPENCODE_GO_API_KEY` | 不用改（原样透传 `Authorization`） |
| 模型名 | `deepseek-v4.1-flash` 等 | 不用改 |
| 其它头 | `x-opencode-session` / `anthropic-version` … | 不用改（全部透传） |

```bash
export OPENAI_BASE_URL=http://127.0.0.1:8899/zen/go/v1
export OPENAI_API_KEY=$OPENCODE_GO_API_KEY
```

更多（Python/Node SDK、curl 对照、排错）见
[`examples/generic-openai-client.md`](examples/generic-openai-client.md)。

---

## 5. 两个开关

### 5.1 模式 A：补发（默认开，无需配置）

- **触发**：整条流里**一次非空 `content` 都没出现**，且收集到的 `reasoning` 非空。
- **动作**：在 `finish_reason` / `message_stop` / `[DONE]` **之前**补一个合成 delta，
  内容 = reasoning 全文。
- **非流式**同理：`message.content` 为空而 `reasoning_content` 有货时回填。

### 5.2 模式 B：碎片合并（**默认关**，需显式开启）

```bash
DSH_MERGE_FRAGMENT=1 node proxy.js
```

四个条件**全部满足**才合并：

| # | 条件 | 默认阈值 | 覆盖变量 |
| --- | --- | --- | --- |
| 1 | 出现过 `content`，但累计长度 **<** 阈值 | 40 字 | `DSH_FRAGMENT_MAX_CHARS` |
| 2a | `reasoning` 长度 **>** 绝对下限 | 200 字 | `DSH_FRAGMENT_MIN_REASONING` |
| 2b | `reasoning` 长度 **>** `content` 长度 × 倍数 | 4 倍 | `DSH_FRAGMENT_RATIO` |
| 3 | 该响应**不含工具调用** | — | 不可关 |
| 4 | 没触发过模式 A（两者互斥） | — | 不可关 |

- **动作**：**追加**一个合成 content delta，内容 = `'\n' + reasoning` 全文；
  **保留**原有短正文，**不覆盖**。
- **条件 3 为什么不可关**：含 `tool_calls` / `tool_use` 时正文短是**正常的**（真正的输出在
  参数里）。此时把 reasoning 塞进 `content` 会污染工具调用流程。
  检测覆盖 OpenAI 的 `tool_calls` / `function_call` 与 Anthropic 的
  `tool_use` / `input_json_delta`。

全部环境变量：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `8899` | 本地监听端口 |
| `HOST` | `127.0.0.1` | 只监听回环，**不要改成 0.0.0.0** |
| `DSH_UPSTREAM_HOST` | `opencode.ai` | 上游主机 |
| `DSH_UPSTREAM_PORT` | `443` | 上游端口 |
| `DSH_UPSTREAM_TLS` | `1` | 设 `0` 走明文（自测假上游用） |
| `DSH_MERGE_FRAGMENT` | 未设（关） | 设 `1` 开启碎片合并 |
| `DSH_FRAGMENT_MAX_CHARS` | `40` | 条件 1 阈值 |
| `DSH_FRAGMENT_RATIO` | `4` | 条件 2b 倍数 |
| `DSH_FRAGMENT_MIN_REASONING` | `200` | 条件 2a 绝对下限 |
| `DSH_NO_FILE_LOG` | 未设 | 设任意值可少写日志文件 |

### 5.3 怎么看日志

每次请求一行，`backfilled` / `merged` 两个字段直接告诉你是哪种情况：

```text
# 模式 A 实弹触发（流式）
2026-09-27T07:33:08.018Z | /zen/go/v1/chat/completions | stream | status=200 | content_seen=0 | content_chars=0 | reasoning_chars=279 | tool_calls=0 | backfilled=true | merged=false | ms=2130

# 模式 A 实弹触发（非流式）
2026-09-27T07:27:46.260Z | /zen/go/v1/chat/completions | non-stream | status=200 | content_seen=0 | reasoning_chars=532 | backfilled=true | ms=5421

# 模式 B 触发（需开 DSH_MERGE_FRAGMENT=1）
2026-09-27T07:35:21.5xxZ | /zen/go/v1/chat/completions | stream | status=200 | content_seen=5 | content_chars=25 | reasoning_chars=1120 | tool_calls=0 | backfilled=false | merged=true | merged_chars=1122 | ms=4

# 都没触发（网关健康）
2026-09-27T07:37:21.583Z | /zen/go/v1/chat/completions | stream | status=200 | content_seen=15 | content_chars=318 | reasoning_chars=3391 | tool_calls=0 | backfilled=false | merged=false | ms=8340
```

| 字段 | 含义 |
| --- | --- |
| `content_seen` | 非空 content 的**片段数** |
| `content_chars` | 非空 content 的**累计字符数**（碎片判据） |
| `reasoning_chars` | 收集到的 reasoning 字符数 |
| `tool_calls` | 见到的工具调用数（>0 则绝不合并） |
| `backfilled` | 是否走了模式 A |
| `merged` | 是否走了模式 B |
| `merged_chars` | 模式 B 追加的字符数 |
| `reasoning_truncated` | reasoning 超过 4MB 被截断（防内存爆） |

启动那行会标明开关状态与生效阈值：

```text
... | listening on http://127.0.0.1:8899 | upstream=https://opencode.ai:443 | merge_fragment=true(max_chars=40,ratio=4,min_reasoning=200)
```

---

## 6. 开机自启

### Windows（写 HKCU Run，免提权、无 UAC）

```powershell
# 安装（默认端口 8899，碎片合并关）
powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1

# 开碎片合并 + 换端口
powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 -Port 9000 -MergeFragment

# 看状态（只读）
powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 -Status

# 卸载
powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 -Remove
```

拉起的是 [`scripts/start.cmd`](scripts/start.cmd)，带崩溃自动重启循环。
想改端口/开关又不用脚本参数：在同目录建 `scripts\proxy.env.cmd`：

```bat
set PORT=8899
set DSH_MERGE_FRAGMENT=1
```

> 注：`start.cmd` 的提示文字是**英文**，且必须是 **CRLF 行尾**。
> 原因见第 9 节「已知坑」。

### Linux（systemd）

```bash
cd scripts/linux
./install.sh              # 装成用户级服务（免 sudo），并 enable --now
./install.sh --status     # 看状态与日志
./install.sh --remove     # 卸载
```

`opencode-go-fix.service` 里 `Restart=always`、`RestartSec=3`。
安装脚本会自动替换 `__NODE_BIN__` / `__PROXY_JS__` / `__WORK_DIR__` 占位符，
并删掉用户级 unit 不允许出现的 `User=` 行。
想装成系统级（开机即启、无需登录）：脚本末尾有说明，把 `User=` 改成你自己的用户名。

### macOS（launchd）

```bash
cd scripts/macos
./install.sh              # 装成 LaunchAgent（免 sudo）
./install.sh --status
./install.sh --remove
```

`com.dsh.gogatewayfix.plist` 里 `KeepAlive=true`、`ThrottleInterval=3`，
日志写到 `~/Library/Logs/dsh-go-gateway-fix/`。

---

## 7. 实测数据

全部数据来自本机真实运行，日期 **2026-09-27**，模型 `deepseek-v4.1-flash`。

### 7.1 模式 B（碎片合并）注入测试 —— `node test/merge-test.js`

假上游精确造病灶，三个代理实例同时跑（关 / 开 / 自定义阈值）。
语料：短正文 14 字、reasoning 960 字、正常长正文 468 字。

**开关关 / 开 × 三种响应形态**（客户端最终可见正文长度）：

| 响应形态 | 开关关 | 开关开 | 期望 |
| --- | --- | --- | --- |
| OpenAI 流式 | **14** | **975** | 14 / 975 |
| Anthropic 流式 | **14** | **975** | 14 / 975 |
| 非流式 | **14** | **975** | 14 / 975 |

`975 = 14 + 1 + 960`（短正文 + 换行 + reasoning 全文），逐字比对通过。
开关关时正文与上游**逐字一致**，说明默认行为没变。

**三个「不该合并」的反例**（开关**开**时也必须原样放行）：

| 反例 | 结果 | 说明 |
| --- | --- | --- |
| ① 合法短回答 `content="通"`，reasoning 空 | `"通"` | 不合并 |
| ①b 合法短回答 + 短 reasoning（未达 200 字） | `"通"` | 不合并 |
| ② 含 `tool_calls`（OpenAI 流式） | 14 字 | 不合并 |
| ②b 含 `tool_use`（Anthropic 流式） | 14 字 | 不合并 |
| ②c 含 `tool_calls`（非流式） | 14 字 | 不合并，且 `tool_calls` 字段未被破坏 |
| ③ 正常长正文 468 字 + 长 reasoning | 468 字 | 不合并 |

**阈值覆盖**：正文 120 字 + reasoning 500 字 →
默认阈值（`MAX_CHARS=40`）**不合并**（120 字）；
自定义 `MAX_CHARS=200 / RATIO=2` **合并**（621 = 120+1+500）。

> 该测试共 **26 项断言，全部 PASS**。

### 7.2 模式 A（补发）注入测试 —— `node test/inject-test.js`

假上游只发 `reasoning_content` / `thinking_delta`、绝不发 `content`：

```text
[1] OpenAI 流式（只有 reasoning_content）
  PASS  客户端拿到完整正文  got=103chars want=103chars
  PASS  内容与 reasoning 逐字一致
  PASS  合成 delta 在 [DONE] 之前  synth@8 done@12
[2] Anthropic 流式（只有 thinking_delta）
  PASS  客户端拿到完整正文  got=103chars want=103chars
  PASS  text_delta 出现在 message_stop 之前
[3] 非流式（content 空，reasoning 有货）
  PASS  content 被回填
  PASS  原始 reasoning_content 保留
[4] 上游本来就正常（不应补发）
  PASS  正文恰为上游原文，未被追加  got="正常正文"
注入测试结果：全部通过
```

### 7.3 真实网关数据 + 真实病灶 —— `node test/e2e-proof.js`

拉一次**真实网关**流式响应，把其中 `content` 清空以复现 issue #37635 的病灶，
再喂给代理内部同一份 `SseFixer` 逻辑（重放）：

```text
拉取真实网关流式响应 ...

真实响应（未改动）：
  客户端可见 content : 302 字
  reasoning_content  : 14449 字
  content 在总输出中的占比：2.0%（其余全被塞进 reasoning）

同一份真实数据、把 content 全部清空（模拟 #37635）：
  打补丁前客户端可见：0 字  ← agent loop 会拿到空内容直接退出
  经代理补发后可见  ：14449 字
  补发是否触发      ：true
  收集到的 reasoning：14449 字
  合成 delta 位置   ：第 2106 行，[DONE] 在第 2112 行

结论：真实网关数据 + 真实病灶下，补发把空 content 救回为完整正文。
```

这一轮尤其能说明问题：真实响应里正文只占 **2.0%**（302 字 vs 14449 字思维链），
是典型的「正文被大量分流」现场。

多次重跑结果同构，救回的正文长度随 reasoning 长度变化（实测 238 ~ 14449 字），
合成 delta 始终落在 `[DONE]` 之前。

### 7.4 默认行为不变 —— `node test/verify.js`（A/B 各 5 次）

**不设任何环境变量**（碎片合并关）跑 A/B：
A 组直连 `https://opencode.ai/zen/go/v1/chat/completions`，
B 组经本地代理（本次用 `PORT=18899`，避开正在服务的 8899）。

任务：`写一段Python脚本：读取CSV，按第二列分组求第三列均值，输出到新CSV。只给完整代码，不要解释。`

| 轮次 | A 直连 content | A reasoning | B 经代理 content | B reasoning |
| --- | --- | --- | --- | --- |
| 1 | 319 | 13562 | 318 | 3391 |
| 2 | 814 | 7044 | 326 | 4355 |
| 3 | 683 | 6858 | 178 | 2197 |
| 4 | 216 | 15175 | 175 | 10318 |
| 5 | 278 | 3595 | 414 | 13509 |

- A 组（直连）content 字符数：`319 / 814 / 683 / 216 / 278`
  → 空响应 **0/5**，碎片(1~99字) **0/5**，完整(≥100字) **5/5**
- B 组（经代理）content 字符数：`318 / 326 / 178 / 175 / 414`
  → 非空 **5/5**，完整(≥100字) **5/5**
- 代理日志 5 行全部 `backfilled=false` `merged=false`（开关关时确实没动手）

**结论（必须说清楚）**：这一轮 **A 组 5/5 都有 content，bug 没有复现**，
所以 B 组的「5/5 非空」是**空结论**——补发与合并一次都没触发，
它只证明了「**经代理不劣化**」，**不能**证明补发有效。
补发有效性的证据是 7.2 / 7.3 的注入测试。

### 7.5 放大探测：碎片确实复现了 —— `node test/hunt.js`

6 个不同任务 × 3 轮共 18 次直连探测：

```text
直连 18 次：空 0，碎片 5，完整 13，错误 0
```

碎片案例细节（这是关键）：

| content 字符数 | content 事件数 | reasoning 字符数 |
| --- | --- | --- |
| 68 | 6 | 6239 |
| 25 | 3 | 798 |
| 25 | 4 | 723 |
| 67 | 6 | 10569 |
| 25 | 3 | 1120 |

对这些碎片任务经代理重跑（**当时碎片合并还没实现**）：

```text
直连content=68 → 经代理content=202  救回
直连content=25 → 经代理content=29   未救回
直连content=25 → 经代理content=29   未救回
直连content=67 → 经代理content=81   未救回
直连content=25 → 经代理content=25   未救回

救回 1/5
```

**为什么救不回来**：这些响应**确实出现过非空 `content`**（3~6 个事件），
按模式 A 的判据「出现过 content 就什么都不做」，代理正确地放行了。
这正是 v1.0.0 新增**模式 B（碎片合并）**要解决的形态——上表 25/67/68 字的案例，
开启 `DSH_MERGE_FRAGMENT=1` 后就会命中条件并追加 reasoning。

### 7.6 自测 —— `node test/selftest.js`

覆盖非流式回填、流式补发、`[DONE]` 位置、已有 content 时不重复补发、
上游 500 错误体透传等：**全部通过**。

---

## 8. 诚实声明

请务必读完再决定是否使用。

1. **它绕过 bug，而不是修网关。** 网关该修的地方在 `opencode.ai` 那侧；
   本代理只是在客户端前面把被错误分流的正文搬回 `content`。
   官方哪天修好了（或 issue 被重新处理），本代理即可直接停用。
2. **碎片合并默认关，且开启后会改变正常短回答。** 阈值是启发式的：
   如果你的场景里「正文本来就短、思维链本来就长」是**正常现象**
   （例如要求模型只回一个字，而它习惯先想很久），开了合并会把思维链拼到正文后面。
   实测三个反例（合法短回答 / 含工具调用 / 正常长正文）都不会误伤，
   但**不能保证覆盖所有场景**。**风险自担。**
3. **含工具调用的响应一律不合并**（这是刻意设计，不是遗漏）。
   但模式 A（补发）**没有**排除工具调用：若模型只发工具调用、正文为空，
   补发会把 reasoning 塞进 content。这是已知未覆盖项，见第 9 节。
4. **实测数据有采样局限。** 7.4 那轮 A 组 bug 未复现，是网关当天状态好；
   bug 的复现率随日期/时段/任务变化，本项目的结论不依赖该轮数据。
5. **不做重试、不设超时。** 网关慢就是慢（实测单次 7~27 秒），代理只负责转发与改写。
6. **只监听回环。** 不要改成 `0.0.0.0`——那会把你的 API Key 暴露在局域网端口上。

---

## 9. 已知未覆盖的边界情况

诚实列出，避免误以为它能解决一切：

1. **模式 A 未排除工具调用**：模型只发 `tool_calls`、正文为空时，补发会把 reasoning
   塞进 `content`。模式 B 已排除，模式 A 尚未（改了会动到默认行为，未做）。
2. **stall / 首字节超时**：网关偶发首字节延迟很长，代理不设超时、不重试。
3. **断流**：上游没发 `finish_reason` / `[DONE]` 就断开时，只在缓冲区为空时兜底补发；
   若断流前已有 content，则不补、也不合并。
4. **reasoning 超过 4MB** 会被截断（防内存爆），日志记 `reasoning_truncated=true`。
5. **只处理 POST**，其它方法返回 405；非 `/zen/go/v1/` 前缀的路径纯透传、不观察。
6. **Anthropic 非流式**只处理顶层 `content[]`；`tool_use` 与 thinking 混排时行为未充分验证。
7. **多 `choices`** 场景下，合成 delta 固定用 `index: 0`。
8. **碎片判据是启发式的**：`content_chars < 40` 与 `ratio > 4` 是实测经验值，
   不同模型/任务的最优阈值可能不同，可用环境变量调。
9. **未做并发压测**：逻辑是每请求一份 `SseFixer` 实例、无共享可变状态，
   但未在高并发下实测。
10. **`chcp` / 编码坑**（构建期踩到并已规避）：`cmd.exe` 会误解析 **LF 行尾**的
    批处理文件；在批处理文件**内部**执行 `chcp 65001` 会让解析器错位、后续行被截断。
    因此 `scripts/start.cmd` 固定为 **ASCII 内容 + CRLF 行尾**（英文提示）。
    Linux/macOS 的 `.sh` 则相反，必须是 **LF**（CRLF 会让 bash 报错）。
    仓库里 `.ps1` 为 **UTF-8 带 BOM + CRLF**（Windows PowerShell 5.1 读无 BOM 的
    UTF-8 会按 ANSI 解码，中文注释会直接导致语法错误）。

---

## 10. 卸载与回滚

**回滚配置**（把流量切回官方网关）：

```yaml
# cordis.patch.yml / opencode.json 里改回：
baseURL: https://opencode.ai/zen/go/v1
```

或：

```powershell
pwsh -File scripts\dsh-wire.ps1 -Restore      # Windows，从自动备份还原
```

**停掉代理**：

| 平台 | 操作 |
| --- | --- |
| 手动启动 | 在跑 `node proxy.js` 的窗口按 Ctrl+C |
| Windows 自启 | `install-autostart.ps1 -Remove`，再结束对应的 `node.exe` |
| Linux | `scripts/linux/install.sh --remove` |
| macOS | `scripts/macos/install.sh --remove` |

**彻底删除**：删掉整个目录即可。代理**不写注册表、不装服务、不改系统配置**，
唯一的痕迹是自启项（上面的卸载命令会清掉）和同目录的 `proxy.log`。

> 代理进程留着跑也不影响别的路由：非 `/zen/go/v1/` 前缀的路径纯透传，
> 且只监听 `127.0.0.1`。

---

## 11. 文件

| 文件 | 说明 |
| --- | --- |
| [`proxy.js`](proxy.js) | 代理本体，零依赖，单文件 |
| [`package.json`](package.json) | 元数据，`dependencies` 显式为空 |
| [`examples/dsh-cordis.patch.yml.snippet`](examples/dsh-cordis.patch.yml.snippet) | DSH 接线片段 |
| [`examples/opencode-config.json.snippet`](examples/opencode-config.json.snippet) | OpenCode CLI provider 片段 |
| [`examples/generic-openai-client.md`](examples/generic-openai-client.md) | 任意 OpenAI 兼容客户端改法 + 排错 |
| [`scripts/start.cmd`](scripts/start.cmd) | Windows 启动器（崩溃自动重启） |
| [`scripts/install-autostart.ps1`](scripts/install-autostart.ps1) | Windows 开机自启（HKCU Run） |
| [`scripts/dsh-wire.ps1`](scripts/dsh-wire.ps1) | DSH 一键接线 / 还原 |
| [`scripts/linux/`](scripts/linux/) | systemd unit + 安装脚本 |
| [`scripts/macos/`](scripts/macos/) | launchd plist + 安装脚本 |
| [`test/selftest.js`](test/selftest.js) | 基础逻辑自测（含错误透传） |
| [`test/inject-test.js`](test/inject-test.js) | 模式 A 注入测试（含 Anthropic 格式） |
| [`test/merge-test.js`](test/merge-test.js) | 模式 B 注入测试（含 3 个反例 + 阈值覆盖） |
| [`test/verify.js`](test/verify.js) | A/B 线上对照（自管代理生命周期） |
| [`test/e2e-proof.js`](test/e2e-proof.js) | 真实网关数据 + 注入病灶的端到端证明 |
| [`test/hunt.js`](test/hunt.js) | 放大探测，找自然复现 |
| [`CHANGELOG.md`](CHANGELOG.md) | 更新日志 |

跑测试：

```bash
node test/selftest.js        # 基础自测，不联网
node test/inject-test.js     # 模式 A 注入，不联网
node test/merge-test.js      # 模式 B 注入，不联网
node test/verify.js          # A/B 线上对照，需要 API Key
node test/e2e-proof.js       # 真实网关端到端，需要 API Key
```

前三个**不联网**（用本地假上游），可直接在离线环境验证逻辑。
`verify.js` / `e2e-proof.js` 会从 `~/.dsh/.credentials.yaml` 读 `OPENCODE_GO_API_KEY`。

---

## 12. 许可

[MIT](LICENSE) © 2026 dsh-go-gateway-fix contributors
