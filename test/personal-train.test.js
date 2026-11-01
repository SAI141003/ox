import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('your own model: examples pasted as Q/A or JSON lines, split so a full batch is held out', async () => {
  const P = await import('../src/personal-model.js');
  const T = await import('../src/personal-train.js');
  assert.deepEqual(P.parseExamples('Q: Who are you?\nA: Ox.\nQ: Hi\nA: Hey!'), [{ input: 'Who are you?', output: 'Ox.' }, { input: 'Hi', output: 'Hey!' }]);
  assert.deepEqual(P.parseExamples('{"prompt":"a","completion":"b"}\nnoise'), [{ input: 'a', output: 'b' }]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-pm-'));
  const ex = Array.from({ length: 22 }, (_, i) => ({ input: `q${i}`, output: `a${i}` }));
  assert.deepEqual(T.writeData(ex, dir), { train: 18, valid: 4 });
  const first = JSON.parse(fs.readFileSync(path.join(dir, 'train.jsonl'), 'utf8').split('\n')[0]);
  assert.deepEqual(first.messages.map((m) => m.role), ['user', 'assistant']);
  assert.ok(T.BASE_MODELS.every((m) => m.id.startsWith('mlx-community/')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a chat-only model (your own) gets no tools', async () => {
  const { resolveBot } = await import('../src/bots.js');
  const t = resolveBot('my-model', { bots: { 'my-model': { provider: 'vllm', model: 'default_model', baseUrl: 'http://127.0.0.1:9/v1', chatOnly: true } } });
  assert.equal(t.chatOnly, true);
});
