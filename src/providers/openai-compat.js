// Some OpenAI-compatible providers (vLLM, llama.cpp, DeepInfra) report a
// mid-stream provider fault as finish_reason 'error' with an empty message
// instead of failing the HTTP request. Treating that as a normal stop turns a
// provider outage into a silent empty answer, so it is raised as an error the
// turn runner can classify, retry, and bounce like any other provider fault.
const ERROR_FINISH_REASONS = new Set([
  'error',
  'internal_error',
  'provider_error',
  'upstream_error',
  'failed',
]);

function errorDetail(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'object') {
    const msg = value.message ?? value.msg ?? value.detail ?? value.description;
    if (typeof msg === 'string' && msg.trim()) return msg.trim();
    const code = value.code ?? value.type ?? value.status;
    return code == null ? '' : String(code);
  }
  return String(value).trim();
}

// Returns a human-readable failure description, or null for a normal turn.
function upstreamError(obj, choice) {
  const reason = choice?.finish_reason;
  const marker = errorDetail(choice?.error) || errorDetail(obj?.error);
  if (!ERROR_FINISH_REASONS.has(String(reason ?? '').toLowerCase()) && !marker) return null;
  const parts = [`finish_reason=${reason ?? 'error'}`];
  const provider = errorDetail(obj?.provider);
  if (provider) parts.push(`provider=${provider}`);
  const detail = marker || errorDetail(choice?.message);
  if (detail) parts.push(detail);
  return `upstream stream error (${parts.join(', ')})`;
}

export function createOpenAICompatParser({ name = 'openai-compat' } = {}) {
  let buf = '';
  let slots = [];
  let stopReason = null;
  let sawToolCalls = false;
  let finalized = false;
  let finishedLatch = false;
  let usageCaptured = false;

  const flushCalls = (events) => {
    for (const slot of slots) {
      if (!slot) continue;
      sawToolCalls = true;
      const raw = slot.args || '{}';
      let call;
      try {
        call = { id: slot.id, name: slot.name, args: JSON.parse(raw) };
      } catch {
        call = { id: slot.id, name: slot.name, args: null, parseError: true };
      }
      events.push({ type: 'tool-call', call });
    }
    slots = [];
  };

  const finalize = (events) => {
    if (finalized) return;
    finalized = true;
    flushCalls(events);
    const reason =
      sawToolCalls || stopReason === 'tool_calls'
        ? 'tool_calls'
        : stopReason === 'length'
          ? 'length'
          : 'stop';
    events.push({ type: 'done', stopReason: reason });
  };

  const handlePayload = (payload, events) => {
    let obj;
    try {
      obj = JSON.parse(payload);
    } catch {
      return;
    }
    if (!obj || typeof obj !== 'object') return;
    if (obj.usage && !usageCaptured) {
      usageCaptured = true;
      events.push({
        type: 'usage',
        inputTokens: Number(obj.usage.prompt_tokens) || 0,
        outputTokens: Number(obj.usage.completion_tokens) || 0,
      });
    }
    const choices = Array.isArray(obj.choices) ? obj.choices : [];
    // Probe before the finish latch: a fault announced after a normal finish
    // reason is still a fault. Null choice covers a bare top-level error chunk.
    for (const choice of choices.length ? choices : [null]) {
      const failure = upstreamError(obj, choice);
      if (failure) throw new Error(`ox[${name}]: ${failure}`);
    }
    if (finishedLatch) return;
    for (const choice of choices) {
      const delta = choice.delta ?? {};
      if (typeof delta.content === 'string' && delta.content) {
        events.push({ type: 'text-delta', text: delta.content });
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const frag of delta.tool_calls) {
          const idx = Number.isInteger(frag.index) && frag.index >= 0 ? frag.index : slots.length;
          while (slots.length <= idx) slots.push(null);
          if (!slots[idx]) slots[idx] = { id: '', name: '', args: '' };
          const slot = slots[idx];
          if (frag.id && !slot.id) slot.id = frag.id;
          const fname = frag.function?.name;
          if (fname && !slot.name) slot.name = fname;
          if (typeof frag.function?.arguments === 'string') slot.args += frag.function.arguments;
        }
      }
      if (choice.finish_reason) {
        stopReason =
          choice.finish_reason === 'tool_calls' || choice.finish_reason === 'function'
            ? 'tool_calls'
            : choice.finish_reason === 'length' || choice.finish_reason === 'max_tokens'
              ? 'length'
              : 'stop';
        flushCalls(events);
        finishedLatch = true;
      }
    }
  };

  const consumeLine = (line, events) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;
    const payload = trimmed.slice(5).trim();
    if (!payload) return;
    if (payload === '[DONE]') {
      finalize(events);
      return;
    }
    handlePayload(payload, events);
  };

  return {
    push(chunk) {
      const events = [];
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        consumeLine(buf.slice(0, nl), events);
        buf = buf.slice(nl + 1);
      }
      return events;
    },
    end() {
      const events = [];
      if (buf.trim()) consumeLine(buf, events);
      buf = '';
      finalize(events);
      return events;
    },
  };
}

function toWireMessages(messages) {
  return (messages ?? []).map((m) => {
    const wire = { role: m.role ?? 'user', content: m.content ?? null };
    if (m.name != null) wire.name = m.name;
    if (m.tool_call_id != null) wire.tool_call_id = m.tool_call_id;
    if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
      wire.tool_calls = m.tool_calls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.function?.name ?? '', arguments: c.function?.arguments ?? '{}' },
      }));
    }
    return wire;
  });
}

const trimBase = (b) => String(b).replace(/\/+$/, '');

export function makeOpenAICompat({ name = 'openai-compat' } = {}) {
  return async function* streamChat({ model, messages, tools = [], apiKey, baseUrl, signal, maxTokens } = {}) {
    if (!baseUrl) throw new Error(`ox[${name}]: no baseUrl configured for OpenAI-compatible provider`);
    const isOllama = name === 'ollama' || trimBase(baseUrl).includes(':11434');
    const body = { model, messages: toWireMessages(messages), stream: true };
    if (tools.length) {
      body.tools = tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.input_schema },
      }));
    }
    if (!isOllama) body.stream_options = { include_usage: true };
    if (maxTokens != null) body.max_tokens = maxTokens;
    const headers = { 'content-type': 'application/json' };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    const res = await fetch(`${trimBase(baseUrl)}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`ox[${name}]: HTTP ${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
    }
    const parser = createOpenAICompatParser({ name });
    const dec = new TextDecoder();
    for await (const chunk of res.body) {
      for (const ev of parser.push(dec.decode(chunk, { stream: true }))) yield ev;
    }
    for (const ev of parser.end(dec.decode())) yield ev;
  };
}
