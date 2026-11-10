// What the memory must get right: a true fact is never overwritten by an
// unrelated one, a statement that takes a fact back closes it, the same thing
// said in other words is not stored twice, and a question nothing answers gets nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { remember, recall, profile, retractionOf, memoryPromptBlock, compact, load, memoryFile } from '../src/memory-graph.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-memq-'));
let n = 0;
const T0 = Date.UTC(2026, 0, 5, 12);
const DAY = 86_400_000;
function told(statements) {
  const file = path.join(dir, `g${n++}.jsonl`);
  let t = T0;
  const ops = statements.map((s) => remember(s, { file, ref: (t += DAY) }).op);
  const now = t + DAY;
  return { file, ops, now, ask: (q) => recall(q, { file, now }).map((m) => m.text), live: () => { const p = profile({ file, now }); return [...p.stable, ...p.lately].map((m) => m.text).sort(); } };
}

test('three things you are stay three facts', () => {
  const m = told(['I am a vegetarian', 'I am 28 years old', 'I am allergic to peanuts']);
  assert.deepEqual(m.live(), ['I am 28 years old', 'I am a vegetarian', 'I am allergic to peanuts']);
  assert.deepEqual(m.ask('what can I eat').sort(), ['I am a vegetarian', 'I am allergic to peanuts']);
  const api = told(['The API is hosted on Vercel', 'The API is written in Go']);
  assert.equal(api.live().length, 2);
  const sis = told(['My sister is Priya', 'My sister is a doctor']);
  assert.equal(sis.live().length, 2);
});

test('the same attribute is still an update', () => {
  assert.deepEqual(told(['I am 28 years old', 'I am 29 years old']).live(), ['I am 29 years old']);
  assert.deepEqual(told(['The API is hosted on Vercel', 'The API is hosted on Fly']).live(), ['The API is hosted on Fly']);
  assert.deepEqual(told(['I am a vegetarian', 'I am vegan now']).live(), ['I am vegan now']);
  assert.deepEqual(told(['My manager is Tom', 'My manager is Lisa']).live(), ['My manager is Lisa']);
  assert.deepEqual(told(['I work at Google', 'I work at Stripe now']).live(), ['I work at Stripe now']);
  assert.deepEqual(told(['I prefer tabs', 'I prefer spaces over tabs']).live(), ['I prefer spaces over tabs']);
});

test('taking a fact back closes it instead of strengthening it', () => {
  assert.equal(retractionOf('I no longer use vim'), 'I use vim');
  assert.equal(retractionOf("I don't work at Google anymore"), 'I work at Google');
  assert.equal(retractionOf('I stopped using npm'), 'I use npm');
  assert.equal(retractionOf('Never push to main'), null);
  const a = told(['I use vim', 'I no longer use vim']);
  assert.deepEqual(a.ops, ['add', 'update']);
  assert.deepEqual(a.live(), ['I no longer use vim']);
  assert.deepEqual(told(['I work at Google', "I don't work at Google anymore"]).live(), ["I don't work at Google anymore"]);
  // A retraction about something else leaves the fact alone.
  assert.deepEqual(told(['I use pnpm', 'I no longer use npm']).live(), ['I no longer use npm', 'I use pnpm']);
  // What you use next is a new fact beside the retraction.
  assert.deepEqual(told(['I use vim', 'I no longer use vim', 'I use neovim']).live(), ['I no longer use vim', 'I use neovim']);
});

test('said again in other words is one memory, made stronger', () => {
  const m = told(['I prefer concise answers', 'I like my answers to be concise', 'Please keep answers concise']);
  assert.deepEqual(m.ops, ['add', 'noop', 'noop']);
  assert.equal(load(m.file).find((x) => x.text === 'I prefer concise answers').strength, 3);
  // ...but a different number is a different fact, and so is the opposite.
  assert.equal(told(['The dev server runs on port 3000 locally', 'The dev server runs on port 3001 locally']).ops[1] !== 'noop', true);
  assert.equal(told(['I like biryani', 'I hate biryani']).ops[1], 'update');
});

test('recall: generic questions, what is coming up, and nothing when nothing fits', () => {
  assert.deepEqual(told(['Call me Sai', 'My name is Sai Yaganti']).ask('what is my name'), ['My name is Sai Yaganti']);
  assert.equal(told(['I have an exam tomorrow', 'Dentist appointment next Friday']).ask('what is coming up').length, 2);
  const m = told(['I work at Google', 'My dog is called Biscuit']);
  assert.deepEqual(m.ask('what is the capital of France'), []);
  assert.deepEqual(m.ask('fix the login bug in auth.ts'), []);
  assert.deepEqual(m.ask('what is my wife called'), [], 'a generic word alone still does not match another subject');
});

test('the block put in front of a run has a budget', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-memq-home-'));
  const file = memoryFile('user', { home });
  const topics = ['tea', 'coffee', 'jazz', 'chess', 'hiking', 'sushi', 'tulips', 'kayaks', 'origami', 'pottery', 'sailing', 'archery', 'baking', 'cycling', 'knitting', 'surfing'];
  topics.forEach((t, i) => remember(`I like ${t} ${'and I can explain at length why that is so '.repeat(18)}`.trim(), { file, ref: T0 + i * 1000 }));
  const saved = process.env.OX_MEMORY_HOME;
  process.env.OX_MEMORY_HOME = path.dirname(file);
  try {
    const block = memoryPromptBlock({ home, cwd: dir, now: T0 + DAY });
    assert.ok(block.length <= 900 * 4 + 400, `within budget: ${block.length} characters`);
    assert.ok(block.split('\n').filter((l) => l.startsWith('- ')).every((l) => l.length <= 300), 'each memory is one short line');
    assert.ok(block.includes('…'));
  } finally { if (saved === undefined) delete process.env.OX_MEMORY_HOME; else process.env.OX_MEMORY_HOME = saved; }
});

test('compact keeps every live line', () => {
  const m = told(['I use vim', 'I use neovim', 'I like tea']);
  const before = load(m.file).length;
  assert.equal(compact(m.file), before);
  assert.equal(load(m.file).length, before);
  assert.ok(!fs.existsSync(`${m.file}.tmp`));
});
