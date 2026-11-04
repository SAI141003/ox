// Follow-up suggestions: whatever list shape a model returns becomes three
// short questions; preambles and over-long lines are dropped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answerStart, parseFollowups } from '../src/followups.js';

test('numbered, bulleted, quoted or plain lines all become clean questions', () => {
  assert.deepEqual(parseFollowups('Here are three:\n1. What about taxes?\n2) Can I pay early?\n- "How is interest computed?"\n4. extra one'), ['What about taxes?', 'Can I pay early?', 'How is interest computed?']);
  assert.deepEqual(parseFollowups('Sure!\n\n• Compare two loans\n↳ Add extra payments'), ['Compare two loans', 'Add extra payments']);
  assert.deepEqual(parseFollowups(`${'x'.repeat(120)}\nok?`), ['ok?']);
  assert.deepEqual(parseFollowups(''), []);
});

test('an answer that is only a drawn card still has something to suggest from', () => {
  assert.equal(answerStart('Done, it runs.\n```openui\nroot = Card("x", [])\n```'), 'Done, it runs.');
  assert.match(answerStart('```openui\nroot = Card("Run YOLO", [])\n```'), /Run YOLO/);
  assert.equal(answerStart(''), '');
});

test('a small call on NVIDIA asks for no hidden thinking, and other hosts are not sent the field', async () => {
  const { makeOpenAICompat } = await import('../src/providers/openai-compat.js');
  const real = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (_u, o) => {
    bodies.push(JSON.parse(o.body));
    return new Response('data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  try {
    for (const name of ['nvidia', 'groq']) {
      const stream = makeOpenAICompat({ name })({ model: 'm', messages: [{ role: 'user', content: 'hi' }], apiKey: 'k', baseUrl: 'http://x.invalid/v1', maxTokens: 50, reasoningEffort: 'none' });
      for await (const _e of stream) { /* drain */ }
    }
  } finally { globalThis.fetch = real; }
  assert.equal(bodies[0].reasoning_effort, 'none');
  assert.equal(bodies[1].reasoning_effort, undefined);
});

