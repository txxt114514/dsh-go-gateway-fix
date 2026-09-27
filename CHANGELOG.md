# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.0.0] - 2026-09-27

首个发布版。包含两种修复模式：默认开启的「完全空补发」，以及默认关闭的「碎片合并」。

### 新增

- **碎片合并（`DSH_MERGE_FRAGMENT=1`，默认关）**
  修复第二种病灶：`content` 出现过但严重碎片化（实测 11~25 个 delta、正文仅 25~68 字），
  而 `reasoning_content` 上千字。四个条件全部满足时，在 `finish_reason` / `message_stop` /
  `[DONE]` **之前**追加一个合成 content delta，内容为 `'\n' + reasoning` 全文，
  **保留**原有短正文不覆盖。
  1. 出现过 content，但累计长度 < `DSH_FRAGMENT_MAX_CHARS`（默认 40）
  2. reasoning 长度 > content 长度 × `DSH_FRAGMENT_RATIO`（默认 4），且 > 200 字
  3. 响应不含工具调用（OpenAI `tool_calls` / `function_call`，Anthropic `tool_use` / `input_json_delta`）
  4. 未触发过「完全空」补发（两者互斥）
- **工具调用检测**：`hasToolCalls()` 覆盖 OpenAI 与 Anthropic 两种格式的流式与非流式写法。
- **日志字段**：新增 `content_chars`、`tool_calls`、`merged`、`merged_chars`，
  可区分一次请求走的是 `backfilled=true`、`merged=true` 还是都没触发；
  启动日志会标注 `merge_fragment=false/true` 及生效阈值。
- **测试** `test/merge-test.js`：3 个代理实例（关 / 开 / 自定义阈值）同时跑，
  覆盖 OpenAI 流式、Anthropic 流式、非流式三种形态，以及 7 个反例断言。
- **发布文件**：`README.md`（发布级重写）、`README.en.md`、`LICENSE`(MIT)、
  `CHANGELOG.md`、`.gitignore`、`examples/`、`scripts/`（三平台自启 + DSH 一键接线）。

### 变更

- `package.json`：显式声明 `"dependencies": {}`（零依赖自证）；新增 `test` /
  `test:merge` / `test:inject` / `e2e` / `hunt` 脚本。
- 非流式回填同步支持碎片合并：`message.content` 极短时追加 `'\n' + reasoning_content`，
  Anthropic 的 `content[]` 则追加一个 `text` 块（原有块保留）。
- `fixNonStreaming()` 返回值扩展为
  `{ json, changed, backfilled, merged, contentChars, reasoningChars, toolCalls }`。

### 修复（打包期发现）

- **`scripts/start.cmd` 原本会被 `cmd.exe` 解析错位**，导致变量丢失、
  后续行被截断（`set "SCRIPT_DIR=%~dp0"` 被吃成 `_DIR.."`）。两个叠加原因：
  1. 批处理文件用了 **LF 行尾**——`cmd.exe` 需要 **CRLF**；
  2. 在批处理文件**内部**执行 `chcp 65001` 会让解析器字节偏移错位。
     已改为 **ASCII 内容 + CRLF 行尾**（提示文字用英文），彻底规避编码问题。
     实测：修复后 stderr 全空、崩溃重启循环按 3 秒节拍正常拉起。
- `start.cmd` 的等待改用 `ping -n 4 127.0.0.1 >nul`：`timeout` 需要交互式 stdin，
  在输出被重定向时会报 "Input redirection is not supported" 并跳过等待（实测 9 秒内
  疯狂重启 208 次；修复后为 3 次）。
- `scripts/*.ps1` 改为 **UTF-8 带 BOM + CRLF**：Windows PowerShell 5.1 会把无 BOM 的
  UTF-8 当 ANSI 解码，中文注释会直接导致语法错误（实测报 5~7 处 unexpected token）。
- `scripts/linux|macos/install.sh` 保持 **LF**（CRLF 会让 bash 报错）。
- `scripts/linux/install.sh` 生成用户级 unit 时删除 `User=` 行——
  `systemd --user` 不接受该指令。
- `scripts/install-autostart.ps1` 的注册表命令构造修正：原实现用
  `$target.Substring(9)` 拼接，会产出 `cmd.exe /c "set PORT=9000&& /c ""..."""` 这种
  非法命令。实测四种引号写法后固定为
  `cmd.exe /c "set X=1&& "<脚本路径>""`（含空格路径下也可用）。

### 兼容性

- **默认行为与上一版完全一致**：不设任何环境变量时，碎片合并关闭，
  `test/verify.js`（A/B 各 5 次）与 `test/inject-test.js`、`test/selftest.js` 全部保持通过。

### 已知限制

见 [README.md](README.md) 的「诚实声明」与「已知未覆盖的边界情况」。
