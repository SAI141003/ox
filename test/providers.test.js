import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAICompatParser } from '../src/providers/openai-compat.js';
import { createAnthropicParser, buildAnthropicBody } from '../src/providers/anthropic.js';
import { createGeminiParser, buildGeminiBody, sanitizeSchema } from '../src/providers/gemini.js';

const line = (o) => `data: ${JSON.stringify(o)}\n\n`;

function feedSplit(parser, s, step = 13) {
  const evts = [];
  for (let i = 0; i < s.length; i += step) evts.push(...parser.push(s.slice(i, i + step)));
  return [...evts, ...parser.end()];
}

test('openai-compat: indexed tool_call fragments across chunks + usage tail + [DONE]', () => {
  let sse = '';
  sse += line({ choices: [{ delta: { content: 'Hel' } }] });
  sse += line({ choices: [{ delta: { content: 'lo' } }] });
  sse += line({
    choices: [
      { delta: { tool_calls: [{ index: 0, id: 'call_abc', function: { name: 'get_weather', arguments: '{"city":' } }] } },
    ],
  });
  sse += line({
    choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"SF","unit":"c"}' } }] } }],
  });
  sse += line({ choices: [{ finish_reason: 'tool_calls' }] });
  sse += line({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 34 } });
  sse += 'data: [DONE]\n\n';

  const events = feedSplit(createOpenAICompatParser(), sse);

  assert.deepEqual(events.slice(0, 2), [
    { type: 'text-delta', text: 'Hel' },
    { type: 'text-delta', text: 'lo' },
  ]);
  const tc = events.find((e) => e.type === 'tool-call');
  assert.deepEqual(tc.call, {
    id: 'call_abc',
    name: 'get_weather',
    args: { city: 'SF', unit: 'c' },
  });
  assert.deepEqual(events.find((e) => e.type === 'usage'), {
    type: 'usage',
    inputTokens: 12,
    outputTokens: 34,
  });
  assert.deepEqual(events.at(-1), { type: 'done', stopReason: 'tool_calls' });
});

test('openai-compat: usage captured from a chunk with NON-empty choices', () => {
  let sse = '';
  sse += line({ choices: [{ delta: { content: 'hey' } }, { delta: {} }], usage: { prompt_tokens: 7, completion_tokens: 8 } });
  sse += line({ choices: [{ delta: {}, finish_reason: 'stop' }] });
  sse += 'data: [DONE]\n\n';
  const events = feedSplit(createOpenAICompatParser(), sse);
  assert.deepEqual(events.find((e) => e.type === 'usage'), {
    type: 'usage',
    inputTokens: 7,
    outputTokens: 8,
  });
});

test('openai-compat: usage emitted exactly once even if repeated, and latched after finish_reason', () => {
  let sse = '';
  sse += line({ choices: [{ delta: { content: 'a' }, finish_reason: null }] });
  sse += line({
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 2 },
  });
  sse += line({ choices: [{ delta: { content: 'IGNORED-AFTER-FINISH' }, finish_reason: null }] });
  sse += line({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'late', function: { name: 'late_tool', arguments: '{}' } }] } }] });
  sse += line({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 4 } });
  sse += 'data: [DONE]\n\n';
  const events = feedSplit(createOpenAICompatParser(), sse);
  assert.deepEqual(
    events.filter((e) => e.type === 'text-delta').map((e) => e.text),
    ['a'],
    `post-finish deltas leaked: ${JSON.stringify(events)}`
  );
  assert.equal(events.filter((e) => e.type === 'tool-call').length, 0, 'post-finish tool_call leaked');
  assert.deepEqual(events.find((e) => e.type === 'usage'), {
    type: 'usage',
    inputTokens: 1,
    outputTokens: 2,
  });
  assert.equal(events.filter((e) => e.type === 'usage').length, 1, 'usage must be captured once');
  assert.deepEqual(events.at(-1), { type: 'done', stopReason: 'stop' });
});

test('openai-compat: malformed tool-arg JSON -> args=null + parseError', () => {
  let sse = '';
  sse += line({
    choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'f', arguments: '{"a":' } }] } }],
  });
  sse += line({ choices: [{ finish_reason: 'tool_calls' }] });
  sse += 'data: [DONE]\n\n';
  const events = feedSplit(createOpenAICompatParser(), sse);
  const call = events.find((e) => e.type === 'tool-call').call;
  assert.equal(call.args, null);
  assert.equal(call.parseError, true);
  assert.equal(call.name, 'f');
});

test('anthropic: full SSE sequence -> text deltas, merged tool args, usage, done', () => {
  let sse = '';
  sse += line({ type: 'message_start', message: { usage: { input_tokens: 21 } } });
  sse += line({ type: 'content_block_start', index: 0, content_block: { type: 'text' } });
  sse += line({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello ' } });
  sse += line({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'world' } });
  sse += line({ type: 'content_block_stop', index: 0 });
  sse += line({
    type: 'content_block_start',
    index: 1,
    content_block: { type: 'tool_use', id: 'toolu_01', name: 'get_weather' },
  });
  sse += line({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"city":' } });
  sse += line({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"SF","unit":"c"}' } });
  sse += line({ type: 'content_block_stop', index: 1 });
  sse += line({
    type: 'message_delta',
    delta: { stop_reason: 'tool_use' },
    usage: { output_tokens: 57 },
  });
  sse += line({ type: 'message_stop' });

  const events = feedSplit(createAnthropicParser(), sse);

  assert.deepEqual(events.filter((e) => e.type === 'text-delta'), [
    { type: 'text-delta', text: 'Hello ' },
    { type: 'text-delta', text: 'world' },
  ]);
  const calls = events.filter((e) => e.type === 'tool-call');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].call, {
    id: 'toolu_01',
    name: 'get_weather',
    args: { city: 'SF', unit: 'c' },
  });
  assert.deepEqual(events.find((e) => e.type === 'usage'), {
    type: 'usage',
    inputTokens: 21,
    outputTokens: 57,
  });
  assert.deepEqual(events.at(-1), { type: 'done', stopReason: 'tool_calls' });
});

test('gemini: parts with text + functionCall + cumulative usageMetadata emitted once', () => {
  let sse = '';
  sse += line({
    candidates: [{ content: { parts: [{ text: 'Hi' }] } }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3 },
  });
  sse += line({
    candidates: [
      { content: { parts: [{ text: ' there' }, { functionCall: { id: 'fc1', name: 'lookup', args: { q: 'ox' } } }] } },
    ],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 9 },
  });

  const parser = createGeminiParser();
  const events = [...feedSplit(parser, sse)];
  assert.deepEqual(
    events.filter((e) => e.type === 'text-delta'),
    [{ type: 'text-delta', text: 'Hi' }, { type: 'text-delta', text: ' there' }]
  );
  const calls = events.filter((e) => e.type === 'tool-call');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].call, { id: 'fc1', name: 'lookup', args: { q: 'ox' } });
  const usages = events.filter((e) => e.type === 'usage');
  assert.equal(usages.length, 1);
  assert.deepEqual(usages[0], { type: 'usage', inputTokens: 10, outputTokens: 9 });
  assert.deepEqual(events.at(-1), { type: 'done', stopReason: 'tool_calls' });
});

test('buildAnthropicBody: system top-level, consecutive role:tool merged into one user msg', () => {
  const body = buildAnthropicBody({
    model: 'claude-sonnet-5',
    maxTokens: 256,
    messages: [
      { role: 'system', content: 'be terse' },
      { role: 'system', content: 'extra sys' },
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: 'calling',
        tool_calls: [{ id: 'tu_1', function: { name: 'get_weather', arguments: '{"city":"SF"}' } }],
      },
      { role: 'tool', tool_call_id: 'tu_1', content: 'sunny' },
      { role: 'tool', tool_call_id: 'tu_2', content: 'warm' },
    ],
  });
  assert.equal(body.system, 'be terse\nextra sys');
  assert.equal(body.max_tokens, 256);
  assert.equal(body.stream, true);
  assert.equal(body.messages.length, 3);
  assert.deepEqual(body.messages[0], { role: 'user', content: [{ type: 'text', text: 'hi' }] });
  assert.deepEqual(body.messages[1].content[0], { type: 'text', text: 'calling' });
  assert.deepEqual(body.messages[1].content[1], {
    type: 'tool_use',
    id: 'tu_1',
    name: 'get_weather',
    input: { city: 'SF' },
  });
  assert.deepEqual(body.messages[2], {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'tu_1', content: 'sunny' },
      { type: 'tool_result', tool_use_id: 'tu_2', content: 'warm' },
    ],
  });
});

test('buildGeminiBody: systemInstruction + functionResponse echoes id/name', () => {
  const messages = [
    { role: 'system', content: 'be terse' },
    { role: 'user', content: 'hi' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'tu_1', function: { name: 'get_weather', arguments: '{"city":"SF"}' } },
        { id: 'tu_2', function: { name: 'get_time', arguments: '{}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'tu_1', content: 'sunny' },
    { role: 'tool', tool_call_id: 'tu_2', content: 'noon' },
  ];
  const body = buildGeminiBody({ messages, tools: [], maxTokens: 128 });
  assert.deepEqual(body.systemInstruction, { parts: [{ text: 'be terse' }] });
  assert.equal(body.generationConfig.maxOutputTokens, 128);

  const assistant = body.contents.find((c) => c.role === 'model');
  assert.deepEqual(assistant.parts[0], {
    functionCall: { id: 'tu_1', name: 'get_weather', args: { city: 'SF' } },
  });
  assert.deepEqual(assistant.parts[1], {
    functionCall: { id: 'tu_2', name: 'get_time', args: {} },
  });
  const responses = body.contents
    .flatMap((c) => c.parts)
    .filter((p) => p.functionResponse)
    .map((p) => p.functionResponse);
  assert.equal(responses.length, 2);
  assert.deepEqual(responses[0], {
    id: 'tu_1',
    name: 'get_weather',
    response: { result: 'sunny' },
  });
  assert.deepEqual(responses[1], {
    id: 'tu_2',
    name: 'get_time',
    response: { result: 'noon' },
  });
});

test('sanitizeSchema strips additionalProperties/$schema/default recursively', () => {
  const out = sanitizeSchema({
    type: 'object',
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
    properties: {
      q: { type: 'string' },
      nested: {
        type: 'object',
        additionalProperties: false,
        $schema: 'x',
        properties: { z: { type: 'number', default: 5 } },
      },
    },
    items: [{ type: 'string', $schema: 'y' }],
  });
  for (const bad of ['additionalProperties', '$schema']) {
    assert.ok(!(bad in out));
    assert.ok(!(bad in out.properties.nested));
  }
  assert.ok(!('default' in out.properties.nested.properties.z));
  assert.ok(!('$schema' in out.items[0]));
  assert.equal(out.properties.nested.properties.z.type, 'number');
  assert.equal(out.items[0].type, 'string');
});
