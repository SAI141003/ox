// Auto model: quick messages to the fastest model that can answer, work with
// code or tools to the strongest; never a model that cannot answer here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const realHome = process.env.HOME;
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-auto-'));
const { autoModel } = await import('../src/serve.js');
test.after(() => { fs.rmSync(process.env.HOME, { recursive: true, force: true }); process.env.HOME = realHome; });
const say = (t) => [{ role: 'user', content: t }];

test('with an Anthropic key: hi goes to the small model, a code fix to the strong one', () => {
  const env = { ANTHROPIC_API_KEY: 'k', OX_NO_KEYSTORE: '1' };
  assert.equal(autoModel(say('hi'), env).id, 'ox-haiku');
  assert.equal(autoModel(say('What is a mortgage?'), env).id, 'ox-haiku');
  assert.equal(autoModel(say('Fix the failing test in src/serve.js'), env).id, 'ox-opus');
});

test('only models that can answer are picked', () => {
  const env = { GROQ_API_KEY: 'k', OX_NO_KEYSTORE: '1' };
  assert.equal(autoModel(say('hi'), env).id, 'ox-groq');
  assert.equal(autoModel(say('refactor src/a.js'), env).id, 'ox-groq');
  assert.match(autoModel(say('refactor src/a.js'), env).why, /only model/);
});
