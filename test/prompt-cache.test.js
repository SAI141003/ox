import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAnthropicBody, createAnthropicParser } from '../src/providers/anthropic.js';
import { createOpenAICompatParser, withCacheMarks } from '../src/providers/openai-compat.js';
import { costOf, cacheRates } from '../src/cost.js';
import { normalizeStreamEvent } from '../src/agent.js';

const convo = [
  { role: 'system', content: 'You are ox.' },
  { role: 'user', content: 'read a.js' },
  { role: 'assistant', content: '', tool_calls: [{ id: 't1', function: { name: 'read_file', arguments: '{"path":"a.js"}' } }] },
  { role: 'tool', tool_call_id: 't1', content: 'export const a = 1;' },
];

test('Anthropic: the system prompt and the newest message carry cache breakpoints', () => {
  const b = buildAnthropicBody({ model: 'claude-sonnet-5-5', messages: convo, tools: [{ name: 'read_file', description: 'd', input_schema: { type: 'object' } }] });
  assert.deepEqual(b.system, [{ type: 'text', text: 'You are ox.', cache_control: { type: 'ephemeral' } }]);
  assert.deepEqual(b.messages.at(-1).content.at(-1).cache_control, { type: 'ephemeral' });
  assert.equal(b.messages[0].content.at(-1).cache_control, undefined, 'only the newest message');
  const marks = JSON.stringify(b).match(/cache_control/g).length;
  assert.ok(marks <= 4, 'Anthropic allows at most 4 breakpoints');
});

test('Anthropic: OX_PROMPT_CACHE=0 sends the plain request', () => {
  process.env.OX_PROMPT_CACHE = '0';
  try {
    const b = buildAnthropicBody({ model: 'claude-sonnet-5-5', messages: convo, tools: [] });
    assert.equal(b.system, 'You are ox.');
    assert.ok(!JSON.stringify(b).includes('cache_control'));
  } finally { delete process.env.OX_PROMPT_CACHE; }
});

test('Anthropic: cached and cache-written tokens are counted into the prompt and reported', () => {
  const p = createAnthropicParser();
  const evs = [];
  const feed = (o) => evs.push(...p.push(`data: ${JSON.stringify(o)}\n\n`));
  feed({ type: 'message_start', message: { usage: { input_tokens: 20, cache_read_input_tokens: 9000, cache_creation_input_tokens: 500 } } });
  feed({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 40 } });
  const u = evs.find((e) => e.type === 'usage');
  assert.deepEqual(u, { type: 'usage', inputTokens: 9520, outputTokens: 40, cacheReadTokens: 9000, cacheWriteTokens: 500 });
});

test('OpenAI-compatible: cached_tokens (and DeepSeek prompt_cache_hit_tokens) are reported', () => {
  for (const usage of [{ prompt_tokens: 5000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 4096 } }, { prompt_tokens: 5000, completion_tokens: 10, prompt_cache_hit_tokens: 4096 }]) {
    const p = createOpenAICompatParser();
    const evs = p.push(`data: ${JSON.stringify({ choices: [], usage })}\n\n`);
    assert.equal(evs.find((e) => e.type === 'usage')?.cacheReadTokens, 4096);
  }
});

test('OpenRouter: Claude and Gemini get cache marks on the system prompt and the last user message; others do not', () => {
  const wire = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' }, { role: 'user', content: 'q2' }];
  const marked = withCacheMarks(wire, { name: 'openrouter', model: 'anthropic/claude-sonnet-4.5', env: {} });
  assert.deepEqual(marked[0].content, [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }]);
  assert.deepEqual(marked[3].content, [{ type: 'text', text: 'q2', cache_control: { type: 'ephemeral' } }]);
  assert.equal(marked[1].content, 'q1');
  assert.equal(withCacheMarks(wire, { name: 'openrouter', model: 'openai/gpt-5', env: {} }), wire, 'OpenAI caches on its own');
  assert.equal(withCacheMarks(wire, { name: 'openai', model: 'claude', env: {} }), wire);
  assert.equal(withCacheMarks(wire, { name: 'openrouter', model: 'google/gemini-3-pro', env: { OX_PROMPT_CACHE: '0' } }), wire);
});

test('costOf: cached input is billed at the cached rate', () => {
  const overrides = { 'claude-x': { in: 3, out: 15 } };
  const full = costOf('claude-x', { inputTokens: 10_000, outputTokens: 0 }, overrides);
  const cached = costOf('claude-x', { inputTokens: 10_000, outputTokens: 0, cacheReadTokens: 9_000 }, overrides);
  assert.equal(full, 0.03);
  assert.ok(Math.abs(cached - (1_000 * 3 + 9_000 * 3 * 0.1) / 1e6) < 1e-12);
  assert.deepEqual(cacheRates('claude-opus-5-5'), { read: 0.1, write: 2 });
  assert.deepEqual(cacheRates('deepseek-v4-pro'), { read: 0.1, write: 1 });
  assert.deepEqual(cacheRates('gpt-5.6-sol'), { read: 0.5, write: 1 });
});

test('the agent keeps cache counts on usage events', () => {
  assert.deepEqual(normalizeStreamEvent({ type: 'usage', inputTokens: 100, outputTokens: 5, cacheReadTokens: 80 }), { kind: 'usage', usage: { inputTokens: 100, outputTokens: 5, cacheReadTokens: 80 } });
});
