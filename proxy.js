#!/usr/bin/env node
'use strict';

/**
 * dsh-go-gateway-fix —— OpenCode Go 网关 reasoning_content 回填代理
 *
 * 背景：opencode.ai/zen/go/v1 会把模型真正的输出塞进 delta.reasoning_content /
 * thinking_delta，而 delta.content 经常为空或只剩碎片，导致 agent loop 拿到空内容直接退出。
 *
 * 本代理只做两件事：
 *   1. 把 /zen/go/v1/* 原样转发到 https://opencode.ai（含全部请求头与状态码）
 *   2. 观察响应并按需回填 content（两种模式，见下）
 *
 * 模式一「补发」（默认开，无需配置）：
 *   整条响应里 content 从未出现过非空内容、而 reasoning 有货，则把 reasoning
 *   补发为 content（流式在 [DONE] / finish_reason 之前补一个合成 delta）。
 *
 * 模式二「碎片合并」（默认关，需 DSH_MERGE_FRAGMENT=1）：
 *   content 出现过但短得离谱、而 reasoning 是它的若干倍，则把 reasoning
 *   追加到正文后面（保留原有短 content，不覆盖）。判据见 shouldMergeFragment()。
 *   含工具调用的响应一律不合并，避免破坏 tool_calls 流程。
 *
 * 零依赖，只用 Node 内置模块。
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const UPSTREAM_HOST = process.env.DSH_UPSTREAM_HOST || 'opencode.ai';
const UPSTREAM_PORT = Number(process.env.DSH_UPSTREAM_PORT || 443);
const UPSTREAM_TLS = process.env.DSH_UPSTREAM_TLS !== '0'; // 设 0 可指向本地假上游（自测用）
const PORT = Number(process.env.PORT || 8899);
const HOST = process.env.HOST || '127.0.0.1';

/* ------------------------------------------------------ 碎片合并（默认关） */

/** 读一个数值型环境变量，非法值退回默认值 */
function numEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

const MERGE_CONFIG = {
  // 总开关：只有显式设为 1 才启用，不设时行为与历史版本完全一致
  enabled: process.env.DSH_MERGE_FRAGMENT === '1',
  // 累计 content 长度小于该值才算「碎片」
  maxChars: numEnv('DSH_FRAGMENT_MAX_CHARS', 40),
  // reasoning 至少要达到 content 的这么多倍
  ratio: numEnv('DSH_FRAGMENT_RATIO', 4),
  // reasoning 的绝对下限，太短就没必要合并
  minReasoning: numEnv('DSH_FRAGMENT_MIN_REASONING', 200),
};

const ROOT = __dirname;
const LOG_FILE = path.join(ROOT, 'proxy.log');

// 需要被观察/改写的路径（前缀匹配）。其余路径纯透传。
const WATCH_PATHS = ['/zen/go/v1/'];

// 这些请求头不能原样转发：Node 会自己算长度与连接方式
const STRIP_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'proxy-connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'content-length',
]);

// 响应侧同理；另外 content-length 会因补发而变化，必须重算
const STRIP_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-length',
]);

/* ------------------------------------------------------------------ 日志 */

let logStream = null;
function logLine(fields) {
  const stamp = new Date().toISOString();
  const line =
    stamp +
    ' | ' +
    fields.join(' | ') +
    '\n';
  process.stdout.write(line);
  try {
    if (!logStream) { logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' }); logStream.on('error', () => { try { logStream.destroy(); } catch (_) {} logStream = null; }); }
    logStream.write(line);
  } catch (_) {
    /* 日志写不了（如 EBUSY）也不能影响请求：只打 stdout 就够了 */
  }
  // 双保险：即便 createWriteStream 抛错/被锁，也绝不让日志成为启动失败原因
  if (!logStream && !process.env.DSH_NO_FILE_LOG) {
    try { logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' }); } catch (_) { }
  }
  if (process.env.DSH_NO_FILE_LOG) logStream = null;
}

/* ------------------------------------------------------------ 内容判定工具 */

/** 判断一段文本是否为“有效内容”（非空且不全是空白） */
function hasText(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * 从一段增量里抽出 content 片段（支持 OpenAI 与 Anthropic 两种写法）。
 * 返回数组：可能是 ['text'] 或 [{type:'text',text:'...'}]
 */
function extractContentPieces(delta) {
  if (!delta || typeof delta !== 'object') return [];

  // Anthropic: content_block_delta -> delta.type === 'text_delta'
  if (delta.type === 'text_delta') {
    return hasText(delta.text) ? [{ type: 'text', text: delta.text }] : [];
  }

  // OpenAI: delta.content 可能是字符串，也可能是分片数组
  const c = delta.content;
  if (typeof c === 'string') return hasText(c) ? [c] : [];
  if (Array.isArray(c)) {
    const out = [];
    for (const part of c) {
      if (part && typeof part === 'object') {
        if (hasText(part.text)) out.push(part);
      } else if (hasText(part)) {
        out.push(part);
      }
    }
    return out;
  }
  return [];
}

/** 从一段增量里抽出 reasoning 文本 */
function extractReasoningText(delta) {
  if (!delta || typeof delta !== 'object') return '';

  // Anthropic: content_block_delta -> delta.type === 'thinking_delta'
  if (delta.type === 'thinking_delta') {
    return typeof delta.thinking === 'string' ? delta.thinking : '';
  }

  const r = delta.reasoning_content;
  if (typeof r === 'string') return r;
  // 少数实现把 reasoning 放进数组分片
  if (Array.isArray(r)) {
    let s = '';
    for (const part of r) {
      if (typeof part === 'string') s += part;
      else if (part && typeof part.text === 'string') s += part.text;
    }
    return s;
  }

  // 兼容 reasoning 字段拼写差异
  if (typeof delta.reasoning === 'string') return delta.reasoning;
  return '';
}

/** 统计一组 content 片段的总字符数（片段可能是字符串或 {type,text} 对象） */
function piecesLength(pieces) {
  let n = 0;
  for (const p of pieces) {
    if (typeof p === 'string') n += p.length;
    else if (p && typeof p.text === 'string') n += p.text.length;
  }
  return n;
}

/**
 * 判断一段增量/消息里是否含工具调用。
 * 覆盖 OpenAI 的 tool_calls / function_call 与 Anthropic 的 tool_use /
 * input_json_delta。含工具调用时碎片合并必须让路：正文短是正常的，
 * 真正的输出在参数里，合并 reasoning 会污染工具调用流程。
 */
function hasToolCalls(obj) {
  if (!obj || typeof obj !== 'object') return false;

  // OpenAI: delta.tool_calls / message.tool_calls（可能只带 index 的分片）
  if (Array.isArray(obj.tool_calls) && obj.tool_calls.length > 0) return true;
  // OpenAI 旧式函数调用
  if (obj.function_call && typeof obj.function_call === 'object') return true;
  if (typeof obj.tool_call_id === 'string' && obj.tool_call_id) return true;

  // Anthropic: content_block_start -> content_block.type === 'tool_use'
  if (obj.content_block && obj.content_block.type === 'tool_use') return true;
  // Anthropic: content_block_delta -> delta.type === 'input_json_delta'
  if (obj.delta && obj.delta.type === 'input_json_delta') return true;
  // Anthropic: 整块 message 里含 tool_use 块
  if (Array.isArray(obj.content) && obj.content.some((b) => b && b.type === 'tool_use')) return true;

  return false;
}

/**
 * 碎片合并判据：四个条件全部满足才合并。
 *   1. 出现过 content，但累计长度 < maxChars（默认 40）
 *   2. reasoning 长度 > content 长度 × ratio（默认 4），且 > minReasoning（默认 200）
 *   3. 该响应不含工具调用
 *   4. 没触发过「完全空」补发 —— 由调用点的分支结构保证（两者互斥）
 *
 * @param {{contentChars:number, reasoningChars:number, toolCalls:number}} stat
 * @param {{enabled:boolean, maxChars:number, ratio:number, minReasoning:number}} cfg
 */
function shouldMergeFragment(stat, cfg) {
  if (!cfg || !cfg.enabled) return false;
  if (stat.toolCalls > 0) return false; // 条件 3
  if (!(stat.contentChars > 0 && stat.contentChars < cfg.maxChars)) return false; // 条件 1
  if (!(stat.reasoningChars > cfg.minReasoning)) return false; // 条件 2a
  if (!(stat.reasoningChars > stat.contentChars * cfg.ratio)) return false; // 条件 2b
  return true;
}

/** 收集 reasoning 文本，带总量上限，避免超长输出把内存吃光 */
const REASONING_LIMIT = 4 * 1024 * 1024;
function makeCollector() {
  let buf = '';
  let truncated = false;
  return {
    push(text) {
      if (!text) return;
      if (buf.length >= REASONING_LIMIT) {
        truncated = true;
        return;
      }
      buf += text;
      if (buf.length > REASONING_LIMIT) {
        buf = buf.slice(0, REASONING_LIMIT);
        truncated = true;
      }
    },
    get text() {
      return buf;
    },
    get truncated() {
      return truncated;
    },
  };
}

/* ---------------------------------------------------------- 非流式响应改写 */

/**
 * 非流式响应改写。
 * 先做「完全空」回填（message.content 为空而 reasoning 有货 → 回填）；
 * 再在启用碎片合并时，对「content 极短 + reasoning 极长」的响应追加 reasoning。
 * 同时兼容 Anthropic 的 content 数组（type=thinking 的块没有可见输出）。
 *
 * 返回 { json, changed, backfilled, merged, contentChars, reasoningChars, toolCalls }；
 * 任何解析异常都吞掉，交给调用方退化成纯透传。
 */
function fixNonStreaming(json, cfg = MERGE_CONFIG) {
  let changed = 0;
  let backfilled = false;
  let merged = false;
  let contentChars = 0;
  let reasoningChars = 0;
  let toolCalls = 0;
  if (!json || typeof json !== 'object') {
    return { json, changed, backfilled, merged, contentChars, reasoningChars, toolCalls };
  }

  // --- OpenAI 风格 ---
  if (Array.isArray(json.choices)) {
    for (const choice of json.choices) {
      const msg = choice && choice.message;
      if (!msg || typeof msg !== 'object') continue;
      const pieces = extractContentPieces({ content: msg.content });
      const contentOk = hasText(msg.content) || pieces.length > 0;
      const reasoning = extractReasoningText(msg);
      const msgHasTools = hasToolCalls(msg);
      const contentLen = piecesLength(pieces);

      if (msgHasTools) toolCalls += 1;
      reasoningChars += reasoning.length;
      if (contentOk) contentChars += contentLen;

      if (!contentOk && hasText(reasoning)) {
        // 模式一：完全空 → 回填
        msg.content = reasoning;
        msg.__dsh_content_backfilled = true;
        backfilled = true;
        changed += 1;
        contentChars += reasoning.length;
      } else if (
        contentOk &&
        shouldMergeFragment(
          { contentChars: contentLen, reasoningChars: reasoning.length, toolCalls: msgHasTools ? 1 : 0 },
          cfg
        )
      ) {
        // 模式二：碎片 → 追加（保留原有短 content，不覆盖）
        msg.content = msg.content + '\n' + reasoning;
        msg.__dsh_content_merged = true;
        merged = true;
        changed += 1;
        contentChars += 1 + reasoning.length;
      }
    }
  }

  // --- Anthropic 风格：顶层 content 数组 ---
  if (Array.isArray(json.content)) {
    const visible = json.content.filter(
      (b) => b && (b.type === 'text' ? hasText(b.text) : b.type !== 'thinking')
    );
    const thinking = json.content.filter((b) => b && b.type === 'thinking');
    const thinkingText = thinking.map((b) => (typeof b.thinking === 'string' ? b.thinking : '')).join('');
    const toolBlocks = json.content.filter((b) => b && b.type === 'tool_use').length;
    toolCalls += toolBlocks;

    let visibleChars = 0;
    for (const b of visible) if (b.type === 'text' && typeof b.text === 'string') visibleChars += b.text.length;
    reasoningChars += thinkingText.length;

    if (visible.length === 0 && thinking.length > 0) {
      // 模式一：没有任何可见块 → 用 thinking 顶上
      if (hasText(thinkingText)) {
        json.content = [{ type: 'text', text: thinkingText }];
        backfilled = true;
        changed += 1;
        contentChars += thinkingText.length;
      }
    } else if (
      visible.length > 0 &&
      shouldMergeFragment({ contentChars: visibleChars, reasoningChars: thinkingText.length, toolCalls: toolBlocks }, cfg)
    ) {
      // 模式二：可见正文极短 → 追加一个 text 块（保留原有块）
      json.content = json.content.concat([{ type: 'text', text: '\n' + thinkingText }]);
      merged = true;
      changed += 1;
      contentChars += 1 + thinkingText.length;
    }
  }

  return { json, changed, backfilled, merged, contentChars, reasoningChars, toolCalls };
}

/* ------------------------------------------------------------ SSE 流式改写 */

/**
 * SSE 流式处理器。
 * 一边透传，一边统计 content / reasoning；结束时若 content 从未出现，
 * 就在终止事件之前插入一个合成 content delta。
 */
class SseFixer {
  constructor(flush, cfg = MERGE_CONFIG) {
    this.flush = flush; // (chunkString) => void
    this.cfg = cfg; // 碎片合并配置
    this.buffer = ''; // 未处理完的文本尾巴
    this.contentSeen = 0; // 非空 content 片段数
    this.contentChars = 0; // 非空 content 累计字符数（碎片判据用）
    this.toolCalls = 0; // 见过的工具调用数（>0 则一律不合并）
    this.reasoning = makeCollector();
    this.done = false;
    this.inserted = false; // 已经插入过合成 delta（补发与合并互斥）
    this.backfilled = false; // 触发的是「完全空」补发
    this.merged = false; // 触发的是「碎片合并」
    this.mergedChars = 0; // 合并后追加的字符数
    this.sawOpenAiDone = false; // 见过 data: [DONE]
    this.sawFinish = false; // 见过 finish_reason / message_stop
    this.syntheticTemplate = null; // 用来合成 delta 的模板（模型名、id、created）
    this.isAnthropic = false; // 这条流是否为 Anthropic 事件格式
    this.formatLocked = false; // 格式判定是否已锁定
  }

  /** 喂入一段（可能是半截的）文本 */
  push(chunk) {
    if (this.done) return;
    this.buffer += chunk;
    // SSE 事件以空行分隔，统一按 \n 处理（\r\n 也覆盖）
    let idx;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const rawLine = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      this.handleLine(rawLine.replace(/\r$/, ''));
    }
  }

  /** 处理一整行 SSE */
  handleLine(line) {
    if (this.done) return;

    // 事件分隔空行：原样放行
    if (line === '') {
      this.flush('\n');
      return;
    }

    // 非 data 行（event: / id: / :注释 / retry:）原样放行
    if (!line.startsWith('data:')) {
      // Anthropic 的 message_stop 表示流自然结束
      if (/^event:\s*message_stop\s*$/.test(line)) {
        this.sawFinish = true;
        this.beforeFinish();
      }
      this.flush(line + '\n');
      return;
    }

    const payload = line.slice(5).trim();

    if (payload === '[DONE]') {
      this.sawOpenAiDone = true;
      this.beforeFinish(); // 合成 delta 必须插在 [DONE] 之前
      this.flush(line + '\n');
      this.done = true;
      return;
    }

    let obj = null;
    try {
      obj = JSON.parse(payload);
    } catch (_) {
      // 解析失败：无法判断内容，原样透传
      this.flush(line + '\n');
      return;
    }

    this.observe(obj);

    // finish_reason 出现时也要先把合成内容补上
    const finishing = obj && obj.choices && obj.choices.some((c) => c && c.finish_reason);
    if (finishing) {
      this.sawFinish = true;
      this.beforeFinish();
    }

    this.flush('data: ' + JSON.stringify(obj) + '\n');
  }

  /** 统计这一条事件里的 content / reasoning */
  observe(obj) {
    if (!obj || typeof obj !== 'object') return;

    // 锁定这条流的格式：Anthropic 用顶层 type 描述事件，OpenAI 用 choices[].delta
    if (!this.formatLocked) {
      if (Array.isArray(obj.choices)) {
        this.isAnthropic = false;
        this.formatLocked = true;
      } else if (
        typeof obj.type === 'string' &&
        /^(message_start|message_delta|message_stop|content_block_start|content_block_delta|content_block_stop|ping)$/.test(obj.type)
      ) {
        this.isAnthropic = true;
        this.formatLocked = true;
      }
    }

    // 记住模板，合成时保持格式一致
    if (!this.syntheticTemplate) {
      this.syntheticTemplate = {
        id: obj.id,
        object: obj.object,
        created: obj.created,
        model: obj.model,
      };
    }

    if (Array.isArray(obj.choices)) {
      for (const choice of obj.choices) {
        const delta = choice && choice.delta;
        if (delta) {
          const pieces = extractContentPieces(delta);
          this.contentSeen += pieces.length;
          this.contentChars += piecesLength(pieces);
          this.reasoning.push(extractReasoningText(delta));
          if (hasToolCalls(delta)) this.toolCalls += 1;
        }
        // 少数网关直接给 message
        const msg = choice && choice.message;
        if (msg) {
          const pieces = extractContentPieces(msg);
          this.contentSeen += pieces.length;
          this.contentChars += piecesLength(pieces);
          this.reasoning.push(extractReasoningText(msg));
          if (hasToolCalls(msg)) this.toolCalls += 1;
        }
        // 工具调用也可能挂在 choice 顶层（非标准写法，顺手兼容；delta 已记过就不重复）
        if (choice && hasToolCalls(choice) && !hasToolCalls(delta) && !hasToolCalls(msg)) {
          this.toolCalls += 1;
        }
      }
    }

    // Anthropic: content_block_delta
    if (obj.type === 'content_block_delta' && obj.delta) {
      if (obj.delta.type === 'text_delta') {
        const pieces = extractContentPieces(obj.delta);
        this.contentSeen += pieces.length;
        this.contentChars += piecesLength(pieces);
      } else if (obj.delta.type === 'thinking_delta') {
        this.reasoning.push(extractReasoningText(obj.delta));
      }
    }

    // Anthropic: content_block_start 里声明 tool_use 块
    if (obj.type === 'content_block_start' && obj.content_block && obj.content_block.type === 'tool_use') {
      this.toolCalls += 1;
    }

    // Anthropic: 整块 message（非增量）
    if (obj.type === 'message' && Array.isArray(obj.content)) {
      const pieces = extractContentPieces({ content: obj.content });
      this.contentSeen += pieces.length;
      this.contentChars += piecesLength(pieces);
      if (obj.content.some((b) => b && b.type === 'tool_use')) this.toolCalls += 1;
    }
  }

  /** 当前这条流的统计快照，供判据与日志使用 */
  stats() {
    return {
      contentSeen: this.contentSeen,
      contentChars: this.contentChars,
      reasoningChars: this.reasoning.text.length,
      toolCalls: this.toolCalls,
    };
  }

  /**
   * 流结束前：判断是否需要补发 / 合并。
   * 两条分支互斥 —— content 从未出现过才走补发，出现过才可能走合并。
   */
  beforeFinish() {
    if (this.inserted) return;

    // ---- 模式一：整条流一次非空 content 都没有 → 补发 ----
    if (this.contentSeen === 0) {
      const text = this.reasoning.text;
      if (!hasText(text)) return; // 没有 reasoning 可补
      this.inserted = true;
      this.backfilled = true;
      for (const chunk of this.buildSynthetic(text)) this.flush(chunk);
      return;
    }

    // ---- 模式二：content 出现过但严重碎片化 → 追加（默认关） ----
    if (!shouldMergeFragment(this.stats(), this.cfg)) return;
    const text = this.reasoning.text;
    const appended = '\n' + text; // 保留原有短 content，只在其后追加
    this.inserted = true;
    this.merged = true;
    this.mergedChars = appended.length;
    for (const chunk of this.buildSynthetic(appended)) this.flush(chunk);
  }

  /**
   * 构造合成 delta 文本。
   * 必须只发“这条流实际用的那一种格式”：两种都发的话，
   * 同时认两种格式的客户端会把正文收到两遍。
   * 判定依据是本流里见过什么：Anthropic 流有 message_start/content_block_*，
   * OpenAI 流有 choices[].delta。都没见过时按 OpenAI 处理（更常见）。
   */
  buildSynthetic(text) {
    const out = [];

    if (this.isAnthropic) {
      // 补一个 content_block_delta(text_delta)，位置在 message_stop 之前
      out.push(
        'event: content_block_delta\n' +
          'data: ' +
          JSON.stringify({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text },
          }) +
          '\n\n'
      );
      return out;
    }

    const tpl = this.syntheticTemplate || {};
    const chunk = {
      id: tpl.id || 'chatcmpl-dsh-backfill',
      object: tpl.object || 'chat.completion.chunk',
      created: tpl.created || Math.floor(Date.now() / 1000),
      model: tpl.model || 'unknown',
      choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
    };
    out.push('data: ' + JSON.stringify(chunk) + '\n\n');
    return out;
  }

  /** 真正的收尾：结束前把缓冲区残余放行 */
  end() {
    if (this.done) return;
    if (this.buffer) {
      this.beforeFinish();
      this.flush(this.buffer);
      this.buffer = '';
    } else if (!this.sawOpenAiDone && !this.sawFinish) {
      // 上游没发终止标记就断流了，仍有必要兜底补发
      this.beforeFinish();
    }
    this.done = true;
  }
}

/* ------------------------------------------------------------ 请求转发 */

/** 构造转发给上游的请求头 */
function buildUpstreamHeaders(reqHeaders) {
  const out = {};
  for (const [k, v] of Object.entries(reqHeaders)) {
    if (STRIP_REQUEST_HEADERS.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  out['host'] = UPSTREAM_TLS ? UPSTREAM_HOST : `${UPSTREAM_HOST}:${UPSTREAM_PORT}`;
  // 用身份编码，避免上游按压缩流返回（我们要逐行看 SSE）
  out['accept-encoding'] = 'identity';
  return out;
}

/** 读取请求体 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      chunks.push(c);
      size += c.length;
      if (size > 64 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** 把响应头写回客户端 */
function writeHead(res, statusCode, headers, overrideLength) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (STRIP_RESPONSE_HEADERS.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  if (overrideLength !== undefined) out['content-length'] = String(overrideLength);
  res.writeHead(statusCode, out);
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const urlPath = req.url || '/';
  const watched = WATCH_PATHS.some((p) => urlPath.startsWith(p));

  // 只处理 POST；其它方法直接 405，避免误用
  if (req.method !== 'POST') {
    res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('dsh-go-gateway-fix: only POST is proxied\n');
    return;
  }

  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('bad request body: ' + err.message + '\n');
    return;
  }

  const headers = buildUpstreamHeaders(req.headers);
  headers['content-length'] = String(body.length);

  const upstreamReq = (UPSTREAM_TLS ? https : http).request(
    {
      host: UPSTREAM_HOST,
      port: UPSTREAM_PORT,
      method: 'POST',
      path: urlPath,
      headers,
      ...(UPSTREAM_TLS ? {} : { agent: false }),
    },
    (upstreamRes) => {
      const ctype = String(upstreamRes.headers['content-type'] || '');
      const isSse = ctype.includes('text/event-stream');
      const status = upstreamRes.statusCode || 502;

      // 非观察路径 / 非流式：先整体收下来再决定怎么回
      if (!watched) {
        writeHead(res, status, upstreamRes.headers);
        upstreamRes.pipe(res);
        logLine([urlPath, 'passthrough', `status=${status}`, `ms=${Date.now() - started}`]);
        return;
      }

      if (!isSse) {
        const bufs = [];
        upstreamRes.on('data', (c) => bufs.push(c));
        upstreamRes.on('end', () => {
          const raw = Buffer.concat(bufs);
          let outBuf = raw;
          let contentSeen = 0;
          let reasoningChars = 0;
          let backfilled = false;
          let merged = false;
          let contentChars = 0;
          let toolCalls = 0;

          // 只对 2xx 的 JSON 生效
          if (status >= 200 && status < 300) {
            try {
              const json = JSON.parse(raw.toString('utf8'));
              // 先统计原始情况
              if (Array.isArray(json.choices)) {
                for (const ch of json.choices) {
                  const msg = (ch && ch.message) || {};
                  const pieces = extractContentPieces({ content: msg.content });
                  contentSeen += pieces.length;
                  contentChars += piecesLength(pieces);
                  reasoningChars += extractReasoningText(msg).length;
                  if (hasToolCalls(msg)) toolCalls += 1;
                }
              }
              const fixed = fixNonStreaming(json);
              backfilled = fixed.backfilled;
              merged = fixed.merged;
              if (fixed.changed > 0) {
                outBuf = Buffer.from(JSON.stringify(fixed.json), 'utf8');
              }
            } catch (_) {
              // 解析失败 -> 纯透传
            }
          }

          writeHead(res, status, upstreamRes.headers, outBuf.length);
          res.end(outBuf);
          logLine([
            urlPath,
            'non-stream',
            `status=${status}`,
            `content_seen=${contentSeen}`,
            `content_chars=${contentChars}`,
            `reasoning_chars=${reasoningChars}`,
            `tool_calls=${toolCalls}`,
            `backfilled=${backfilled}`,
            `merged=${merged}`,
            `ms=${Date.now() - started}`,
          ]);
        });
        upstreamRes.on('error', () => {
          try {
            if (!res.headersSent) writeHead(res, status, upstreamRes.headers);
            res.end();
          } catch (_) {}
        });
        return;
      }

      // ---- SSE 流式 ----
      const fixer = new SseFixer((chunk) => {
        if (!res.writableEnded) res.write(chunk);
      });

      writeHead(res, status, upstreamRes.headers);

      upstreamRes.setEncoding('utf8');
      upstreamRes.on('data', (chunk) => {
        try {
          fixer.push(chunk);
        } catch (_) {
          // 任何解析意外：退化成纯透传
          try {
            res.write(chunk);
          } catch (_) {}
        }
      });

      const finish = () => {
        if (res.writableEnded) return;
        try {
          fixer.end();
        } catch (_) {}
        logLine([
          urlPath,
          'stream',
          `status=${status}`,
          `content_seen=${fixer.contentSeen}`,
          `content_chars=${fixer.contentChars}`,
          `reasoning_chars=${fixer.reasoning.text.length}`,
          `tool_calls=${fixer.toolCalls}`,
          `backfilled=${fixer.backfilled}`,
          `merged=${fixer.merged}`,
          fixer.merged ? `merged_chars=${fixer.mergedChars}` : '',
          fixer.reasoning.truncated ? 'reasoning_truncated=true' : '',
          `ms=${Date.now() - started}`,
        ].filter(Boolean));
        res.end();
      };

      upstreamRes.on('end', finish);
      upstreamRes.on('error', finish);
      res.on('close', () => {
        // 客户端提前断开：上游也收掉
        try {
          upstreamRes.destroy();
        } catch (_) {}
      });
    }
  );

  upstreamReq.on('error', (err) => {
    logLine([urlPath, 'upstream_error', err.message]);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    }
    res.end('upstream error: ' + err.message + '\n');
  });

  upstreamReq.end(body);
});

// 作为库被 require 时（测试脚本复用 SseFixer）不自动起服务
if (require.main === module) {
  server.listen(PORT, HOST, () => {
    logLine([
      `listening on http://${HOST}:${PORT}`,
      `upstream=${UPSTREAM_TLS ? 'https' : 'http'}://${UPSTREAM_HOST}:${UPSTREAM_PORT}`,
      `merge_fragment=${MERGE_CONFIG.enabled}` +
        (MERGE_CONFIG.enabled
          ? `(max_chars=${MERGE_CONFIG.maxChars},ratio=${MERGE_CONFIG.ratio},min_reasoning=${MERGE_CONFIG.minReasoning})`
          : ''),
    ]);
  });

  // 优雅退出：verify 脚本会 kill 我们
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 500).unref();
    });
  }
}

module.exports = {
  server,
  SseFixer,
  fixNonStreaming,
  extractContentPieces,
  extractReasoningText,
  piecesLength,
  hasToolCalls,
  shouldMergeFragment,
  MERGE_CONFIG,
};
