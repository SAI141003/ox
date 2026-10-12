import { imagesAt, lastImageIndex, withNote } from './images.js';
export function sanitizeSchema(value) {
  if (Array.isArray(value)) return value.map(sanitizeSchema);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === 'additionalProperties' || k === '$schema' || k === 'default') continue;
      out[k] = sanitizeSchema(v);
    }
    return out;
  }
  return value;
}

function parseArgsOrEmpty(raw) {
  try {
    const v = JSON.parse(raw || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

function toolNameFor(messages, toolMsg) {
  if (toolMsg.name) return toolMsg.name;
  const id = toolMsg.tool_call_id;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue;
    const hit = m.tool_calls.find((c) => c.id === id);
    if (hit) return hit.function?.name ?? id ?? 'unknown';
  }
  return id ?? 'unknown';
}

export function buildGeminiBody({ messages, tools, maxTokens }) {
  const sys = [];
  const contents = [];
  const lastImage = lastImageIndex(messages);
  for (const [idx, m] of messages.entries()) {
    if (m.role === 'system') {
      sys.push(String(m.content ?? ''));
      continue;
    }
    if (m.role === 'assistant') {
      const parts = [];
      if (typeof m.content === 'string' && m.content) parts.push({ text: m.content });
      for (const c of m.tool_calls ?? []) {
        parts.push({
          functionCall: { id: c.id, name: c.function?.name ?? '', args: parseArgsOrEmpty(c.function?.arguments) },
        });
      }
      contents.push({ role: 'model', parts: parts.length ? parts : [{ text: '(empty)' }] });
      continue;
    }
    if (m.role === 'tool') {
      contents.push({
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: m.tool_call_id,
              name: toolNameFor(messages, m),
              response: { result: String(m.content ?? '') },
            },
          },
        ],
      });
      continue;
    }
    const { images, note } = imagesAt(messages, idx, lastImage);
    contents.push({
      role: 'user',
      parts: [
        ...images.map((im) => ({ inlineData: { mimeType: im.mediaType, data: im.data } })),
        { text: withNote(String(m.content ?? ''), note) || '(see image)' },
      ],
    });
  }
  const body = { contents, generationConfig: { maxOutputTokens: maxTokens || 4096 } };
  if (sys.length) body.systemInstruction = { parts: [{ text: sys.join('\n') }] };
  if (tools?.length) {
    body.tools = [
      {
        functionDeclarations: tools.map((t) => {
          const decl = { name: t.name };
          if (t.description != null) decl.description = t.description;
          if (t.input_schema) decl.parameters = sanitizeSchema(t.input_schema);
          return decl;
        }),
      },
    ];
  }
  return body;
}

export function createGeminiParser() {
  let buf = '';
  let counter = 0;
  let sawFunctionCall = false;
  let finishReason = null;
  let usage = null;
  let finalized = false;

  const finalize = (events) => {
    if (finalized) return;
    finalized = true;
    if (usage) {
      events.push({ type: 'usage', inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });
    }
    const truncated = finishReason === 'MAX_TOKENS' || finishReason === 'LENGTH';
    events.push({ type: 'done', stopReason: sawFunctionCall ? 'tool_calls' : truncated ? 'length' : 'stop' });
  };

  const handlePayload = (payload, events) => {
    let obj;
    try {
      obj = JSON.parse(payload);
    } catch {
      return;
    }
    if (!obj || typeof obj !== 'object') return;
    const cand = obj.candidates?.[0];
    if (cand?.finishReason) finishReason = String(cand.finishReason);
    const parts = cand?.content?.parts;
    if (Array.isArray(parts)) {
      for (const part of parts) {
        if (typeof part.text === 'string' && part.text) {
          events.push({ type: 'text-delta', text: part.text });
        }
        const fc = part.functionCall;
        if (fc && fc.name) {
          counter++;
          sawFunctionCall = true;
          events.push({
            type: 'tool-call',
            call: {
              id: fc.id || `gem_${counter}`,
              name: fc.name,
              args: fc.args && typeof fc.args === 'object' && !Array.isArray(fc.args) ? fc.args : {},
            },
          });
        }
      }
    }
    const um = obj.usageMetadata;
    if (um) {
      usage = {
        inputTokens: Number(um.promptTokenCount) || 0,
        outputTokens: Number(um.candidatesTokenCount) || 0,
      };
    }
  };

  const consumeLine = (line, events) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;
    const payload = trimmed.slice(5).trim();
    if (!payload) return;
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

export function makeGemini() {
  return async function* streamChat({
    model,
    messages = [],
    tools = [],
    apiKey,
    baseUrl,
    signal,
    maxTokens,
  } = {}) {
    if (!baseUrl) throw new Error('ox[gemini]: no baseUrl configured');
    if (!model) throw new Error('ox[gemini]: no model specified');
    const body = buildGeminiBody({ messages, tools, maxTokens });
    const url = `${String(baseUrl).replace(/\/+$/, '')}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey ?? '' },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`ox[gemini]: HTTP ${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
    }
    const parser = createGeminiParser();
    const dec = new TextDecoder();
    for await (const chunk of res.body) {
      for (const ev of parser.push(dec.decode(chunk, { stream: true }))) yield ev;
    }
    for (const ev of parser.end(dec.decode())) yield ev;
  };
}
