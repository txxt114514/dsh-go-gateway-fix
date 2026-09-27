# dsh-go-gateway-fix

**In one line**: a zero-dependency local proxy that fixes the OpenCode Go gateway putting the
model's real answer into `reasoning_content` while leaving `content` empty or reduced to
fragments — put it in front of your client and the problem goes away.

```
client  ──►  http://127.0.0.1:8899/zen/go/v1/...  ──►  https://opencode.ai/zen/go/v1/...
                    (this proxy; rewrites `content` only when needed)
```

- **Pure Node (>=18), single file, zero third-party dependencies**
- Listens on `127.0.0.1:8899` (loopback only)
- Touches **only the `content` field** — headers, status codes and every other field pass through

> Chinese documentation (more detailed, with the full test log): [README.md](README.md)

---

## 1. The problem

The OpenCode Go gateway (`https://opencode.ai/zen/go/v1/...`) wraps model streaming responses in a
Chain-of-Thought wrapper: the assistant's actual output lands in `delta.reasoning_content`, while
`delta.content` is frequently **completely empty** or only a few fragments. An agent loop that
receives empty content concludes the model said nothing and exits immediately.

Upstream issue: [opencode-ai/opencode#37635](https://github.com/opencode-ai/opencode/issues/37635) —
verbatim:

> The opencode-go gateway wraps ALL model streaming responses in a Chain-of-Thought wrapper,
> putting the assistant's actual output in `delta.reasoning_content` instead of `delta.content`.
> This causes the agent loop to receive empty content and exit immediately.

The issue was auto-closed by a bot for "60 days of inactivity" and **is still unfixed**.

| Field | Normal | Behind the Go gateway |
| --- | --- | --- |
| `delta.content` | the full answer | empty, or a few dozen chars of fragments |
| `delta.reasoning_content` | short chain of thought | most of the answer, thousands of chars |
| `finish_reason` | — | usually `stop` (gateway reports success) |

Two failure shapes, both handled:

| Shape | Symptom | Feature | Default |
| --- | --- | --- | --- |
| **A. Completely empty** | not one non-empty `content` in the whole stream | **backfill** | **on** |
| **B. Badly fragmented** | `content` appears but totals 25–68 chars while `reasoning` is thousands | **fragment merge** | off (opt-in) |

### How it works

```text
upstream SSE:  delta.reasoning_content = "the whole answer..."
               delta.content           = ""  or  "ok" "ay" ...
               finish_reason           = "stop"          <- reports success!

      (direct)                          (through this proxy)
         |                                     |
         v                        pass through while counting:
  agent loop sees                 contentSeen / contentChars
  content="" -> exits             reasoning text
                                  tool_calls?
                                          |
                    +---------------------+---------------------+
                    |                                           |
        no non-empty content ever               content seen but tiny
        + reasoning available                   + reasoning >> content
                    |                                           |
                    v                                           v
        A: BACKFILL (default on)                B: MERGE (opt-in, default off)
        inject a synthetic content              APPEND a synthetic content delta
        delta BEFORE [DONE] /                   BEFORE [DONE] / finish_reason:
        finish_reason, text = reasoning         original short text + '\n' + reasoning
                    |                                           |
                    +---------------------+---------------------+
                                          v
                            client gets the full answer
```

The critical detail: the synthetic delta **must** be inserted *before* the terminating event.
Insert it after `[DONE]` and the client has already closed the stream, so it is discarded.

---

## 2. Quick start (30 seconds)

```bash
# 1. start the proxy (no npm install needed)
node proxy.js
#    -> ... | listening on http://127.0.0.1:8899 | upstream=https://opencode.ai:443 | merge_fragment=false

# 2. change your client's base URL from
#      https://opencode.ai/zen/go/v1
#    to
#      http://127.0.0.1:8899/zen/go/v1
#    Keep the /zen/go/v1 path. API key, model name and all headers stay as they are.

# 3. send a message and watch the log
tail -f proxy.log
```

Change port / enable fragment merge:

```bash
PORT=9000 DSH_MERGE_FRAGMENT=1 node proxy.js
```

Windows users can double-click [`scripts/start.cmd`](scripts/start.cmd) (auto-restarts on crash).

### Client configuration

The change is **always exactly one line** — the base URL. Examples for DSH
(`cordis.patch.yml`), the OpenCode CLI (`opencode.json`) and any OpenAI-compatible client are in
[`examples/`](examples/):

- [`examples/dsh-cordis.patch.yml.snippet`](examples/dsh-cordis.patch.yml.snippet)
- [`examples/opencode-config.json.snippet`](examples/opencode-config.json.snippet)
- [`examples/generic-openai-client.md`](examples/generic-openai-client.md)

```yaml
# DSH: ~/.dsh/profiles/<profile>/cordis.patch.yml
- id: llm-pi-ai
  config:
    providers:
      opencode-go-ds41:
        api: openai-completions
        baseURL: http://127.0.0.1:8899/zen/go/v1   # was https://opencode.ai/zen/go/v1
        headers:
          x-opencode-session: dsh-opencode-go
```

On Windows there is a one-shot wiring script that backs up, validates and prints the rollback:

```powershell
pwsh -File scripts\dsh-wire.ps1 -DryRun    # preview
pwsh -File scripts\dsh-wire.ps1            # apply
pwsh -File scripts\dsh-wire.ps1 -Restore   # roll back
```

---

## 3. The two switches

### A. Backfill — default **on**, no configuration

- **Trigger**: not one non-empty `content` in the entire stream, and `reasoning` is non-empty.
- **Action**: emit a synthetic delta **before** `finish_reason` / `message_stop` / `[DONE]`
  whose text is the full reasoning.
- Non-streaming works too: `message.content` is filled from `reasoning_content` when empty.

### B. Fragment merge — default **off**, opt in with `DSH_MERGE_FRAGMENT=1`

All four conditions must hold:

| # | Condition | Default | Override |
| --- | --- | --- | --- |
| 1 | `content` appeared but total length **<** threshold | 40 chars | `DSH_FRAGMENT_MAX_CHARS` |
| 2a | `reasoning` length **>** absolute floor | 200 chars | `DSH_FRAGMENT_MIN_REASONING` |
| 2b | `reasoning` length **>** `content` length x factor | 4x | `DSH_FRAGMENT_RATIO` |
| 3 | response contains **no tool calls** | — | not overridable |
| 4 | backfill (A) did not fire (mutually exclusive) | — | not overridable |

- **Action**: **append** a synthetic content delta = `'\n' + reasoning`. The original short
  `content` is **kept, never overwritten**.
- **Why condition 3 is mandatory**: when a response carries `tool_calls` / `tool_use`, a short
  `content` is *correct* — the real payload is in the arguments. Merging reasoning into `content`
  would corrupt the tool-calling flow. Detection covers OpenAI `tool_calls` / `function_call` and
  Anthropic `tool_use` / `input_json_delta`.

All environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8899` | local listen port |
| `HOST` | `127.0.0.1` | loopback only — **do not use `0.0.0.0`** |
| `DSH_UPSTREAM_HOST` | `opencode.ai` | upstream host |
| `DSH_UPSTREAM_PORT` | `443` | upstream port |
| `DSH_UPSTREAM_TLS` | `1` | `0` = plaintext (for a local fake upstream in tests) |
| `DSH_MERGE_FRAGMENT` | unset (off) | `1` enables fragment merge |
| `DSH_FRAGMENT_MAX_CHARS` | `40` | condition 1 threshold |
| `DSH_FRAGMENT_RATIO` | `4` | condition 2b factor |
| `DSH_FRAGMENT_MIN_REASONING` | `200` | condition 2a floor |
| `DSH_NO_FILE_LOG` | unset | set to reduce file logging |

### Reading the log

One line per request; `backfilled` / `merged` tell you exactly which path ran:

```text
# backfill fired (stream)
2026-09-27T07:33:08.018Z | /zen/go/v1/chat/completions | stream | status=200 | content_seen=0 | content_chars=0 | reasoning_chars=279 | tool_calls=0 | backfilled=true | merged=false | ms=2130

# fragment merge fired (needs DSH_MERGE_FRAGMENT=1)
2026-09-27T07:35:21.5xxZ | /zen/go/v1/chat/completions | stream | status=200 | content_seen=5 | content_chars=25 | reasoning_chars=1120 | tool_calls=0 | backfilled=false | merged=true | merged_chars=1122 | ms=4

# neither fired (healthy gateway)
2026-09-27T07:37:21.583Z | /zen/go/v1/chat/completions | stream | status=200 | content_seen=15 | content_chars=318 | reasoning_chars=3391 | tool_calls=0 | backfilled=false | merged=false | ms=8340
```

The startup line states the switch state and effective thresholds:

```text
... | listening on http://127.0.0.1:8899 | upstream=https://opencode.ai:443 | merge_fragment=true(max_chars=40,ratio=4,min_reasoning=200)
```

---

## 4. Autostart

| Platform | Command |
| --- | --- |
| Windows | `powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1` (HKCU Run, no admin/UAC); `-Status` to inspect, `-Remove` to uninstall |
| Linux | `cd scripts/linux && ./install.sh` (systemd user unit, no sudo); `--status`, `--remove` |
| macOS | `cd scripts/macos && ./install.sh` (launchd LaunchAgent, no sudo); `--status`, `--remove` |

Windows launches [`scripts/start.cmd`](scripts/start.cmd), which restarts the proxy after a crash.
Linux uses `Restart=always` / `RestartSec=3`; macOS uses `KeepAlive=true` / `ThrottleInterval=3`.

---

## 5. Measured results (2026-09-27, `deepseek-v4.1-flash`)

### Fragment merge, injected — `node test/merge-test.js`

Corpus: short content 14 chars, reasoning 960 chars, normal long content 468 chars.
Client-visible content length:

| Response shape | switch off | switch on | expected |
| --- | --- | --- | --- |
| OpenAI streaming | **14** | **975** | 14 / 975 |
| Anthropic streaming | **14** | **975** | 14 / 975 |
| Non-streaming | **14** | **975** | 14 / 975 |

`975 = 14 + 1 + 960` (short text + newline + full reasoning), verified character by character.
With the switch off the body is byte-identical to upstream.

Negative cases (must **not** merge even with the switch on):

| Case | Result |
| --- | --- |
| Legal short answer `content="通"`, no reasoning | `"通"` |
| Legal short answer + short reasoning (below the 200-char floor) | `"通"` |
| Response with `tool_calls` (OpenAI streaming) | 14 chars |
| Response with `tool_use` (Anthropic streaming) | 14 chars |
| Response with `tool_calls` (non-streaming) | 14 chars, `tool_calls` intact |
| Normal long content (468) + long reasoning | 468 chars |

Threshold override: content 120 + reasoning 500 → **not merged** at default thresholds,
**merged** (621 = 120+1+500) with `MAX_CHARS=200 / RATIO=2`.
**26 assertions, all PASS.**

### Backfill, injected — `node test/inject-test.js`

Fake upstream emits only `reasoning_content` / `thinking_delta`: all PASS
(103/103 chars recovered for both OpenAI and Anthropic streaming, non-streaming backfilled,
and an already-healthy response is passed through untouched).

### Real gateway data + real symptom — `node test/e2e-proof.js`

```text
real response (unmodified):
  client-visible content : 302 chars
  reasoning_content      : 14449 chars
  content share of total : 2.0%

same real data with content wiped (simulating #37635):
  before patch : 0 chars      <- agent loop would exit immediately
  after proxy  : 14449 chars
  backfilled   : true
  synthetic delta at line 2106, [DONE] at line 2112
```

### Default behaviour unchanged — `node test/verify.js` (A/B, 5 runs each)

No environment variables set (merge off). Group A direct, group B through the proxy:

| Run | A direct content | A reasoning | B via proxy content | B reasoning |
| --- | --- | --- | --- | --- |
| 1 | 319 | 13562 | 318 | 3391 |
| 2 | 814 | 7044 | 326 | 4355 |
| 3 | 683 | 6858 | 178 | 2197 |
| 4 | 216 | 15175 | 175 | 10318 |
| 5 | 278 | 3595 | 414 | 13509 |

- Group A: empty **0/5**, fragments **0/5**, complete **5/5**
- Group B: non-empty **5/5**, complete **5/5**
- All five proxy log lines: `backfilled=false` `merged=false`

**Honest reading**: group A had content in 5/5 runs, so the bug did **not** reproduce that day.
Group B's "5/5 non-empty" is therefore a **null result** — neither feature fired. It only proves
the proxy **does not degrade** traffic. The evidence that backfill works is the injected tests above.

---

## 6. Honest disclaimer

1. **This works around the bug; it does not fix the gateway.** The real fix belongs upstream at
   `opencode.ai`. When the gateway is fixed, simply stop using this proxy.
2. **Fragment merge is off by default, and enabling it changes legitimate short answers.** The
   thresholds are heuristics. If "short answer + long reasoning" is *normal* in your workload
   (e.g. you ask for a one-word reply and the model thinks at length first), enabling merge will
   append the reasoning to the answer. Three negative cases are covered by tests, but
   **coverage is not exhaustive. Use at your own risk.**
3. **Responses containing tool calls are never merged** (by design). Backfill, however, does *not*
   exclude tool calls — see the limitations below.
4. **Sampling caveat**: the A/B run above did not reproduce the bug, because the gateway happened
   to be healthy that day. Reproduction rate varies by date, time and task. None of the conclusions
   here depend on that run.
5. **No retries, no timeouts.** If the gateway is slow, the proxy is slow (observed 7–27s).
6. **Loopback only.** Do not bind `0.0.0.0` — that would expose your API key on the LAN.

---

## 7. Known limitations

1. **Backfill does not exclude tool calls**: if the model emits only `tool_calls` with empty
   content, backfill will put reasoning into `content`. Fragment merge excludes this case;
   backfill does not (changing it would alter default behaviour).
2. **No stall / first-byte timeout**, and no retries.
3. **Truncated streams**: if upstream drops without `finish_reason` / `[DONE]`, backfill only runs
   when the buffer is empty; if content already appeared, nothing is added or merged.
4. **Reasoning over 4MB is truncated** (memory guard); the log records `reasoning_truncated=true`.
5. **POST only**; other methods get 405. Paths outside `/zen/go/v1/` pass through unobserved.
6. **Anthropic non-streaming** only handles a top-level `content[]`; mixed `tool_use` + thinking
   blocks are not fully verified.
7. **Multiple `choices`**: the synthetic delta always uses `index: 0`.
8. **Heuristic thresholds**: `content_chars < 40` and `ratio > 4` are empirical; tune via env vars.
9. **No load testing**: state is per-request (`SseFixer` per stream, no shared mutable state),
   but high concurrency is untested.
10. **Encoding traps found while building this** (already avoided): `cmd.exe` mis-parses batch
    files with **LF** endings, and running `chcp 65001` *inside* a batch file desyncs the parser
    and truncates later lines — so `scripts/start.cmd` is **ASCII + CRLF**. Shell scripts must be
    **LF**. `.ps1` files are **UTF-8 with BOM + CRLF** (Windows PowerShell 5.1 decodes BOM-less
    UTF-8 as ANSI, which breaks Chinese comments outright).

---

## 8. Uninstall and rollback

```yaml
# point the client back at the official gateway
baseURL: https://opencode.ai/zen/go/v1
```

```powershell
pwsh -File scripts\dsh-wire.ps1 -Restore      # Windows: restore from the automatic backup
```

Stop the proxy: Ctrl+C in its window, or
`install-autostart.ps1 -Remove` (Windows) / `scripts/linux/install.sh --remove` (Linux) /
`scripts/macos/install.sh --remove` (macOS).

Full removal = delete the directory. The proxy writes **no registry keys, installs no service and
changes no system configuration**; the only trace is the autostart entry (removed by the commands
above) and `proxy.log` in its own directory.

---

## 9. License

[MIT](LICENSE) © 2026 dsh-go-gateway-fix contributors
