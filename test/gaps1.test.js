import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Sandbox HOME + workspace BEFORE importing src modules (config.js bakes
// CONFIG_DIR from os.homedir() at import time — same pattern as v3b tests).
// ---------------------------------------------------------------------------

const realHome = process.env.HOME;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-gaps1-home-'));
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-gaps1-ws-'));
process.env.HOME = home;
fs.mkdirSync(path.join(home, '.ox'), { recursive: true });

const AUX_ENV_KEYS = ['OX_AUX_BOT', 'OX_MODEL_WINDOW', 'OX_COMPACT_AT', 'OX_KEEP_TURNS', 'OX_YOLO'];
const savedEnv = Object.fromEntries(AUX_ENV_KEYS.map((k) => [k, process.env[k]]));
for (const k of AUX_ENV_KEYS) delete process.env[k];
process.env.OX_API_KEY = process.env.OX_API_KEY ?? 'test-gaps-key';

after(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(ws, { recursive: true, force: true });
  process.env.HOME = realHome;
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const { PRICING, lookupModel, resolveModelWindow, DEFAULT_MODEL_WINDOW } = await import('../src/cost.js');
const { loadConfig, resolveAuxTarget, compactionKnobs, resetAuxWarningForTest } = await import('../src/config.js');
const { resolveBot } = await import('../src/bots.js');
const { listToolSchemas, pruneToolSchemas } = await import('../src/tools/index.js');
const { buildSystemPrompt, loadPersona } = await import('../src/system-prompt.js');
const { runAgent } = await import('../src/agent.js');
const { runMaxModePlanning } = await import('../src/maxmode.js');

// ---------- shared mock-provider plumbing ----------

const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

function turn({ text = '', calls = [], usage = { prompt_tokens: 21, completion_tokens: 13 } } = {}) {
  const out = [];
  if (text) {
    out.push(sse({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }));
  }
  calls.forEach((call, index) => {
    out.push(
      sse({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index,
                  id: call.id,
                  type: 'function',
                  function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      })
    );
  });
  out.push(sse({ choices: [{ index: 0, delta: {}, finish_reason: calls.length ? 'tool_calls' : 'stop' }] }));
  out.push(sse({ choices: [], usage }));
  out.push('data: [DONE]\n\n');
  return out.join('');
}

function startServer(t, handler) {
  const bodies = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      let parsed = {};
      try {
        parsed = JSON.parse(body);
      } catch {}
      bodies.push(parsed);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(handler(parsed));
    });
  });
  t.after(() => {
    server.closeAllConnections?.();
    server.close();
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, bodies }))
  );
}

const mkTarget = (port, model = 'mock-model') => ({
  provider: 'custom',
  baseUrl: `http://127.0.0.1:${port}/v1`,
  model,
});

const isJudgeBody = (b) => JSON.stringify(b.messages ?? []).includes('completion auditor');
const isSummaryBody = (b) => JSON.stringify(b.messages ?? []).includes('Summarize the following coding-agent');

async function collectEvents(opts) {
  const events = [];
  for await (const ev of runAgent(opts)) events.push(ev);
  return events;
}

function tmpDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const bigHistoryMsgs = (payloadChars = 3000) => [
  { role: 'user', content: 'u1' },
  { role: 'assistant', content: 'a1' },
  { role: 'user', content: 'u2' },
  { role: 'assistant', content: 'a2' },
  { role: 'user', content: 'u3' },
  { role: 'assistant', content: 'a3' },
  { role: 'user', content: 'x'.repeat(payloadChars) },
];

// ===========================================================================
// G2 — model windows
// ===========================================================================

test('PRICING windows: every listed model carries its context window; lookupModel returns it', () => {
  const expected = {
    'grok-4.6': 500_000,
    'grok-build-0.1': 256_000,
    'claude-opus-5': 200_000,
    'claude-sonnet-5': 200_000,
    'claude-haiku-4-5': 200_000,
    'gpt-5.6-sol': 400_000,
    'gemini-3.1-pro-preview': 1_000_000,
    'gemini-3.7-flash': 1_000_000,
    'moonshotai/kimi-k2-instruct-0905': 256_000,
    'deepseek-v4-pro': 128_000,
  };
  for (const [model, window] of Object.entries(expected)) {
    assert.equal(PRICING[model].window, window, model);
    assert.equal(lookupModel(model).window, window, model);
    assert.equal(lookupModel(model).priced, true, model);
  }
  assert.deepEqual(lookupModel('nope'), { priced: false });
  assert.equal(DEFAULT_MODEL_WINDOW, 128_000);
});

test('resolveModelWindow precedence: env OX_MODEL_WINDOW > config > pricing > default', () => {
  assert.equal(resolveModelWindow({ model: 'totally-unpriced' }), 128_000);
  assert.equal(resolveModelWindow({ model: 'grok-4.6' }), 500_000, 'pricing table supplies window');
  assert.equal(
    resolveModelWindow({ model: 'grok-4.6', configWindow: 123_456 }),
    123_456,
    'explicit config override beats pricing'
  );
  process.env.OX_MODEL_WINDOW = '4242';
  try {
    assert.equal(resolveModelWindow({ model: 'grok-4.6', configWindow: 123_456 }), 4242, 'env wins over everything');
    assert.equal(resolveModelWindow({ model: 'unpriced-model' }), 4242);
  } finally {
    delete process.env.OX_MODEL_WINDOW;
  }
  // garbage values fall through to lower tiers
  assert.equal(resolveModelWindow({ model: 'unpriced', configWindow: 'bogus' }), 128_000);
});

test('resolved bots attach a window; config model_window and env override win', () => {
  assert.equal(resolveBot('ox-grok').window, 500_000);
  assert.equal(resolveBot('ollama:llama3').window, 128_000, 'unpriced models get the default window');
  assert.equal(resolveBot('ox-grok', { modelWindow: 999 }).window, 999);
  process.env.OX_MODEL_WINDOW = '555';
  try {
    assert.equal(resolveBot('ox-grok').window, 555, 'env OX_MODEL_WINDOW highest');
  } finally {
    delete process.env.OX_MODEL_WINDOW;
  }
});

test('runAgent honors env OX_MODEL_WINDOW as a compaction trigger (test hook)', async (t) => {
  const cwd = tmpDir(t, 'ox-gaps1-envwin-');
  let requests = 0;
  const { port, bodies } = await startServer(t, () => {
    requests++;
    if (requests === 1) return turn({ text: 'ENVWIN_SUMMARY compacted ok' });
    return turn({ text: 'final after env-window compaction' });
  });
  process.env.OX_MODEL_WINDOW = '600';
  try {
    const events = await collectEvents({
      target: mkTarget(port),
      messages: bigHistoryMsgs(),
      ctx: { cwd },
      auxTarget: null,
    });
    assert.ok(events.some((e) => e.type === 'compaction'), 'tiny env-forced window triggers compaction');
    assert.equal(requests, 2, 'one summary + one final request');
    assert.ok(bodies[0] && isSummaryBody(bodies[0]));
  } finally {
    delete process.env.OX_MODEL_WINDOW;
  }
});

// ===========================================================================
// G2 — pruneToolSchemas
// ===========================================================================

test('pruneToolSchemas no-op when schemas fit comfortably; input untouched', () => {
  const schemas = listToolSchemas({});
  const before = JSON.stringify(schemas);
  const out = pruneToolSchemas(schemas, 10_000_000);
  assert.deepEqual(out, schemas);
  assert.equal(JSON.stringify(schemas), before, 'input not mutated');
});

test('small forced window clips descriptions to 160 chars and drops non-required properties', () => {
  // Stage 1 is tested on a fixed tool set, not on whatever ox ships today: the
  // mail tools are left out so a new builtin cannot silently push this test
  // into stage 2 (which has its own test below).
  const schemas = listToolSchemas({}).filter((s) => !s.name.startsWith('mail_'));
  // The prune budget floors at 8000 (cap 2000 tok) and the built-ins fit under
  // it, so pad with fat filler tools to create real pressure. Two, not three:
  // each builtin added since this was written eats into the headroom the
  // stage-1 pass has under the 2000 cap (show_ui took the third filler's
  // share), and the count below is the largest that still leaves stage 1 to
  // clip and keep every tool.
  for (let i = 0; i < 2; i++) {
    schemas.push({
      name: `mcp__pad__filler${i}`,
      description: 'f'.repeat(1200),
      input_schema: { type: 'object', properties: { x: { type: 'string' } } },
    });
  }
  const originalRead = schemas.find((s) => s.name === 'read_file');
  const out = pruneToolSchemas(schemas, 4_000);
  assert.ok(out.length === schemas.length, 'stage 1 keeps all tools');
  const read = out.find((s) => s.name === 'read_file');
  assert.ok(read.description.length <= 161, `desc clipped (${read.description.length})`);
  assert.ok(originalRead.description.length > 161, 'sanity: original desc exceeded the 160-char clip cap');
  assert.deepEqual(Object.keys(read.input_schema.properties), ['path'], 'optional props offset/limit dropped');
  assert.deepEqual(read.input_schema.required, ['path']);
  const bash = out.find((s) => s.name === 'bash');
  assert.deepEqual(Object.keys(bash.input_schema.properties), ['command'], 'timeout_ms dropped as optional');
  // originals still intact
  assert.ok(originalRead.description.length > 161);
  assert.ok('offset' in originalRead.input_schema.properties);
});

test('stage 2 caps to priority core first, then fills with leading mcp/memory tools under budget', () => {
  const fat = (name) => ({
    name,
    description: `${name} ${'d'.repeat(1200)}`,
    input_schema: {
      type: 'object',
      properties: {
        a: { type: 'string', description: 'req '.padEnd(900, 'q') },
        opt: { type: 'string' },
      },
      required: ['a'],
    },
  });
  const PRIORITY = ['read_file', 'edit_file', 'write_file', 'bash', 'grep', 'glob', 'list_dir', 'todo_write'];
  const mcpNames = Array.from({ length: 20 }, (_, i) => `mcp__srv__t${String(i).padStart(2, '0')}`);
  const schemas = [...PRIORITY.map((n) => fat(n)), ...mcpNames.map((n) => fat(n))];

  // Budget below the 8000 floor -> effective cap 2000 tok; the slimmed core
  // (~2300 tok) alone exceeds it, so nothing beyond priority survives.
  const tight = pruneToolSchemas(schemas, 800);
  assert.deepEqual(
    tight.map((s) => s.name),
    PRIORITY,
    'priority core retained even when alone over cap'
  );

  // Mid budget -> cap 4000 tok: all core plus a deterministic prefix of mcp.
  const roomy = pruneToolSchemas(schemas, 16_000);
  const names = roomy.map((s) => s.name);
  for (const p of PRIORITY) assert.ok(names.includes(p), `core ${p} retained`);
  const keptMcp = names.filter((n) => n.startsWith('mcp__'));
  assert.ok(keptMcp.length >= 1 && keptMcp.length < mcpNames.length, `mcp capped (${keptMcp.length}/20)`);
  assert.deepEqual(keptMcp, mcpNames.slice(0, keptMcp.length), 'first-N mcp tools win');
  const slimmed = roomy.find((s) => s.name === 'read_file');
  assert.ok(slimmed.description.length <= 161, 'kept tools are the slimmed variants');
});

// ===========================================================================
// G1 — auxiliary-model routing
// ===========================================================================

test('resolveAuxTarget resolves valid bots, returns null silently when unset, warns once on junk', () => {
  resetAuxWarningForTest();
  assert.equal(resolveAuxTarget({}), null);
  assert.equal(resolveAuxTarget(null), null);

  const haiku = resolveAuxTarget({ auxBot: 'ox-haiku' });
  assert.equal(haiku.model, 'claude-haiku-4-5');
  assert.equal(haiku.provider, 'anthropic');

  const orig = process.stderr.write;
  const lines = [];
  process.stderr.write = (s) => {
    lines.push(String(s));
    return true;
  };
  try {
    const bad = { auxBot: 'definitely-not-a-bot-xyz' };
    assert.equal(resolveAuxTarget(bad), null, 'unresolvable -> null, never throws');
    assert.equal(resolveAuxTarget(bad), null, 'still null on repeat');
    assert.equal(lines.length, 1, `warned exactly once, got ${lines.length}: ${lines.join('|')}`);
    assert.match(lines[0], /definitely-not-a-bot-xyz/);
    assert.match(lines[0], /aux bot/);
  } finally {
    process.stderr.write = orig;
  }

  // custom bots defined in config.bots resolve too
  const custom = resolveAuxTarget({
    auxBot: 'cheapo',
    bots: { cheapo: { provider: 'custom', baseUrl: 'http://127.0.0.1:9/v1' } },
  });
  assert.equal(custom?.provider, 'custom');
  assert.equal(custom?.model, null);
});

test('loadConfig picks up aux_bot/model_window/compact_at/keep_turns/soul with env winning aux_bot', () => {
  const cfgFile = path.join(home, '.ox', 'config.json');
  fs.writeFileSync(
    cfgFile,
    JSON.stringify({ aux_bot: 'ox-flash', model_window: 7777, compact_at: 0.9, keep_turns: 2 })
  );
  try {
    const c = loadConfig({ cwd: ws });
    assert.equal(c.auxBot, 'ox-flash');
    assert.equal(c.modelWindow, 7777);
    assert.equal(c.compactAt, 0.9);
    assert.equal(c.keepTurns, 2);
    assert.equal(c.soul, true);

    process.env.OX_AUX_BOT = 'ox-haiku';
    assert.equal(loadConfig({ cwd: ws }).auxBot, 'ox-haiku', 'OX_AUX_BOT env beats file');
    delete process.env.OX_AUX_BOT;

    assert.equal(loadConfig({ cwd: ws, auxBot: 'ox-grok-fast' }).auxBot, 'ox-grok-fast', 'flag-level override wins');

    fs.writeFileSync(cfgFile, JSON.stringify({ compact_at: 0.3 }));
    assert.equal(loadConfig({ cwd: ws }).compactAt, 0.5, 'compact_at clamped up to 0.5');
    fs.writeFileSync(cfgFile, JSON.stringify({ compact_at: 0.99 }));
    assert.equal(loadConfig({ cwd: ws }).compactAt, 0.95, 'compact_at clamped down to 0.95');
    fs.writeFileSync(cfgFile, JSON.stringify({ soul: false }));
    assert.equal(loadConfig({ cwd: ws }).soul, false, 'soul:false recorded');

    fs.writeFileSync(cfgFile, '{}');
    const d = loadConfig({ cwd: ws });
    assert.equal(d.auxBot, null);
    assert.equal(d.modelWindow, null);
    assert.equal(d.compactAt, 0.75);
    assert.equal(d.keepTurns, 4);
    assert.equal(d.soul, true);
  } finally {
    fs.rmSync(cfgFile, { force: true });
  }
});

test('compactionKnobs: defaults, clamping, env overrides beat config', () => {
  assert.deepEqual(compactionKnobs({}), { compactAt: 0.75, keepTurns: 4 });
  assert.deepEqual(compactionKnobs({ compactAt: 0.5, keepTurns: 7 }), { compactAt: 0.5, keepTurns: 7 });
  assert.equal(compactionKnobs({ compactAt: 0.99 }).compactAt, 0.95);
  assert.equal(compactionKnobs({ compactAt: -3 }).compactAt, 0.5);
  assert.equal(compactionKnobs({ keepTurns: 1.9 }).keepTurns, 2);
  process.env.OX_COMPACT_AT = '0.6';
  process.env.OX_KEEP_TURNS = '2';
  try {
    assert.deepEqual(compactionKnobs({ compactAt: 0.9, keepTurns: 8 }), { compactAt: 0.6, keepTurns: 2 });
  } finally {
    delete process.env.OX_COMPACT_AT;
    delete process.env.OX_KEEP_TURNS;
  }
});

test('aux routing: judge + compaction summarizer hit the aux target; usage tagged aux:true and labeled in totals', async (t) => {
  const cwd = tmpDir(t, 'ox-gaps1-auxflow-');
  const main = await startServer(t, (b) => {
    if (isJudgeBody(b)) throw new Error('judge must never reach the main target');
    return turn({ text: 'AUXFLOW_FINAL done' }); // single main turn, no tool calls
  });
  let auxRole = 'summary';
  const aux = await startServer(t, (b) => {
    assert.ok(!Array.isArray(b.tools) || b.tools == null || b.tools.length === 0, 'aux calls omit tools');
    if (isJudgeBody(b)) {
      return turn({
        text: '{"complete": true, "gaps": ""}',
        usage: { prompt_tokens: 111, completion_tokens: 7 },
      });
    }
    assert.ok(isSummaryBody(b), 'aux sees the summarizer prompt');
    return turn({ text: 'AUX_SUMMARY_MARKER preserved decisions', usage: { prompt_tokens: 30, completion_tokens: 10 } });
  });

  const events = await collectEvents({
    target: mkTarget(main.port),
    auxTarget: mkTarget(aux.port, 'aux-model'),
    messages: bigHistoryMsgs(),
    ctx: { cwd, modelWindow: 600 }, // forces est (~800 tok) past 0.75*600
    config: {},
    verify: true,
  });

  assert.ok(events.some((e) => e.type === 'compaction'), 'compaction ran under tiny window');
  assert.equal(aux.bodies.length, 2, 'aux served summary + judge');
  assert.equal(main.bodies.length, 1, 'main served only the agent turn');
  assert.ok(isSummaryBody(aux.bodies[0]), 'first aux call is the summarizer');
  assert.ok(isJudgeBody(aux.bodies[1]), 'second aux call is the goal verifier');
  const judgeUser = aux.bodies[1].messages.find((m) => m.role === 'user')?.content ?? '';
  assert.ok(judgeUser.includes('GOAL:') && judgeUser.includes('TRANSCRIPT DIGEST:'), 'judge request carries goal + digest');

  const auxUsageEvents = events.filter((e) => e.type === 'usage' && e.aux === true);
  assert.deepEqual(
    auxUsageEvents.map((e) => [e.inputTokens, e.outputTokens]),
    [
      [30, 10],
      [111, 7],
    ],
    'both auxiliary usage events tagged aux:true'
  );
  const total = events.find((e) => e.type === 'usage-total');
  assert.equal(total.inputTokens, 21 + 30 + 111, 'grand totals include aux spend');
  assert.equal(total.outputTokens, 13 + 10 + 7);
  assert.equal(total.auxInputTokens, 141, 'labeled aux totals');
  assert.equal(total.auxOutputTokens, 17);
  assert.equal(total.auxCostUsd, null, 'mock models are unpriced');
  assert.equal(events.filter((e) => e.type === 'verification').length, 1, 'verifier completed in one round');
});

test('without an aux target, verifier traffic stays on the main target and stays untagged', async (t) => {
  const cwd = tmpDir(t, 'ox-gaps1-noaux-');
  const main = await startServer(t, (b) => {
    if (isJudgeBody(b)) return turn({ text: '{"complete": true, "gaps": ""}', usage: { prompt_tokens: 50, completion_tokens: 5 } });
    return turn({ text: 'plain final' });
  });
  const events = await collectEvents({
    target: mkTarget(main.port),
    messages: [{ role: 'user', content: 'finish fast' }],
    ctx: { cwd },
    config: {},
    verify: true,
  });
  assert.equal(main.bodies.length, 2, 'agent turn + judge on the same target');
  assert.ok(isJudgeBody(main.bodies[1]));
  const tagged = events.filter((e) => e.type === 'usage' && e.aux === true);
  assert.deepEqual(tagged, [], 'nothing tagged aux without an aux target');
  const total = events.find((e) => e.type === 'usage-total');
  assert.equal(total.inputTokens, 71);
  assert.equal(total.auxInputTokens, 0);
});

test('maxmode planning + judge route to the aux target when one is provided', async (t) => {
  const main = await startServer(t, () => {
    throw new Error('main target must not receive max-mode traffic');
  });
  const aux = await startServer(t, (b) => {
    const joined = JSON.stringify(b.messages ?? []);
    if (joined.includes('CANDIDATE PLANS')) {
      return turn({ text: '{"best": 2, "reason": "tighter"}', usage: { prompt_tokens: 31, completion_tokens: 11 } });
    }
    return turn({ text: 'AUX_PLAN_MARKER step one', usage: { prompt_tokens: 21, completion_tokens: 13 } });
  });

  const mm = await runMaxModePlanning({
    target: mkTarget(main.port),
    auxTarget: mkTarget(aux.port, 'aux-model'),
    goal: 'add oauth device login',
    n: 2,
    cwd: ws,
  });
  assert.equal(mm.skipped, false);
  assert.equal(mm.chosen, 2);
  assert.equal(mm.aux, true, 'aux flag reported');
  assert.deepEqual(
    mm.auxUsage,
    { inputTokens: 21 * 2 + 31, outputTokens: 13 * 2 + 11 },
    'all maxmode spend labeled aux'
  );
  assert.deepEqual(mm.usage, mm.auxUsage, 'aggregated usage mirrors the aux spend');
  assert.equal(aux.bodies.length, 3, 'two planners + one judge on aux');
  assert.equal(main.bodies.length, 0, 'main untouched');

  // no aux target -> previous behavior, nothing tagged
  const solo = await startServer(t, (b) => {
    const joined = JSON.stringify(b.messages ?? []);
    if (joined.includes('CANDIDATE PLANS')) return turn({ text: '{"best": 1, "reason": "ok"}' });
    return turn({ text: 'SOLO_PLAN_MARKER plan' });
  });
  const mm2 = await runMaxModePlanning({
    target: mkTarget(solo.port),
    goal: 'do it',
    n: 2,
    cwd: ws,
  });
  assert.equal(mm2.aux, false);
  assert.deepEqual(mm2.auxUsage, { inputTokens: 0, outputTokens: 0 });
});

// ===========================================================================
// G5 — persona injection
// ===========================================================================

test('buildSystemPrompt injects ## PERSONA block with the safety-precedence rule line', async () => {
  const base = await buildSystemPrompt({ cwd: ws, contextParts: {} });
  assert.ok(!base.includes('PERSONA'), 'no persona section by default');

  const withPersona = await buildSystemPrompt({ cwd: ws, contextParts: {}, personaBlock: 'Speak like a crusty pirate.' });
  assert.ok(withPersona.includes('## PERSONA'));
  assert.ok(withPersona.includes('Speak like a crusty pirate.'));
  assert.match(withPersona, /persona shapes tone[^]*never overrides/i, 'tone-only / never-overrides rule present');
  assert.ok(withPersona.includes('# TOOL RULES'), 'tool rules survive');
  const personaIdx = withPersona.indexOf('## PERSONA');
  const skillsIdx = withPersona.indexOf('# SKILLS');
  assert.ok(personaIdx > -1 && skillsIdx > personaIdx, 'persona sits between memory and skills sections');
});

test('loadPersona reads ~/.ox/soul.md then <cwd>/SOUL.md with per-file truncation notice', () => {
  const soulHome = path.join(home, '.ox', 'soul.md');
  const soulCwd = path.join(ws, 'SOUL.md');
  fs.writeFileSync(soulHome, `HOME_SOUL_MARKER ${'h'.repeat(6000)}`);
  fs.writeFileSync(soulCwd, 'CWD_SOUL_MARKER be terse');
  try {
    const p = loadPersona({ home, cwd: ws });
    assert.equal(p.enabled, true);
    assert.deepEqual(p.found, { home: true, cwd: true });
    assert.equal(p.truncated, true);
    assert.ok(p.sizes.home <= 4000, `home persona clipped (${p.sizes.home})`);
    assert.ok(p.block.includes('HOME_SOUL_MARKER') && p.block.includes('CWD_SOUL_MARKER'));
    assert.ok(p.block.indexOf('HOME_SOUL_MARKER') < p.block.indexOf('CWD_SOUL_MARKER'), 'home file comes first');
    assert.match(p.block, /\[ox: persona truncated[^\]]*\]/, 'combined truncation notice appended');
    assert.ok(p.block.length < 4200, `block bounded (${p.block.length})`);

    const disabled = loadPersona({ home, cwd: ws, enabled: false });
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.block, '');
    assert.deepEqual(disabled.found, { home: false, cwd: false });
    assert.ok(typeof disabled.paths.home === 'string' && disabled.paths.home.endsWith('soul.md'));

    fs.rmSync(soulHome, { force: true });
    fs.rmSync(soulCwd, { force: true });
    const empty = loadPersona({ home, cwd: ws });
    assert.equal(empty.block, '');
    assert.equal(empty.truncated, false);
    assert.deepEqual(empty.found, { home: false, cwd: false });
  } finally {
    fs.rmSync(soulHome, { force: true });
    fs.rmSync(soulCwd, { force: true });
  }
});

test('runAgent threads ctx.personaBlock into the system message', async (t) => {
  const cwd = tmpDir(t, 'ox-gaps1-persona-');
  const { port, bodies } = await startServer(t, () => turn({ text: 'persona final' }));
  await collectEvents({
    target: mkTarget(port),
    messages: [{ role: 'user', content: 'hi' }],
    ctx: { cwd, personaBlock: 'REPL_PERSONA_MARKER stay terse' },
    auxTarget: null,
  });
  assert.equal(bodies.length, 1);
  const sys = bodies[0].messages.find((m) => m.role === 'system');
  assert.match(sys.content, /## PERSONA[\s\S]*REPL_PERSONA_MARKER/);
  assert.match(sys.content, /persona shapes tone/i);
});

// ===========================================================================
// G6 — compaction knobs observable through events
// ===========================================================================

function knobServer(t) {
  return startServer(t, (b) => {
    if (isSummaryBody(b)) return turn({ text: 'KNOB_SUMMARY decisions kept', usage: { prompt_tokens: 30, completion_tokens: 10 } });
    return turn({ text: 'KNOB_FINAL done' });
  });
}

test('compact_at=0.5 compacts where compact_at=0.9 does not, under the same forced tiny window', async (t) => {
  // est lands in (0.5*W, 0.9*W) for W=7000 regardless of system-prompt drift:
  // payload ~4000 tok + system noise (200..800) stays under 6300 = 0.9*W and
  // over 3500 = 0.5*W.
  const msgs = bigHistoryMsgs(16_000);
  const early = await knobServer(t);
  const earlyEvents = await collectEvents({
    target: mkTarget(early.port),
    messages: msgs,
    ctx: { cwd: ws, modelWindow: 7000 },
    config: { compactAt: 0.5 },
    auxTarget: null,
  });
  assert.ok(earlyEvents.some((e) => e.type === 'compaction'), 'compact_at 0.5 triggers below the window');

  const late = await knobServer(t);
  const lateEvents = await collectEvents({
    target: mkTarget(late.port),
    messages: msgs,
    ctx: { cwd: ws, modelWindow: 7000 },
    config: { compactAt: 0.9 },
    auxTarget: null,
  });
  assert.equal(lateEvents.some((e) => e.type === 'compaction'), false, 'compact_at 0.9 does NOT trigger yet');
  assert.ok(lateEvents.some((e) => e.type === 'final'));
});

test('keep_turns high enough suppresses compaction entirely; summary usage counted untagged', async (t) => {
  const srv = await knobServer(t);
  const events = await collectEvents({
    target: mkTarget(srv.port),
    messages: bigHistoryMsgs(),
    ctx: { cwd: ws, modelWindow: 400 }, // 0.75*400=300 << est
    config: { keepTurns: 99 }, // tail swallows everything -> nothing to summarize
    auxTarget: null,
  });
  assert.equal(events.some((e) => e.type === 'compaction'), false, 'huge keep_turns leaves no summarize slice');

  const srv2 = await knobServer(t);
  const events2 = await collectEvents({
    target: mkTarget(srv2.port),
    messages: bigHistoryMsgs(),
    ctx: { cwd: ws, modelWindow: 400 },
    config: {},
    auxTarget: null,
  });
  assert.ok(events2.some((e) => e.type === 'compaction'), 'default knobs do compact');
  const u = events2.find((e) => e.type === 'usage' && e.inputTokens === 30);
  assert.ok(u, 'summary usage event emitted');
  assert.notEqual(u.aux, true, 'untagged when no aux configured');
  const total = events2.find((e) => e.type === 'usage-total');
  assert.equal(total.inputTokens, 51, '30 summary + 21 final-turn input tokens');
});

// ===========================================================================
// G1 — --aux-bot flag end-to-end (subprocess, loopback mocks only)
// ===========================================================================

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OX_BIN = path.join(ROOT, 'bin', 'ox.js');

function spawnOx({ args, extraEnv = {} }) {
  const child = spawn(process.execPath, [OX_BIN, ...args], {
    cwd: ws,
    env: {
      ...process.env,
      HOME: home,
      NO_COLOR: '1',
      OX_API_KEY: 'test-gaps-key',
      ...extraEnv,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  const done = new Promise((resolve) => {
    const killer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ code: null, stdout, stderr: `${stderr}\n[gaps1: timed out]` });
    }, 25000);
    child.on('error', () => {
      clearTimeout(killer);
      resolve({ code: null, stdout, stderr });
    });
    child.on('close', (code) => {
      clearTimeout(killer);
      resolve({ code, stdout, stderr });
    });
  });
  child.stdin.end();
  return done;
}

test('--aux-bot flag routes verifier traffic to the aux bot in a real CLI run', async (t) => {
  const cfgFile = path.join(home, '.ox', 'config.json');
  fs.writeFileSync(cfgFile, '{}'); // isolation: no global aux_bot
  const flagHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-gaps1-flagws-'));
  t.after(() => fs.rmSync(flagHome, { recursive: true, force: true }));

  const main = await startServer(t, (b) => {
    if (isJudgeBody(b)) throw new Error('judge leaked to the main provider');
    return turn({ text: 'FLAG_MAIN_DONE finished the work' });
  });
  const aux = await startServer(t, (b) => {
    assert.ok(isJudgeBody(b), 'aux only sees verifier traffic');
    return turn({ text: '{"complete": true, "gaps": ""}', usage: { prompt_tokens: 111, completion_tokens: 7 } });
  });

  // aux bot definition lives in ~/.ox/config.json bots; selected via --aux-bot
  fs.writeFileSync(
    cfgFile,
    JSON.stringify({ bots: { gapstestaux: { provider: 'custom', baseUrl: `http://127.0.0.1:${aux.port}/v1` } } })
  );

  try {
    const out = await spawnOx({
      args: ['-p', 'wrap it up', '--json', '--verify', '--aux-bot', 'gapstestaux'],
      extraEnv: { OX_BASE_URL: `http://127.0.0.1:${main.port}/v1` },
    });
    assert.equal(out.code, 0, `exit ${out.code}\nstdout: ${out.stdout}\nstderr: ${out.stderr}`);
    const events = out.stdout.split('\n').filter((l) => l.trim().startsWith('{')).map((l) => JSON.parse(l));
    const auxTagged = events.filter((e) => e.t === 'usage' && e.aux === true);
    assert.equal(auxTagged.length, 1, 'one aux-tagged usage event (the verifier)');
    assert.equal(auxTagged[0].inputTokens, 111);
    const total = events.find((e) => e.t === 'usage-total');
    assert.equal(total.auxInputTokens, 111, 'CLI totals carry labeled aux spend');
    assert.equal(aux.bodies.length, 1, 'aux provider contacted exactly once');
    assert.ok(events.some((e) => e.t === 'final'));
  } finally {
    fs.rmSync(cfgFile, { force: true });
  }
});
