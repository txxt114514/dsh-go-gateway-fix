#!/usr/bin/env node
'use strict';

/**
 * hunt.js —— 复现猎手
 *
 * 背景：2026-09-27 当天 A 组 5 次全部有 content，bug 未复现，
 * 于是“B 组 5/5 非空”这个结论是空的（补发一次都没触发）。
 *
 * 本脚本用更多样的任务、更高并发放大复现概率。
 * 只做只读验证：直连网关若干次，统计 content 空/碎片出现率。
 * 找到空 content 的请求时，立即用同一任务经代理重跑一次，看能否救回来。
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PROXY_PORT = 8899;
const MODEL = process.env.VERIFY_MODEL || 'deepseek-v4.1-flash';

const TASKS = [
  '写一段Python脚本：读取CSV，按第二列分组求第三列均值，输出到新CSV。只给完整代码，不要解释。',
  '写一个bash脚本：找出当前目录下所有大于100MB的文件并按大小排序。只给代码。',
  '用JavaScript写一个防抖函数，带取消功能。只给代码。',
  '写一段SQL：统计每个用户最近7天的订单总额。只给SQL。',
  '用Python写快速排序，要求原地排序。只给代码。',
  '写一个正则，匹配中国大陆手机号。只给正则和一行示例。',
];

function loadApiKey() {
  if (process.env.OPENCODE_GO_API_KEY) return process.env.OPENCODE_GO_API_KEY;
  const p = path.join(os.homedir(), '.dsh', '.credentials.yaml');
  const t = fs.readFileSync(p, 'utf8');
  const m = t.match(/^\s*OPENCODE_GO_API_KEY\s*:\s*(.+?)\s*$/m);
  if (!m) throw new Error('凭据里没有 OPENCODE_GO_API_KEY');
  let v = m[1].trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  return v;
}

function run({ target, apiKey, prompt }) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ model: MODEL, stream: true, messages: [{ role: 'user', content: prompt }] });
    const useTls = target === 'direct';
    const mod = useTls ? https : http;
    const req = mod.request(
      {
        host: useTls ? 'opencode.ai' : '127.0.0.1',
        port: useTls ? 443 : PROXY_PORT,
        method: 'POST',
        path: '/zen/go/v1/chat/completions',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          authorization: 'Bearer ' + apiKey,
          'x-opencode-session': 'dsh-go-gateway-fix-hunt',
          'content-length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let buf = '';
        const st = { target, prompt: prompt.slice(0, 14), status: res.statusCode, content: 0, reasoning: 0, contentEvents: 0, error: null };
        const ctype = String(res.headers['content-type'] || '');
        if (!ctype.includes('text/event-stream')) {
          let raw = '';
          res.setEncoding('utf8');
          res.on('data', (c) => (raw += c));
          res.on('end', () => {
            st.error = 'HTTP ' + res.statusCode + ': ' + raw.slice(0, 200);
            resolve(st);
          });
          return;
        }
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          buf += chunk;
          let i;
          while ((i = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, i).replace(/\r$/, '');
            buf = buf.slice(i + 1);
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
            if (d && typeof d.content === 'string' && d.content.trim()) {
              st.content += d.content.length;
              st.contentEvents += 1;
            }
            if (d && typeof d.reasoning_content === 'string') st.reasoning += d.reasoning_content.length;
            if (o.type === 'content_block_delta' && o.delta) {
              if (o.delta.type === 'text_delta') {
                st.content += (o.delta.text || '').length;
                st.contentEvents += 1;
              }
              if (o.delta.type === 'thinking_delta') st.reasoning += (o.delta.thinking || '').length;
            }
          }
        });
        res.on('end', () => resolve(st));
        res.on('error', (e) => {
          st.error = e.message;
          resolve(st);
        });
      }
    );
    req.setTimeout(180000, () => req.destroy(new Error('timeout')));
    req.on('error', (e) => {
      resolve({ target, prompt: prompt.slice(0, 14), status: 0, content: 0, reasoning: 0, contentEvents: 0, error: e.message });
    });
    req.end(body);
  });
}

(async () => {
  const apiKey = loadApiKey();
  const ROUNDS = Number(process.env.HUNT_ROUNDS || 3);

  const proxy = spawn(process.execPath, [path.join(ROOT, 'proxy.js')], {
    env: { ...process.env, PORT: String(PROXY_PORT) },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  await new Promise((r) => setTimeout(r, 1200));

  console.log(`直连探测：${TASKS.length} 个任务 × ${ROUNDS} 轮 = ${TASKS.length * ROUNDS} 次\n`);

  const bad = [];
  const all = [];

  for (let round = 1; round <= ROUNDS; round++) {
    // 并发发一轮，放大概率
    const jobs = TASKS.map((p) => run({ target: 'direct', apiKey, prompt: p }));
    const results = await Promise.all(jobs);
    for (const r of results) {
      all.push(r);
      const flag = r.error ? 'ERR' : r.content === 0 ? '空!' : r.content < 100 ? '碎片' : 'ok';
      console.log(
        `  轮${round} [${r.target}] ${flag.padEnd(4)} content=${String(r.content).padStart(5)} reasoning=${String(r.reasoning).padStart(6)}  ${r.prompt}${r.error ? '  ' + r.error.slice(0, 60) : ''}`
      );
      if (!r.error && r.content < 100) bad.push(r);
    }
  }

  console.log('\n' + '='.repeat(70));
  const empt = all.filter((r) => !r.error && r.content === 0).length;
  const tiny = all.filter((r) => !r.error && r.content > 0 && r.content < 100).length;
  const ok = all.filter((r) => !r.error && r.content >= 100).length;
  const err = all.filter((r) => r.error).length;
  console.log(`直连 ${all.length} 次：空 ${empt}，碎片 ${tiny}，完整 ${ok}，错误 ${err}`);

  if (bad.length === 0) {
    console.log('\n本轮未复现空/碎片内容 —— 网关今天健康，无法用线上数据证明补发。');
    console.log('补发逻辑的有效性证据见 test/inject-test.js（注入病灶，确定性验证）。');
  } else {
    console.log(`\n复现 ${bad.length} 次空/碎片！对这些任务经代理重跑：`);
    let saved = 0;
    for (const b of bad) {
      const full = TASKS.find((t) => t.startsWith(b.prompt)) || TASKS[0];
      const via = await run({ target: 'proxy', apiKey, prompt: full });
      const rescued = via.content >= 100;
      if (rescued) saved++;
      console.log(`  ${b.prompt}  直连content=${b.content} → 经代理content=${via.content}  ${rescued ? '救回' : '未救回'}`);
    }
    console.log(`\n救回 ${saved}/${bad.length}`);
  }
  console.log('='.repeat(70));

  proxy.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 600));
  fs.writeFileSync(path.join(ROOT, 'hunt-result.json'), JSON.stringify({ all, bad }, null, 2));
  process.exit(0);
})();
