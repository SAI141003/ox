import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {
  HOOK_EVENTS,
  loadHooksConfig,
  fireHooks,
  formatHookOutputs,
  formatHookErrors,
  hooksFor,
} from '../src/hooks.js';

// ---------------------------------------------------------------------------
// HOOK_EVENTS: complete list
// ---------------------------------------------------------------------------

test('HOOK_EVENTS: contains the 6 lifecycle events', () => {
  assert.deepEqual(HOOK_EVENTS, [
    'PreToolUse',
    'PostToolUse',
    'PreLLM',
    'PostLLM',
    'SessionStart',
    'SessionStop',
  ]);
});

// ---------------------------------------------------------------------------
// loadHooksConfig: merges global + project
// ---------------------------------------------------------------------------

test('loadHooksConfig: returns empty config when no files exist', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-test-'));
  const config = loadHooksConfig(tmp);
  for (const ev of HOOK_EVENTS) {
    assert.deepEqual(config[ev], []);
  }
  fs.rmSync(tmp, { recursive: true });
});

test('loadHooksConfig: loads project .ox/hooks.json', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-test-'));
  fs.mkdirSync(path.join(tmp, '.ox'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, '.ox', 'hooks.json'),
    JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: 'Bash', command: 'echo blocked' }],
        PostToolUse: [{ command: 'echo done' }],
      },
    })
  );
  const config = loadHooksConfig(tmp);
  assert.equal(config.PreToolUse.length, 1);
  assert.equal(config.PreToolUse[0].matcher, 'Bash');
  assert.equal(config.PreToolUse[0].command, 'echo blocked');
  assert.equal(config.PostToolUse.length, 1);
  assert.equal(config.PostToolUse[0].command, 'echo done');
  assert.equal(config.PreLLM.length, 0);
  fs.rmSync(tmp, { recursive: true });
});

// ---------------------------------------------------------------------------
// fireHooks: PreToolUse blocking behavior
// ---------------------------------------------------------------------------

test('fireHooks: PreToolUse exit-2 denies the tool', async () => {
  const config = {
    PreToolUse: [{ matcher: 'Bash', command: 'echo denied >&2; exit 2' }],
  };
  const result = await fireHooks('PreToolUse', { tool: 'Bash', args: { command: 'ls' } }, config);
  assert.equal(result.decision, 'deny');
});

test('fireHooks: PreToolUse exit-0 allows the tool', async () => {
  const config = {
    PreToolUse: [{ matcher: 'Bash', command: 'echo ok; exit 0' }],
  };
  const result = await fireHooks('PreToolUse', { tool: 'Bash', args: { command: 'ls' } }, config);
  assert.equal(result.decision, 'allow');
  assert.equal(result.outputs.length, 1);
  assert.match(result.outputs[0].output, /ok/);
});

test('fireHooks: PreToolUse exit-1 (non-2) is a failure but does NOT deny', async () => {
  const config = {
    PreToolUse: [{ matcher: 'Bash', command: 'echo fail >&2; exit 1' }],
  };
  const result = await fireHooks('PreToolUse', { tool: 'Bash', args: { command: 'ls' } }, config);
  assert.equal(result.decision, 'allow');
  assert.equal(result.errors.length, 1);
});

test('fireHooks: matcher filters by tool name', async () => {
  const config = {
    PreToolUse: [{ matcher: 'Write', command: 'echo should-not-fire' }],
  };
  const result = await fireHooks('PreToolUse', { tool: 'Bash', args: {} }, config);
  assert.equal(result.outputs.length, 0);
});

test('fireHooks: pipe-separated matcher matches any of the tools', async () => {
  const config = {
    PreToolUse: [{ matcher: 'Bash|Write', command: 'echo fire' }],
  };
  const r1 = await fireHooks('PreToolUse', { tool: 'Bash', args: {} }, config);
  assert.equal(r1.outputs.length, 1);
  const r2 = await fireHooks('PreToolUse', { tool: 'Write', args: {} }, config);
  assert.equal(r2.outputs.length, 1);
  const r3 = await fireHooks('PreToolUse', { tool: 'Read', args: {} }, config);
  assert.equal(r3.outputs.length, 0);
});

test('fireHooks: no matcher matches all tools', async () => {
  const config = {
    PreToolUse: [{ command: 'echo universal' }],
  };
  for (const tool of ['Bash', 'Write', 'Read', 'Anything']) {
    const r = await fireHooks('PreToolUse', { tool, args: {} }, config);
    assert.equal(r.outputs.length, 1, `expected universal hook to fire for ${tool}`);
  }
});

test('fireHooks: empty config returns allow with no outputs/errors', async () => {
  const result = await fireHooks('PreToolUse', { tool: 'Bash', args: {} }, {});
  assert.equal(result.decision, 'allow');
  assert.equal(result.outputs.length, 0);
  assert.equal(result.errors.length, 0);
});

test('fireHooks: unknown event returns allow', async () => {
  const result = await fireHooks('InvalidEvent', {}, { InvalidEvent: [{ command: 'echo x' }] });
  assert.equal(result.decision, 'allow');
  assert.equal(result.outputs.length, 0);
});

// ---------------------------------------------------------------------------
// fireHooks: env var injection
// ---------------------------------------------------------------------------

test('fireHooks: env vars are set for tool events', async () => {
  const config = {
    PreToolUse: [{ matcher: 'Bash', command: 'echo "TOOL=$OX_TOOL_NAME FILE=$OX_FILE_PATH"' }],
  };
  const result = await fireHooks('PreToolUse', {
    tool: 'Bash',
    args: { command: 'ls', path: '/tmp/foo' },
  }, config);
  assert.equal(result.outputs.length, 1);
  assert.match(result.outputs[0].output, /TOOL=Bash/);
  assert.match(result.outputs[0].output, /FILE=\/tmp\/foo/);
});

// NOTE: these two call `fireHooks` DIRECTLY, so on their own they prove only
// that the dispatcher's env builder handles LLM-shaped payloads. That the agent
// loop actually fires PreLLM/PostLLM is proved in test/hook-events.test.js,
// which drives the real loop; the wiring guard at the bottom of this file pins
// the call-site set.
test('fireHooks: env vars are set for LLM-shaped payloads', async () => {
  const config = {
    PreLLM: [{ command: 'echo "MODEL=$OX_MODEL PROMPT=$OX_PROMPT"' }],
  };
  const result = await fireHooks('PreLLM', {
    model: 'grok-4.6',
    prompt: 'hello world',
  }, config);
  assert.equal(result.outputs.length, 1);
  assert.match(result.outputs[0].output, /MODEL=grok-4\.6/);
  assert.match(result.outputs[0].output, /PROMPT=hello world/);
});

test('fireHooks: env vars include token counts on PostLLM', async () => {
  const config = {
    PostLLM: [{ command: 'echo "IN=$OX_TOKENS_IN OUT=$OX_TOKENS_OUT"' }],
  };
  const result = await fireHooks('PostLLM', {
    model: 'grok-4.6',
    tokensIn: 100,
    tokensOut: 50,
  }, config);
  assert.equal(result.outputs.length, 1);
  assert.match(result.outputs[0].output, /IN=100/);
  assert.match(result.outputs[0].output, /OUT=50/);
});

test('fireHooks: OX_HOOK_ERROR is set only on an errored PostLLM payload', async () => {
  const config = { PostLLM: [{ command: 'echo "E=[$OX_HOOK_ERROR]"' }] };
  const clean = await fireHooks('PostLLM', { model: 'm', error: null }, config);
  assert.match(clean.outputs[0].output, /E=\[\]/, 'a clean turn must leave OX_HOOK_ERROR unset');
  const errored = await fireHooks('PostLLM', { model: 'm', error: 'stream died' }, config);
  assert.match(errored.outputs[0].output, /E=\[stream died\]/);
});

test('fireHooks: OX_BOT carries the bot label for Session* payloads', async () => {
  const config = { SessionStart: [{ command: 'echo "BOT=$OX_BOT MODEL=$OX_MODEL"' }] };
  const result = await fireHooks('SessionStart', { model: 'm-1', bot: 'ox-ollama:qwen2.5:0.5b' }, config);
  assert.match(result.outputs[0].output, /BOT=ox-ollama:qwen2\.5:0\.5b/);
  assert.match(result.outputs[0].output, /MODEL=m-1/);
});

// ---------------------------------------------------------------------------
// fireHooks: timeout
// ---------------------------------------------------------------------------

test('fireHooks: timeout marks hook as failed (no deny)', async () => {
  const config = {
    PreToolUse: [{ matcher: 'Bash', command: 'sleep 5', timeoutMs: 200 }],
  };
  const result = await fireHooks('PreToolUse', { tool: 'Bash', args: {} }, config);
  assert.equal(result.decision, 'allow'); // timeout is not exit-2
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].error, /timeout/i);
});

// ---------------------------------------------------------------------------
// formatHookOutputs / formatHookErrors
// ---------------------------------------------------------------------------

test('formatHookOutputs: empty when no outputs', () => {
  assert.equal(formatHookOutputs([]), '');
});

test('formatHookOutputs: includes hook label and ms timing', () => {
  const s = formatHookOutputs([{ hook: { matcher: 'Bash' }, output: 'hello', ms: 42 }]);
  assert.match(s, /\[hook output\]/);
  assert.match(s, /Bash hook/);
  assert.match(s, /\(42ms\)/);
  assert.match(s, /hello/);
});

test('formatHookErrors: empty when no errors', () => {
  assert.equal(formatHookErrors([]), '');
});

test('formatHookErrors: includes error message', () => {
  const s = formatHookErrors([{ hook: { matcher: 'Write' }, error: 'permission denied', ms: 5 }]);
  assert.match(s, /\[hook errors\]/);
  assert.match(s, /Write hook/);
  assert.match(s, /permission denied/);
});

// ---------------------------------------------------------------------------
// fireHooks: multiple hooks
// ---------------------------------------------------------------------------

test('fireHooks: first deny wins among multiple PreToolUse hooks', async () => {
  const config = {
    PreToolUse: [
      { matcher: 'Bash', command: 'echo first; exit 0' },
      { matcher: 'Bash', command: 'echo second; exit 2' },
      { matcher: 'Bash', command: 'echo third; exit 2' },
    ],
  };
  const result = await fireHooks('PreToolUse', { tool: 'Bash', args: {} }, config);
  assert.equal(result.decision, 'deny');
  assert.equal(result.outputs.length, 3); // all 3 ran
});

test('fireHooks: PostToolUse ignores exit-2 (does not deny)', async () => {
  const config = {
    PostToolUse: [{ matcher: 'Bash', command: 'echo done; exit 2' }],
  };
  const result = await fireHooks('PostToolUse', { tool: 'Bash', args: {} }, config);
  assert.equal(result.decision, 'allow'); // PostToolUse never denies
});

// ---------------------------------------------------------------------------
// Wiring guard: which declared events actually have call sites?
// ---------------------------------------------------------------------------
//
// HOOK_EVENTS lists six names. Only two of them are ever fired by src/. This
// test pins that split so the shipped docs cannot drift back into claiming six
// working events. If you wire one of the four reserved events, this test fails
// on purpose: update README.md, docs/comparison.md, and this list together.

const WIRED_HOOK_EVENTS = ['PostLLM', 'PostToolUse', 'PreLLM', 'PreToolUse', 'SessionStart', 'SessionStop']; // sorted: compared to a sorted scan

function collectFiredHookEvents() {
  const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src');
  const found = new Set();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js')) continue;
      // .bak files are neither compiled nor shipped. Scanning them would
      // assert wiring that does not exist in the running program.
      if (entry.name.endsWith('.bak')) continue;
      const src = fs.readFileSync(full, 'utf8');
      for (const m of src.matchAll(/fireHooks\(\s*'([A-Za-z]+)'/g)) found.add(m[1]);
      for (const m of src.matchAll(/fireLifecycle\(\s*'([A-Za-z]+)'/g)) found.add(m[1]);
    }
  };
  walk(root);
  return [...found].sort();
}

test('wiring: all six declared events have a call site in src/', () => {
  const fired = collectFiredHookEvents();
  assert.deepEqual(fired, WIRED_HOOK_EVENTS,
    `src/ fires ${JSON.stringify(fired)}. If this changed, update WIRED_HOOK_EVENTS and the hooks docs together.`);
});

test('wiring: every fired event is a declared HOOK_EVENT', () => {
  for (const ev of collectFiredHookEvents()) {
    assert.ok(HOOK_EVENTS.includes(ev), `src/ fires undeclared event: ${ev}`);
  }
});

test('wiring: every declared HOOK_EVENT has a call site', () => {
  const fired = collectFiredHookEvents();
  for (const ev of HOOK_EVENTS) {
    assert.ok(fired.includes(ev),
      `${ev} is declared in HOOK_EVENTS but nothing in src/ fires it -- it is a reserved name again. Say so in the docs.`);
  }
});

test('hooksFor: agrees with fireHooks on which hooks run', () => {
  const config = {
    PreToolUse: [{ matcher: 'Bash', command: 'true' }, { matcher: 'Write', command: '' }],
    PostLLM: [{ command: 'true' }],
  };
  assert.equal(hooksFor('PreToolUse', { tool: 'Bash' }, config).length, 1);
  assert.equal(hooksFor('PreToolUse', { tool: 'Write' }, config).length, 0);
  assert.equal(hooksFor('PostLLM', {}, config).length, 1);
  assert.equal(hooksFor('Nope', {}, config).length, 0);
});
