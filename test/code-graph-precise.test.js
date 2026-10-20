// code_graph's precise answers: callers, callees, definition, outline, with line ranges.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { codeGraphTool } from '../src/tools/code-graph.js';

test('code_graph: callers, callees, definition and outline answer in lines, not files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-cg-'));
  fs.writeFileSync(path.join(dir, 'a.js'), "import { tax } from './b.js';\n\nexport function total(items) {\n  const sum = items.reduce((n, i) => n + i, 0);\n  return sum + tax(sum);\n}\n");
  fs.writeFileSync(path.join(dir, 'b.js'), 'export function tax(x) {\n  return x * 0.2;\n}\n\nexport function unused() {\n  return 1;\n}\n');
  const ask = async (action, target) => (await codeGraphTool({ action, target }, { cwd: dir })).content;
  assert.match(await ask('callers', 'tax'), /tax \(b\.js:1-3\) is called from 1 place:\n {2}total at a\.js:5/);
  assert.match(await ask('callees', 'total'), /tax at b\.js:1-3 \(call on line 5\)/);
  assert.match(await ask('definition', 'total'), /total \(function\) at a\.js:3-6\n {2}export function total\(items\) \{/);
  assert.equal(await ask('outline', 'b.js'), 'b.js: 2 functions and classes\n  tax (function) lines 1-3\n  unused (function) lines 5-7');
  assert.match(await ask('callers', 'unused'), /no callers/);
  fs.rmSync(dir, { recursive: true, force: true });
});
