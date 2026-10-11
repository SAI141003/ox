const trimBase = (b) => String(b).replace(/\/+$/, '');

function endpoint(baseUrl) {
  const base = trimBase(baseUrl);
  return base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`;
}

function parseArgsOrEmpty(raw) {
  try {
    const v = JSON.parse(raw || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

export function buildAnthropicBody({ model, messages, tools, maxTokens }) {
  let i = 0;
  const sysTexts = [];
  while (i < messages.length && messages[i].role === 'system') {
    sysTexts.push(String(messages[i].content ?? ''));
    i++;
  }
  const conv = [];
  while (i < messages.length) {
    const m = messages[i];
    i++;
    if (m.role === 'assistant') {
      const blocks = [];
      const text = typeof m.content === 'string' ? m.content : m.content == null ? '' : String(m.content);
      if (text) blocks.push({ type: 'text', text });
      for (const c of m.tool_calls ?? []) {
        blocks.push({
          type: 'tool_use',
          id: c.id,
          name: c.function?.name ?? '',
          input: parseArgsOrEmpty(c.function?.arguments),
        });
      }
      conv.push({ role: 'assistant', content: blocks.length ? blocks : [{ type: 'text', text: '(empty)' }] });
    } else if (m.role === 'tool') {
      const results = [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: String(m.content ?? '') }];
      while (i < messages.length && messages[i].role === 'tool') {
        results.push({
          type: 'tool_result',
          tool_use_id: messages[i].tool_call_id,
          content: String(messages[i].content ?? ''),
        });
        i++;
      }
      conv.push({ role: 'user', content: results });
    } else {
      conv.push({ role: 'user', content: [{ type: 'text', text: String(m.content ?? '') }] });
    }
  }
  const body = { model, messages: conv, max_tokens: maxTokens || 4096, stream: true };
  if (sysTexts.length) body.system = sysTexts.join('\n');
  if (tools?.length) {
    body.tools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    }));
  }
  return body;
}

export function createAnthropicParser() {
  let buf = '';
  const blocks = new Map();
  let inputTokens = 0;
  let stopReason = null;
  let sawToolUse = false;
  let finalized = false;

  const emitTool = (b, events) => {
    sawToolUse = true;
    let call;
    try {
      call = { id: b.id, name: b.name, args: JSON.parse(b.json || '{}') ?? {} };
    } catch {
      call = { id: b.id, name: b.name, args: null, parseError: true };
    }
    events.push({ type: 'tool-call', call });
  };

  const finalize = (events) => {
    if (finalized) return;
    finalized = true;
    for (const [, b] of blocks) {
      if (b.type === 'tool_use') emitTool(b, events);
    }
    blocks.clear();
    const reason = stopReason
      ? stopReason === 'tool_use'
        ? 'tool_calls'
        : stopReason === 'max_tokens' || stopReason === 'length'
          ? 'length'
          : 'stop'
      : sawToolUse
        ? 'tool_calls'
        : 'stop';
    events.push({ type: 'done', stopReason: reason });
  };

  const handleEvent = (obj, events) => {
    switch (obj.type) {
      case 'message_start': {
        const n = Number(obj.message?.usage?.input_tokens);
        if (Number.isFinite(n)) inputTokens = n;
        break;
      }
      case 'content_block_start': {
        const cb = obj.content_block ?? {};
        blocks.set(obj.index, { type: cb.type, id: cb.id, name: cb.name, json: '' });
        break;
      }
      case 'content_block_delta': {
        const b = blocks.get(obj.index);
        const d = obj.delta ?? {};
        if (!b) break;
        if (d.type === 'text_delta' && d.text) {
          events.push({ type: 'text-delta', text: d.text });
        } else if (d.type === 'input_json_delta' && d.partial_json) {
          b.json += d.partial_json;
        }
        break;
      }
      case 'content_block_stop': {
        const b = blocks.get(obj.index);
        blocks.delete(obj.index);
        if (b?.type === 'tool_use') emitTool(b, events);
        break;
      }
      case 'message_delta': {
        const out = Number(obj.usage?.output_tokens);
        if (Number.isFinite(out)) {
          events.push({ type: 'usage', inputTokens, outputTokens: out });
        }
        if (obj.delta?.stop_reason) stopReason = obj.delta.stop_reason;
        break;
      }
      case 'message_stop':
        finalize(events);
        break;
      case 'error':
        throw new Error(
          `ox[anthropic]: stream error: ${obj.error?.message ?? JSON.stringify(obj.error ?? obj)}`
        );
      default:
        break;
    }
  };

  const consumeLine = (line, events) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;
    const payload = trimmed.slice(5).trim();
    if (!payload) return;
    let obj;
    try {
      obj = JSON.parse(payload);
    } catch {
      return;
    }
    if (obj && typeof obj === 'object') handleEvent(obj, events);
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

export function makeAnthropic() {
  return async function* streamChat({
    model,
    messages = [],
    tools = [],
    apiKey,
    baseUrl,
    signal,
    maxTokens,
  } = {}) {
    if (!baseUrl) throw new Error('ox[anthropic]: no baseUrl configured');
    const body = buildAnthropicBody({ model, messages, tools, maxTokens });
    const res = await fetch(endpoint(baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey ?? '',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`ox[anthropic]: HTTP ${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
    }
    const parser = createAnthropicParser();
    const dec = new TextDecoder();
    for await (const chunk of res.body) {
      for (const ev of parser.push(dec.decode(chunk, { stream: true }))) yield ev;
    }
    for (const ev of parser.end(dec.decode())) yield ev;
  };
}
