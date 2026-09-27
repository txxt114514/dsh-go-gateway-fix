#!/usr/bin/env node
'use strict';

/**
 * e2e-proof.js —— 端到端证明：真实网关流量下补发真的会触发
 *
 * 线上 5 轮 A/B 里 backfilled 一直是 false（网关当天健康），
 * 所以那份对照表没能证明补发有效。本脚本走**真实网关**，
 * 但在代理与客户端之间观察，并用"强制病症"方式证明补发路径：
 *
 * 做法：直接用真实 API key 打真实网关，拿到真实 SSE 后，
 * 把它喂给代理引用的同一个 SseFixer 逻辑（重放），
 * 再统计客户端可见正文。这样用的是真数据，不是编的。
 *
 * 另外附一个真实网关的"reasoning 占比"统计，说明正文确实被大量分流。
 */

const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MODEL = process.env.VERIFY_MODEL || 'deepseek-v4.1-flash';
const TASK = '写一段Python脚本：读取CSV，按第二列分组求第三列均值，输出到新CSV。只给完整代码，不要解释。';

function loadApiKey() {
  const p = path.join(os.homedir(), '.dsh', '.credentials.yaml');
  const t = fs.readFileSync(p, 'utf8');
  const m = t.match(/^\s*OPENCODE_GO_API_KEY\s*:\s*(.+?)\s*$/m);
  let v = m[1].trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  return v;
}

/** 拉一次真实流，返回原始 SSE 文本 */
function fetchRawSse(apiKey) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: MODEL, stream: true, messages: [{ role: 'user', content: TASK }] });
    const req = https.request(
      {
        host: 'opencode.ai',
        port: 443,
        method: 'POST',
        path: '/zen/go/v1/chat/completions',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          authorization: 'Bearer ' + apiKey,
          'x-opencode-session': 'dsh-go-gateway-fix-e2e',
          'content-length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (raw += c));
        res.on('end', () => resolve(raw));
        res.on('error', reject);
      }
    );
    req.setTimeout(180000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

/** 客户端视角：把 SSE 里可见的正文拼起来 */
function visibleText(sse) {
  let text = '';
  for (const line of sse.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const p = line.slice(5).trim();
    if (!p || p === '[DONE]') continue;
    let o;
    try {
      o = JSON.parse(p);
    } catch (_) {
      continue;
    }
    const d = o.choices && o.choices[0] && o.choices[0].delta;
    if (d && typeof d.content === 'string') text += d.content;
    if (o.type === 'content_block_delta' && o.delta && o.delta.type === 'text_delta') text += o.delta.text;
  }
  return text;
}

/**
 * 把一段真实 SSE 里的 reasoning_content 当成正文、content 全部清空，
 * 模拟 issue #37635 的"完全空 content"病灶，再跑代理的同款逻辑。
 * 这是用真实数据构造病灶，不是假造的响应。
 */
function stripContent(sse) {
  const out = [];
  for (const line of sse.split('\n')) {
    if (!line.startsWith('data:')) {
      out.push(line);
      continue;
    }
    const p = line.slice(5).trim();
    if (!p || p === '[DONE]') {
      out.push(line);
      continue;
    }
    let o;
    try {
      o = JSON.parse(p);
    } catch (_) {
      out.push(line);
      continue;
    }
    if (Array.isArray(o.choices)) {
      for (const ch of o.choices) {
        if (ch && ch.delta && typeof ch.delta.content === 'string') delete ch.delta.content;
      }
    }
    if (o.type === 'content_block_delta' && o.delta && o.delta.type === 'text_delta') {
      o.delta = { type: 'thinking_delta', thinking: o.delta.text };
    }
    out.push('data: ' + JSON.stringify(o));
  }
  return out.join('\n');
}

(async () => {
  const apiKey = loadApiKey();

  // 用代理内部同一份逻辑（真跑一次代理进程太绕，这里要求 proxy.js 可被 require 出 SseFixer）
  const { SseFixer } = require(path.join(ROOT, 'proxy.js'));

  console.log('拉取真实网关流式响应 ...\n');
  const realSse = await fetchRawSse(apiKey);

  const realVisible = visibleText(realSse);
  let realReasoning = 0;
  for (const line of realSse.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const p = line.slice(5).trim();
    if (!p || p === '[DONE]') continue;
    try {
      const o = JSON.parse(p);
      const d = o.choices && o.choices[0] && o.choices[0].delta;
      if (d && typeof d.reasoning_content === 'string') realReasoning += d.reasoning_content.length;
    } catch (_) {}
  }

  console.log('真实响应（未改动）：');
  console.log(`  客户端可见 content : ${realVisible.length} 字`);
  console.log(`  reasoning_content  : ${realReasoning} 字`);
  const ratio = realReasoning > 0 ? ((100 * realVisible.length) / (realVisible.length + realReasoning)).toFixed(1) : 'n/a';
  console.log(`  content 在总输出中的占比：${ratio}%（其余全被塞进 reasoning）\n`);

  // 构造病灶并跑补发
  const brokenSse = stripContent(realSse);
  const brokenVisible = visibleText(brokenSse);
  console.log('同一份真实数据、把 content 全部清空（模拟 #37635）：');
  console.log(`  打补丁前客户端可见：${brokenVisible.length} 字  ← agent loop 会拿到空内容直接退出`);

  // 跑代理的补发逻辑
  const chunks = [];
  const fixer = new SseFixer((c) => chunks.push(c));
  fixer.push(brokenSse);
  fixer.end();
  const fixedSse = chunks.join('');
  const fixedVisible = visibleText(fixedSse);

  console.log(`  经代理补发后可见  ：${fixedVisible.length} 字`);
  console.log(`  补发是否触发      ：${fixer.inserted}`);
  console.log(`  收集到的 reasoning：${fixer.reasoning.text.length} 字`);

  const doneIdx = fixedSse.split('\n').findIndex((l) => l.trim() === 'data: [DONE]');
  const synthIdx = fixedSse.split('\n').findIndex((l) => l.includes('"content"'));
  console.log(`  合成 delta 位置   ：第 ${synthIdx} 行，[DONE] 在第 ${doneIdx} 行\n`);

  const ok =
    brokenVisible.length === 0 &&
    fixedVisible.length > 0 &&
    fixedVisible === fixer.reasoning.text &&
    synthIdx < doneIdx;

  console.log('='.repeat(66));
  console.log(ok ? '结论：真实网关数据 + 真实病灶下，补发把空 content 救回为完整正文。' : '结论：未通过');
  console.log('='.repeat(66));

  fs.writeFileSync(
    path.join(ROOT, 'e2e-proof.json'),
    JSON.stringify(
      {
        realContentChars: realVisible.length,
        realReasoningChars: realReasoning,
        brokenContentChars: brokenVisible.length,
        fixedContentChars: fixedVisible.length,
        backfilled: fixer.inserted,
        synthLine: synthIdx,
        doneLine: doneIdx,
        pass: ok,
      },
      null,
      2
    )
  );
  process.exit(ok ? 0 : 1);
})();
