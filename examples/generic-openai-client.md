# 任意 OpenAI 兼容客户端：怎么改 baseURL

代理是**协议透明**的：它只监听 `POST`，把 `/zen/go/v1/*` 原样转发到
`https://opencode.ai`，请求头、请求体、状态码、响应头一律不动，
只在必要时往 `content` 里补内容。所以任何「OpenAI 兼容」的客户端都能接，
**改动永远只有一处**：把 base URL 从官方网关换成 `http://127.0.0.1:8899`。

## 一句话规则

| | 原值 | 改成 |
| --- | --- | --- |
| base URL | `https://opencode.ai/zen/go/v1` | `http://127.0.0.1:8899/zen/go/v1` |
| API Key | 你的 `OPENCODE_API_KEY` | **不用改**（代理原样透传 `Authorization`） |
| 模型名 | `deepseek-v4.1-flash` 等 | **不用改** |
| 其它头 | `x-opencode-session` / `anthropic-version` … | **不用改**（全部透传） |

> 注意路径里要保留 `/zen/go/v1`，不要只写 `http://127.0.0.1:8899`。
> 代理只观察 `/zen/go/v1/` 前缀；其它路径纯透传（也就是说不改写）。

## 常见客户端写法

### 1. 环境变量式（OpenAI SDK、LangChain、多数 CLI）

```bash
# 官方直连
# export OPENAI_BASE_URL=https://opencode.ai/zen/go/v1

export OPENAI_BASE_URL=http://127.0.0.1:8899/zen/go/v1
export OPENAI_API_KEY=$OPENCODE_API_KEY
```

Python（openai SDK）：

```python
from openai import OpenAI
client = OpenAI(
    base_url="http://127.0.0.1:8899/zen/go/v1",
    api_key=os.environ["OPENCODE_API_KEY"],
)
```

Node（openai SDK）：

```js
import OpenAI from 'openai';
const client = new OpenAI({
  baseURL: 'http://127.0.0.1:8899/zen/go/v1',
  apiKey: process.env.OPENCODE_API_KEY,
});
```

### 2. 配置文件式

把配置里形如 `https://opencode.ai/zen/go/v1` 的字符串整串替换为
`http://127.0.0.1:8899/zen/go/v1` 即可，其余字段保持不动。
（DSH 与 OpenCode CLI 的具体片段见同目录另外两个文件。）

### 3. 只想临时验证、不改配置

用 `curl` 直接对比官方与代理两条路径：

```bash
# A：官方直连
curl -N https://opencode.ai/zen/go/v1/chat/completions \
  -H "Authorization: Bearer $OPENCODE_API_KEY" \
  -H "Content-Type: application/json" \
  -H "x-opencode-session: probe" \
  -d '{"model":"deepseek-v4.1-flash","stream":true,"messages":[{"role":"user","content":"写个快排"}]}'

# B：经代理（同一份请求，只换了 host）
curl -N http://127.0.0.1:8899/zen/go/v1/chat/completions \
  -H "Authorization: Bearer $OPENCODE_API_KEY" \
  -H "Content-Type: application/json" \
  -H "x-opencode-session: probe" \
  -d '{"model":"deepseek-v4.1-flash","stream":true,"messages":[{"role":"user","content":"写个快排"}]}'
```

对比两边 `delta.content` 的累计长度；B 侧不该比 A 侧少。

## 换端口 / 换上游

代理全部走环境变量，改完重启进程即可：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `8899` | 本地监听端口 |
| `HOST` | `127.0.0.1` | 只监听回环，不对外暴露 |
| `DSH_UPSTREAM_HOST` | `opencode.ai` | 上游主机 |
| `DSH_UPSTREAM_PORT` | `443` | 上游端口 |
| `DSH_UPSTREAM_TLS` | `1` | 设 `0` 走明文（自测假上游用） |
| `DSH_MERGE_FRAGMENT` | 未设（关） | 设 `1` 开启碎片合并 |
| `DSH_FRAGMENT_MAX_CHARS` | `40` | 正文短于该值才算碎片 |
| `DSH_FRAGMENT_RATIO` | `4` | reasoning 至少是正文的几倍 |
| `DSH_FRAGMENT_MIN_REASONING` | `200` | reasoning 的绝对下限（字） |
| `DSH_NO_FILE_LOG` | 未设 | 设任意值可少写日志文件 |

```bash
PORT=9000 DSH_MERGE_FRAGMENT=1 node proxy.js
```

## 自检：确认流量真的走了代理

1. 看代理进程的 stdout / `proxy.log`，每来一个请求会追加一行：

   ```text
   2026-09-27T07:33:08.018Z | /zen/go/v1/chat/completions | stream | status=200 | content_seen=0 | content_chars=0 | reasoning_chars=279 | tool_calls=0 | backfilled=true | merged=false | ms=2130
   ```

2. 没有新行 = 客户端还在直连官方网关，base URL 没生效（或客户端把配置缓存了）。
3. `status=502` 且日志有 `upstream_error` = 代理连不上官方网关，先确认本机网络/代理设置。

## 注意事项

- 代理**只处理 POST**，其它方法返回 405；这不是 bug。
- 代理**不做重试、不设超时**，慢就是慢（实测网关首字节 7~18 秒）。
- 它**不是** MITM 证书代理，也不改 HTTPS，只是一个本地 HTTP 转发口。
- 只监听 `127.0.0.1`，局域网内其它机器访问不到；不要改成 `0.0.0.0`，
  否则你的 API Key 会跟着请求一起暴露在那个端口上。
