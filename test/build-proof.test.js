// ox build's tamper-proof proof (src/build-proof.js), on a real little project.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as P from '../src/build-proof.js';
import { detectTests, traceSpec } from '../src/build-spec.js';

function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-proof-'));
  const w = (f, t) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), t); };
  w('package.json', JSON.stringify({ name: 'p', type: 'module', scripts: { test: 'node --test' } }));
  w('src/max.js', 'export function bigger(a, b) {\n  return a;\n}\n');
  const g = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  g('init', '-q'); g('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.'); g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base');
  const base = g('rev-parse', 'HEAD').stdout.trim();
  // tests first
  w('test/max.test.js', "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { bigger } from '../src/max.js';\ntest('AC-1: the bigger of two numbers', () => {\n  assert.equal(bigger(2, 5), 5);\n  assert.equal(bigger(7, 3), 7);\n});\n");
  return { dir, w, base, spec: { id: 'max', title: 'Bigger', summary: 'the bigger number', acceptance: [{ id: 'AC-1', given: '', when: '', then: 'the bigger of two numbers' }] } };
}

test('proof: a locked test that is edited, skipped, narrowed or deleted fails the proof', () => {
  const { dir, w, base, spec } = project();
  P.lockTests(dir, spec.id, { base });
  assert.equal(P.integrity(dir, P.loadLock(dir, spec.id)).ok, true, 'nothing changed yet');
  w('test/extra.test.js', "import { test } from 'node:test';\ntest('more', () => {});\n");
  assert.equal(P.integrity(dir, P.loadLock(dir, spec.id)).ok, true, 'adding a test is fine');
  const orig = fs.readFileSync(path.join(dir, 'test/max.test.js'), 'utf8');
  w('test/max.test.js', orig.replace('  assert.equal(bigger(7, 3), 7);\n', ''));
  let r = P.integrity(dir, P.loadLock(dir, spec.id));
  assert.deepEqual(r.problems.map((x) => x.kind).sort(), ['assertions-dropped', 'changed']);
  w('test/max.test.js', orig.replace("test('AC-1", "test.skip('AC-1"));
  assert.ok(P.integrity(dir, P.loadLock(dir, spec.id)).problems.some((x) => x.kind === 'skip-added'));
  w('test/max.test.js', orig);
  w('test/other.test.js', "import { test } from 'node:test';\ntest.only('x', () => {});\n");
  assert.ok(P.integrity(dir, P.loadLock(dir, spec.id)).problems.some((x) => x.kind === 'only-added'), 'a new .only in a new file');
  fs.rmSync(path.join(dir, 'test/other.test.js'));
  w('package.json', JSON.stringify({ name: 'p', type: 'module', scripts: { test: 'node --test || true' } }));
  assert.ok(P.integrity(dir, P.loadLock(dir, spec.id)).problems.some((x) => x.kind === 'config-changed'), 'the test command was loosened');
  w('package.json', JSON.stringify({ name: 'p', type: 'module', scripts: { test: 'node --test' } }));
  fs.rmSync(path.join(dir, 'test/max.test.js'));
  assert.ok(P.integrity(dir, P.loadLock(dir, spec.id)).problems.some((x) => x.kind === 'deleted'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('proof: mutants of the changed lines, caught by good tests', () => {
  const { dir, w, base } = project();
  w('src/max.js', 'export function bigger(a, b) {\n  return a > b ? a : b;\n}\n');
  const changed = P.changedSource(dir, base);
  assert.deepEqual(changed, [{ file: 'src/max.js', lines: [2] }]);
  const list = P.mutants(dir, changed);
  assert.equal(list.length, 1);
  assert.equal(list[0].to.trim(), 'return a <= b ? a : b;');
  const rec = P.recorder(dir);
  const m = P.mutationCheck(dir, list, { run: (why) => rec.shell(why, 'node --test') });
  assert.equal(m.killed, 1, 'the tests catch the flipped comparison');
  assert.equal(fs.readFileSync(path.join(dir, 'src/max.js'), 'utf8'), 'export function bigger(a, b) {\n  return a > b ? a : b;\n}\n', 'the source is put back');
  // a weak test lets the same break through
  w('test/max.test.js', "import { test } from 'node:test';\nimport { bigger } from '../src/max.js';\ntest('AC-1: runs', () => { bigger(1, 2); });\n");
  assert.equal(P.mutationCheck(dir, list, { run: (why) => rec.shell(why, 'node --test') }).killed, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('proof: the whole proof, with held-out tests kept outside the project', async () => {
  const { dir, w, base, spec } = project();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-proof-home-'));
  P.lockTests(dir, spec.id, { base });
  w('src/max.js', 'export function bigger(a, b) {\n  return a > b ? a : b;\n}\n');
  const tests = detectTests(dir);
  const trace = traceSpec(dir, spec, { tests });
  const asked = [];
  const ask = async ({ system, user }) => {
    asked.push({ system, user });
    if (system === P.HELDOUT_SYSTEM) return "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { bigger } from '../src/max.js';\ntest('held out: equal and negative numbers', () => { assert.equal(bigger(-1, -4), -1); assert.equal(bigger(3, 3), 3); });\n";
    return '{"criteria":[{"id":"AC-1","verdict":"met","why":"returns the larger"}],"concerns":[]}';
  };
  const p = await P.prove(dir, spec, { tests, trace, ask, home });
  assert.equal(p.verdict, 'proven', p.reasons.join('; '));
  assert.equal(p.heldOut.ok, true);
  assert.equal(p.mutation.killed, p.mutation.total);
  assert.equal(p.verifier.criteria[0].verdict, 'met');
  assert.ok(!asked[0].user.includes('test/max.test.js'), 'the held-out writer never sees the coder\'s tests');
  assert.ok(fs.existsSync(P.heldOutDir(dir, spec.id, home)), 'held-out tests live outside the project');
  assert.ok(!fs.readdirSync(path.join(dir, 'test')).some((f) => f.includes('heldout')), 'and leave nothing behind');
  assert.ok(p.commands.some((c) => c.why === 'held-out tests' && c.exit === 0));
  const md = fs.readFileSync(path.join(dir, P.saveProof(dir, spec, p)), 'utf8');
  assert.match(md, /✓ Proven/);
  assert.match(md, /\| the whole test suite \| `(?:sh -c|cmd \/c) npm test` \| 0 \|/);
  // the coder then "fixes" a failure by deleting an assertion: not proven
  const t = fs.readFileSync(path.join(dir, 'test/max.test.js'), 'utf8');
  w('test/max.test.js', t.replace('  assert.equal(bigger(7, 3), 7);\n', ''));
  const q = await P.prove(dir, spec, { tests, trace: traceSpec(dir, spec, { tests }), home, mutate: 0 });
  assert.equal(q.verdict, 'not proven');
  assert.match(q.reasons[0], /tests changed after they were locked/);
  assert.equal((await P.prove(dir, spec, { tests, trace: traceSpec(dir, spec, { tests }), home, mutate: 0, acceptTestChanges: true })).verdict, 'proven', 'unless you approve the change');
  fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true });
});
