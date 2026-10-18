// A project wiki from its code graph (src/wiki.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildWiki, fileSummary } from '../src/wiki.js';

test('an index of subsystems and a page each, with what every file says it does', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-wiki-'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'pay.js'), "// Payments: charges a card and records the receipt.\nimport { save } from './store.js';\nexport function charge(x) { return save(x); }\n");
  fs.writeFileSync(path.join(root, 'src', 'store.js'), "// The store: keeps records on disk.\nexport function save(x) { return x; }\n");
  assert.equal(fileSummary(root, 'src/pay.js'), 'Payments: charges a card and records the receipt.');
  const r = buildWiki(root, { out: path.join(root, 'wiki') });
  assert.ok(r.subsystems >= 1);
  const index = fs.readFileSync(path.join(root, 'wiki', 'index.md'), 'utf8');
  assert.match(index, /## Subsystems/);
  const pages = fs.readdirSync(path.join(root, 'wiki')).filter((f) => f !== 'index.md');
  const all = pages.map((p) => fs.readFileSync(path.join(root, 'wiki', p), 'utf8')).join('\n');
  assert.match(all, /src\/pay\.js.*Payments: charges a card/);
  assert.match(all, /\[Back to the index\]\(index\.md\)/);
});
