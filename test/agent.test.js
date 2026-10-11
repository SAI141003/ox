import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sanitizeHistory, runAgent, resolveRunCwd } from '../src/agent.js';

const asst = (ids, text = '') => ({
  role: 'assistant',
  content: text || null,
  tool_calls: ids.map((id, i) => ({
    id,
    type: 'function',
    function: { name: `tool_${i}`, arguments: '{}' },
  })),
});
const tool = (id, content = 'ok') => ({ role: 'tool', tool_call_id: id, content });

test('sanitizeHistory leaves clean histories unchanged', () => {
  const clean = [
    { role: 'user', content: 'go' },
    asst(['a1', 'a2'], 'calling'),
    tool('a1', 'one'),
    tool('a2', 'two'),
    { role: 'user', content: 'next' },
  ];
  const out = sanitizeHistory(clean);
  assert.deepEqual(out, clean);
});

test('sanitizeHistory synthesizes one tool msg per dangling id after the answered run', () => {
  const dirty = [
    { role: 'user', content: 'go' },
    asst(['a1', 'a2', 'a3'], 'calling'),
    tool('a2', 'done'),
    { role: 'user', content: 'next' },
  ];
  const out = sanitizeHistory(dirty);
  assert.equal(out.length, dirty.length + 2);
  assert.deepEqual(out[2], tool('a2', 'done'));
  assert.deepEqual(out[3], { role: 'tool', tool_call_id: 'a1', content: '[not executed: interrupted]' });
  assert.deepEqual(out[4], { role: 'tool', tool_call_id: 'a3', content: '[not executed: interrupted]' });
  assert.deepEqual(out[5], { role: 'user', content: 'next' });
});

test('sanitizeHistory repairs an assistant turn followed by nothing', () => {
  const dirty = [asst(['x1', 'x2'], 'calling'), { role: 'assistant', content: 'later' }];
  const out = sanitizeHistory(dirty);
  assert.equal(out.length, 4);
  assert.deepEqual(out[1], { role: 'tool', tool_call_id: 'x1', content: '[not executed: interrupted]' });
  assert.deepEqual(out[2], { role: 'tool', tool_call_id: 'x2', content: '[not executed: interrupted]' });
  assert.deepEqual(out[3], { role: 'assistant', content: 'later' });
});

test('sanitizeHistory does not mutate its input', () => {
  const dirty = [asst(['z1'])];
  sanitizeHistory(dirty);
  assert.equal(dirty.length, 1);
});

test('runAgent emits a sanitized terminal history event for dangling incoming messages', async () => {
  const dirty = [{ role: 'user', content: 'hi' }, asst(['dangling1'], 'working')];
  const events = [];
  for await (const ev of runAgent({ target: { provider: 'definitely-not-a-provider' }, messages: dirty })) {
    events.push(ev);
  }
  assert.ok(events.some((e) => e.type === 'error'), 'expected the provider error event');
  const hist = events.find((e) => e.type === 'history');
  assert.ok(hist, 'terminal history event must be emitted');
  const msgs = hist.messages;
  assert.equal(msgs[0].role, 'system');
  assert.deepEqual(msgs[1], dirty[0]);
  assert.deepEqual(msgs[2], dirty[1]);
  assert.deepEqual(msgs[3], { role: 'tool', tool_call_id: 'dangling1', content: '[not executed: interrupted]' });
  assert.equal(msgs.length, 4);
});

// ---------------------------------------------------------------------------
// The working-directory footgun.
//
// `cwd` picks the tree a run reads AGENTS.md from and writes session notes and
// memory into. It was read from `ctx.cwd` ONLY, so a caller passing the
// plausible top-level `runAgent({ cwd })` got no error -- the run just used the
// real process cwd and scattered a session's artefacts across the wrong
// directory. These tests pin the chosen resolution: a top-level `cwd` is an
// honoured alias for `ctx.cwd`, and the ambiguous/bad cases throw rather than
// resolving quietly. Nothing here touches a real provider or a real repo.
// ---------------------------------------------------------------------------

// A temp directory nothing else can be reading, optionally holding a
// uniquely-named AGENTS.md. The marker only reaches a system prompt if that
// specific directory was the one the run read, which is what makes the "no
// cwd" control below a real check rather than an assumption.
function cwdFixture(t, marker) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-runcwd-'));
  if (marker) fs.writeFileSync(path.join(dir, 'AGENTS.md'), `${marker}\n`);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // If the suite ever ran from inside the fixture, the control in the
  // end-to-end test would pass vacuously. Make that impossible.
  assert.notEqual(fs.realpathSync(dir), fs.realpathSync(process.cwd()));
  return dir;
}

// A second, conflicting directory, cleaned up with its test.
function otherDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-runcwd-other-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const BAD_TARGET = { provider: 'definitely-not-a-provider' };

// Pull the system prompt out of the terminal history event. The unknown
// provider fails fast, so no network and no API key is involved.
async function systemPromptFor(opts) {
  for await (const ev of runAgent(opts)) {
    if (ev.type === 'history') return ev.messages.find(m => m.role === 'system')?.content ?? '';
  }
  return '';
}

test('resolveRunCwd honours a top-level cwd -- an alias for ctx.cwd, never ignored', (t) => {
  const dir = cwdFixture(t);
  assert.equal(resolveRunCwd({ cwd: dir }), dir);
});

test('resolveRunCwd keeps ctx.cwd ahead of the alias when the two agree', (t) => {
  const dir = cwdFixture(t);
  assert.equal(resolveRunCwd({ cwd: dir, ctx: { cwd: dir } }), dir);
  // A trailing separator is the same directory, not a conflict. The caller's
  // own string is returned unchanged -- normalization is only for the
  // comparison, so what callers already put in ctx.cwd is what they get back.
  assert.equal(resolveRunCwd({ cwd: dir, ctx: { cwd: `${dir}/` } }), `${dir}/`);
  assert.equal(
    fs.realpathSync(resolveRunCwd({ cwd: dir, ctx: { cwd: `${dir}/` } })),
    fs.realpathSync(dir)
  );
});

test('resolveRunCwd throws on a conflicting cwd rather than picking a winner silently', (t) => {
  const a = cwdFixture(t);
  const b = otherDir(t);
  // Two different directories is a genuine ambiguity and must be reported. If
  // either one quietly won, the caller would write to a directory they never
  // named -- the exact failure being fixed here.
  assert.throws(
    () => resolveRunCwd({ cwd: a, ctx: { cwd: b } }),
    /conflicting working directories/,
    'a conflict resolved silently would restore the footgun'
  );
  assert.throws(() => resolveRunCwd({ cwd: a, ctx: { cwd: b } }), /ctx\.cwd/);
});

test('resolveRunCwd rejects a cwd that is not a usable path, naming the field', () => {
  for (const bad of [42, '', '   ', true, {}, []]) {
    assert.throws(() => resolveRunCwd({ cwd: bad }), /cwd/, `accepted ${JSON.stringify(bad)} silently`);
  }
  assert.throws(() => resolveRunCwd({ cwd: 42 }), /non-empty string/);
});

test('resolveRunCwd falls back to config.cwd then the process cwd when unset', (t) => {
  const dir = cwdFixture(t);
  assert.equal(resolveRunCwd({}), process.cwd());
  assert.equal(resolveRunCwd({ config: { cwd: dir } }), dir);
});

test('a top-level cwd is applied, not silently dropped: the run reads that directory AGENTS.md', async (t) => {
  const marker = 'OX_CWD_ALIAS_MARKER_4f21';
  const dir = cwdFixture(t, marker);
  const base = { target: BAD_TARGET, messages: [{ role: 'user', content: 'hi' }] };

  // Control: with no cwd anywhere the marker cannot appear, so a pass below is
  // attributable to the option being honoured and not to ambient state.
  assert.equal((await systemPromptFor(base)).includes(marker), false);

  // The alias works end to end. This is the assertion that fails against the
  // old `ctx.cwd ?? config.cwd ?? process.cwd()` line.
  assert.equal((await systemPromptFor({ ...base, cwd: dir })).includes(marker), true);

  // And it means the same thing as ctx.cwd, not a subtly different directory.
  assert.equal((await systemPromptFor({ ...base, ctx: { cwd: dir } })).includes(marker), true);
});

test('runAgent rejects a bad top-level cwd synchronously, at the call site', (t) => {
  const dir = cwdFixture(t);
  const other = otherDir(t);
  // No iteration, no await: if these only threw on the first next() the caller
  // would learn about the mistake far from the line that made it.
  assert.throws(() => runAgent({ cwd: 7, target: BAD_TARGET, messages: [] }), /non-empty string/);
  assert.throws(
    () => runAgent({ cwd: dir, ctx: { cwd: other }, target: BAD_TARGET, messages: [] }),
    /conflicting working directories/
  );
});
