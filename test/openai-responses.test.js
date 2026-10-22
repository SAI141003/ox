import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeOpenAIResponses, toResponseInput, createOpenAIResponsesParser } from '../src/providers/openai-responses.js';
import { getProvider } from '../src/providers/index.js';

const frame = (event) => `data: ${JSON.stringify(event)}\r\n\r\n`;

function parseSplit(parser, text, size = 7) {
  const events = [];
  for (let i = 0; i < text.length; i += size) events.push(...parser.push(text.slice(i, i + size)));
  return [...events, ...parser.end()];
}

test('Responses input maps tool turns and retains only the newest user image', () => {
  const messages = [
    { role: 'system', content: 'Be concise' },
    { role: 'user', content: 'old image', images: [{ mediaType: 'image/png', data: 'OLD' }] },
    { role: 'assistant', content: 'Looking', tool_calls: [{ id: 'call_1', function: { name: 'lookup', arguments: '{"q":"x"}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: 'found it' },
    { role: 'user', content: 'inspect this', images: [{ mediaType: 'image/jpeg', data: 'NEW' }] },
  ];
  assert.deepEqual(toResponseInput(messages), [
    { role: 'system', content: 'Be concise' },
    { role: 'user', content: '[1 earlier screenshot(s) omitted]\nold image' },
    { role: 'assistant', content: 'Looking' },
    { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"q":"x"}' },
    { type: 'function_call_output', call_id: 'call_1', output: 'found it' },
    { role: 'user', content: [
      { type: 'input_text', text: 'inspect this' },
      { type: 'input_image', image_url: 'data:image/jpeg;base64,NEW' },
    ] },
  ]);
});

test('Responses SSE parser emits text, one assembled tool call, usage, and completion', () => {
  const stream = [
    { type: 'response.output_text.delta', delta: 'Hello' },
    { type: 'response.output_item.added', item_id: 'fc_item', item: { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '' } },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_item', delta: '{"q":' },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_item', delta: '"ox"}' },
    { type: 'response.function_call_arguments.done', item_id: 'fc_item', arguments: '{"q":"ox"}' },
    { type: 'response.output_item.done', item_id: 'fc_item', item: { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"q":"ox"}' } },
    { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 120, output_tokens: 18, input_tokens_details: { cached_tokens: 40 }, output_tokens_details: { reasoning_tokens: 7 } } } },
  ].map(frame).join('');
  const events = parseSplit(createOpenAIResponsesParser(), stream);
  assert.deepEqual(events.filter((event) => event.type === 'text-delta'), [{ type: 'text-delta', text: 'Hello' }]);
  assert.deepEqual(events.filter((event) => event.type === 'tool-call'), [
    { type: 'tool-call', call: { id: 'call_1', name: 'lookup', args: { q: 'ox' } } },
  ]);
  assert.deepEqual(events.find((event) => event.type === 'usage'), {
    type: 'usage', inputTokens: 120, outputTokens: 18, cacheReadTokens: 40, reasoningTokens: 7,
  });
  assert.deepEqual(events.at(-1), { type: 'done', stopReason: 'tool_calls' });
});

test('Responses parser reports truncation and provider failures', () => {
  const truncated = parseSplit(createOpenAIResponsesParser(), frame({
    type: 'response.completed', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } },
  }));
  assert.deepEqual(truncated.at(-1), { type: 'done', stopReason: 'length' });
  const parser = createOpenAIResponsesParser();
  assert.throws(() => parser.push(frame({ type: 'response.failed', response: { error: { message: 'unavailable' } } })), /unavailable/);
});

test('Responses adapter sends the Responses wire format and consumes streamed events', async () => {
  let captured;
  const fakeFetch = async (url, options) => {
    captured = { url, options, body: JSON.parse(options.body) };
    return new Response([
      frame({ type: 'response.output_text.delta', delta: 'ok' }),
      frame({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 3, output_tokens: 1 } } }),
    ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const adapter = makeOpenAIResponses({ fetchImpl: fakeFetch });
  const events = [];
  for await (const event of adapter({
    model: 'gpt-6-luna', baseUrl: 'https://api.openai.com/v1/', apiKey: 'test-key',
    messages: [{ role: 'user', content: 'hi' }], maxTokens: 64, reasoningEffort: 'none',
    tools: [{ name: 'lookup', description: 'Look up', input_schema: { type: 'object', properties: { q: { type: 'string' } } } }],
  })) events.push(event);
  assert.equal(captured.url, 'https://api.openai.com/v1/responses');
  assert.equal(captured.options.headers.authorization, 'Bearer test-key');
  assert.deepEqual(captured.body.tools, [{ type: 'function', name: 'lookup', description: 'Look up', parameters: { type: 'object', properties: { q: { type: 'string' } } } }]);
  assert.equal(captured.body.max_output_tokens, 64);
  assert.deepEqual(captured.body.reasoning, { effort: 'none' });
  assert.deepEqual(events.filter((event) => event.type === 'text-delta'), [{ type: 'text-delta', text: 'ok' }]);
  assert.deepEqual(events.at(-1), { type: 'done', stopReason: 'stop' });
});

test('Responses adapter rejects unsupported model reasoning settings before network access', async () => {
  let called = false;
  const adapter = makeOpenAIResponses({ fetchImpl: async () => { called = true; throw new Error('should not fetch'); } });
  await assert.rejects(async () => {
    for await (const _ of adapter({ model: 'gpt-6.1-sol', baseUrl: 'https://api.openai.com/v1', reasoningEffort: 'none' })) { /* consume */ }
  }, /not supported by gpt-6.1-sol; choose low, medium, high, xhigh, max/);
  assert.equal(called, false);
});

test('OpenAI routes only GPT-6 tool calls to Responses; legacy model calls remain Chat Completions', async (t) => {
  const originalFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    const payload = String(url).endsWith('/responses')
      ? frame({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } } })
      : 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\ndata: [DONE]\n\n';
    return new Response(payload, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const openai = getProvider('openai');
  const common = { baseUrl: 'https://api.openai.com/v1', messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 'f', input_schema: { type: 'object' } }] };
  for await (const _ of openai.streamChat({ ...common, model: 'gpt-6-luna' })) { /* consume */ }
  for await (const _ of openai.streamChat({ ...common, model: 'gpt-5.6-sol' })) { /* consume */ }
  assert.deepEqual(urls, ['https://api.openai.com/v1/responses', 'https://api.openai.com/v1/chat/completions']);
});
