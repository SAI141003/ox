import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { listSessions, findSession, readSession, handoffMarkdown, writeHandoff, deliveryPlan, importToOx } from '../src/session-transfer.js';

function tmp(t, prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}
const jsonl = (rows) => `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`;
const FAKE_KEY = `sk-ant-api03-${'a'.repeat(40)}`;
const REAL_LOOKING_KEY = 'sk-ant-api03-Xy7_Qp2-Lm9vB3nR8tK4wZ6cJ1hF5dG0sA2eU7iO3pY9';

// A home folder with one session in each tool, shaped like the real stores.
function fakeHome(t) {
  const home = tmp(t, 'ox-xfer-home-');
  const project = tmp(t, 'ox-xfer-proj-');
  const cdir = path.join(home, '.claude', 'projects', '-proj');
  fs.mkdirSync(cdir, { recursive: true });
  fs.writeFileSync(path.join(cdir, 'aaaa1111-2222.jsonl'), jsonl([
    { type: 'user', cwd: project, gitBranch: 'main', timestamp: '2026-10-17T10:00:00Z', message: { role: 'user', content: 'Add a login page to the app' } },
    { type: 'user', cwd: project, message: { role: 'user', content: '<command-name>/clear</command-name>' } },
    { type: 'assistant', timestamp: '2026-10-17T10:01:00Z', message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'I will add src/login.js.' }, { type: 'tool_use', id: 't1', name: 'Write', input: { file_path: 'src/login.js', content: 'x' } }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
    { type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'a subagent aside' }] } },
    { type: 'user', message: { role: 'user', content: `now wire it up, the key is ${FAKE_KEY} or ${REAL_LOOKING_KEY}` } },
    { type: 'custom-title', customTitle: 'Login page' },
  ]));
  const xdir = path.join(home, '.codex', 'sessions', '2026', '10', '16');
  fs.mkdirSync(xdir, { recursive: true });
  fs.writeFileSync(path.join(xdir, 'rollout-2026-10-16T09-00-00-bbbb.jsonl'), jsonl([
    { type: 'session_meta', timestamp: '2026-10-16T09:00:00Z', payload: { id: 'bbbb2222-3333', cwd: project, git: { branch: 'feat' } } },
    { type: 'turn_context', payload: { model: 'gpt-6-luna' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n  <cwd>/x</cwd>\n</environment_context>' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fix the failing test in math.js' }] } },
    { type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', input: '*** Begin Patch\n*** Update File: src/math.js\n@@\n-a\n+b\n*** End Patch' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Fixed the off-by-one in add().' }] } },
  ]));
  fs.utimesSync(path.join(xdir, 'rollout-2026-10-16T09-00-00-bbbb.jsonl'), new Date('2026-10-16T09:00:00Z'), new Date('2026-10-16T09:00:00Z'));
  return { home, project, claudeFile: path.join(cdir, 'aaaa1111-2222.jsonl'), codexFile: path.join(xdir, 'rollout-2026-10-16T09-00-00-bbbb.jsonl') };
}
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

test('reads a Claude Code session: the person, the assistant and the files, not tool output or asides', (t) => {
  const { home, project } = fakeHome(t);
  const s = readSession(findSession('claude', { home }), { home });
  assert.equal(s.cwd, project);
  assert.equal(s.branch, 'main');
  assert.equal(s.model, 'claude-opus-5-5');
  assert.equal(s.title, 'Login page');
  assert.deepEqual(s.messages.map((m) => m.role), ['user', 'assistant', 'user'], 'no slash-command echo, tool result or sidechain');
  assert.deepEqual(s.files, ['src/login.js']);
  assert.equal(s.messages[1].tools[0].name, 'Write');
});

test('reads a Codex session: environment blocks left out, patched files found', (t) => {
  const { home } = fakeHome(t);
  const s = readSession(findSession('codex:bbbb', { home }), { home });
  assert.equal(s.id, 'bbbb2222-3333');
  assert.equal(s.model, 'gpt-6-luna');
  assert.equal(s.branch, 'feat');
  assert.deepEqual(s.messages.map((m) => [m.role, m.text]), [['user', 'Fix the failing test in math.js'], ['assistant', 'Fixed the off-by-one in add().']]);
  assert.deepEqual(s.files, ['src/math.js']);
});

test('reads a Hermes session from its database, read-only', { skip: spawnSync('sqlite3', ['-version']).status !== 0 && 'no sqlite3' }, (t) => {
  const { home, project } = fakeHome(t);
  const db = path.join(home, '.hermes', 'state.db');
  fs.mkdirSync(path.dirname(db), { recursive: true });
  const sql = `create table sessions (id text primary key, title text, cwd text, model text, git_branch text, started_at real, ended_at real, last_activity_at real, message_count integer, hidden integer default 0, archived integer default 0);
create table messages (id integer primary key autoincrement, session_id text, role text, content text, tool_calls text, active integer default 1);
insert into sessions values ('h1', 'Deploy the bot', '${project}', 'longcat', null, 1760000000, null, 1760000100, 3, 0, 0);
insert into messages (session_id, role, content) values ('h1', 'user', '[CONTEXT COMPACTION — REFERENCE ONLY] earlier: set up the server');
insert into messages (session_id, role, content) values ('h1', 'user', 'deploy it to the VPS');
insert into messages (session_id, role, content, tool_calls) values ('h1', 'assistant', 'Deploying.', '[{"function":{"name":"write_file","arguments":"{\\"path\\":\\"deploy.sh\\"}"}}]');`;
  assert.equal(spawnSync('sqlite3', [db, sql]).status, 0);
  const before = sha(db);
  const s = readSession(findSession('hermes', { home }), { home });
  assert.equal(s.title, 'Deploy the bot');
  assert.deepEqual(s.files, ['deploy.sh']);
  const md = handoffMarkdown(s, { git: null });
  assert.match(md, /## What it was for\ndeploy it to the VPS/, 'the compaction summary is not the request');
  assert.match(md, /## Earlier summary \(written by the tool itself\)\nearlier: set up the server/);
  assert.equal(sha(db), before, 'the database is unchanged');
});

test('lists sessions across tools, newest first, and by folder', (t) => {
  const { home, project } = fakeHome(t);
  const all = listSessions({ home });
  assert.deepEqual(all.map((s) => s.tool), ['claude', 'codex']);
  assert.equal(listSessions({ home, cwd: project }).length, 2);
  assert.equal(listSessions({ home, cwd: os.tmpdir() + '/elsewhere-not-here' }).length, 0);
  assert.equal(findSession('latest', { home }).tool, 'claude');
  assert.throws(() => findSession('cursor', { home }), /can read sessions from/);
});

test('the handoff: the request, the conversation, the files, and no secrets', (t) => {
  const { home } = fakeHome(t);
  const s = readSession(findSession('claude', { home }), { home });
  const md = handoffMarkdown(s, { git: { branch: 'main', status: ['?? src/login.js'], log: ['abc123 first'] } });
  assert.match(md, /^# Handoff: Login page/);
  assert.match(md, /## What it was for\nAdd a login page to the app/);
  assert.match(md, /\*\*Latest request:\*\*\nnow wire it up/);
  assert.match(md, /- Write: src\/login\.js/);
  assert.match(md, /## Files it changed\n- `src\/login\.js`/);
  assert.match(md, /\?\? src\/login\.js/);
  assert.ok(!md.includes(FAKE_KEY) && !md.includes(REAL_LOOKING_KEY.slice(14)), 'no key reaches the handoff');
  // A tight budget keeps the opening request and the latest turns.
  const small = handoffMarkdown({ ...s, messages: [...s.messages, ...Array.from({ length: 50 }, (_, i) => ({ role: 'assistant', text: `step ${i} ${'x'.repeat(300)}`, tools: [] }))] }, { budget: 2000, git: null });
  assert.match(small, /earlier messages left out/);
  assert.match(small, /step 49/);
});

test('writing a transfer never changes the source tool, and the handoff never shows in git', (t) => {
  const { home, project, claudeFile, codexFile } = fakeHome(t);
  const before = [sha(claudeFile), sha(codexFile)];
  spawnSync('git', ['init', '-q', project]);
  const s = readSession(findSession('claude', { home }), { home });
  const h = writeHandoff(s);
  assert.ok(h.md.startsWith(path.join(project, '.agent', 'handoff')));
  assert.ok(fs.existsSync(h.json));
  assert.equal(spawnSync('git', ['-C', project, 'status', '--porcelain', '--untracked-files=all']).stdout.toString().trim(), '', 'nothing untracked');
  assert.deepEqual([sha(claudeFile), sha(codexFile)], before);
});

test('delivery: the same tool resumes itself; another tool is started on the handoff; Paperclip through its CLI', (t) => {
  const { home } = fakeHome(t);
  const s = readSession(findSession('claude', { home }), { home });
  const h = writeHandoff(s);
  const same = deliveryPlan(s, 'claude', h);
  assert.equal(same.kind, 'resume');
  assert.deepEqual(same.args, ['--resume', 'aaaa1111-2222']);
  const other = deliveryPlan(s, 'codex', h, { home });
  assert.equal(other.kind, 'start');
  assert.match(other.args[0], /read \.agent\/handoff\/.+\.md first/);
  assert.equal(other.cwd, h.dir);
  assert.equal(deliveryPlan(s, 'hermes', h).args[0], 'chat');
  assert.equal(deliveryPlan(s, 'paperclip', h, { company: null }).cmd, null);
  const pc = deliveryPlan(s, 'paperclip', h, { company: 'c1' });
  assert.deepEqual(pc.args.slice(0, 5), ['issue', 'create', '-C', 'c1', '--title']);
  assert.match(pc.args[pc.args.indexOf('--description') + 1], /# Handoff: Login page/);
  assert.equal(deliveryPlan(s, 'file', h).kind, 'file');
  assert.throws(() => deliveryPlan(s, 'notepad', h), /can hand a session to/);
});

test('into ox: the conversation becomes an ox session that ox resumes', async (t) => {
  const { home } = fakeHome(t);
  const s = readSession(findSession('codex', { home }), { home });
  const r = importToOx(s, { home });
  const rows = fs.readFileSync(r.file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows[0].t, 'meta');
  assert.equal(rows[0].importedFrom.tool, 'codex');
  assert.deepEqual(rows.filter((x) => x.t === 'user' || x.t === 'assistant').map((x) => x.t), ['user', 'assistant']);
  const { loadSession } = await import('../src/session.js');
  assert.equal(loadSession(r.file).filter((e) => e.t === 'user').length, 1);
  // And ox itself can be a source.
  const back = readSession(findSession(`ox:${r.id}`, { home }), { home });
  assert.equal(back.messages[0].text, 'Fix the failing test in math.js');
});

test("Codex: the account's own model list decides when its config asks for a refused model", async (t) => {
  const { codexModelArgs } = await import('../src/session-transfer.js');
  const home = tmp(t, 'ox-xfer-codex-');
  fs.mkdirSync(path.join(home, '.codex'));
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), 'model = "gpt-5.5"\nmodel_reasoning_effort = "medium"\n');
  assert.deepEqual(codexModelArgs('codex', { home, listed: ['gpt-6-luna', 'gpt-5.6-terra'] }), ['-m', 'gpt-6-luna'], 'refused: the first listed');
  assert.deepEqual(codexModelArgs('codex', { home, listed: ['gpt-5.5', 'gpt-6-luna'] }), [], 'allowed: left as configured');
  assert.deepEqual(codexModelArgs('codex', { home: tmp(t, 'ox-xfer-nocfg-'), listed: ['a'] }), [], 'no config: Codex decides');
});
