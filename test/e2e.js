'use strict';

/**
 * e2e.js —— 端到端：假模型端点 + 真实 Agent 循环
 *
 * 单元测试只能证明「工具单独拿出来是对的」，证明不了「模型要工具时整条链子能跑通」。
 * 这里起一个本地 HTTP 服务扮演 OpenAI 兼容端点，按剧本一轮轮地返回 tool_calls，
 * 然后跑真正的 runAgent，检查文件真的被改了、命令真的跑了、审批真的拦住了。
 *
 * 跑法： node test/e2e.js
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const safety = require('../src/safety');
const { runAgent } = require('../src/agent');
const { listModels } = require('../src/llm');

let pass = 0;
let fail = 0;

async function step(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (e) {
    fail++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${e.message}`);
  }
}

/* ============================================================
 * 假模型端点
 * ============================================================ */

/**
 * @param {Array} script 每一轮的剧本：{ text?, toolCalls?: [{name,args}] }
 * @param {Array} seen   把收到的请求体收集起来，供断言检查
 */
function startMock(script, seen) {
  let turn = 0;
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'mock-small' }, { id: 'mock-large' }] }));
      return;
    }

    if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
      res.writeHead(404).end();
      return;
    }

    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      seen.push(body);

      const turnScript = script[Math.min(turn, script.length - 1)];
      turn++;

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

      if (turnScript.text) {
        // 故意切成小块，验证流式拼接
        for (const chunk of turnScript.text.match(/[\s\S]{1,7}/g) || []) {
          send({ choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }] });
        }
      }

      if (turnScript.toolCalls) {
        turnScript.toolCalls.forEach((tc, i) => {
          send({
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    { index: i, id: `call_${turn}_${i}`, type: 'function', function: { name: tc.name, arguments: '' } },
                  ],
                },
                finish_reason: null,
              },
            ],
          });
          // 参数分两段发，验证累加逻辑
          const json = JSON.stringify(tc.args);
          const half = Math.ceil(json.length / 2);
          for (const part of [json.slice(0, half), json.slice(half)]) {
            send({
              choices: [
                {
                  index: 0,
                  delta: { tool_calls: [{ index: i, function: { arguments: part } }] },
                  finish_reason: null,
                },
              ],
            });
          }
        });
      }

      send({
        choices: [{ index: 0, delta: {}, finish_reason: turnScript.toolCalls ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 },
      });
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

const BASE_CFG = {
  temperature: 0,
  maxSteps: 12,
  stream: true,
  shell: process.platform === 'win32' ? 'cmd' : 'bash',
};

/* ============================================================
 * 主流程
 * ============================================================ */

(async () => {
  console.log('\n\x1b[1m端到端：Agent 循环\x1b[0m');

  const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wuyun-e2e-'));
  const WORKSPACE = safety.normalizeRoot(ROOT);
  fs.mkdirSync(path.join(WORKSPACE, 'src'), { recursive: true });
  fs.writeFileSync(path.join(WORKSPACE, 'src', 'index.js'), 'console.log("hi");\n', 'utf8');

  const seen = [];
  const script = [
    { toolCalls: [{ name: 'list_dir', args: { path: '.' } }] },
    { toolCalls: [{ name: 'write_file', args: { path: 'out/note.txt', content: '你好\n世界\n' } }] },
    { toolCalls: [{ name: 'run_command', args: { command: 'echo E2E_OK' } }] },
    { toolCalls: [{ name: 'edit_file', args: { path: 'out/note.txt', old_string: '世界', new_string: 'WORLD' } }] },
    { text: '四步都做完了：目录已看、文件已写、命令已跑、文件已改。' },
  ];

  const { server, port } = await startMock(script, seen);
  const baseUrl = `http://127.0.0.1:${port}/v1`;

  const config = { ...BASE_CFG, baseUrl, apiKey: 'test-key', model: 'mock-model' };
  const messages = [{ role: 'user', content: '走一遍流程' }];

  const events = [];
  const approvals = [];

  const result = await runAgent({
    messages,
    config,
    workspace: WORKSPACE,
    approvalMode: 'auto',
    sessionAllowlist: new Set(),
    onEvent: (ev) => events.push(ev),
    requestApproval: async (req) => {
      approvals.push(req);
      return true;
    },
    signal: new AbortController().signal,
  });

  await step('循环正常结束，没有报错', () => {
    assert.ok(!result.error, result.error && result.error.message);
    assert.strictEqual(result.aborted, undefined);
  });

  await step('一共跑了 4 轮工具 + 1 轮收尾', () => {
    const starts = events.filter((e) => e.type === 'step_start');
    assert.strictEqual(starts.length, 5, `实际 ${starts.length} 轮`);
  });

  await step('四个工具全部执行成功', () => {
    const ends = events.filter((e) => e.type === 'tool_end');
    assert.strictEqual(ends.length, 4, `实际 ${ends.length} 个`);
    for (const e of ends) assert.strictEqual(e.ok, true, `${e.name} 失败了：${e.content}`);
  });

  await step('list_dir 的结果回到了模型手里', () => {
    const last = seen[seen.length - 1];
    const toolMsgs = last.messages.filter((m) => m.role === 'tool');
    assert.ok(toolMsgs.length >= 4, `只有 ${toolMsgs.length} 条工具结果`);
    assert.ok(toolMsgs[0].content.includes('src/'), 'list_dir 的输出没回传');
  });

  await step('write_file 真的落盘了', () => {
    const p = path.join(WORKSPACE, 'out', 'note.txt');
    assert.ok(fs.existsSync(p), '文件没建出来');
  });

  await step('edit_file 真的改了内容（且是改后的最终态）', () => {
    const txt = fs.readFileSync(path.join(WORKSPACE, 'out', 'note.txt'), 'utf8');
    assert.strictEqual(txt, '你好\nWORLD\n');
  });

  await step('diff 信息带给了界面层', () => {
    const edit = events.find((e) => e.type === 'tool_end' && e.name === 'edit_file');
    assert.ok(edit.meta.diff.includes('+WORLD'), edit.meta.diff);
    assert.ok(edit.meta.diff.includes('-世界'), edit.meta.diff);
    assert.deepStrictEqual(edit.meta.stat, { add: 1, del: 1 });
  });

  await step('run_command 拿到了真实输出', () => {
    const cmd = events.find((e) => e.type === 'tool_end' && e.name === 'run_command');
    assert.strictEqual(cmd.meta.exitCode, 0, JSON.stringify(cmd.meta));
    assert.ok(cmd.content.includes('E2E_OK'), cmd.content);
  });

  await step('流式文本被完整拼接', () => {
    const deltas = events.filter((e) => e.type === 'assistant_delta').map((e) => e.delta).join('');
    assert.ok(deltas.includes('四步都做完了'), deltas);
  });

  await step('assistant 最终消息写回了历史', () => {
    const last = messages[messages.length - 1];
    assert.strictEqual(last.role, 'assistant');
    assert.ok(last.content.includes('四步都做完了'), last.content);
  });

  await step('token 用量被累加', () => {
    assert.strictEqual(result.usage.total_tokens, 160 * 5);
  });

  await step('普通命令没有触发审批', () => {
    assert.strictEqual(approvals.length, 0);
  });

  await step('请求里带上了工具声明', () => {
    assert.ok(Array.isArray(seen[0].tools), '没传 tools');
    const names = seen[0].tools.map((t) => t.function.name);
    assert.ok(names.includes('run_command'), names.join(','));
    assert.ok(names.includes('edit_file'), names.join(','));
  });

  /* ---------- 推理强度 ---------- */

  console.log('\n\x1b[1m端到端：推理强度（reasoning_effort）\x1b[0m');

  await step('配了推理强度就原样发出去', async () => {
    const s = [];
    const { server, port } = await startMock([{ text: '收到' }], s);
    try {
      await runAgent({
        messages: [{ role: 'user', content: '你好' }],
        config: { ...BASE_CFG, baseUrl: `http://127.0.0.1:${port}`, apiKey: 'k', model: 'mock-small', reasoningEffort: 'high' },
        workspace: WORKSPACE,
        approvalMode: 'full',
        sessionAllowlist: new Set(),
        onEvent: () => {},
        requestApproval: async () => true,
        signal: new AbortController().signal,
      });
    } finally {
      server.close();
    }
    assert.strictEqual(s[0].reasoning_effort, 'high', `实际是 ${JSON.stringify(s[0].reasoning_effort)}`);
  });

  await step('没配（空串）就一个字都不传', async () => {
    const s = [];
    const { server, port } = await startMock([{ text: '收到' }], s);
    try {
      await runAgent({
        messages: [{ role: 'user', content: '你好' }],
        config: { ...BASE_CFG, baseUrl: `http://127.0.0.1:${port}`, apiKey: 'k', model: 'mock-small', reasoningEffort: '' },
        workspace: WORKSPACE,
        approvalMode: 'full',
        sessionAllowlist: new Set(),
        onEvent: () => {},
        requestApproval: async () => true,
        signal: new AbortController().signal,
      });
    } finally {
      server.close();
    }
    // 这条断言看着像废话，其实是在守住一个真实的坑：很多端点（本地 vLLM、老模型）
    // 收到不认识的 reasoning_effort 会直接 400，所以「不选」必须等于「不传」，
    // 不能传一个空串或者 null 出去。
    assert.ok(!('reasoning_effort' in s[0]), `不该出现这个字段：${JSON.stringify(s[0].reasoning_effort)}`);
  });

  /* ---------- 危险命令审批 ---------- */

  console.log('\n\x1b[1m端到端：危险命令的审批闸门\x1b[0m');

  const seen2 = [];
  const script2 = [
    { toolCalls: [{ name: 'run_command', args: { command: 'rm -rf build' } }] },
    { text: '好的，我跳过了这条命令。' },
  ];
  const mock2 = await startMock(script2, seen2);

  const events2 = [];
  const approvals2 = [];
  let allow = false;

  const r2 = await runAgent({
    messages: [{ role: 'user', content: '清一下 build' }],
    config: { ...BASE_CFG, baseUrl: `http://127.0.0.1:${mock2.port}/v1`, apiKey: 'k', model: 'm' },
    workspace: WORKSPACE,
    approvalMode: 'auto',
    sessionAllowlist: new Set(),
    onEvent: (ev) => events2.push(ev),
    requestApproval: async (req) => {
      approvals2.push(req);
      return allow;
    },
    signal: new AbortController().signal,
  });

  await step('危险命令触发了审批请求', () => {
    assert.strictEqual(approvals2.length, 1, `审批次数 ${approvals2.length}`);
    assert.ok(approvals2[0].reasons.length > 0, '必须说明为什么危险');
  });

  await step('拒绝之后命令没有真的执行', () => {
    const end = events2.find((e) => e.type === 'tool_end' && e.name === 'run_command');
    assert.strictEqual(end.ok, false);
    assert.strictEqual(end.denied, true);
    assert.ok(end.content.includes('用户拒绝'), end.content);
    // build 目录本来就不存在；这里确认没有意外创建/删除的痕迹
    assert.strictEqual(fs.existsSync(path.join(WORKSPACE, 'build')), false);
  });

  await step('被拒绝的结果回传给了模型，模型能继续往下走', () => {
    const last = seen2[seen2.length - 1];
    const toolMsg = last.messages.find((m) => m.role === 'tool');
    assert.ok(toolMsg.content.includes('用户拒绝'), toolMsg.content);
    assert.ok(!r2.error);
  });

  await step('同一会话内放行过的命令不再重复弹窗', () => {
    const allowlist = new Set();
    const args = { command: 'rm -rf build' };
    const tools = require('../src/tools');
    const first = tools.needsApproval('run_command', args, 'auto', allowlist);
    allowlist.add(first.key);
    assert.strictEqual(tools.needsApproval('run_command', args, 'auto', allowlist).needed, false);
  });

  /* ---------- 只读模式 ---------- */

  console.log('\n\x1b[1m端到端：只读模式\x1b[0m');

  const seen3 = [];
  const mock3 = await startMock([{ text: '好的。' }], seen3);
  await runAgent({
    messages: [{ role: 'user', content: '看看项目' }],
    config: { ...BASE_CFG, baseUrl: `http://127.0.0.1:${mock3.port}/v1`, apiKey: 'k', model: 'm' },
    workspace: WORKSPACE,
    approvalMode: 'read-only',
    sessionAllowlist: new Set(),
    onEvent: () => {},
    requestApproval: async () => true,
    signal: new AbortController().signal,
  });

  await step('只读模式下模型看不到写文件和跑命令的工具', () => {
    const names = seen3[0].tools.map((t) => t.function.name).sort();
    assert.deepStrictEqual(names, ['list_dir', 'read_file', 'search_files']);
  });

  /* ---------- 模型列表 ---------- */

  console.log('\n\x1b[1m端到端：模型列表\x1b[0m');

  await step('listModels 能解析出模型 id', async () => {
    const ids = await listModels({ baseUrl, apiKey: 'k' });
    assert.deepStrictEqual(ids, ['mock-large', 'mock-small']);
  });

  /* ---------- 错误处理 ---------- */

  console.log('\n\x1b[1m端到端：错误处理\x1b[0m');

  const badServer = http.createServer((req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Invalid API key' } }));
  });
  const badPort = await new Promise((r) => badServer.listen(0, '127.0.0.1', () => r(badServer.address().port)));

  await step('401 会给出「Key 不对」的提示而不是干巴巴的状态码', async () => {
    const events4 = [];
    const r4 = await runAgent({
      messages: [{ role: 'user', content: 'hi' }],
      config: { ...BASE_CFG, baseUrl: `http://127.0.0.1:${badPort}/v1`, apiKey: 'bad', model: 'm' },
      workspace: WORKSPACE,
      approvalMode: 'auto',
      sessionAllowlist: new Set(),
      onEvent: (ev) => events4.push(ev),
      requestApproval: async () => true,
      signal: new AbortController().signal,
    });
    const err = events4.find((e) => e.type === 'error');
    assert.ok(err, '没有报错事件');
    assert.ok(err.message.includes('401'), err.message);
    assert.ok(err.message.includes('API Key'), err.message);
    assert.ok(r4.error, '结果里没有 error');
  });

  await step('端点完全不通时也有清楚的错误', async () => {
    const events5 = [];
    await runAgent({
      messages: [{ role: 'user', content: 'hi' }],
      config: { ...BASE_CFG, baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', model: 'm' },
      workspace: WORKSPACE,
      approvalMode: 'auto',
      sessionAllowlist: new Set(),
      onEvent: (ev) => events5.push(ev),
      requestApproval: async () => true,
      signal: new AbortController().signal,
    });
    const err = events5.find((e) => e.type === 'error');
    assert.ok(err, '没有报错事件');
  });

  /* ---------- 收尾 ---------- */

  server.close();
  mock2.server.close();
  mock3.server.close();
  badServer.close();
  fs.rmSync(ROOT, { recursive: true, force: true });

  console.log(`\n${'─'.repeat(56)}`);
  if (fail === 0) console.log(`\x1b[32m全部通过：${pass} 项\x1b[0m`);
  else console.log(`\x1b[31m失败 ${fail} 项\x1b[0m，通过 ${pass} 项`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('测试脚本自身崩了：', e);
  process.exit(1);
});
