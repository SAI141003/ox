// ox fix (src/fix.js): a failing test first, then the fix, then proof run by ox.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const F = await import('../src/fix.js');

function project() {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ox-fix-')));
  fs.writeFileSync(path.join(d, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(d, 'cart.js'), 'export const total = (items) => items.reduce((s, x) => s + x, 1);\n'); // bug: starts at 1
  return d;
}
const TEST = "import { test } from 'node:test'; import assert from 'node:assert/strict'; import { total } from './cart.js';\ntest('empty cart is 0', () => assert.equal(total([]), 0));\n";

test('the flow: a test that fails, a fix that makes it pass, checked by ox itself', async () => {
  const d = project();
  const steps = [];
  const ask = async (prompt) => {
    if (prompt.startsWith('Reproduce')) { fs.writeFileSync(path.join(d, 'cart.test.js'), TEST); return 'Wrote it.\nFILE: cart.test.js\nTEST: node --test cart.test.js'; }
    fs.writeFileSync(path.join(d, 'cart.js'), 'export const total = (items) => items.reduce((s, x) => s + x, 0);\n');
    return 'Started the sum at 0.';
  };
  const r = await F.fixBug('the total of an empty cart is 1', { cwd: d, ask, onStep: (s) => steps.push(s) });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.before.pass, false);
  assert.equal(r.after.pass, true);
  assert.deepEqual(steps, ['repro', 'check', 'fix', 'prove']);
  assert.match(r.message, /failed before and passes now/);
});

test('a "fix" that edits the test does not count; a test that never failed proves nothing', async () => {
  const d = project();
  const cheat = async (prompt) => {
    if (prompt.startsWith('Reproduce')) { fs.writeFileSync(path.join(d, 'cart.test.js'), TEST); return 'FILE: cart.test.js\nTEST: node --test cart.test.js'; }
    fs.writeFileSync(path.join(d, 'cart.test.js'), "import { test } from 'node:test'; test('ok', () => {});\n");
    return 'done';
  };
  const r = await F.fixBug('empty cart total', { cwd: d, ask: cheat });
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'fix');
  assert.match(r.message, /test file cart\.test\.js was edited/);

  const d2 = project();
  const toothless = async () => { fs.writeFileSync(path.join(d2, 't.test.js'), "import { test } from 'node:test'; test('ok', () => {});\n"); return 'FILE: t.test.js\nTEST: node --test t.test.js'; };
  const r2 = await F.fixBug('empty cart total', { cwd: d2, ask: toothless });
  assert.equal(r2.ok, false);
  assert.equal(r2.stage, 'repro');
  assert.match(r2.message, /could not write a test that fails/);
});

test('the agent must name its test; FILE and TEST are read from its reply', () => {
  assert.deepEqual(F.parseRepro('blah\nFILE: `test/a.test.js`\nTEST: `npx vitest run test/a.test.js`\n'), { file: 'test/a.test.js', test: 'npx vitest run test/a.test.js' });
  assert.deepEqual(F.parseRepro('no lines'), { file: null, test: null });
});
