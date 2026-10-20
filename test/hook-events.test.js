// Wiring tests for the four lifecycle hook events that src/agent.js now fires:
// PreLLM, PostLLM, SessionStart, SessionStop.
//
// These drive the REAL agent loop against a loopback fake provider and marker
// files written by the hooks themselves, because the whole point is proving the
// call sites exist in the agent -- not that fireHooks can run a shell command.
// test/hooks.test.js covers the dispatcher itself and guards the call-site set.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { runAgent, drainPendingHooks } from '../src/agent.js';
import { fireHooks, hooksFor, HOOK_EVENTS, loadHooksConfig } from '../src/hooks.js';

const marker = (dir, name) => path.join(dir, name);
const readMarker = (dir, name) => {
  try {
    return fs.readFileSync(marker(dir, name), 'utf8').trim();
  } catch {
    return null;
  }
};
// Hooks are fire-and-forget for PreLLM/PostLLM, so their marker files land a few
// ms after the event. Poll rather than sleep a fixed amount.
async function waitForMarker(dir, name, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = readMarker(dir, name);
    if (v !== null) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  return null;
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ox-hookev-'));
}

// A loopback OpenAI-compatible endpoint. `reply` decides the response body, so
// a test can make the stream succeed, die mid-flight, or ask for a tool call.
async function fakeProvider(t, reply) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      calls.push(JSON.parse(body));
    } catch {
      calls.push(null);
    }
    reply(res, calls.length);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { calls, target: { provider: 'ollama', model: 'test-model', baseUrl: `http://127.0.0.1:${server.address().port}/v1` } };
}

const sseText = (text, usage = { prompt_tokens: 100, completion_tokens: 20 }) => {
  const payload = JSON.stringify({
    choices: [{ delta: { content: text }, finish_reason: 'stop' }],
    usage,
  });
  return `data: ${payload}\n\ndata: [DONE]\n\n`;
};
const replyWith = (res, body) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(body);
};

// Wire one hook per event, each appending to its own marker file.
function allSixConfig(dir) {
  const cfg = {};
  for (const ev of HOOK_EVENTS) {
    cfg[ev] = [{ command: `printf '%s|%s' "$OX_HOOK_EVENT" "$OX_HOOK_ERROR" >> "${marker(dir, ev)}"` }];
  }
  return cfg;
}

async function drainRun(iter) {
  const events = [];
  for await (const ev of iter) events.push(ev);
  // Belt and braces: the agent drains internally, but a test must not depend on
  // that to observe its markers.
  await drainPendingHooks();
  return events;
}

// ---------------------------------------------------------------------------
// 1. All six events fire, once per turn/cycle
// ---------------------------------------------------------------------------

test('all six hook events fire through the real agent loop', async (t) => {
  const dir = tmpDir();
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* a throwing hook skips later cleanup: see e2e.test.js */ } });
  const { target } = await fakeProvider(t, (res) => replyWith(res, sseText('hi')));
  const events = await drainRun(
    runAgent({
      target,
      messages: [{ role: 'user', content: 'say hi' }],
      ctx: { cwd: dir, sessionId: 'sess-all-six', hooksConfig: allSixConfig(dir) },
      config: { cwd: dir },
    })
  );
  // The four lifecycle events fire on a tool-free turn.
  for (const ev of ['PreLLM', 'PostLLM', 'SessionStart', 'SessionStop']) {
    assert.notEqual(readMarker(dir, ev), null, `${ev} never fired`);
  }
  // The two tool events correctly do NOT fire: this turn called no tool. Assert
  // it rather than letting a blanket "all six" loop imply they did.
  assert.equal(readMarker(dir, 'PreToolUse'), null, 'PreToolUse must not fire without a tool call');
  assert.equal(readMarker(dir, 'PostToolUse'), null, 'PostToolUse must not fire without a tool call');
  assert.ok(events.some((e) => e.type === 'final') || events.some((e) => e.type === 'text-delta'));
});

test('all six events fire including the two tool events when a tool runs', async (t) => {
  const dir = tmpDir();
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* a throwing hook skips later cleanup: see e2e.test.js */ } });
  let n = 0;
  const { target } = await fakeProvider(t, (res) => {
    n++;
    if (n === 1) {
      const payload = JSON.stringify({
        choices: [{
          delta: {
            tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 100, completion_tokens: 5 },
      });
      return replyWith(res, `data: ${payload}\n\ndata: [DONE]\n\n`);
    }
    return replyWith(res, sseText('done reading'));
  });
  fs.writeFileSync(path.join(dir, 'README.md'), '# hi\n');
  await drainRun(
    runAgent({
      target,
      messages: [{ role: 'user', content: 'read README.md' }],
      ctx: { cwd: dir, sessionId: 'sess-tools', hooksConfig: allSixConfig(dir) },
      config: { cwd: dir },
    })
  );
  for (const ev of HOOK_EVENTS) {
    assert.notEqual(readMarker(dir, ev), null, `${ev} never fired`);
  }
  // The tool events fired exactly once each -- a single read_file, a single
  // dispatch. Count non-empty fields: `printf '%s|%s'` with an unset
  // OX_HOOK_ERROR writes a trailing '|', which is not a second record.
  const lines = (v) => (v ? v.split('|').filter(Boolean).length : 0);
  assert.equal(lines(readMarker(dir, 'PreToolUse')), 1, 'PreToolUse must fire once');
  assert.equal(lines(readMarker(dir, 'PostToolUse')), 1, 'PostToolUse must fire once');
});

// ---------------------------------------------------------------------------
// 2. PostLLM fires even when the stream errors
// ---------------------------------------------------------------------------

test('PostLLM fires when the stream dies mid-flight', async (t) => {
  const dir = tmpDir();
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* a throwing hook skips later cleanup: see e2e.test.js */ } });
  const { target } = await fakeProvider(t, (res) => {
    // Headers, one chunk, then a hard socket destroy: the stream throws.
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'partial' } }] })}\n\n`);
    setTimeout(() => res.socket?.destroy(), 20);
  });
  const events = await drainRun(
    runAgent({
      target,
      messages: [{ role: 'user', content: 'say hi' }],
      ctx: { cwd: dir, sessionId: 'sess-die', hooksConfig: allSixConfig(dir) },
      config: { cwd: dir },
    })
  );
  assert.ok(events.some((e) => e.type === 'error'), 'expected a stream error event');
  const v = await waitForMarker(dir, 'PostLLM');
  assert.notEqual(v, null, 'PostLLM must fire on the errored path too');
  // The documented flag: OX_HOOK_ERROR is set on an errored turn.
  const parts = v.split('|');
  assert.equal(parts[0], 'PostLLM');
  assert.ok(parts[1].length > 0, `expected OX_HOOK_ERROR to be set, got "${parts[1]}"`);
});

test('PostLLM leaves OX_HOOK_ERROR unset on a clean turn', async (t) => {
  const dir = tmpDir();
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* a throwing hook skips later cleanup: see e2e.test.js */ } });
  const { target } = await fakeProvider(t, (res) => replyWith(res, sseText('clean')));
  await drainRun(
    runAgent({
      target,
      messages: [{ role: 'user', content: 'say hi' }],
      ctx: { cwd: dir, sessionId: 'sess-clean', hooksConfig: allSixConfig(dir) },
      config: { cwd: dir },
    })
  );
  const v = await waitForMarker(dir, 'PostLLM');
  assert.equal(v, 'PostLLM|');
});

// ---------------------------------------------------------------------------
// 3. SessionStart / SessionStop fire once per run, not per turn
// ---------------------------------------------------------------------------

test('SessionStart and SessionStop fire exactly once for a multi-iteration turn', async (t) => {
  const dir = tmpDir();
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* a throwing hook skips later cleanup: see e2e.test.js */ } });
  let n = 0;
  const { target } = await fakeProvider(t, (res) => {
    n++;
    if (n <= 3) {
      const payload = JSON.stringify({
        choices: [{
          delta: {
            tool_calls: [{ index: 0, id: `c${n}`, type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 100, completion_tokens: 5 },
      });
      return replyWith(res, `data: ${payload}\n\ndata: [DONE]\n\n`);
    }
    return replyWith(res, sseText('all done'));
  });
  fs.writeFileSync(path.join(dir, 'README.md'), '# hi\n');
  const events = await drainRun(
    runAgent({
      target,
      messages: [{ role: 'user', content: 'read README.md three times' }],
      ctx: { cwd: dir, sessionId: 'sess-once', hooksConfig: allSixConfig(dir) },
      config: { cwd: dir },
    })
  );
  const iters = events.filter((e) => e.type === 'turn-end').length;
  assert.ok(iters >= 4, `expected the loop to iterate several times, got ${iters}`);
  assert.equal(readMarker(dir, 'SessionStart'), 'SessionStart|', 'SessionStart fired more than once');
  assert.equal(readMarker(dir, 'SessionStop'), 'SessionStop|', 'SessionStop fired more than once');
  // PreLLM/PostLLM, by contrast, fire per LLM call: 4 calls here.
  // The marker command appends one "PostLLM|" record per fire, so counting the
  // non-empty '|'-separated fields counts the fires directly.
  const postCalls = readMarker(dir, 'PostLLM').split('|').filter(Boolean).length;
  assert.equal(postCalls, iters, 'PostLLM must fire once per LLM call');
});

test('SessionStop fires even when the turn ends in an error', async (t) => {
  const dir = tmpDir();
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* a throwing hook skips later cleanup: see e2e.test.js */ } });
  const { target } = await fakeProvider(t, (res) => replyWith(res, sseText('x')));
  await drainRun(
    runAgent({
      target: { ...target, provider: 'definitely-not-a-provider' },
      messages: [{ role: 'user', content: 'say hi' }],
      ctx: { cwd: dir, sessionId: 'sess-badbot', hooksConfig: allSixConfig(dir) },
      config: { cwd: dir },
    })
  );
  assert.equal(readMarker(dir, 'SessionStart'), 'SessionStart|');
  assert.equal(readMarker(dir, 'SessionStop'), 'SessionStop|');
});

// ---------------------------------------------------------------------------
// 4. A non-matching matcher does not fire
// ---------------------------------------------------------------------------

test('a non-matching matcher suppresses the event entirely, including the hook-event notice', async (t) => {
  const dir = tmpDir();
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* a throwing hook skips later cleanup: see e2e.test.js */ } });
  let n = 0;
  const { target } = await fakeProvider(t, (res) => {
    n++;
    if (n === 1) {
      const payload = JSON.stringify({
        choices: [{
          delta: {
            tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 10, completion_tokens: 1 },
      });
      return replyWith(res, `data: ${payload}\n\ndata: [DONE]\n\n`);
    }
    return replyWith(res, sseText('done'));
  });
  fs.writeFileSync(path.join(dir, 'README.md'), '# hi\n');
  const hooksConfig = {
    ...allSixConfig(dir),
    // read_file runs; this matcher names a tool that never runs.
    PreToolUse: [{ matcher: 'NopeTool', command: `printf x >> "${marker(dir, 'PreToolUse')}"` }],
  };
  const events = await drainRun(
    runAgent({
      target,
      messages: [{ role: 'user', content: 'read README.md' }],
      ctx: { cwd: dir, sessionId: 'sess-nomatch', hooksConfig },
      config: { cwd: dir },
    })
  );
  assert.equal(readMarker(dir, 'PreToolUse'), null, 'a non-matching matcher must not run');
  // And the loop must not claim it fired.
  assert.ok(!events.some((e) => e.type === 'hook-event' && e.event === 'PreToolUse'));
  // The other events are unaffected.
  assert.notEqual(readMarker(dir, 'PostToolUse'), null);
});

// ---------------------------------------------------------------------------
// 5. The "not silent" mechanism
// ---------------------------------------------------------------------------

test('a configured hook that fires emits a hook-event NDJSON event', async (t) => {
  const dir = tmpDir();
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* a throwing hook skips later cleanup: see e2e.test.js */ } });
  const { target } = await fakeProvider(t, (res) => replyWith(res, sseText('hi')));
  const events = await drainRun(
    runAgent({
      target,
      messages: [{ role: 'user', content: 'say hi' }],
      ctx: { cwd: dir, sessionId: 'sess-visible', hooksConfig: allSixConfig(dir) },
      config: { cwd: dir },
    })
  );
  const hookEvents = events.filter((e) => e.type === 'hook-event');
  const names = new Set(hookEvents.map((e) => e.event));
  for (const ev of ['PreLLM', 'PostLLM', 'SessionStart', 'SessionStop']) {
    assert.ok(names.has(ev), `no hook-event emitted for ${ev}; got ${JSON.stringify([...names])}`);
  }
  // The payload must say which events are blocking, so a user can tell a
  // fire-and-forget hook from a gating one.
  const pre = hookEvents.find((e) => e.event === 'PreLLM');
  assert.equal(pre.blocking, false);
  const start = hookEvents.find((e) => e.event === 'SessionStart');
  assert.equal(start.blocking, true);
  assert.ok(start.hooks >= 1, 'hook-event must report how many hooks ran');
});

test('zero configured hooks emits no hook-event at all', async (t) => {
  const dir = tmpDir();
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* a throwing hook skips later cleanup: see e2e.test.js */ } });
  const { target } = await fakeProvider(t, (res) => replyWith(res, sseText('hi')));
  const events = await drainRun(
    runAgent({
      target,
      messages: [{ role: 'user', content: 'say hi' }],
      ctx: { cwd: dir, sessionId: 'sess-silent', hooksConfig: loadHooksConfig(dir) },
      config: { cwd: dir },
    })
  );
  assert.ok(!events.some((e) => e.type === 'hook-event'));
});

test('every hook-event names a declared HOOK_EVENT', async (t) => {
  const dir = tmpDir();
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* a throwing hook skips later cleanup: see e2e.test.js */ } });
  const { target } = await fakeProvider(t, (res) => replyWith(res, sseText('hi')));
  const events = await drainRun(
    runAgent({
      target,
      messages: [{ role: 'user', content: 'say hi' }],
      ctx: { cwd: dir, sessionId: 'sess-declared', hooksConfig: allSixConfig(dir) },
      config: { cwd: dir },
    })
  );
  for (const e of events.filter((x) => x.type === 'hook-event')) {
    assert.ok(HOOK_EVENTS.includes(e.event), `hook-event for undeclared ${e.event}`);
  }
});

// ---------------------------------------------------------------------------
// 6. With ZERO configured hooks, added latency is ~0
// ---------------------------------------------------------------------------

test('with zero configured hooks the four new call sites cost ~0ms', async (t) => {
  const dir = tmpDir();
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* a throwing hook skips later cleanup: see e2e.test.js */ } });
  const { target } = await fakeProvider(t, (res) => replyWith(res, sseText('hi')));
  const empty = loadHooksConfig(dir);
  for (const ev of HOOK_EVENTS) assert.equal(empty[ev].length, 0, `${ev} should be unconfigured`);

  // Measure the hook path itself, not the whole run. A full agent turn is
  // dominated by the loopback HTTP round trip (~20ms) and would bury a
  // microsecond-scale predicate, so timing the run would prove nothing.
  // What a zero-config call site actually executes is: one hooksFor() predicate
  // per event, plus one drain of an empty promise set. That is the entire cost.
  const iterations = 5000;
  for (let i = 0; i < 500; i++) {
    for (const ev of HOOK_EVENTS) hooksFor(ev, { cwd: dir }, empty);
    await drainPendingHooks();
  }
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) {
    // SessionStart + PreLLM + PostLLM + SessionStop, exactly as the loop calls them.
    for (const ev of ['SessionStart', 'PreLLM', 'PostLLM', 'SessionStop']) hooksFor(ev, { cwd: dir }, empty);
    await drainPendingHooks();
  }
  const perCallSite = Number(process.hrtime.bigint() - t0) / 1e6 / iterations;
  // A spawn of `sh -c 'exit 0'` costs ~2.7ms; two trivial hooks measured ~5.5ms
  // per turn. If the zero-config path were spawning anything this would be
  // orders of magnitude larger. Budget stays loose for slow CI, but is three
  // orders of magnitude below a single spawn.
  assert.ok(perCallSite < 0.05, `zero-hook hook path cost ${perCallSite.toFixed(5)}ms per turn, expected < 0.05ms`);
  t.diagnostic(`zero-config hook path: ${perCallSite.toFixed(6)}ms/turn (${iterations} iterations)`);

  // And end to end: a real zero-hook run emits no hook-event and spawns nothing.
  const events = await drainRun(
    runAgent({
      target,
      messages: [{ role: 'user', content: 'say hi' }],
      ctx: { cwd: dir, sessionId: 'sess-latency', hooksConfig: empty },
      config: { cwd: dir },
    })
  );
  assert.ok(!events.some((e) => e.type === 'hook-event'), 'a zero-config run must emit no hook-event');
  assert.equal(fs.readdirSync(dir).length, 0, 'a zero-config run must not write any marker');
});

// ---------------------------------------------------------------------------
// hooksFor: the shared predicate
// ---------------------------------------------------------------------------

test('hooksFor filters by declared event, command shape, and matcher', () => {
  const config = {
    PreToolUse: [{ matcher: 'Bash', command: 'true' }, { matcher: 'Write', command: '' }, { matcher: 'Write' }],
    PreLLM: [{ command: 'true' }],
  };
  assert.equal(hooksFor('PreToolUse', { tool: 'Bash' }, config).length, 1);
  assert.equal(hooksFor('PreToolUse', { tool: 'Read' }, config).length, 0);
  assert.equal(hooksFor('PreToolUse', { tool: 'Write' }, config).length, 0, 'blank/missing commands never run');
  assert.equal(hooksFor('PreLLM', {}, config).length, 1);
  assert.equal(hooksFor('NotAnEvent', {}, config).length, 0);
  assert.equal(hooksFor('PreLLM', {}, {}).length, 0);
});

test('hooksFor and fireHooks agree on what runs', async () => {
  const config = {
    PreToolUse: [{ matcher: 'Bash', command: 'echo one' }, { matcher: 'Write', command: 'echo two' }],
  };
  for (const tool of ['Bash', 'Write', 'Read', undefined]) {
    const data = tool ? { tool } : {};
    const res = await fireHooks('PreToolUse', data, config);
    assert.equal(
      res.outputs.length + res.errors.length,
      hooksFor('PreToolUse', data, config).length,
      `disagreement for tool=${tool}`
    );
  }
});

// ---------------------------------------------------------------------------
// Env contract for the newly reachable events
// ---------------------------------------------------------------------------

test('PreLLM/PostLLM/Session* hooks receive the documented env vars', async (t) => {
  const dir = tmpDir();
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* a throwing hook skips later cleanup: see e2e.test.js */ } });
  const out = path.join(dir, 'env.txt');
  const res = await fireHooks(
    'PreLLM',
    { cwd: dir, sessionId: 'sid-1', model: 'm-1', bot: 'b-1', prompt: 'p-1' },
    { PreLLM: [{ command: `printf '%s %s %s %s %s' "$OX_HOOK_EVENT" "$OX_SESSION_ID" "$OX_MODEL" "$OX_BOT" "$OX_PROMPT" > ${out}` }] },
    { cwd: dir }
  );
  assert.equal(res.errors.length, 0);
  assert.equal(fs.readFileSync(out, 'utf8'), 'PreLLM sid-1 m-1 b-1 p-1');
});

// ---------------------------------------------------------------------------
// Static wiring guard, mirrored from test/hooks.test.js
// ---------------------------------------------------------------------------

test('src/ has a call site for all six declared events', () => {
  const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src');
  const found = new Set();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js')) continue;
      if (entry.name.endsWith('.bak')) continue;
      const src = fs.readFileSync(full, 'utf8');
      for (const m of src.matchAll(/fireHooks\(\s*'([A-Za-z]+)'/g)) found.add(m[1]);
      for (const m of src.matchAll(/fireLifecycle\(\s*'([A-Za-z]+)'/g)) found.add(m[1]);
    }
  };
  walk(root);
  assert.deepEqual([...found].sort(), [...HOOK_EVENTS].sort());
});
