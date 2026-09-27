#!/usr/bin/env node
'use strict';

/**
 * selftest.js —— 不联网的逻辑自测
 *
 * 起一个假上游，模拟 Go 网关两种病灶（流式 / 非流式都把内容塞进 reasoning_content），
 * 再起真代理指向它，检查补发是否发生、位置是否正确。
 * 用 DSH_UPSTREAM 环境变量把代理指到本地假上游。
 */

const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FAKE_PORT = 18899;
const PROXY_PORT = 18898;

/* ---------- 假上游 ---------- */
const fake = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = JSON.parse(raw || '{}');
    const model = body.model || 'fake';

    // 非流式：content 空，reasoning 有货
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'x',
          object: 'chat.completion',
          model,
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: { role: 'assistant', content: '', reasoning_content: '这是被塞进 reasoning 的正文' },
            },
          ],
        })
      );
      return;
    }

    // 流式：只有 reasoning_content，没有任何 content
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
    send({ id: 'x', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
    send({ id: 'x', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { reasoning_content: '第一段推理' }, finish_reason: null }] });
    send({ id: 'x', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { reasoning_content: '第二段推理' }, finish_reason: null }] });
    send({ id: 'x', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    res.write('data: [DONE]\n\n');
    res.end();
  });
});

/* ---------- 请求工具 ---------- */
function post(port, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/zen/go/v1/chat/completions',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
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
  proxy.stdout.on('data', (d) => process.stdout.write('[proxy] ' + d));
  proxy.stderr.on('data', (d) => process.stdout.write('[proxy:err] ' + d));

  await new Promise((r) => setTimeout(r, 700));

  let failures = 0;
  const check = (name, cond, extra) => {
    console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (extra ? '  ' + extra : ''));
    if (!cond) failures++;
  };

  // 1) 非流式补发
  const n = await post(PROXY_PORT, { model: 'fake', stream: false, messages: [] });
  const nj = JSON.parse(n.body);
  console.log('\n[非流式]');
  check('HTTP 200 透传', n.status === 200, 'status=' + n.status);
  check(
    'content 已回填 reasoning',
    nj.choices[0].message.content === '这是被塞进 reasoning 的正文',
    'content=' + JSON.stringify(nj.choices[0].message.content)
  );

  // 2) 流式补发，且必须在 [DONE] 之前
  const s = await post(PROXY_PORT, { model: 'fake', stream: true, messages: [] });
  console.log('\n[流式]');
  const lines = s.body.split('\n').filter((l) => l.startsWith('data:'));
  const doneIdx = lines.findIndex((l) => l.trim() === 'data: [DONE]');
  let synthIdx = -1;
  let synthText = '';
  lines.forEach((l, i) => {
    const p = l.slice(5).trim();
    if (p === '[DONE]') return;
    let o;
    try {
      o = JSON.parse(p);
    } catch (_) {
      return;
    }
    const c = o.choices && o.choices[0] && o.choices[0].delta && o.choices[0].delta.content;
    if (typeof c === 'string' && c.trim()) {
      synthIdx = i;
      synthText = c;
    }
  });
  check('存在 [DONE]', doneIdx !== -1);
  check('补发了 content delta', synthIdx !== -1);
  check('合成的 content 在 [DONE] 之前', synthIdx !== -1 && doneIdx !== -1 && synthIdx < doneIdx,
    `synth@${synthIdx} done@${doneIdx}`);
  check(
    'reasoning 被完整拼接',
    synthText === '第一段推理第二段推理',
    'text=' + JSON.stringify(synthText)
  );

  // 3) 已有 content 的流不做任何改动
  //    （用第二个假上游行为：这次直接发 content）
  fake.removeAllListeners('request');
  fake.on('request', (req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ id: 'y', object: 'chat.completion.chunk', model: 'fake', choices: [{ index: 0, delta: { content: '正常正文' }, finish_reason: null }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ id: 'y', object: 'chat.completion.chunk', model: 'fake', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  const s2 = await post(PROXY_PORT, { model: 'fake', stream: true, messages: [] });
  const contentChunks = s2.body.split('\n').filter((l) => l.includes('"content"'));
  console.log('\n[已有 content 的流]');
  check('content 只出现一次（未重复补发）', contentChunks.length === 1, 'count=' + contentChunks.length);
  check('原始正文未被改动', s2.body.includes('正常正文'));

  // 4) 坏 JSON 不影响透传
  fake.removeAllListeners('request');
  fake.on('request', (req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"error":"upstream boom"}');
    });
  });
  const e = await post(PROXY_PORT, { model: 'fake', stream: false, messages: [] });
  console.log('\n[上游错误]');
  check('透传 500', e.status === 500, 'status=' + e.status);
  check('错误体未被吞', e.body.includes('upstream boom'));

  proxy.kill('SIGTERM');
  fake.close();
  await new Promise((r) => setTimeout(r, 400));
  console.log('\n自测结果：' + (failures === 0 ? '全部通过' : failures + ' 项失败'));
  process.exit(failures === 0 ? 0 : 1);
})();
