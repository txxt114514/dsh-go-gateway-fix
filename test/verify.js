#!/usr/bin/env node
'use strict';

/**
 * verify.js —— A/B 对照验证
 *
 * A 组：直连 https://opencode.ai/zen/go/v1/chat/completions
 * B 组：经本地代理 http://127.0.0.1:8899/zen/go/v1/chat/completions
 *
 * 同一个编码任务各跑 5 次，都用流式，统计每次真正拿到的 content 字符数。
 * 脚本自己 spawn 代理、跑完自己关掉。
 */

const { spawn } = require('child_process');
const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PROXY_JS = path.join(ROOT, 'proxy.js');
const PORT = Number(process.env.PORT || 8899);
const DIRECT_HOST = 'opencode.ai';
const TASK =
  '写一段Python脚本：读取CSV，按第二列分组求第三列均值，输出到新CSV。只给完整代码，不要解释。';
const RUNS = 5;
const MODEL = process.env.VERIFY_MODEL || 'deepseek-v4.1-flash';

/* --------------------------------------------------------- 凭据读取 */

function loadApiKey() {
  if (process.env.OPENCODE_GO_API_KEY) return process.env.OPENCODE_GO_API_KEY;
  const p = path.join(os.homedir(), '.dsh', '.credentials.yaml');
  const text = fs.readFileSync(p, 'utf8');
  // 只找 refs: 段落里的 OPENCODE_GO_API_KEY，容忍引号与行尾注释
  const m = text.match(/^\s*OPENCODE_GO_API_KEY\s*:\s*(.+?)\s*$/m);
  if (!m) throw new Error('凭据文件里没有 OPENCODE_GO_API_KEY: ' + p);
  let v = m[1].trim();
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    v = v.slice(1, -1);
  }
  return v;
}

/* --------------------------------------------------------- HTTP 请求 */

/** 发一次流式请求，边收边解析 SSE，返回统计结果 */
function streamRequest({ host, port, useTls, apiKey, label }) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: MODEL,
      stream: true,
      messages: [{ role: 'user', content: TASK }],
    });

    const headers = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      authorization: 'Bearer ' + apiKey,
      'x-opencode-session': 'dsh-go-gateway-fix-verify',
      'content-length': Buffer.byteLength(body),
    };

    const mod = useTls ? https : http;
    const req = mod.request(
      {
        host,
        port: port || (useTls ? 443 : 80),
        method: 'POST',
        path: '/zen/go/v1/chat/completions',
        headers,
      },
      (res) => {
        const status = res.statusCode;
        const ctype = String(res.headers['content-type'] || '');
        let buf = '';
        const stats = {
          label,
          status,
          ctype,
          contentChars: 0,
          reasoningChars: 0,
          contentEvents: 0,
          reasoningEvents: 0,
          finishReasons: [],
          sseEvents: 0,
          error: null,
        };

        // 非 SSE（多半是报错 JSON），整体收下来
        if (!ctype.includes('text/event-stream')) {
          res.setEncoding('utf8');
          let raw = '';
          res.on('data', (c) => (raw += c));
          res.on('end', () => {
            stats.error = `HTTP ${status}: ${raw.slice(0, 300)}`;
            resolve(stats);
          });
          return;
        }

        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          buf += chunk;
          let idx;
          while ((idx = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, idx).replace(/\r$/, '');
            buf = buf.slice(idx + 1);
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            let obj;
            try {
              obj = JSON.parse(payload);
            } catch (_) {
              continue;
            }
            stats.sseEvents += 1;

            // OpenAI 风格
            if (Array.isArray(obj.choices)) {
              for (const ch of obj.choices) {
                const d = (ch && ch.delta) || {};
                if (typeof d.content === 'string' && d.content.trim()) {
                  stats.contentChars += d.content.length;
                  stats.contentEvents += 1;
                }
                const r = typeof d.reasoning_content === 'string' ? d.reasoning_content : '';
                if (r) {
                  stats.reasoningChars += r.length;
                  stats.reasoningEvents += 1;
                }
                if (ch && ch.finish_reason) stats.finishReasons.push(ch.finish_reason);
              }
            }

            // Anthropic 风格
            if (obj.type === 'content_block_delta' && obj.delta) {
              if (obj.delta.type === 'text_delta' && typeof obj.delta.text === 'string') {
                stats.contentChars += obj.delta.text.length;
                stats.contentEvents += 1;
              }
              if (obj.delta.type === 'thinking_delta' && typeof obj.delta.thinking === 'string') {
                stats.reasoningChars += obj.delta.thinking.length;
                stats.reasoningEvents += 1;
              }
            }
          }
        });
        res.on('end', () => resolve(stats));
        res.on('error', (e) => {
          stats.error = e.message;
          resolve(stats);
        });
      }
    );

    req.setTimeout(180000, () => {
      req.destroy(new Error('timeout 180s'));
    });
    req.on('error', (e) => {
      resolve({
        label,
        status: 0,
        contentChars: 0,
        reasoningChars: 0,
        contentEvents: 0,
        reasoningEvents: 0,
        finishReasons: [],
        sseEvents: 0,
        error: e.message,
      });
    });
    req.end(body);
  });
}

/* --------------------------------------------------------- 代理生命周期 */

function startProxy() {
  const child = spawn(process.execPath, [PROXY_JS], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write('[proxy] ' + d));
  child.stderr.on('data', (d) => process.stderr.write('[proxy:err] ' + d));
  return child;
}

/** 等代理端口可用 */
function waitForProxy(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.request(
        { host: '127.0.0.1', port: PORT, method: 'POST', path: '/__ping' },
        (res) => {
          res.resume();
          resolve();
        }
      );
      req.on('error', () => {
        if (Date.now() > deadline) reject(new Error('代理未在超时内就绪'));
        else setTimeout(tick, 200);
      });
      // 代理只转发 POST，这里的 405/400 都算“活着”
      req.end('{}');
    };
    tick();
  });
}

function stopProxy(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.on('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch (_) {}
      resolve();
    }, 3000);
  });
}

/* --------------------------------------------------------- 主流程 */

function pad(s, n) {
  s = String(s);
  // 中文字符按 2 列算，保证表格对齐
  let w = 0;
  for (const ch of s) w += /[\u4e00-\u9fff]/.test(ch) ? 2 : 1;
  return s + ' '.repeat(Math.max(0, n - w));
}

(async () => {
  let apiKey;
  try {
    apiKey = loadApiKey();
  } catch (e) {
    console.error('读取凭据失败：' + e.message);
    process.exit(2);
  }
  console.log('凭据已读取（OPENCODE_GO_API_KEY，长度 ' + apiKey.length + '）');
  console.log('模型：' + MODEL + '   任务：' + TASK);
  console.log('每组跑 ' + RUNS + ' 次，全部流式。\n');

  const proxy = startProxy();
  try {
    await waitForProxy();
  } catch (e) {
    console.error(String(e.message));
    await stopProxy(proxy);
    process.exit(3);
  }
  console.log('代理已就绪：http://127.0.0.1:' + PORT + '\n');

  const A = [];
  const B = [];

  for (let i = 1; i <= RUNS; i++) {
    process.stdout.write(`A 组 直连    第 ${i}/${RUNS} 次 ... `);
    const a = await streamRequest({
      host: DIRECT_HOST,
      port: 443,
      useTls: true,
      apiKey,
      label: `A${i}`,
    });
    A.push(a);
    console.log(
      `content=${a.contentChars} reasoning=${a.reasoningChars}` +
        (a.error ? '  错误=' + a.error.slice(0, 80) : '')
    );
  }

  for (let i = 1; i <= RUNS; i++) {
    process.stdout.write(`B 组 经代理  第 ${i}/${RUNS} 次 ... `);
    const b = await streamRequest({
      host: '127.0.0.1',
      port: PORT,
      useTls: false,
      apiKey,
      label: `B${i}`,
    });
    B.push(b);
    console.log(
      `content=${b.contentChars} reasoning=${b.reasoningChars}` +
        (b.error ? '  错误=' + b.error.slice(0, 80) : '')
    );
  }

  await stopProxy(proxy);
  console.log('\n代理已关闭（端口 ' + PORT + ' 已释放）\n');

  /* ---------- 报告 ---------- */
  console.log('='.repeat(78));
  console.log('A/B 对照表（同一编码任务，流式，各 ' + RUNS + ' 次）');
  console.log('='.repeat(78));
  console.log(
    pad('轮次', 8) +
      pad('A 直连 content', 20) +
      pad('A reasoning', 16) +
      pad('B 经代理 content', 22) +
      pad('B reasoning', 14)
  );
  console.log('-'.repeat(78));
  for (let i = 0; i < RUNS; i++) {
    console.log(
      pad(i + 1, 8) +
        pad(A[i].contentChars, 20) +
        pad(A[i].reasoningChars, 16) +
        pad(B[i].contentChars, 22) +
        pad(B[i].reasoningChars, 14)
    );
  }
  console.log('-'.repeat(78));

  const aEmpty = A.filter((r) => r.contentChars === 0).length;
  const aTiny = A.filter((r) => r.contentChars > 0 && r.contentChars < 100).length;
  const aOk = A.filter((r) => r.contentChars >= 100).length;
  const bNonEmpty = B.filter((r) => r.contentChars > 0).length;
  const bOk = B.filter((r) => r.contentChars >= 100).length;

  const aLens = A.map((r) => r.contentChars).join(' / ');
  const bLens = B.map((r) => r.contentChars).join(' / ');

  console.log('\nA 组（直连）content 字符数：' + aLens);
  console.log('  → 空响应 ' + aEmpty + '/' + RUNS + '，碎片(1~99字) ' + aTiny + '/' + RUNS +
    '，完整(≥100字) ' + aOk + '/' + RUNS);
  console.log('B 组（经代理）content 字符数：' + bLens);
  console.log('  → 非空 ' + bNonEmpty + '/' + RUNS + '，完整(≥100字) ' + bOk + '/' + RUNS);

  const pass = bNonEmpty === RUNS;
  console.log('\n结论：B 组 content ' + bNonEmpty + '/' + RUNS + ' 非空；' +
    'A 组空响应 ' + aEmpty + '/' + RUNS + '，碎片 ' + aTiny + '/' + RUNS + '。');
  console.log(pass ? '判定：通过（B 组 ' + RUNS + '/' + RUNS + ' 都拿到非空 content）'
    : '判定：未通过');

  const errs = [...A, ...B].filter((r) => r.error);
  if (errs.length) {
    console.log('\n出现错误的请求：');
    for (const e of errs) console.log('  ' + e.label + ' : ' + e.error);
  }

  console.log('\n代理日志尾部：');
  try {
    const lines = fs.readFileSync(path.join(ROOT, 'proxy.log'), 'utf8').trim().split('\n');
    for (const l of lines.slice(-6)) console.log('  ' + l);
  } catch (_) {}

  // 结果同时落盘，便于贴报告
  fs.writeFileSync(
    path.join(ROOT, 'verify-result.json'),
    JSON.stringify({ task: TASK, model: MODEL, runs: RUNS, A, B, pass }, null, 2)
  );
  console.log('\n明细已写入 ' + path.join(ROOT, 'verify-result.json'));

  process.exit(pass ? 0 : 1);
})();
