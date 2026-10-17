// ox build (src/build-spec.js): requirement → spec → tests first → trace.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseSpec, saveSpec, loadSpec, specMarkdown, buildBrief, traceSpec, formatTrace, detectTests, projectContext } from '../src/build-spec.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ox-build-'));

test('a spec is parsed from what the model wrote, and refused without criteria', () => {
  const spec = parseSpec('Here it is:\n{"title":"Discounts","summary":"Orders over 100 get 10% off","acceptance":[{"id":"AC-1","given":"an order of 150","when":"totalled","then":"the total is 135"},{"given":"an order of 50","when":"totalled","then":"no discount"}],"questions":["Does tax apply before the discount? Assumed after."]}');
  assert.equal(spec.acceptance.length, 2);
  assert.equal(spec.acceptance[1].id, 'AC-2', 'a missing id is numbered');
  assert.deepEqual(spec.questions, ['Does tax apply before the discount? Assumed after.']);
  assert.throws(() => parseSpec('{"title":"x","acceptance":[]}'), /no acceptance criteria/);
  assert.throws(() => parseSpec('I think you should…'), /JSON/);
});

test('the brief puts tests first and makes the test command a gate', () => {
  const spec = { id: 's1', title: 'Discounts', summary: 'Orders over 100 get 10% off', acceptance: [{ id: 'AC-1', given: 'an order of 150', when: 'totalled', then: 'the total is 135' }], constraints: ['amounts in cents'], outOfScope: ['coupons'], files: ['src/order.js'], questions: [] };
  const { brief, contract } = buildBrief(spec, { framework: 'node:test', cmd: 'npm test' });
  assert.match(brief, /Write the tests first/);
  assert.match(brief, /AC-1/);
  assert.match(brief, /Do not weaken or delete a test/);
  assert.match(brief, /coupons/);
  assert.equal(contract.verification, 'gate: npm test');
});

test('the trace runs each criterion on its own: passes, fails, no test', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'shop', type: 'module', scripts: { test: 'node --test' } }));
  fs.mkdirSync(path.join(dir, 'test'));
  fs.writeFileSync(path.join(dir, 'order.js'), 'export const total = (n) => (n > 100 ? n * 0.9 : n);\n');
  fs.writeFileSync(path.join(dir, 'test', 'order.test.js'), [
    "import { test } from 'node:test'; import assert from 'node:assert/strict'; import { total } from '../order.js';",
    "test('AC-1: an order of 150 totals 135', () => assert.equal(total(150), 135));",
    "test('AC-2: an order of exactly 100 gets the discount', () => assert.equal(total(100), 90));",
  ].join('\n'));
  const spec = saveSpec(dir, { title: 'Discounts', summary: 'x', acceptance: [{ id: 'AC-1', given: '', when: '', then: 'over 100 gets 10% off' }, { id: 'AC-2', given: '', when: '', then: 'exactly 100 gets it too' }, { id: 'AC-3', given: '', when: '', then: 'negative totals are refused' }], constraints: [], outOfScope: [], files: [], questions: [] });
  assert.equal(detectTests(dir).framework, 'node:test');
  const t = traceSpec(dir, spec);
  assert.deepEqual(t.rows.map((r) => `${r.id}:${r.status}`), ['AC-1:passes', 'AC-2:fails', 'AC-3:no test']);
  assert.deepEqual([t.passed, t.failed, t.missing], [1, 1, 1]);
  assert.match(formatTrace(spec, t), /1\/3 criteria proven by a passing test, 1 failing, 1 with no test/);
  assert.equal(loadSpec(dir).id, spec.id);
  assert.match(fs.readFileSync(path.join(dir, '.agent', 'specs', `${spec.id}.md`), 'utf8'), /## Acceptance criteria/);
  assert.match(projectContext(dir), /order\.js[\s\S]*Tests: node:test/);
});
