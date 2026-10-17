// ox port (src/port.js): inventory without a model, order, factors, plan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inventory, topoOrder, factorsMissing, makePlan, savePlan, loadPlan, moduleBrief } from '../src/port.js';

function project() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-port-'));
  const w = (f, t) => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), t); };
  w('package.json', '{"name":"svc","type":"module"}');
  w('src/db.js', "import pg from 'pg';\nexport const url = process.env.DATABASE_URL;\n");
  w('src/users.js', "import { url } from './db.js';\nimport fs from 'node:fs';\nexport const seed = () => fs.readFileSync('data/users.csv', 'utf8');\n");
  w('src/server.js', "import express from 'express';\nimport { seed } from './users.js';\nexpress().listen(8080);\nfetch('https://api.example.com/v1/rates');\n");
  w('test/users.test.js', "import { seed } from '../src/users.js';\nconst x = '/tmp/only-in-a-test.json';\n");
  return d;
}

test('the inventory: modules leaves first, libraries (not built-ins), external factors (not from tests)', () => {
  const inv = inventory(project());
  assert.equal(inv.lang, 'js');
  assert.deepEqual(inv.order, ['src/db.js', 'src/users.js', 'src/server.js']);
  assert.deepEqual(inv.libraries.map((l) => l.name).sort(), ['express', 'pg']);
  const f = inv.factors.map((x) => `${x.kind}:${x.name}`);
  for (const want of ['env:DATABASE_URL', 'file:data/users.csv', 'port:8080', 'url:https://api.example.com/v1/rates', 'database:pg', 'manifest:package.json']) assert.ok(f.includes(want), `${want} in ${f.join(', ')}`);
  assert.ok(!f.some((x) => x.includes('only-in-a-test')), 'a path only a test uses is not a factor');
});

test('cycles do not hang the order, and every module appears once', () => {
  const order = topoOrder([{ file: 'a', deps: ['b'] }, { file: 'b', deps: ['a'] }, { file: 'c', deps: [] }]);
  assert.deepEqual([...order].sort(), ['a', 'b', 'c']);
});

test('the check names every factor the port forgot, and the plan resumes', () => {
  const src = project();
  const inv = inventory(src);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-port-out-'));
  fs.writeFileSync(path.join(out, 'db.py'), 'import os\nurl = os.environ.get("DATABASE_URL")\n');
  const missing = factorsMissing(inv, out).map((x) => x.name);
  assert.ok(missing.includes('data/users.csv') && missing.includes('8080') && !missing.includes('DATABASE_URL'), missing.join(', '));
  const plan = makePlan(inv, { to: 'py', out });
  plan.steps[0].status = 'done';
  savePlan(plan);
  assert.equal(loadPlan(src).steps[0].status, 'done');
  const brief = moduleBrief(inv, plan, plan.steps[1], { testCmd: 'python3 -m pytest -q' });
  assert.match(brief, /Already ported \(use them, do not redo\): src\/db\.js/);
  assert.match(brief, /file data\/users\.csv/);
  assert.match(brief, /its tests: test\/users\.test\.js/);
});
