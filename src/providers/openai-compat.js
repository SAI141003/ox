import { imagesAt, lastImageIndex, withNote } from './images.js';
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
        // Part of prompt_tokens served from the provider's cache (OpenAI,
        // OpenRouter, xAI, Groq: prompt_tokens_details; DeepSeek: its own field).
        ...((n) => (n > 0 ? { cacheReadTokens: n } : {}))(Number(obj.usage.prompt_tokens_details?.cached_tokens ?? obj.usage.prompt_cache_hit_tokens) || 0),
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

export function toWireMessages(messages) {
  const list = messages ?? [];
  const lastImage = lastImageIndex(list);
  return list.map((m, idx) => {
    const wire = { role: m.role ?? 'user', content: m.content ?? null };
    if ((m.role ?? 'user') === 'user') {
      const { images, note } = imagesAt(list, idx, lastImage);
      if (note) wire.content = withNote(String(m.content ?? ''), note);
      if (images.length) {
        // Chat Completions vision parts; Ollama, LM Studio and vLLM accept the same shape.
        wire.content = [
          { type: 'text', text: String(m.content ?? '') || '(see image)' },
          ...images.map((im) => ({ type: 'image_url', image_url: { url: `data:${im.mediaType};base64,${im.data}` } })),
        ];
      }
    }
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

// OpenAI, DeepSeek and xAI cache a repeated prompt prefix on their own. Claude
// and Gemini behind OpenRouter cache only what is marked: the system prompt
// and the newest message get a cache_control mark (OpenRouter passes it on),
// so each turn re-reads the conversation at the cached price. Off with
// OX_PROMPT_CACHE=0.
export function withCacheMarks(wire, { name, model, env = process.env } = {}) {
  if (env.OX_PROMPT_CACHE === '0' || name !== 'openrouter' || !/anthropic\/|claude|google\/gemini/i.test(String(model ?? ''))) return wire;
  const mark = (m) => {
    if (!m) return m;
    const parts = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : Array.isArray(m.content) ? [...m.content] : null;
    if (!parts?.length || !parts.some((p) => p?.type === 'text' && p.text)) return m;
    const i = parts.map((p) => p?.type).lastIndexOf('text');
    parts[i] = { ...parts[i], cache_control: { type: 'ephemeral' } };
    return { ...m, content: parts };
  };
  const out = [...wire];
  const sys = out.findIndex((m) => m.role === 'system');
  if (sys >= 0) out[sys] = mark(out[sys]);
  const lastText = out.map((m) => m.role === 'user' || (m.role === 'tool' && typeof m.content === 'string')).lastIndexOf(true);
  if (lastText > sys && out[lastText].role === 'user') out[lastText] = mark(out[lastText]);
  return out;
}

export function makeOpenAICompat({ name = 'openai-compat' } = {}) {
  return async function* streamChat({ model, messages, tools = [], apiKey, baseUrl, signal, maxTokens } = {}) {
    if (!baseUrl) throw new Error(`ox[${name}]: no baseUrl configured for OpenAI-compatible provider`);
    const body = { model, messages: withCacheMarks(toWireMessages(messages), { name, model }), stream: true };
    if (tools.length) {
      body.tools = tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.input_schema },
      }));
    }
    // Ollama reports token counts when asked too (checked on 0.40); older
    // versions ignore the field, so asking costs nothing and the usage log
    // gets real numbers for local models instead of zeros.
    body.stream_options = { include_usage: true };
    if (maxTokens != null) body.max_tokens = maxTokens;
    const headers = { 'content-type': 'application/json' };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    // A stalled provider (no reply, or a stream that stops sending) used to hold
    // a turn for five minutes before the connection gave up (seen: 330 s on a
    // free NVIDIA endpoint). A watchdog aborts after OX_STREAM_FIRST_MS with no
    // reply or OX_STREAM_IDLE_MS with no bytes, and the agent loop retries.
    const firstMs = Number(process.env.OX_STREAM_FIRST_MS) || 120_000;
    const idleMs = Number(process.env.OX_STREAM_IDLE_MS) || 90_000;
    const watch = new AbortController();
    let stalled = null;
    let timer = null;
    const arm = (ms, why) => { clearTimeout(timer); timer = setTimeout(() => { stalled = why; watch.abort(); }, ms); timer.unref?.(); };
    const onOuter = () => watch.abort();
    if (signal) { if (signal.aborted) watch.abort(); else signal.addEventListener('abort', onOuter, { once: true }); }
    arm(firstMs, `no reply in ${Math.round(firstMs / 1000)} s`);
    const stallError = (e) => (stalled && !signal?.aborted ? new Error(`ox[${name}]: stream stalled (${stalled}) from ${model}`) : e);
    let res;
    try {
      res = await fetch(`${trimBase(baseUrl)}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: watch.signal,
      });
    } catch (e) { clearTimeout(timer); throw stallError(e); }
    arm(idleMs, `nothing for ${Math.round(idleMs / 1000)} s`);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`ox[${name}]: HTTP ${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
    }
    const parser = createOpenAICompatParser({ name });
    const dec = new TextDecoder();
    // A local server whose context window is smaller than the request silently
    // drops the front of it (Ollama does), so the model works without part of
    // its instructions. Counted tokens far below the request's size is the sign.
    const sentChars = JSON.stringify(body.messages).length + JSON.stringify(body.tools ?? []).length;
    const check = (ev) => {
      if (ev?.type === 'usage' && isLocalBase(baseUrl)) {
        const warning = truncationWarning(ev.inputTokens, sentChars, baseUrl);
        if (warning && !warnedTruncation.has(baseUrl)) { warnedTruncation.add(baseUrl); process.stderr.write(`${warning}\n`); }
      }
      return ev;
    };
    // Ollama, streaming with tools attached, swallows an answer that starts like
    // a tool call (a code fence or JSON) and sends nothing in its place: tokens
    // counted, no text, no call (seen on 0.40 with qwen2.5). The same request
    // without streaming returns the answer, so that is asked once instead.
    let sawText = false, sawCall = false, outTokens = 0, done = null;
    const seen = (ev) => {
      if (ev.type === 'text-delta') sawText = true;
      else if (ev.type === 'tool-call') sawCall = true;
      else if (ev.type === 'usage') outTokens = ev.outputTokens;
      return check(ev);
    };
    try {
      for await (const chunk of res.body) {
        arm(idleMs, `nothing for ${Math.round(idleMs / 1000)} s`);
        for (const ev of parser.push(dec.decode(chunk, { stream: true }))) { if (ev.type === 'done') { done = ev; continue; } yield seen(ev); }
      }
    } catch (e) { throw stallError(e); } finally { clearTimeout(timer); signal?.removeEventListener?.('abort', onOuter); }
    for (const ev of parser.end(dec.decode())) { if (ev.type === 'done') { done = ev; continue; } yield seen(ev); }
    if (!sawText && !sawCall && outTokens > 0 && body.tools) {
      // First recover the Ollama streaming quirk.  If its non-streaming retry
      // is empty too, this is not a successful assistant answer.  Throw a
      // classified failure so the agent loop retries once without tools and
      // tells the user that code actions were not available on this model.
      let recoveredMeaningful = false;
      for await (const ev of recoverSwallowed({ name, baseUrl, headers, body, signal })) {
        if (ev.type === 'text-delta' && ev.text) recoveredMeaningful = true;
        if (ev.type === 'tool-call') recoveredMeaningful = true;
        yield ev;
      }
      if (!recoveredMeaningful) {
        throw new Error(`ox[${name}]: empty response with tools from ${model}`);
      }
      return;
    }
    if (done) yield done;
  };
}

// The non-streaming retry for an answer a server dropped from its stream.
export async function* recoverSwallowed({ name, baseUrl, headers, body, signal, fetchImpl = fetch }) {
  const { stream_options: _, ...plain } = body;
  const res = await fetchImpl(`${trimBase(baseUrl)}/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ ...plain, stream: false }), signal });
  if (!res.ok) throw new Error(`ox[${name}]: HTTP ${res.status} ${res.statusText}: ${(await res.text()).slice(0, 300)}`);
  const j = await res.json();
  const choice = j.choices?.[0] ?? {};
  const msg = choice.message ?? {};
  if (j.usage) yield { type: 'usage', inputTokens: Number(j.usage.prompt_tokens) || 0, outputTokens: Number(j.usage.completion_tokens) || 0 };
  if (typeof msg.content === 'string' && msg.content) yield { type: 'text-delta', text: msg.content };
  const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  for (const c of calls) {
    let args = null, parseError = false;
    try { args = JSON.parse(c.function?.arguments || '{}'); } catch { parseError = true; }
    yield { type: 'tool-call', call: { id: c.id ?? '', name: c.function?.name ?? '', args, ...(parseError ? { parseError: true } : {}) } };
  }
  yield { type: 'done', stopReason: calls.length ? 'tool_calls' : choice.finish_reason === 'length' ? 'length' : 'stop' };
}

const warnedTruncation = new Set();
const isLocalBase = (u) => /\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:|\/)/.test(String(u));

// ~4 characters a token for English and code. A count under half of that is a
// cut prompt, not a tokenizer difference.
export function truncationWarning(promptTokens, sentChars, baseUrl = '') {
  const expected = Math.round(sentChars / 4);
  if (!(promptTokens > 0) || expected < 1500 || promptTokens >= expected * 0.5) return null;
  const ollama = String(baseUrl).includes(':11434');
  return `ox: the local model saw about ${promptTokens} of the ~${expected} tokens ox sent — its context window cut the rest, so it is missing part of its instructions.${ollama ? ' Raise it: OLLAMA_CONTEXT_LENGTH=16384 ollama serve (or set num_ctx on the model).' : ' Raise the server\'s context length.'}`;
}
