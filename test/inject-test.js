#!/usr/bin/env node
'use strict';

/**
 * inject-test.js —— 补发逻辑的确定性验证（本任务最关键的证据）
 *
 * 为什么需要它：线上 A/B 只是“观察”，bug 复现与否取决于网关当天状态。
 * 实测 2026-09-27 当天 A 组 5/5 都有 content，bug 未复现 —— 此时 B 组 5/5 非空
 * 并不能证明补发逻辑有效（一次都没触发）。
 *
 * 本脚本注入精确病灶：上游只发 reasoning_content、绝不发 content，
 * 然后检查经代理后客户端是否拿到完整正文、且合成 delta 位于 [DONE] 之前。
 * 覆盖 OpenAI 与 Anthropic 两种流式格式 + 非流式。
 */

const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FAKE_PORT = 18901;
const PROXY_PORT = 18900;

const BODY_TEXT = 'import pandas as pd\n\ndf = pd.read_csv("in.csv")\nprint(df.groupby(df.columns[1])[df.columns[2]].mean())\n';

/* ---------- 假上游：三种病灶 ---------- */
const fake = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    let body = {};
    try {
      body = JSON.parse(raw || '{}');
    } catch (_) {}
    const model = body.model || 'fake';
    // 用 header 选择模拟哪个上游
    const mode = req.headers['x-fake-mode'] || 'openai-stream';

    if (mode === 'openai-nonstream') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'c1',
          object: 'chat.completion',
          model,
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: { role: 'assistant', content: '', reasoning_content: BODY_TEXT },
            },
          ],
        })
      );
      return;
    }

    if (mode === 'anthropic-stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const ev = (t, o) => res.write(`event: ${t}\ndata: ${JSON.stringify(o)}\n\n`);
      ev('message_start', { type: 'message_start', message: { id: 'm1', model, content: [] } });
      ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } });
      // 只发 thinking_delta，正文全在 thinking 里
      for (const part of [BODY_TEXT.slice(0, 30), BODY_TEXT.slice(30)]) {
        ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: part } });
      }
      ev('content_block_stop', { type: 'content_block_stop', index: 0 });
      ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } });
      ev('message_stop', { type: 'message_stop' });
      res.end();
      return;
    }

    // 默认：OpenAI 流式，只有 reasoning_content
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
    send({ id: 'c2', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
    for (const part of [BODY_TEXT.slice(0, 25), BODY_TEXT.slice(25, 60), BODY_TEXT.slice(60)]) {
      send({ id: 'c2', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: { reasoning_content: part }, finish_reason: null }] });
    }
    send({ id: 'c2', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    res.write('data: [DONE]\n\n');
    res.end();
  });
});

function post(port, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/zen/go/v1/chat/completions',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(data),
          ...extraHeaders,
        },
      },
      (res) => {
        let out = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (out += c));
        res.on('end', () => resolve({ status: res.statusCode, body: out }));
      }
    );
    req.on('error', reject);
    req.end(data);
  });
}

/** 从 SSE 文本里拼出客户端最终可见的正文 */
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

(async () => {
  await new Promise((r) => fake.listen(FAKE_PORT, '127.0.0.1', r));
  const proxy = spawn(process.execPath, [path.join(ROOT, 'proxy.js')], {
    env: {
      ...process.env,
      PORT: String(PROXY_PORT),
      DSH_UPSTREAM_HOST: '127.0.0.1',
      DSH_UPSTREAM_PORT: String(FAKE_PORT),
      DSH_UPSTREAM_TLS: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proxy.stderr.on('data', (d) => process.stdout.write('[proxy:err] ' + d));
  await new Promise((r) => setTimeout(r, 700));

  let fail = 0;
  const check = (n, c, e) => {
    console.log((c ? '  PASS  ' : '  FAIL  ') + n + (e ? '  ' + e : ''));
    if (!c) fail++;
  };

  console.log('注入病灶：上游只发 reasoning_content / thinking_delta，绝不发 content\n');

  // 1) OpenAI 流式
  console.log('[1] OpenAI 流式（只有 reasoning_content）');
  const r1 = await post(PROXY_PORT, { model: 'fake', stream: true }, { 'x-fake-mode': 'openai-stream' });
  const t1 = visibleText(r1.body);
  const doneIdx = r1.body.split('\n').findIndex((l) => l.trim() === 'data: [DONE]');
  let synthIdx = -1;
  r1.body.split('\n').forEach((l, i) => {
    if (l.includes('"content"')) synthIdx = i;
  });
  check('客户端拿到完整正文', t1 === BODY_TEXT, `got=${t1.length}chars want=${BODY_TEXT.length}chars`);
  check('内容与 reasoning 逐字一致', t1 === BODY_TEXT);
  check('合成 delta 在 [DONE] 之前', synthIdx !== -1 && synthIdx < doneIdx, `synth@${synthIdx} done@${doneIdx}`);

  // 2) Anthropic 流式
  console.log('\n[2] Anthropic 流式（只有 thinking_delta）');
  const r2 = await post(PROXY_PORT, { model: 'fake', stream: true }, { 'x-fake-mode': 'anthropic-stream' });
  const t2 = visibleText(r2.body);
  check('客户端拿到完整正文', t2 === BODY_TEXT, `got=${t2.length}chars want=${BODY_TEXT.length}chars`);
  check('text_delta 出现在 message_stop 之前',
    r2.body.indexOf('"text_delta"') !== -1 &&
      r2.body.indexOf('"text_delta"') < r2.body.indexOf('message_stop'));

  // 3) 非流式
  console.log('\n[3] 非流式（content 空，reasoning 有货）');
  const r3 = await post(PROXY_PORT, { model: 'fake', stream: false }, { 'x-fake-mode': 'openai-nonstream' });
  const j3 = JSON.parse(r3.body);
  check('content 被回填', j3.choices[0].message.content === BODY_TEXT);
  check('原始 reasoning_content 保留', j3.choices[0].message.reasoning_content === BODY_TEXT);

  // 4) 有 content 时不重复补发
  console.log('\n[4] 上游本来就正常（不应补发）');
  fake.removeAllListeners('request');
  fake.on('request', (req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ id: 'ok', model: 'fake', choices: [{ index: 0, delta: { content: '正常正文' }, finish_reason: null }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ id: 'ok', model: 'fake', choices: [{ index: 0, delta: { reasoning_content: '一些推理' }, finish_reason: null }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ id: 'ok', model: 'fake', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  const r4 = await post(PROXY_PORT, { model: 'fake', stream: true });
  const t4 = visibleText(r4.body);
  check('正文恰为上游原文，未被追加', t4 === '正常正文', `got=${JSON.stringify(t4)}`);

  proxy.kill('SIGTERM');
  fake.close();
  await new Promise((r) => setTimeout(r, 400));
  console.log('\n注入测试结果：' + (fail === 0 ? '全部通过' : fail + ' 项失败'));
  process.exit(fail === 0 ? 0 : 1);
})();
