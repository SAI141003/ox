// Run traces and stuck signals (src/trace.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as T from '../src/trace.js';

test('watcher: the same call three times is a loop, said once', () => {
  const w = T.stuckWatcher();
  const call = { type: 'tool-start', name: 'read_file', argsPreview: '{"path":"a"}' };
  assert.equal(w(call), null);
  assert.equal(w(call), null);
  assert.match(w(call).text, /stuck in a loop: called read_file with the same arguments 3 times/);
  assert.equal(w(call), null, 'each kind once per run');
});

test('watcher: ping-pong between two calls, errors in a row, many quiet turns', () => {
  const w = T.stuckWatcher();
  const a = { type: 'tool-start', name: 'grep', argsPreview: 'x' }, b = { type: 'tool-start', name: 'read_file', argsPreview: 'y' };
  let sig = null;
  for (const e of [a, b, a, b, a, b]) sig = w(e) ?? sig;
  assert.match(sig.text, /back and forth/);
  const e = T.stuckWatcher();
  let s2 = null;
  for (let i = 0; i < 4; i++) s2 = e({ type: 'tool-end', name: 'exec', ok: false }) ?? s2;
  assert.match(s2.text, /4 tool calls failed in a row/);
  const q = T.stuckWatcher({ quietTurns: 3 });
  q({ type: 'usage' }); q({ type: 'usage' });
  assert.match(q({ type: 'usage' }).text, /3 model turns without changing a file/);
  const q2 = T.stuckWatcher({ quietTurns: 3 });
  q2({ type: 'usage' }); q2({ type: 'usage' }); q2({ type: 'tool-start', name: 'edit_file', argsPreview: '1' });
  assert.equal(q2({ type: 'usage' }), null, 'an edit resets it');
});

test('withTrace records turns, tools and signals, and passes every event through', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-trace-'));
  const old = process.env.OX_HOME;
  process.env.OX_HOME = home;
  try {
    const call = { type: 'tool-start', id: '1', name: 'exec', argsPreview: 'ls' };
    const events = [{ type: 'usage', inputTokens: 100, outputTokens: 5, costUsd: 0.001, model: 'm' }, call, { type: 'tool-end', id: '1', name: 'exec', ok: true, ms: 4 }, call, call, { type: 'final' }];
    async function* src() { yield* events; }
    const seen = [], notes = [];
    for await (const e of T.withTrace({ messages: [{ role: 'user', content: 'list files' }], target: { model: 'm' } }, src(), { notify: (s) => notes.push(s), env: { OX_TRACE: '1' } })) seen.push(e);
    assert.deepEqual(seen, events);
    assert.equal(notes.length, 1);
    const [t] = T.listTraces();
    assert.equal(t.prompt, 'list files');
    assert.equal(t.turns, 1);
    assert.equal(t.inTokens, 100);
    assert.equal(t.cost, 0.001);
    assert.equal(t.tools, 1);
    assert.equal(t.outcome, 'done');
    assert.equal(t.signals.length, 1);
    assert.equal(T.listTraces({ signals: true }).length, 1);
  } finally { if (old === undefined) delete process.env.OX_HOME; else process.env.OX_HOME = old; }
});
