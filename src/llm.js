'use strict';

/**
 * llm.js —— OpenAI 兼容的模型客户端
 *
 * 只依赖 Node 自带的 fetch，不引任何 SDK。这样任何「OpenAI 兼容」的端点
 * 都能直接接：OpenAI、DeepSeek、通义、Kimi、智谱、Groq、本地 Ollama / vLLM / LM Studio……
 * 用户只要填 base_url + api_key + 模型名。
 *
 * 输出统一成事件流，上层（agent.js）不用关心是流式还是非流式：
 *   { type: 'text',      delta }   —— 正文增量
 *   { type: 'reasoning', delta }   —— 思维链增量（DeepSeek-R1 这类会返回）
 *   { type: 'done', message, usage, finishReason }
 */

/** 把用户填的 base_url 规整成不带尾斜杠、不带 /chat/completions 的根 */
function normalizeBaseUrl(input) {
  let s = String(input || '').trim();
  if (!s) return '';
  s = s.replace(/\/+$/, '');
  s = s.replace(/\/chat\/completions$/, '');
  return s;
}

function endpoint(baseUrl, suffix) {
  return normalizeBaseUrl(baseUrl) + suffix;
}

function buildHeaders(apiKey, extra) {
  const h = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    ...(extra || {}),
  };
  if (apiKey) h.Authorization = `Bearer ${apiKey}`;
  return h;
}

/** 把服务端返回的错误体压成一句人话 */
async function describeHttpError(res) {
  let body = '';
  try {
    body = await res.text();
  } catch {
    /* 忽略 */
  }
  let detail = body.slice(0, 1500);
  try {
    const j = JSON.parse(body);
    detail = j?.error?.message || j?.message || detail;
  } catch {
    /* 不是 JSON 就用原文 */
  }
  const hint =
    res.status === 401
      ? '\n（401 一般是 API Key 不对，或者这个 Key 没有该模型的权限）'
      : res.status === 404
        ? '\n（404 一般是 base_url 写错了。注意要带上 /v1，例如 https://api.openai.com/v1）'
        : res.status === 429
          ? '\n（429 是触发限流或余额不足，稍后再试）'
          : '';
  return new Error(`模型接口返回 HTTP ${res.status} ${res.statusText}${hint}\n${detail}`);
}

/* ============================================================
 * 非流式
 * ============================================================ */

/**
 * 把「推理强度」写进请求体。
 *
 * 只有非空才写 —— 空串代表「不传」，因为很多端点（尤其是老模型、本地 vLLM）
 * 收到不认识的 reasoning_effort 会直接 400，而它们本来也不需要这个参数。
 * 传了就原样透传：网关（api/v1_chat_completions.php）是整包转发的，
 * 不需要服务端为这个参数做任何改动。
 */
function applyReasoning(body, reasoningEffort) {
  const v = String(reasoningEffort || '').trim();
  if (v) body.reasoning_effort = v;
  return body;
}

async function chatOnce({ baseUrl, apiKey, model, messages, tools, toolChoice, temperature, maxTokens, reasoningEffort, extraHeaders, signal }) {
  const body = { model, messages, stream: false };
  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = toolChoice || 'auto';
  }
  if (typeof temperature === 'number') body.temperature = temperature;
  if (maxTokens) body.max_tokens = maxTokens;
  applyReasoning(body, reasoningEffort);

  const res = await fetch(endpoint(baseUrl, '/chat/completions'), {
    method: 'POST',
    headers: buildHeaders(apiKey, extraHeaders),
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw await describeHttpError(res);

  const json = await res.json();
  const choice = json?.choices?.[0] || {};
  const msg = choice.message || {};
  return {
    message: {
      role: 'assistant',
      content: msg.content ?? '',
      ...(msg.reasoning_content ? { reasoning_content: msg.reasoning_content } : {}),
      ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}),
    },
    usage: json?.usage || null,
    finishReason: choice.finish_reason || null,
  };
}

/* ============================================================
 * 流式
 * ============================================================ */

async function* chatStream({ baseUrl, apiKey, model, messages, tools, toolChoice, temperature, maxTokens, reasoningEffort, extraHeaders, signal }) {
  const body = { model, messages, stream: true };
  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = toolChoice || 'auto';
  }
  if (typeof temperature === 'number') body.temperature = temperature;
  if (maxTokens) body.max_tokens = maxTokens;
  applyReasoning(body, reasoningEffort);
  // 有些兼容端点需要显式要 usage
  body.stream_options = { include_usage: true };

  const res = await fetch(endpoint(baseUrl, '/chat/completions'), {
    method: 'POST',
    headers: buildHeaders(apiKey, extraHeaders),
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw await describeHttpError(res);
  if (!res.body) throw new Error('模型接口没有返回响应体，无法流式读取');

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');

  let buffer = '';
  let text = '';
  let reasoning = '';
  let finishReason = null;
  let usage = null;
  const toolAcc = new Map(); // index -> { id, name, args }

  const handleData = function* (payload) {
    if (!payload || payload === '[DONE]') return;
    let json;
    try {
      json = JSON.parse(payload);
    } catch {
      return; // 兼容端点偶尔会发心跳或非 JSON 行，跳过
    }

    if (json.usage) usage = json.usage;
    const choice = json?.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;

    const delta = choice.delta || {};

    if (typeof delta.content === 'string' && delta.content) {
      text += delta.content;
      yield { type: 'text', delta: delta.content };
    }
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
      reasoning += delta.reasoning_content;
      yield { type: 'reasoning', delta: delta.reasoning_content };
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = typeof tc.index === 'number' ? tc.index : 0;
        let cur = toolAcc.get(idx);
        if (!cur) {
          cur = { id: '', name: '', args: '' };
          toolAcc.set(idx, cur);
        }
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name = tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
      }
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE 以空行分隔事件；这里按行处理，兼容 \n 与 \r\n
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (!line || line.startsWith(':')) continue; // 空行或注释（心跳）
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        yield* handleData(payload);
      }
    }
    // 收尾：把最后一行没换行的也处理掉
    const rest = buffer.trim();
    if (rest.startsWith('data:')) yield* handleData(rest.slice(5).trim());
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* 忽略 */
    }
  }

  // 组装成标准的 assistant message
  const toolCalls = [...toolAcc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v], i) => ({
      id: v.id || `call_${Date.now()}_${i}`,
      type: 'function',
      function: { name: v.name, arguments: v.args || '{}' },
    }));

  const message = { role: 'assistant', content: text };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length) message.tool_calls = toolCalls;

  yield { type: 'done', message, usage, finishReason };
}

/** 统一入口：按配置决定走流式还是非流式 */
async function* runChat(opts) {
  if (opts.stream === false) {
    const r = await chatOnce(opts);
    if (r.message.content) yield { type: 'text', delta: r.message.content };
    if (r.message.reasoning_content) yield { type: 'reasoning', delta: r.message.reasoning_content };
    yield { type: 'done', message: r.message, usage: r.usage, finishReason: r.finishReason };
    return;
  }
  yield* chatStream(opts);
}

/* ============================================================
 * 连通性测试 / 拉模型列表
 * ============================================================ */

async function listModels({ baseUrl, apiKey, extraHeaders, signal }) {
  const res = await fetch(endpoint(baseUrl, '/models'), {
    method: 'GET',
    headers: buildHeaders(apiKey, extraHeaders),
    signal,
  });
  if (!res.ok) throw await describeHttpError(res);
  const json = await res.json();
  const ids = (json?.data || []).map((m) => m.id).filter(Boolean);
  ids.sort();
  return ids;
}

module.exports = { runChat, chatOnce, chatStream, listModels, normalizeBaseUrl, endpoint };
