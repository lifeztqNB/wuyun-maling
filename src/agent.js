'use strict';

/**
 * agent.js —— Agent 主循环
 *
 * 一轮 = 请求模型 → 流式吐字 → 如果模型要调工具就执行 → 把结果塞回上下文 → 再请求模型。
 * 直到模型不再要工具、或者撞上最大步数、或者用户点了停止。
 *
 * 这里刻意不做「花哨的规划器 / 反思器」那套。工具调用协议本身已经是规划器了，
 * 额外加一层自我反思的提示词，实测只会让模型话变多、动手变少。
 */

const os = require('os');

const { runChat } = require('./llm');
const { toOpenAITools, executeTool, needsApproval, specOf } = require('./tools');

const MAX_STEPS_DEFAULT = 25;
const CONTEXT_BUDGET_CHARS = 600_000; // 粗略的上下文预算，超了就从最老的轮次开始丢

/* ============================================================
 * 系统提示词
 * ============================================================ */

function buildSystemPrompt({ workspace, shell, approvalMode }) {
  const platform =
    process.platform === 'win32'
      ? `Windows（${os.release()}，${process.arch}）`
      : process.platform === 'darwin'
        ? `macOS（${os.release()}，${process.arch}）`
        : `Linux（${os.release()}，${process.arch}）`;

  const today = new Date().toISOString().slice(0, 10);

  const modeNote =
    approvalMode === 'read-only'
      ? '当前是「只读」模式：你只能读取和搜索文件，不能写入、修改或执行命令。需要改动时请告诉用户切换到「自动」模式。'
      : approvalMode === 'full'
        ? '当前是「完全放行」模式：写文件和执行命令都不会弹确认框，请格外谨慎。'
        : '当前是「自动」模式：常规读写和命令会直接执行，破坏性操作会弹确认框让用户决定。';

  return [
    '你是「雾韵码灵」，一个运行在用户本机的 AI 编程助手，界面风格参照 Codex。',
    '你可以通过工具真实地读写文件、执行命令，而不只是给建议。',
    '',
    '## 当前环境',
    `- 操作系统：${platform}`,
    `- 工作区根目录：${workspace}`,
    `- 默认 shell：${shell}`,
    `- 今天日期：${today}`,
    '',
    '## 工作原则',
    '1. **先看再改**。动任何文件之前，先用 read_file 或 search_files 确认当前真实内容，不要凭猜测写代码。',
    '2. **小改动用 edit_file**，整篇重写才用 write_file。edit_file 的 old_string 必须和文件里逐字符一致。',
    '3. **路径不能越界**。所有文件操作都必须在工作区内。用户要求操作工作区外的文件时，直接说明做不到，并建议先切换工作区。',
    '4. **命令是真的会执行**。破坏性操作（删除、格式化、改注册表等）界面上会弹确认框，但你也应该在动手前用一句话说清楚你要做什么、为什么。',
    '5. **做完要验证**。改完代码至少跑一次测试或语法检查，不要把「已经改好了」当成结论。',
    '6. **不要编造**。没读过的文件不要说它的内容，没跑过的命令不要报它的结果。不确定就先去看。',
    '7. **多步任务先列清单**。任务超过三步时，先用一段简短的待办清单告诉用户你打算怎么做，然后逐步执行。',
    '8. **回答用简体中文，简洁直接**。不要复述工具返回的原始内容，只讲结论、关键改动和需要注意的地方。',
    '9. **不要在文字里请求许可**，界面上有确认机制。但动手前要用一句话说明计划。',
    '',
    modeNote,
  ].join('\n');
}

/* ============================================================
 * 上下文预算
 * ============================================================ */

function messagesSize(messages) {
  let n = 0;
  for (const m of messages) {
    n += (typeof m.content === 'string' ? m.content.length : 0) + 200;
    if (m.tool_calls) n += JSON.stringify(m.tool_calls).length;
  }
  return n;
}

/**
 * 超预算时从最老的「轮次」开始丢。
 * 一轮 = 一条 user 消息 + 它后面跟着的所有 assistant / tool 消息。
 * 必须整轮丢：单独留下一个 tool 消息而丢掉对应的 assistant tool_calls，
 * 会让接口报「tool_call_id 找不到对应的调用」。
 */
function compactMessages(messages) {
  if (messagesSize(messages) <= CONTEXT_BUDGET_CHARS) return { messages, dropped: 0 };

  const system = messages[0]?.role === 'system' ? [messages[0]] : [];
  const rest = messages[0]?.role === 'system' ? messages.slice(1) : messages.slice();

  // 按 user 消息切轮
  const turns = [];
  let cur = null;
  for (const m of rest) {
    if (m.role === 'user') {
      if (cur) turns.push(cur);
      cur = [m];
    } else {
      if (!cur) cur = [];
      cur.push(m);
    }
  }
  if (cur && cur.length) turns.push(cur);

  let dropped = 0;
  while (turns.length > 1 && messagesSize([...system, ...turns.flat()]) > CONTEXT_BUDGET_CHARS) {
    turns.shift();
    dropped++;
  }
  return { messages: [...system, ...turns.flat()], dropped };
}

/* ============================================================
 * 主循环
 * ============================================================ */

/**
 * @param {object} p
 * @param {Array}  p.messages         完整历史（会被就地追加）
 * @param {object} p.config           { baseUrl, apiKey, model, temperature, maxTokens, maxSteps, stream, shell, extraHeaders }
 * @param {string} p.workspace        工作区根目录（已规范化）
 * @param {string} p.approvalMode     read-only | auto | full
 * @param {Set}    p.sessionAllowlist 本会话已放行的操作
 * @param {Function} p.onEvent        事件回调
 * @param {Function} p.requestApproval 请求人工确认，返回 Promise<boolean>
 * @param {AbortSignal} p.signal
 */
async function runAgent({
  messages,
  config,
  workspace,
  approvalMode,
  sessionAllowlist,
  onEvent,
  requestApproval,
  signal,
}) {
  const maxSteps = Math.max(1, Number.parseInt(config.maxSteps ?? MAX_STEPS_DEFAULT, 10) || MAX_STEPS_DEFAULT);
  const shell = config.shell || undefined;
  const tools = toOpenAITools(approvalMode);

  const totalUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  for (let step = 1; step <= maxSteps; step++) {
    if (signal.aborted) {
      onEvent({ type: 'aborted' });
      return { messages, aborted: true, steps: step - 1, usage: totalUsage };
    }

    // 每轮开始前压一次上下文
    const { messages: compacted, dropped } = compactMessages(messages);
    if (dropped > 0) {
      messages.length = 0;
      messages.push(...compacted);
      onEvent({ type: 'compacted', dropped });
    }

    onEvent({ type: 'step_start', step, maxSteps });

    let assistantMessage = null;
    let usage = null;
    let finishReason = null;

    try {
      const iter = runChat({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model: config.model,
        messages,
        tools,
        temperature: config.temperature,
        maxTokens: config.maxTokens,
        stream: config.stream !== false,
        extraHeaders: config.extraHeaders,
        signal,
      });

      for await (const ev of iter) {
        if (ev.type === 'text') onEvent({ type: 'assistant_delta', delta: ev.delta });
        else if (ev.type === 'reasoning') onEvent({ type: 'reasoning_delta', delta: ev.delta });
        else if (ev.type === 'done') {
          assistantMessage = ev.message;
          usage = ev.usage;
          finishReason = ev.finishReason;
        }
      }
    } catch (err) {
      if (signal.aborted) {
        onEvent({ type: 'aborted' });
        return { messages, aborted: true, steps: step, usage: totalUsage };
      }
      onEvent({ type: 'error', message: err?.message || String(err) });
      return { messages, error: err, steps: step, usage: totalUsage };
    }

    if (usage) {
      totalUsage.prompt_tokens += usage.prompt_tokens || 0;
      totalUsage.completion_tokens += usage.completion_tokens || 0;
      totalUsage.total_tokens += usage.total_tokens || 0;
      onEvent({ type: 'usage', usage: totalUsage, stepUsage: usage });
    }

    if (!assistantMessage) {
      onEvent({ type: 'error', message: '模型没有返回任何内容。请检查模型名是否正确、或者该模型是否支持工具调用。' });
      return { messages, steps: step, usage: totalUsage };
    }

    onEvent({ type: 'assistant_message', message: assistantMessage, finishReason });

    // 把 assistant 消息写回历史（即使没有 tool_calls 也要写，保证上下文完整）
    messages.push({
      role: 'assistant',
      content: assistantMessage.content || '',
      ...(assistantMessage.tool_calls ? { tool_calls: assistantMessage.tool_calls } : {}),
    });

    const toolCalls = assistantMessage.tool_calls || [];
    if (!toolCalls.length) {
      onEvent({ type: 'done', steps: step, usage: totalUsage });
      return { messages, steps: step, usage: totalUsage };
    }

    // —— 逐个执行工具 ——
    for (const call of toolCalls) {
      const name = call.function?.name || '';
      const rawArgs = call.function?.arguments || '{}';

      let args = {};
      let parseError = null;
      try {
        args = rawArgs.trim() ? JSON.parse(rawArgs) : {};
      } catch (err) {
        parseError = err.message;
      }

      const spec = specOf(name);
      onEvent({
        type: 'tool_start',
        id: call.id,
        name,
        args,
        rawArgs,
        mutating: !!spec?.mutating,
      });

      if (parseError) {
        const content = `工具参数不是合法 JSON，无法执行：${parseError}\n收到的原始参数：${rawArgs.slice(0, 500)}`;
        onEvent({ type: 'tool_end', id: call.id, name, ok: false, content, meta: { kind: 'error' } });
        messages.push({ role: 'tool', tool_call_id: call.id, content });
        continue;
      }

      if (signal.aborted) {
        const content = '用户中断了执行。';
        onEvent({ type: 'tool_end', id: call.id, name, ok: false, content, meta: { kind: 'aborted' } });
        messages.push({ role: 'tool', tool_call_id: call.id, content });
        return { messages, aborted: true, steps: step, usage: totalUsage };
      }

      // —— 人工确认 ——
      const gate = needsApproval(name, args, approvalMode, sessionAllowlist);
      if (gate.needed) {
        const approved = await requestApproval({
          id: call.id,
          name,
          args,
          title: gate.title,
          reasons: gate.reasons,
          key: gate.key,
        });
        if (!approved) {
          const content = `用户拒绝了这次操作（${name}）。请不要重试同一个操作；如果确实必要，先向用户解释原因并询问替代方案。`;
          onEvent({ type: 'tool_end', id: call.id, name, ok: false, denied: true, content, meta: { kind: 'denied' } });
          messages.push({ role: 'tool', tool_call_id: call.id, content });
          continue;
        }
      }

      const started = Date.now();
      const result = await executeTool(name, args, { workspace, shell, signal });
      const durationMs = Date.now() - started;

      onEvent({
        type: 'tool_end',
        id: call.id,
        name,
        ok: !result.isError,
        content: result.content,
        meta: result.meta,
        durationMs,
      });

      messages.push({ role: 'tool', tool_call_id: call.id, content: result.content });
    }
  }

  onEvent({ type: 'error', message: `已达到最大步数（${maxSteps}），自动停止。可以把任务拆小一点再试，或者调高设置里的最大步数。` });
  return { messages, steps: maxSteps, usage: totalUsage };
}

module.exports = { runAgent, buildSystemPrompt, compactMessages, MAX_STEPS_DEFAULT };
