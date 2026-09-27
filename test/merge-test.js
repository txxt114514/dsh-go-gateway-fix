#!/usr/bin/env node
'use strict';

/**
 * merge-test.js —— 「碎片合并」开关的确定性验证
 *
 * 背景：补发（backfill）只修「content 完全为空」；实测还有第二种病灶：
 * content 出现过，但只有 11~25 个 delta、正文很短，而 reasoning_content 上千字。
 * 本测试用假上游精确造出这种响应，验证：
 *   A. 开关关（默认）时：行为与历史版本一致，绝不合并
 *   B. 开关开（DSH_MERGE_FRAGMENT=1）时：合并，且最终正文 = 短正文 + '\n' + reasoning 全文
 *   C. 三个「不该合并」的反例，开关开时也必须原样放行
 *   D. 阈值可被环境变量覆盖
 *
 * 三个代理实例同时跑，全部指向同一个假上游，靠 x-fake-mode 头选场景：
 *   18910 —— 开关关（默认配置）
 *   18911 —— 开关开（默认阈值）
 *   18912 —— 开关开 + 自定义阈值（MAX_CHARS=200, RATIO=2）
 */

const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FAKE_PORT = 18909;
const PORT_OFF = 18910;
const PORT_ON = 18911;
const PORT_CUSTOM = 18912;

/* ------------------------------------------------------------ 测试语料 */

// 碎片正文：模拟网关只漏出来的那一小截
const SHORT = 'print("hello")';
// 思维链：上千字，模拟正文被塞进 reasoning 的那部分
const REASON = ('这是一段被网关错误分流进 reasoning_content 的正文内容。'.repeat(40)).slice(0, 960);
// 正常长正文：不该被合并
const LONG = ('def main():\n    print("正常长回答，不需要任何补丁")\n'.repeat(12)).slice(0, 480);
// 自定义阈值场景用的中长正文：默认阈值下不算碎片，自定义阈值下算
const MID = 'x'.repeat(120);

/* ------------------------------------------------------- 假上游（按场景） */

/** 把一段文本切成 n 片，模拟真实的逐 token 流 */
function slice(text, n) {
  const out = [];
  const step = Math.max(1, Math.ceil(text.length / n));
  for (let i = 0; i < text.length; i += step) out.push(text.slice(i, i + step));
  return out;
}

const fake = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const mode = req.headers['x-fake-mode'] || 'frag-openai';

    /* ---- OpenAI 流式 ---- */
    const openaiStream = (contentPieces, reasoningPieces, extraDelta, finish) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (delta, fr) =>
        res.write(
          'data: ' +
            JSON.stringify({
              id: 'cmpl-merge-test',
              object: 'chat.completion.chunk',
              created: 1700000000,
              model: 'fake',
              choices: [{ index: 0, delta, finish_reason: fr || null }],
            }) +
            '\n\n'
        );
      send({ role: 'assistant' });
      for (const p of contentPieces) send({ content: p });
      for (const p of reasoningPieces) send({ reasoning_content: p });
      if (extraDelta) send(extraDelta);
      send({}, finish || 'stop');
      res.write('data: [DONE]\n\n');
      res.end();
    };

    /* ---- Anthropic 流式 ---- */
    const anthropicStream = (contentPieces, reasoningPieces, withToolUse) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const ev = (t, o) => res.write(`event: ${t}\ndata: ${JSON.stringify(o)}\n\n`);
      ev('message_start', { type: 'message_start', message: { id: 'm1', model: 'fake', content: [] } });
      if (contentPieces.length) {
        ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
        for (const p of contentPieces) {
          ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: p } });
        }
        ev('content_block_stop', { type: 'content_block_stop', index: 0 });
      }
      if (reasoningPieces.length) {
        ev('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'thinking', thinking: '' } });
        for (const p of reasoningPieces) {
          ev('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', thinking: p } });
        }
        ev('content_block_stop', { type: 'content_block_stop', index: 1 });
      }
      if (withToolUse) {
        ev('content_block_start', { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: {} } });
        ev('content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path":"a.txt"}' } });
        ev('content_block_stop', { type: 'content_block_stop', index: 2 });
      }
      ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } });
      ev('message_stop', { type: 'message_stop' });
      res.end();
    };

    /* ---- 非流式 ---- */
    const nonStream = (content, reasoning, withTools) => {
      const message = { role: 'assistant', content, reasoning_content: reasoning };
      if (withTools) {
        message.tool_calls = [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }];
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'cmpl-merge-test',
          object: 'chat.completion',
          created: 1700000000,
          model: 'fake',
          choices: [{ index: 0, finish_reason: 'stop', message }],
        })
      );
    };

    switch (mode) {
      // 主场景：短 content + 大量 reasoning
      case 'frag-openai':
        return openaiStream(slice(SHORT, 3), slice(REASON, 6));
      case 'frag-anthropic':
        return anthropicStream(slice(SHORT, 3), slice(REASON, 6), false);
      case 'frag-nonstream':
        return nonStream(SHORT, REASON, false);

      // 反例 1：合法短回答，reasoning 为空
      case 'ref-legal-short':
        return openaiStream(['通'], [], null, 'stop');
      // 反例 1b：合法短回答，reasoning 很短（不到 200 字下限）
      case 'ref-legal-short-reasoning':
        return openaiStream(['通'], ['嗯，用户只让我回一个字。'], null, 'stop');
      // 反例 2：含工具调用的响应（OpenAI 流式）
      case 'ref-tool-calls':
        return openaiStream(
          slice(SHORT, 3),
          slice(REASON, 6),
          { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] },
          'tool_calls'
        );
      // 反例 2b：含工具调用的响应（Anthropic tool_use 块）
      case 'ref-tool-calls-anthropic':
        return anthropicStream(slice(SHORT, 3), slice(REASON, 6), true);
      // 反例 2c：含工具调用的非流式响应
      case 'ref-tool-calls-nonstream':
        return nonStream(SHORT, REASON, true);
      // 反例 3：正常长正文 + 长 reasoning
      case 'ref-normal-long':
        return openaiStream(slice(LONG, 10), slice(REASON, 6));

      // 阈值覆盖场景：正文 120 字，默认阈值（40）下不算碎片
      case 'mid-content':
        return openaiStream(slice(MID, 5), slice('y'.repeat(500), 5));

      default:
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end('unknown mode');
    }
  });
});

/* --------------------------------------------------------------- 工具 */

function post(port, mode) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ model: 'fake', stream: mode !== 'frag-nonstream', messages: [{ role: 'user', content: 'hi' }] });
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/zen/go/v1/chat/completions',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), 'x-fake-mode': mode },
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

function startProxy(port, env) {
  const child = spawn(process.execPath, [path.join(ROOT, 'proxy.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DSH_UPSTREAM_HOST: '127.0.0.1',
      DSH_UPSTREAM_PORT: String(FAKE_PORT),
      DSH_UPSTREAM_TLS: '0',
      DSH_NO_FILE_LOG: '1',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.out = '';
  child.stdout.on('data', (d) => (child.out += d));
  child.stderr.on('data', (d) => process.stderr.write(`[proxy:${port}] ` + d));
  return child;
}

/** 取该代理最后一条 stream/non-stream 日志行，便于核对 backfilled / merged 字段 */
function lastLogLine(child) {
  const lines = child.out.trim().split('\n').filter((l) => l.includes(' | /zen/go/'));
  return lines.length ? lines[lines.length - 1] : '(无请求日志)';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* --------------------------------------------------------------- 主流程 */

(async () => {
  await new Promise((r) => fake.listen(FAKE_PORT, '127.0.0.1', r));

  const off = startProxy(PORT_OFF, {});
  const on = startProxy(PORT_ON, { DSH_MERGE_FRAGMENT: '1' });
  const custom = startProxy(PORT_CUSTOM, {
    DSH_MERGE_FRAGMENT: '1',
    DSH_FRAGMENT_MAX_CHARS: '200',
    DSH_FRAGMENT_RATIO: '2',
  });
  await sleep(800);

  let fail = 0;
  const check = (name, cond, extra) => {
    console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (extra ? '  ' + extra : ''));
    if (!cond) fail++;
  };
  const row = (name, offV, onV, wantOff, wantOn, detail) => {
    const ok = offV === wantOff && onV === wantOn;
    if (!ok) fail++;
    console.log(
      (ok ? '  PASS  ' : '  FAIL  ') +
        name.padEnd(34) +
        ` 开关关=${String(offV).padEnd(5)} 开关开=${String(onV).padEnd(5)}` +
        ` (期望 ${wantOff}/${wantOn})` +
        (detail ? '  ' + detail : '')
    );
  };

  console.log('语料：SHORT=' + SHORT.length + '字  REASON=' + REASON.length + '字  LONG=' + LONG.length + '字  MID=' + MID.length + '字\n');

  /* ============ 1. 碎片合并注入测试（三种响应形态） ============ */
  console.log('[1] 碎片合并注入测试：短 content + 大量 reasoning');
  console.log('    开关关 → 必须原样放行（正文 = 短正文）；开关开 → 正文 = 短正文 + \\n + reasoning 全文\n');

  const wantMerged = SHORT + '\n' + REASON;

  // 1a OpenAI 流式
  const aOff = await post(PORT_OFF, 'frag-openai');
  const aOn = await post(PORT_ON, 'frag-openai');
  const aOffText = visibleText(aOff.body);
  const aOnText = visibleText(aOn.body);
  row('OpenAI 流式 正文长度', aOffText.length, aOnText.length, SHORT.length, wantMerged.length);
  check('  └ 开关关：正文与上游短正文逐字一致', aOffText === SHORT, `got=${JSON.stringify(aOffText)}`);
  check('  └ 开关开：正文 = 短正文 + 换行 + reasoning 全文', aOnText === wantMerged);
  check(
    '  └ 开关开：长度 = SHORT+1+REASON',
    aOnText.length === SHORT.length + 1 + REASON.length,
    `${aOnText.length} = ${SHORT.length}+1+${REASON.length}`
  );
  check('  └ 开关开：原有短正文仍在开头（未被覆盖）', aOnText.startsWith(SHORT));
  check('  └ 开关开：reasoning 全文都在（逐字）', aOnText.slice(SHORT.length + 1) === REASON);
  const doneIdx = aOn.body.split('\n').findIndex((l) => l.trim() === 'data: [DONE]');
  let synthIdx = -1;
  aOn.body.split('\n').forEach((l, i) => {
    if (l.includes('"' + REASON.slice(0, 12)) || (l.includes('"content"') && l.includes('reasoning'))) synthIdx = i;
  });
  if (synthIdx === -1) synthIdx = aOn.body.split('\n').findIndex((l) => l.includes(SHORT) && l.includes(REASON.slice(0, 8)));
  check('  └ 合成 delta 在 [DONE] 之前', synthIdx !== -1 && synthIdx < doneIdx, `synth@${synthIdx} done@${doneIdx}`);

  // 1b Anthropic 流式
  const bOff = await post(PORT_OFF, 'frag-anthropic');
  const bOn = await post(PORT_ON, 'frag-anthropic');
  const bOffText = visibleText(bOff.body);
  const bOnText = visibleText(bOn.body);
  row('Anthropic 流式 正文长度', bOffText.length, bOnText.length, SHORT.length, wantMerged.length);
  check('  └ 开关关：正文与上游短正文逐字一致', bOffText === SHORT);
  check('  └ 开关开：正文 = 短正文 + 换行 + reasoning 全文', bOnText === wantMerged);
  check(
    '  └ 合成 text_delta 在 message_stop 之前',
    bOn.body.indexOf('"text_delta"') !== -1 && bOn.body.indexOf('"text_delta"') < bOn.body.indexOf('message_stop')
  );

  // 1c 非流式
  const cOff = await post(PORT_OFF, 'frag-nonstream');
  const cOn = await post(PORT_ON, 'frag-nonstream');
  const cOffMsg = JSON.parse(cOff.body).choices[0].message;
  const cOnMsg = JSON.parse(cOn.body).choices[0].message;
  row('非流式 content 长度', cOffMsg.content.length, cOnMsg.content.length, SHORT.length, wantMerged.length);
  check('  └ 开关关：content 与上游短正文逐字一致', cOffMsg.content === SHORT);
  check('  └ 开关开：content = 短正文 + 换行 + reasoning 全文', cOnMsg.content === wantMerged);
  check('  └ 原始 reasoning_content 保留', cOnMsg.reasoning_content === REASON);

  /* ============ 2. 三个「不该合并」的反例 ============ */
  console.log('\n[2] 不该合并的反例（开关开时也必须原样放行）\n');

  // 反例 1：合法短回答
  const r1Off = visibleText((await post(PORT_OFF, 'ref-legal-short')).body);
  const r1On = visibleText((await post(PORT_ON, 'ref-legal-short')).body);
  row('反例1 合法短回答 "通"', r1Off, r1On, '通', '通');
  const r1bOn = visibleText((await post(PORT_ON, 'ref-legal-short-reasoning')).body);
  check('反例1b 短回答 + 短 reasoning 不合并', r1bOn === '通', `got=${JSON.stringify(r1bOn)} (reasoning 未达 200 字下限)`);

  // 反例 2：含工具调用
  const r2On = visibleText((await post(PORT_ON, 'ref-tool-calls')).body);
  check('反例2 OpenAI 流式 tool_calls 不合并', r2On === SHORT, `got=${r2On.length}字（应=${SHORT.length}）`);
  const r2bOn = visibleText((await post(PORT_ON, 'ref-tool-calls-anthropic')).body);
  check('反例2b Anthropic tool_use 不合并', r2bOn === SHORT, `got=${r2bOn.length}字（应=${SHORT.length}）`);
  const r2cOn = JSON.parse((await post(PORT_ON, 'ref-tool-calls-nonstream')).body).choices[0].message;
  check('反例2c 非流式 tool_calls 不合并', r2cOn.content === SHORT, `got=${r2cOn.content.length}字（应=${SHORT.length}）`);
  check('  └ tool_calls 字段本身未被破坏', Array.isArray(r2cOn.tool_calls) && r2cOn.tool_calls.length === 1);

  // 反例 3：正常长正文 + 长 reasoning
  const r3Off = visibleText((await post(PORT_OFF, 'ref-normal-long')).body);
  const r3On = visibleText((await post(PORT_ON, 'ref-normal-long')).body);
  row('反例3 正常长正文', r3Off.length, r3On.length, LONG.length, LONG.length);
  check('  └ 开关开：正文与上游长正文逐字一致', r3On === LONG);

  /* ============ 3. 阈值可被环境变量覆盖 ============ */
  console.log('\n[3] 阈值覆盖：正文 ' + MID.length + ' 字 + reasoning 500 字');
  console.log('    默认阈值 MAX_CHARS=40 → 不合并；自定义 MAX_CHARS=200/RATIO=2 → 合并\n');
  const dOn = visibleText((await post(PORT_ON, 'mid-content')).body);
  const dCustom = visibleText((await post(PORT_CUSTOM, 'mid-content')).body);
  check('默认阈值下不合并', dOn === MID, `got=${dOn.length}字`);
  check('自定义阈值下合并', dCustom === MID + '\n' + 'y'.repeat(500), `got=${dCustom.length}字（应=${MID.length + 1 + 500}）`);

  /* ============ 4. 日志字段 ============ */
  console.log('\n[4] 日志可区分 backfilled / merged\n');
  await sleep(200);
  const offLog = lastLogLine(off);
  const onLog = lastLogLine(on);
  console.log('  开关关 最后一行： ' + offLog);
  console.log('  开关开 最后一行： ' + onLog);
  check('开关关日志 merged=false', offLog.includes('merged=false'));
  check('开关开日志出现 merged=true', on.out.includes('merged=true'));
  check('开关开日志 merged=false 与 merged=true 并存（说明可区分）', on.out.includes('merged=false'));
  check('日志含 tool_calls 字段', onLog.includes('tool_calls='));
  check('启动日志标注 merge_fragment 状态', on.out.includes('merge_fragment=true') && off.out.includes('merge_fragment=false'));

  /* ============ 收尾 ============ */
  for (const c of [off, on, custom]) {
    try {
      c.kill('SIGTERM');
    } catch (_) {}
  }
  fake.close();
  await sleep(400);

  console.log('\n碎片合并测试结果：' + (fail === 0 ? '全部通过' : fail + ' 项失败'));
  process.exit(fail === 0 ? 0 : 1);
})();
