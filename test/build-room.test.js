// The build room: a planner splits the task, builders work at the same time in
// their own worktrees, every line keeps the name of whoever wrote it, another
// agent reviews each change, must-fix comments go back to the author, and a part
// is merged only once its review passes and its tests are green.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-build-room-'));
const env = { ...process.env, OX_HOME: path.join(root, '.ox') };
const B = await import('../src/build-room.js');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('lines keep their author: kept lines stay, new and changed lines belong to the writer', () => {
  const a = B.attribute(null, 'one\ntwo\nthree', 'Agent 1');
  assert.deepEqual(a.owners, ['Agent 1', 'Agent 1', 'Agent 1']);
  assert.deepEqual(a.changed, [0, 1, 2]);
  const b = B.attribute(a, 'one\nTWO\nthree\nfour', 'Agent 2');
  assert.deepEqual(b.owners, ['Agent 1', 'Agent 2', 'Agent 1', 'Agent 2']);
  assert.deepEqual(b.changed, [1, 3]);
  assert.deepEqual(B.matchLines(['a', 'x', 'b', 'c'], ['a', 'b', 'y', 'c']), [0, 2, -1, 3]);
});

test('a plan is read leniently and never has more parts than agents', () => {
  const p = B.parsePlan('sure! {"summary":"s","test":"npm test","parts":[{"title":"A","files":["a.js","../etc/passwd","/abs"]},{"title":"B"},{"title":"C"}]}', 'task', 2);
  assert.equal(p.parts.length, 2);
  assert.deepEqual(p.parts[0].files, ['a.js']);
  assert.equal(B.parsePlan('no json', 'do the thing').parts[0].brief, 'do the thing');
});

test('a review verdict follows its must-fix comments, whatever the model says', () => {
  assert.equal(B.parseReview('{"verdict":"pass","comments":[{"file":"a.js","line":2,"severity":"must-fix","comment":"bug"}]}').verdict, 'changes');
  assert.equal(B.parseReview('{"verdict":"changes","comments":[{"file":"a.js","line":2,"severity":"suggestion","comment":"nit"}]}').verdict, 'pass');
  assert.equal(B.parseReview('nope'), null);
});

/** A builder that writes files like an ox run and prints its JSONL events. */
function fakeBuilder(script) {
  return ({ cwd, prompt, name }) => {
    const steps = script({ cwd, prompt, name });
    async function* lines() {
      let n = 0;
      for (const [file, text] of steps.files) {
        const id = `c${n++}`;
        yield JSON.stringify({ type: 'assistant-turn', message: { tool_calls: [{ id, function: { name: 'write_file', arguments: JSON.stringify({ path: file, content: text }) } }] } });
        yield JSON.stringify({ type: 'tool-start', id, name: 'write_file' });
        fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
        fs.writeFileSync(path.join(cwd, file), text);
        await new Promise((r) => setTimeout(r, 5));
        yield JSON.stringify({ type: 'tool-end', id, name: 'write_file', ok: true, filesTouched: [file] });
      }
      yield JSON.stringify({ type: 'assistant-turn', message: { tool_calls: [{ id: 'b1', function: { name: 'bash', arguments: '{"command":"node --test"}' } }] } });
      yield JSON.stringify({ type: 'tool-start', id: 'b1', name: 'bash' });
      yield JSON.stringify({ type: 'tool-end', id: 'b1', name: 'bash', ok: true });
      yield JSON.stringify({ type: 'final', message: { content: `${name} done` } });
    }
    return { lines: lines(), done: Promise.resolve(0), kill() {} };
  };
}

test('two agents build at once, the reviewer sends one back to fix, both are merged', async () => {
  const dir = path.join(root, 'budget');
  const prompts = [];
  let reviews = 0;
  const ask = async ({ system, user }) => {
    if (system === B.PLAN_SYSTEM) return JSON.stringify({ summary: 'A tiny budget library', stack: 'node', test: 'node --test', parts: [
      { title: 'Money math', files: ['money.js'], brief: 'add(a,b)' },
      { title: 'Report', files: ['report.js'], brief: 'report(items)' },
    ] });
    reviews++;
    // Agent 1's first version has a bug the reviewer catches.
    if (/money\.js/.test(user) && /a - b/.test(user)) return JSON.stringify({ verdict: 'changes', comments: [{ file: 'money.js', line: 1, severity: 'must-fix', comment: 'add subtracts' }] });
    return JSON.stringify({ verdict: 'pass', comments: [{ file: '', line: 0, severity: 'good', comment: 'clear' }] });
  };
  const spawnBuilder = fakeBuilder(({ prompt, name }) => {
    prompts.push({ name, prompt });
    if (name === 'Agent 1') {
      const fixed = /came back from review/.test(prompt);
      return { files: [
        ['money.js', `export const add = (a, b) => ${fixed ? 'a + b' : 'a - b'};\n`],
        ['money.test.js', "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { add } from './money.js';\ntest('add', () => assert.equal(add(2, 3), 5));\n"],
      ] };
    }
    return { files: [['report.js', 'export const report = (xs) => xs.join(", ");\n']] };
  });
  const room = new B.BuildRoom({ task: 'a budget library', dir, agents: 3, ask, spawnBuilder, env });
  const seen = [];
  room.on('event', (e) => seen.push(e));
  await room.run();

  const done = seen.find((e) => e.type === 'done');
  assert.ok(done.ok, done.summary);
  assert.equal(done.merged, 2);
  // Built at the same time, in their own copies.
  assert.deepEqual(seen.find((e) => e.type === 'plan').parts.map((p) => [p.agent, p.reviewer]), [['Agent 1', 'Agent 2'], ['Agent 2', 'Agent 1']]);
  // Each line names its writer, live.
  const money = seen.filter((e) => e.type === 'file' && e.file === 'money.js');
  assert.ok(money.length >= 2);
  assert.ok(money.every((e) => e.owners.every((o) => o === 'Agent 1')));
  assert.ok(seen.some((e) => e.type === 'file' && e.file === 'report.js' && e.agent === 'Agent 2'));
  // Reviewed by the other agent; the must-fix went back to the author with the comment.
  const r1 = seen.filter((e) => e.type === 'review' && e.agent === 'Agent 1');
  assert.equal(r1[0].reviewer, 'Agent 2');
  assert.equal(r1[0].verdict, 'changes');
  assert.equal(r1.at(-1).verdict, 'pass');
  assert.ok(prompts.some((p) => p.name === 'Agent 1' && /add subtracts/.test(p.prompt)));
  // The author's tests ran (and failed on the bug) before the fix.
  const t1 = seen.filter((e) => e.type === 'tests' && e.agent === 'Agent 1');
  assert.equal(t1[0].ok, false);
  assert.equal(t1.at(-1).ok, true);
  // Commands are shown per agent.
  assert.ok(seen.some((e) => e.type === 'cmd' && e.command === 'node --test'));
  // Merged into the project; the copies are cleaned up.
  assert.match(fs.readFileSync(path.join(dir, 'money.js'), 'utf8'), /a \+ b/);
  assert.ok(fs.existsSync(path.join(dir, 'report.js')));
  assert.equal(spawnSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).stdout.trim(), '');
  assert.deepEqual(fs.readdirSync(path.join(dir, '.ox-build')), []);
  // Kept for replay.
  assert.equal(B.listBuilds({ env })[0].ok, true);
  assert.ok(B.readBuild(room.id, { env }).events.length > 10);
});

test('a part whose review never passes is not merged and is named in the summary', async () => {
  const dir = path.join(root, 'stubborn');
  const ask = async ({ system }) => system === B.PLAN_SYSTEM
    ? JSON.stringify({ summary: 's', parts: [{ title: 'Only', files: ['x.js'], brief: 'x' }] })
    : JSON.stringify({ comments: [{ file: 'x.js', line: 1, severity: 'must-fix', comment: 'still wrong' }] });
  const room = new B.BuildRoom({ task: 'x', dir, ask, spawnBuilder: fakeBuilder(() => ({ files: [['x.js', 'export const x = 1;\n']] })), env });
  const seen = [];
  room.on('event', (e) => seen.push(e));
  await room.run();
  const done = seen.find((e) => e.type === 'done');
  assert.equal(done.ok, false);
  assert.match(done.summary, /Not merged: Agent 1 \(Only\): review still asks for changes/);
  assert.equal(fs.existsSync(path.join(dir, 'x.js')), false, 'nothing unreviewed reaches the project');
  assert.equal(seen.filter((e) => e.type === 'review').length, 3, 'first try plus two fix rounds');
});

test('your own files are never committed for you: a non-empty folder or uncommitted changes are refused', () => {
  const plain = path.join(root, 'plain');
  fs.mkdirSync(plain, { recursive: true });
  fs.writeFileSync(path.join(plain, '.env'), 'SECRET=1');
  assert.throws(() => B.prepareRepo(plain), /not a git repository/);
  const repo = path.join(root, 'dirty');
  B.prepareRepo(repo);
  fs.writeFileSync(path.join(repo, 'mine.txt'), 'wip');
  assert.throws(() => B.prepareRepo(repo), /uncommitted changes/);
});

test('tests that fail only for a teammate\'s unmerged file wait for that teammate, then pass', async () => {
  const dir = path.join(root, 'waits');
  const ask = async ({ system }) => system === B.PLAN_SYSTEM
    ? JSON.stringify({ summary: 's', parts: [{ title: 'Lib', files: ['lib.js'], brief: '' }, { title: 'App', files: ['app.js'], brief: '' }] })
    : JSON.stringify({ comments: [] });
  const base = fakeBuilder(({ name }) => (name === 'Agent 1'
    ? { files: [['lib.js', 'export const two = () => 2;\n']] }
    : { files: [['app.js', "import { two } from './lib.js';\nexport const four = () => two() * 2;\n"], ['app.test.js', "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { four } from './app.js';\ntest('four', () => assert.equal(four(), 4));\n"]] }));
  // Agent 1 is slow: Agent 2 finishes first and must wait for lib.js.
  const spawnBuilder = (o) => {
    const run = base(o);
    if (o.name !== 'Agent 1') return run;
    return { ...run, lines: (async function* () { await new Promise((r) => setTimeout(r, 700)); yield* run.lines; })() };
  };
  const room = new B.BuildRoom({ task: 't', dir, ask, spawnBuilder, env });
  const seen = [];
  room.on('event', (e) => seen.push(e));
  await room.run();
  assert.ok(seen.some((e) => e.type === 'agent' && e.agent === 'Agent 2' && e.status === 'waiting' && /Agent 1/.test(e.doing)));
  const t2 = seen.filter((e) => e.type === 'tests' && e.agent === 'Agent 2');
  assert.equal(t2.length, 1, 'no fix round spent on a teammate\'s missing file');
  assert.equal(t2[0].ok, true);
  assert.ok(seen.find((e) => e.type === 'done').ok);
});

test("ox's own edit backups never reach a commit or a part's tests", () => {
  const repo = path.join(root, 'backups');
  const base = B.prepareRepo(repo);
  fs.mkdirSync(path.join(repo, '.ox-backups', '1', 'test'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.ox-backups', '1', 'test', 'old.test.js'), "import { test } from 'node:test'; test('stale', () => { throw new Error('stale'); });\n");
  fs.writeFileSync(path.join(repo, 'ok.test.js'), "import { test } from 'node:test'; test('ok', () => {});\n");
  spawnSync('git', ['add', '-A'], { cwd: repo });
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'x'], { cwd: repo });
  assert.equal(spawnSync('git', ['ls-files'], { cwd: repo, encoding: 'utf8' }).stdout.trim(), 'ok.test.js');
  const t = B.partTests(repo, base);
  assert.deepEqual(t.files, ['ok.test.js']);
  assert.equal(t.ok, true);
});

test('a fix round sees the failing tests, not the passing tail', () => {
  const out = ['TAP version 13', '# Subtest: a', 'not ok 1 - adds', '  ---', '  duration_ms: 1', "  error: 'expected 5, got -1'", '  ...', ...Array.from({ length: 300 }, (_, i) => `ok ${i + 2} - fine ${i}`), '# tests 301', '# pass 300', '# fail 1'].join('\n');
  const d = B.failureDigest(out);
  assert.match(d, /not ok 1 - adds/);
  assert.match(d, /expected 5, got -1/);
  assert.match(d, /# fail 1/);
  assert.doesNotMatch(d, /fine 200/);
  assert.match(B.fixPrompt({ base: 'b', comments: [], tests: { ok: false, out: d, command: 'node --test' } }), /expected 5, got -1/);
});

test("a builder that writes another agent's file has it put back; the owner's version is the one merged", async () => {
  const dir = path.join(root, 'owners');
  const ask = async ({ system }) => system === B.PLAN_SYSTEM
    ? JSON.stringify({ summary: 's', parts: [{ title: 'Lib', files: ['lib.js', 'package.json'], brief: '' }, { title: 'App', files: ['app.js'], brief: '' }] })
    : JSON.stringify({ comments: [] });
  const base = fakeBuilder(({ name }) => (name === 'Agent 1'
    ? { files: [['package.json', '{"type":"module","name":"real"}\n'], ['lib.js', 'export const two = () => 2;\n']] }
    // Agent 2 makes its own stub of Agent 1's files so its tests pass on their own.
    : { files: [['package.json', '{"type":"module","name":"stub"}\n'], ['lib.js', 'export const two = () => 2; // stub\n'], ['app.js', "import { two } from './lib.js';\nexport const four = () => two() * 2;\n"], ['app.test.js', "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { four } from './app.js';\ntest('four', () => assert.equal(four(), 4));\n"]] }));
  const spawnBuilder = (o) => {
    const run = base(o);
    if (o.name !== 'Agent 1') return run;
    return { ...run, lines: (async function* () { await new Promise((r) => setTimeout(r, 500)); yield* run.lines; })() };
  };
  const room = new B.BuildRoom({ task: 't', dir, ask, spawnBuilder, env });
  const seen = [];
  room.on('event', (e) => seen.push(e));
  await room.run();
  const done = seen.find((e) => e.type === 'done');
  assert.ok(done.ok, done.summary);
  assert.ok(seen.some((e) => e.type === 'note' && e.agent === 'Agent 2' && /Agent 1's package\.json/.test(e.text)));
  assert.match(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'), /"real"/);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'lib.js'), 'utf8'), /stub/);
});
