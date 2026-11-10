// A session's requests repeat their earlier messages exactly, so the provider's
// prompt cache keeps hitting: memory notes stay where they were, hidden output
// stays hidden the same way, and the providers get the fields that keep a cache.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionCache, withMemoryNotes, freshPart, cacheIsCold, CACHE_TTL_MS, forgetSessionCache } from '../src/session-cache.js';
import { maskOldOutputs } from '../src/context-mask.js';
import { buildAnthropicBody, longCacheFor } from '../src/providers/anthropic.js';
import { cacheFields } from '../src/providers/openai-compat.js';

const PROFILE = '# WHAT OX REMEMBERS\nAbout the user (always true until they say otherwise):\n- I work at Stripe\n- I prefer short answers';

test('the memory note stays on the message it was on, turn after turn', () => {
  const sid = 'sc-notes-1';
  forgetSessionCache(sid);
  const turn1 = [{ role: 'system', content: 's' }, { role: 'user', content: 'fix the test' }];
  const sent1 = withMemoryNotes(turn1, PROFILE, sessionCache(sid));
  assert.match(sent1[1].content, /^<recalled-memory>\n# WHAT OX REMEMBERS/);
  // The client sends the conversation again without the note, plus a new message.
  const turn2 = [...turn1, { role: 'assistant', content: 'done' }, { role: 'user', content: 'now the linter' }];
  const sent2 = withMemoryNotes(turn2, `${PROFILE}\n\nRemembered and relevant to this task:\n- To lint this project: \`npm run lint\``, sessionCache(sid));
  assert.equal(sent2[1].content, sent1[1].content, 'the first message is byte-identical to what was cached');
  assert.match(sent2[3].content, /npm run lint/);
  assert.ok(!sent2[3].content.includes('I work at Stripe'), 'the profile is not sent a second time');
  // Nothing new for a third message: no note at all, and the earlier two stay.
  const turn3 = [...turn2, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'thanks' }];
  const sent3 = withMemoryNotes(turn3, PROFILE, sessionCache(sid));
  assert.equal(sent3[5].content, 'thanks');
  assert.deepEqual(sent3.slice(0, 4), sent2);
  // Asked again (a retry of the same last message): the same note, not a new one.
  assert.deepEqual(withMemoryNotes(turn2, 'something else entirely\n- x', sessionCache(sid)), sent2);
});

test('a message with parts keeps its parts; no memory means no note', () => {
  const h = [{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', data: 'x' }] }];
  const out = withMemoryNotes(h, PROFILE, sessionCache(null));
  assert.equal(out[0].content.length, 3);
  assert.match(out[0].content[0].text, /recalled-memory/);
  assert.deepEqual(withMemoryNotes(h, '', sessionCache(null)), h);
  assert.equal(freshPart('- a\n- ab', '- ab\n'), '- a');
  assert.equal(freshPart('prose only', 'x'), 'prose only');
});

test('hidden output is hidden again the same way when the client resends it in full', () => {
  const big = (c) => c.repeat(30_000);
  const call = (id) => ({ role: 'assistant', content: '', tool_calls: [{ id, function: { name: 'read_file', arguments: JSON.stringify({ path: `${id}.js` }) } }] });
  const base = [{ role: 'user', content: 'go' }];
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) base.push(call(id), { role: 'tool', tool_call_id: id, content: big(id) });
  const hidden = new Map();
  const first = maskOldOutputs(base, { hidden });
  assert.ok(first[2].content.startsWith('[hidden to save context:'));
  assert.ok(hidden.size >= 3);
  // Next message: the original outputs come back, and a short conversation tail. Below the
  // trigger for a new batch, yet what was hidden stays hidden, word for word.
  const resent = base.slice(0, 7);
  const second = maskOldOutputs(resent, { hidden, triggerChars: 10_000_000 });
  assert.deepEqual(second.slice(0, 7).map((m) => m.content), first.slice(0, 7).map((m) => m.content));
  assert.equal(maskOldOutputs(resent, { triggerChars: 10_000_000 }), resent, 'without the session nothing is hidden');
});

test('after a pause the cache is cold, and only then', () => {
  const s = sessionCache(null);
  assert.equal(cacheIsCold(s, 1e12), false, 'no request yet');
  s.lastAt = 1_000_000;
  assert.equal(cacheIsCold(s, 1_000_000 + CACHE_TTL_MS - 1), false);
  assert.equal(cacheIsCold(s, 1_000_000 + CACHE_TTL_MS + 1), true);
});

test('Anthropic: three breakpoints, the previous one included, and an hour for a session', () => {
  const messages = [
    { role: 'system', content: 'sys' }, { role: 'user', content: 'q1' },
    { role: 'assistant', content: '', tool_calls: [{ id: 't1', function: { name: 'x', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 't1', content: 'r1' },
    { role: 'assistant', content: '', tool_calls: [{ id: 't2', function: { name: 'x', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 't2', content: 'r2' },
  ];
  const body = buildAnthropicBody({ model: 'claude-sonnet-5-5', messages, tools: [], longCache: true });
  assert.deepEqual(body.system[0].cache_control, { type: 'ephemeral', ttl: '1h' });
  const marked = body.messages.map((m) => m.content.some((b) => b.cache_control));
  assert.deepEqual(marked, [false, false, true, false, true], 'the previous tool result and the newest one');
  assert.ok(JSON.stringify(body).split('"cache_control"').length - 1 <= 4, 'at most four breakpoints');
  assert.deepEqual(buildAnthropicBody({ model: 'm', messages, tools: [] }).system[0].cache_control, { type: 'ephemeral' });
  assert.equal(longCacheFor({ model: 'claude-sonnet-5-5', session: true, env: {} }), true);
  assert.equal(longCacheFor({ model: 'claude-sonnet-5-5', session: false, env: {} }), false);
  assert.equal(longCacheFor({ model: 'claude-3-5-sonnet', session: true, env: {} }), false);
  assert.equal(longCacheFor({ model: 'claude-sonnet-5-5', session: true, env: { OX_PROMPT_CACHE_TTL: '5m' } }), false);
});

test('OpenAI and OpenRouter get a cache key that says nothing about the session', () => {
  const f = cacheFields({ name: 'openai', model: 'gpt-6.1-sol', cacheKey: 'my private session name', env: {} });
  assert.match(f.prompt_cache_key, /^ox-[0-9a-f]{32}$/);
  assert.ok(!JSON.stringify(f).includes('private'));
  assert.equal(f.prompt_cache_retention, undefined);
  assert.equal(cacheFields({ name: 'openai', model: 'm', cacheKey: 'k', env: { OX_PROMPT_CACHE_RETENTION: '24h' } }).prompt_cache_retention, '24h');
  assert.deepEqual(cacheFields({ name: 'openrouter', model: 'anthropic/claude-sonnet-5.5', env: {} }), { cache_control: { type: 'ephemeral' } });
  assert.deepEqual(cacheFields({ name: 'groq', model: 'm', cacheKey: 'k', env: {} }), {}, 'a host that may refuse unknown fields gets none');
  assert.deepEqual(cacheFields({ name: 'openai', model: 'm', cacheKey: 'k', env: { OX_PROMPT_CACHE: '0' } }), {});
});
