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
const env = { ...process.env, OX_HOME: path.join(root, '.ox'), OX_BUILD_RETRY_SCALE: '0.001' };
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

test('your own files are never committed for you: a folder of files that is not a git repository is refused', () => {
  const plain = path.join(root, 'plain');
  fs.mkdirSync(plain, { recursive: true });
  fs.writeFileSync(path.join(plain, '.env'), 'SECRET=1');
  assert.throws(() => B.prepareRepo(plain), /not a git repository/);
});

test('in a project of yours the team works on its own branch: your checkout and uncommitted work are untouched', async () => {
  const repo = path.join(root, 'yours');
  fs.mkdirSync(repo, { recursive: true });
  const g = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
  g('init', '-q'); fs.writeFileSync(path.join(repo, 'app.js'), 'export const app = 1;\n');
  g('add', '-A'); g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'mine');
  fs.writeFileSync(path.join(repo, 'wip.txt'), 'not committed');
  const branchBefore = g('rev-parse', '--abbrev-ref', 'HEAD').stdout.trim();
  const ask = async ({ system }) => system === B.PLAN_SYSTEM ? JSON.stringify({ summary: 's', parts: [{ title: 'Extra', files: ['extra.js'], brief: '' }] }) : JSON.stringify({ comments: [] });
  const room = new B.BuildRoom({ task: 'add extra', dir: repo, ask, spawnBuilder: fakeBuilder(() => ({ files: [['extra.js', 'export const extra = 2;\n']] })), env });
  const seen = [];
  room.on('event', (e) => seen.push(e));
  await room.run();
  const done = seen.find((e) => e.type === 'done');
  assert.ok(done.ok, done.summary);
  assert.match(done.branch, /^ox-team\//);
  assert.match(done.summary, /git merge ox-team\//);
  assert.equal(g('rev-parse', '--abbrev-ref', 'HEAD').stdout.trim(), branchBefore, 'still on your branch');
  assert.equal(fs.readFileSync(path.join(repo, 'wip.txt'), 'utf8'), 'not committed');
  assert.equal(fs.existsSync(path.join(repo, 'extra.js')), false, 'not in your checkout');
  assert.match(g('show', `${done.branch}:extra.js`).stdout, /extra = 2/);
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
  let releaseAgent1;
  const agent2Waits = new Promise((r) => { releaseAgent1 = r; });
  const spawnBuilder = (o) => {
    const run = base(o);
    if (o.name !== 'Agent 1') return run;
    return { ...run, lines: (async function* () { await agent2Waits; yield* run.lines; })() };
  };
  const room = new B.BuildRoom({ task: 't', dir, ask, spawnBuilder, env });
  const seen = [];
  room.on('event', (e) => {
    seen.push(e);
    if (e.type === 'agent' && e.agent === 'Agent 2' && e.status === 'waiting') releaseAgent1();
  });
  // Not a fixed delay: a slow machine finished Agent 1 before Agent 2 began to wait.
  const giveUp = setTimeout(releaseAgent1, 60_000);
  await room.run();
  clearTimeout(giveUp);
  assert.ok(seen.some((e) => e.type === 'agent' && e.agent === 'Agent 2' && e.status === 'waiting' && /Agent 1/.test(e.doing)));
  const t2 = seen.filter((e) => e.type === 'tests' && e.agent === 'Agent 2');
  assert.equal(t2.length, 1, 'no fix round spent on a teammate\'s missing file');
  assert.equal(t2[0].ok, true);
  assert.ok(seen.find((e) => e.type === 'done').ok);
});

test("ox's own edit backups never reach a commit or a part's tests", async () => {
  const repo = path.join(root, 'backups');
  const base = B.prepareRepo(repo);
  fs.mkdirSync(path.join(repo, '.ox-backups', '1', 'test'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.ox-backups', '1', 'test', 'old.test.js'), "import { test } from 'node:test'; test('stale', () => { throw new Error('stale'); });\n");
  fs.writeFileSync(path.join(repo, 'ok.test.js'), "import { test } from 'node:test'; test('ok', () => {});\n");
  spawnSync('git', ['add', '-A'], { cwd: repo });
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'x'], { cwd: repo });
  assert.equal(spawnSync('git', ['ls-files'], { cwd: repo, encoding: 'utf8' }).stdout.trim(), 'ok.test.js');
  const t = await B.partTests(repo, base);
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

test('a run cut off by the model (rate limit) is tried again, carrying on, without spending a review round', async () => {
  const dir = path.join(root, 'ratelimit');
  const ask = async ({ system }) => system === B.PLAN_SYSTEM ? JSON.stringify({ summary: 's', parts: [{ title: 'Only', files: ['x.js'], brief: '' }] }) : JSON.stringify({ comments: [] });
  let runs = 0;
  const prompts = [];
  const ok = fakeBuilder(() => ({ files: [['x.js', 'export const x = 1;\n']] }));
  const spawnBuilder = (o) => {
    runs++; prompts.push(o.prompt);
    if (runs === 1) return { lines: (async function* () { yield JSON.stringify({ type: 'error', message: 'ox[nvidia]: HTTP 429 Too Many Requests' }); })(), done: Promise.resolve(1), kill() {} };
    return ok(o);
  };
  const room = new B.BuildRoom({ task: 't', dir, ask, spawnBuilder, env });
  const seen = [];
  room.on('event', (e) => seen.push(e));
  await room.run();
  assert.equal(runs, 2);
  assert.match(prompts[1], /cut off by a model error/);
  assert.ok(seen.some((e) => e.type === 'agent' && /model is busy/.test(e.doing)));
  assert.ok(seen.find((e) => e.type === 'done').ok);
  assert.equal(seen.filter((e) => e.type === 'review').length, 1);
});

test('a build belongs to the chat that started it; any chat can ask what is going on', async () => {
  const henv = { ...env, OX_HOME: path.join(root, 'status-home') };
  const dir = path.join(root, 'status');
  const ask = async ({ system }) => system === B.PLAN_SYSTEM ? JSON.stringify({ summary: 's', parts: [{ title: 'Only', files: ['x.js'], brief: '' }] }) : JSON.stringify({ comments: [] });
  const room = new B.BuildRoom({ task: 'a status demo', dir, ask, spawnBuilder: fakeBuilder(() => ({ files: [['x.js', 'export const x = 1;\n']] })), env: henv, sessionId: 'chat-A' });
  await room.run();
  assert.equal(B.listBuilds({ env: henv })[0].sessionId, 'chat-A');
  const here = B.statusReply("what's going on?", { sessionId: 'chat-A', env: henv });
  assert.match(here, /\*\*Finished\*\* \(started in this chat\): a status demo/);
  assert.match(B.statusReply('how are the agents doing', { sessionId: 'chat-B', env: henv }), /started in another chat/);
  assert.equal(B.statusReply('write me a poem', { env: henv }), null);
  assert.equal(B.statusReply("what's going on?", { env: { ...env, OX_HOME: path.join(root, 'nobody') } }), null, 'no builds: the model answers');
});

test('your edit to a merged file is committed as yours; a file still being written is not yours to edit yet', async () => {
  const henv = { ...env, OX_HOME: path.join(root, 'edit-home') };
  const dir = path.join(root, 'edit');
  const ask = async ({ system }) => system === B.PLAN_SYSTEM ? JSON.stringify({ summary: 's', parts: [{ title: 'Only', files: ['x.js'], brief: '' }] }) : JSON.stringify({ comments: [] });
  const room = new B.BuildRoom({ task: 't', dir, ask, spawnBuilder: fakeBuilder(() => ({ files: [['x.js', 'export const x = 1;\nexport const y = 2;\n']] })), env: henv });
  await room.run();
  await B.editBuildFile(room.id, 'x.js', 'export const x = 1;\nexport const y = 3;\n', { env: henv });
  assert.match(fs.readFileSync(path.join(dir, 'x.js'), 'utf8'), /y = 3/);
  assert.match(spawnSync('git', ['log', '-1', '--format=%s'], { cwd: dir, encoding: 'utf8' }).stdout, /You: edit x\.js/);
  const last = B.readBuild(room.id, { env: henv }).events.filter((e) => e.type === 'file' && e.file === 'x.js').at(-1);
  assert.deepEqual(last.owners, ['Agent 1', 'You', 'Agent 1']);
  await assert.rejects(B.editBuildFile(room.id, '../escape.js', 'x', { env: henv }), /not a file of this project/);
  await assert.rejects(B.editBuildFile(room.id, 'not-merged.js', 'x', { env: henv }), /once it is merged/);
});

test('Stop ends the builders and what they started, and the server keeps answering while tests run', async () => {
  const dir = path.join(root, 'stoppable');
  const ask = async ({ system }) => system === B.PLAN_SYSTEM ? JSON.stringify({ summary: 's', parts: [{ title: 'Slow', files: ['x.js'], brief: '' }] }) : JSON.stringify({ comments: [] });
  // Like a real `ox -p`: it works until it is killed, then its output ends and it exits.
  let killed = 0, end, exit;
  const ended = new Promise((r) => { end = r; });
  const spawnBuilder = () => ({
    lines: (async function* () { await ended; })(),
    done: new Promise((r) => { exit = r; }),
    kill() { killed++; end(); exit(143); },
  });
  const room = new B.BuildRoom({ task: 't', dir, ask, spawnBuilder, env });
  const seen = [];
  room.on('event', (e) => seen.push(e));
  room.run();
  for (let i = 0; i < 50 && !seen.some((e) => e.type === 'agent' && e.agent === 'Agent 1' && e.status === 'writing'); i++) await new Promise((r) => setTimeout(r, 20));
  // The event loop is free: a timer fires while the builder "works".
  const tick = await Promise.race([new Promise((r) => setTimeout(() => r('free'), 30)), new Promise((r) => setTimeout(() => r('blocked'), 2000))]);
  assert.equal(tick, 'free');
  room.stop();
  assert.equal(killed, 1);
  assert.equal(seen.filter((e) => e.type === 'done').length, 1);
  assert.equal(seen.find((e) => e.type === 'done').stopped, true);
});

test('a shell command and everything it started end together', { skip: process.platform === 'win32' }, async () => {
  const { spawn } = await import('node:child_process');
  const child = spawn('/bin/sh', ['-c', 'sleep 30 & sleep 30; wait'], { detached: true, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 200));
  const closed = new Promise((r) => child.on('close', r));
  B.killTree(child);
  await closed;
  const left = spawnSync('pgrep', ['-g', String(child.pid)], { encoding: 'utf8' }).stdout.trim();
  assert.equal(left, '', 'nothing of its group is left');
});

test('talking to one agent: its answer comes from its own record; what you tell it goes into its next step', async () => {
  const dir = path.join(root, 'talk');
  const ask = async ({ system }) => system === B.PLAN_SYSTEM ? JSON.stringify({ summary: 's', parts: [{ title: 'Money math', files: ['money.js'], brief: 'add(a,b)' }] }) : JSON.stringify({ comments: [] });
  const prompts = [];
  const base = fakeBuilder(() => ({ files: [['money.js', 'export const add = (a, b) => a + b;\n']] }));
  let room;
  const spawnBuilder = (o) => { prompts.push(o.prompt); if (prompts.length === 1) room.tell('Agent 1', 'use integer cents'); return base(o); };
  room = new B.BuildRoom({ task: 't', dir, ask, spawnBuilder, env });
  room.on('event', () => {});
  await room.run();
  assert.throws(() => room.tell('Agent 9', 'x'), /no Agent 9/);
  const ctx = B.agentContext(B.readBuild(room.id, { env }).events, 'Agent 1');
  assert.match(ctx, /YOUR PART: Money math/);
  assert.match(ctx, /FILES YOU WROTE: money\.js/);
  assert.match(ctx, /WHAT THE OWNER TOLD YOU: use integer cents/);
  let seenUser = '';
  const answer = await B.askBuildAgent(room.id, 'Agent 1', 'what are you doing?', { env, ask: async ({ system, user }) => { seenUser = user; assert.equal(system, B.AGENT_CHAT_SYSTEM); return ' I wrote money.js. '; } });
  assert.equal(answer, 'I wrote money.js.');
  assert.match(seenUser, /YOU ARE Agent 1[\s\S]*THE OWNER ASKS: what are you doing\?/);
});

test('"how is it going?" counts as asking about the build', async () => {
  const henv = { ...env, OX_HOME: path.join(root, 'status-home') };
  assert.ok(B.statusReply('how is it going?', { env: henv }));
  assert.ok(B.statusReply("how's it going", { env: henv }));
});
