import { imagesAt, lastImageIndex, withNote } from './images.js';

const trimBase = (value) => String(value).replace(/\/+$/, '');

/** Convert Ox's transcript/tool format to the typed input items accepted by Responses. */
export function toResponseInput(messages = []) {
  const lastImage = lastImageIndex(messages);
  const input = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i] ?? {};
    const role = message.role ?? 'user';
    if (role === 'tool') {
      input.push({ type: 'function_call_output', call_id: String(message.tool_call_id ?? ''), output: String(message.content ?? '') });
      continue;
    }
    if (role === 'assistant' && Array.isArray(message.tool_calls)) {
      if (typeof message.content === 'string' && message.content) input.push({ role: 'assistant', content: message.content });
      for (const call of message.tool_calls) {
        input.push({
          type: 'function_call',
          call_id: String(call?.id ?? ''),
          name: String(call?.function?.name ?? ''),
          arguments: String(call?.function?.arguments ?? '{}'),
        });
      }
      continue;
    }
    let content = String(message.content ?? '');
    if (role === 'user') {
      const { images, note } = imagesAt(messages, i, lastImage);
      if (note) content = withNote(content, note);
      if (images.length) {
        input.push({ role, content: [
          { type: 'input_text', text: content || '(see image)' },
          ...images.map((image) => ({ type: 'input_image', image_url: `data:${image.mediaType};base64,${image.data}` })),
        ] });
        continue;
      }
    }
    input.push({ role, content });
  }
  return input;
}

/** Parse OpenAI Responses SSE events into the provider-neutral Ox stream contract. */
export function createOpenAIResponsesParser({ name = 'openai' } = {}) {
  let buffer = '';
  let dataLines = [];
  let finalized = false;
  let stopReason = 'stop';
  let sawToolCall = false;
  const calls = new Map();
  const emittedCalls = new Set();

  const emitCall = (itemId, argumentsText, events) => {
    const call = calls.get(itemId);
    if (!call || emittedCalls.has(itemId)) return;
    emittedCalls.add(itemId);
    let args;
    let parseError = false;
    try { args = JSON.parse(argumentsText || call.arguments || '{}'); }
    catch { args = null; parseError = true; }
    sawToolCall = true;
    events.push({ type: 'tool-call', call: { id: call.call_id, name: call.name, args, ...(parseError ? { parseError: true } : {}) } });
  };

  const handle = (payload, events) => {
    if (!payload || payload === '[DONE]') return;
    let event;
    try { event = JSON.parse(payload); } catch { return; }
    if (!event || typeof event !== 'object') return;
    const type = String(event.type ?? '');
    if (type === 'error' || type === 'response.failed') {
      const error = event.error ?? event.response?.error ?? {};
      throw new Error(`ox[${name}]: ${error.message ?? event.message ?? error.code ?? 'Responses request failed'}`);
    }
    if (type === 'response.output_text.delta' && typeof event.delta === 'string' && event.delta) {
      events.push({ type: 'text-delta', text: event.delta });
    } else if (type === 'response.refusal.delta' && typeof event.delta === 'string' && event.delta) {
      events.push({ type: 'text-delta', text: event.delta });
    } else if (type === 'response.output_item.added' || type === 'response.output_item.done') {
      const item = event.item;
      if (item?.type === 'function_call') {
        const id = String(event.item_id ?? item.id ?? '');
        calls.set(id, { call_id: String(item.call_id ?? ''), name: String(item.name ?? ''), arguments: String(item.arguments ?? '') });
        if (type === 'response.output_item.done') emitCall(id, item.arguments, events);
      }
    } else if (type === 'response.function_call_arguments.delta') {
      const id = String(event.item_id ?? '');
      const call = calls.get(id);
      if (call && typeof event.delta === 'string') call.arguments += event.delta;
    } else if (type === 'response.function_call_arguments.done') {
      emitCall(String(event.item_id ?? ''), event.arguments, events);
    } else if (type === 'response.completed') {
      const response = event.response ?? {};
      const usage = response.usage;
      if (usage) {
        const cacheReadTokens = Number(usage.input_tokens_details?.cached_tokens) || 0;
        const reasoningTokens = Number(usage.output_tokens_details?.reasoning_tokens) || 0;
        events.push({ type: 'usage', inputTokens: Number(usage.input_tokens) || 0, outputTokens: Number(usage.output_tokens) || 0,
          ...(cacheReadTokens ? { cacheReadTokens } : {}), ...(reasoningTokens ? { reasoningTokens } : {}) });
      }
      if (response.status === 'incomplete' && response.incomplete_details?.reason === 'max_output_tokens') stopReason = 'length';
      if (sawToolCall) stopReason = 'tool_calls';
      if (!finalized) { finalized = true; events.push({ type: 'done', stopReason }); }
    }
  };

  const consumeFrame = (events) => {
    if (dataLines.length) handle(dataLines.join('\n'), events);
    dataLines = [];
  };
  return {
    push(chunk) {
      const events = [];
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (!line) consumeFrame(events);
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
      }
      return events;
    },
    end() {
      const events = [];
      if (buffer) {
        const line = buffer.replace(/\r$/, '');
        if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
      }
      consumeFrame(events);
      if (!finalized) { finalized = true; events.push({ type: 'done', stopReason: sawToolCall ? 'tool_calls' : stopReason }); }
      return events;
    },
  };
}

export function makeOpenAIResponses({ fetchImpl = fetch } = {}) {
  return async function* streamChat({ model, messages = [], tools = [], apiKey, baseUrl, signal, maxTokens, reasoningEffort } = {}) {
    if (!baseUrl) throw new Error('ox[openai]: no baseUrl configured for Responses API');
    const effortOptions = /^gpt-6-luna$/i.test(String(model))
      ? ['none', 'low', 'medium', 'high', 'xhigh', 'max']
      : /^gpt-6(?:\.1-sol|-astra)$/i.test(String(model))
        ? ['low', 'medium', 'high', 'xhigh', 'max']
        : null;
    if (reasoningEffort && effortOptions && !effortOptions.includes(reasoningEffort)) {
      throw new Error(`ox[openai]: reasoning effort '${reasoningEffort}' is not supported by ${model}; choose ${effortOptions.join(', ')}`);
    }
    const body = {
      model,
      input: toResponseInput(messages),
      stream: true,
      ...(tools.length ? { tools: tools.map((tool) => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.input_schema })) } : {}),
      ...(maxTokens != null ? { max_output_tokens: maxTokens } : {}),
      ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
    };
    const headers = { 'content-type': 'application/json' };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    const response = await fetchImpl(`${trimBase(baseUrl)}/responses`, { method: 'POST', headers, body: JSON.stringify(body), signal });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      throw new Error(`ox[openai]: Responses API HTTP ${response.status} ${response.statusText}: ${detail}`);
    }
    if (!response.body) throw new Error('ox[openai]: Responses API returned an empty stream');
    const parser = createOpenAIResponsesParser();
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      for (const event of parser.push(decoder.decode(chunk, { stream: true }))) yield event;
    }
    for (const event of parser.push(decoder.decode())) yield event;
    for (const event of parser.end()) yield event;
  };
}
