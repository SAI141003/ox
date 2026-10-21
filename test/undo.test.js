// One undo for files and chat (src/undo.js): a turn's changes go back exactly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const U = await import('../src/undo.js');
const T = await import('../src/tools/fs.js');
const proj = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ox-undo-')));
const read = (d, f) => fs.readFileSync(path.join(d, f), 'utf8');

test('a turn that edited, rewrote and created files is put back in one undo', async () => {
  const d = proj();
  fs.writeFileSync(path.join(d, 'a.js'), 'one\n');
  fs.writeFileSync(path.join(d, 'b.js'), 'keep me\n');
  const ctx = { cwd: d, turnId: U.newTurnId() };
  await T.editFileTool({ path: 'a.js', old_string: 'one', new_string: 'two' }, ctx);
  await T.editFileTool({ path: 'a.js', old_string: 'two', new_string: 'three' }, ctx); // twice in one turn
  await T.writeFileTool({ path: 'b.js', content: 'replaced\n' }, ctx);
  await T.writeFileTool({ path: 'new/c.js', content: 'made by the turn\n' }, ctx);
  assert.equal(read(d, 'a.js'), 'three\n');
  assert.deepEqual(U.undoableTurns(d)[0].files.sort(), ['a.js', 'b.js', 'new/c.js']);
  const r = U.undoTurn(d);
  assert.equal(read(d, 'a.js'), 'one\n', 'back to before the turn, not to the middle edit');
  assert.equal(read(d, 'b.js'), 'keep me\n');
  assert.ok(!fs.existsSync(path.join(d, 'new', 'c.js')), 'a file the turn made is removed');
  assert.deepEqual(r.restored.sort(), ['a.js', 'b.js']);
  assert.deepEqual(r.removed, ['new/c.js']);
  assert.match(U.describe(r), /restored a\.js, b\.js; removed new\/c\.js/);
  assert.equal(U.undoableTurns(d).length, 0);
  assert.equal(U.undoTurn(d).none, true, 'nothing left to undo');
});

test('a file changed again after the turn is left alone, the rest still goes back', async () => {
  const d = proj();
  fs.writeFileSync(path.join(d, 'x.txt'), 'x0');
  fs.writeFileSync(path.join(d, 'y.txt'), 'y0');
  const ctx = { cwd: d, turnId: U.newTurnId() };
  await T.writeFileTool({ path: 'x.txt', content: 'x1' }, ctx);
  await T.writeFileTool({ path: 'y.txt', content: 'y1' }, ctx);
  fs.writeFileSync(path.join(d, 'y.txt'), 'yours'); // you edited it afterwards
  const r = U.undoTurn(d);
  assert.equal(read(d, 'x.txt'), 'x0');
  assert.equal(read(d, 'y.txt'), 'yours', 'your later edit is not thrown away');
  assert.deepEqual(r.skipped, [{ file: 'y.txt', why: 'changed again since that turn' }]);
});

test('the newest turn is undone first; each turn once', async () => {
  const d = proj();
  fs.writeFileSync(path.join(d, 'f'), '0');
  const t1 = { cwd: d, turnId: '20261020000001-aaaaaa' };
  const t2 = { cwd: d, turnId: '20261020000002-bbbbbb' };
  await T.writeFileTool({ path: 'f', content: '1' }, t1);
  await T.writeFileTool({ path: 'f', content: '2' }, t2);
  U.undoTurn(d);
  assert.equal(read(d, 'f'), '1');
  U.undoTurn(d);
  assert.equal(read(d, 'f'), '0');
});
