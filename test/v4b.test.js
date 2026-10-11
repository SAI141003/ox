import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Sandbox HOME + workspace BEFORE importing src modules (config.js bakes
// CONFIG_DIR from os.homedir() at import time — same pattern as gaps2).
// ---------------------------------------------------------------------------

const realHome = process.env.HOME;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-v4b-home-'));
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-v4b-ws-'));
process.env.HOME = home;
fs.mkdirSync(path.join(home, '.ox'), { recursive: true });
process.env.OX_API_KEY = process.env.OX_API_KEY ?? 'test-v4b-key';

const savedEnv = Object.fromEntries(['OX_FALLBACK_BOTS', 'OX_MODEL_WINDOW', 'OX_AUX_BOT'].map((k) => [k, process.env[k]]));
for (const k of ['OX_FALLBACK_BOTS', 'OX_MODEL_WINDOW', 'OX_AUX_BOT']) delete process.env[k];

after(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(ws, { recursive: true, force: true });
  process.env.HOME = realHome;
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const { runAgent, classifyProviderError } = await import('../src/agent.js');
const { loadConfig } = await import('../src/config.js');
const { assembleCtx, cleanupCtx } = await import('../src/headless.js');

// ---------- mock-provider plumbing (loopback HTTP) ----------

const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

function turn({ text = '', usage = { prompt_tokens: 21, completion_tokens: 13 } } = {}) {
  return [
    text ? sse({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }) : '',
    sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    sse({ choices: [], usage }),
    'data: [DONE]\n\n',
  ].join('');
}

function startServerRaw(t, handler) {
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
      handler(parsed, res);
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

function statusServer(t, status, statusText, bodyText) {
  return startServerRaw(t, (b, res) => {
    res.writeHead(status, { 'content-type': 'text/plain' });
    res.end(bodyText ?? `${status} ${statusText}`);
  });
}

const mkTarget = (port, model = 'mock-model') => ({
  provider: 'custom',
  baseUrl: `http://127.0.0.1:${port}/v1`,
  model,
});

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

// ---------- classifier ----------

test('classifyProviderError buckets provider failure strings', () => {
  assert.equal(classifyProviderError('ox[custom]: HTTP 429 Too Many Requests: slow down'), 'rate-limit');
  assert.equal(classifyProviderError('quota exceeded for project'), 'rate-limit');
  assert.equal(classifyProviderError('ox[xai]: HTTP 401 Unauthorized: bad key'), 'auth');
  assert.equal(classifyProviderError('ox[gemini]: HTTP 403 Forbidden'), 'auth');
  assert.equal(classifyProviderError('HTTP 404 model not found'), 'not-found');
  assert.equal(classifyProviderError('ox[anthropic]: HTTP 503 Service Unavailable'), 'server');
  assert.equal(classifyProviderError('HTTP 500 Internal Server Error'), 'server');
  assert.equal(classifyProviderError('fetch failed / socket hang up'), null, 'generic network death is unclassified');
});

// ---------- F2 bounce behavior ----------

test('persistent 429 on primary bounces once to the secondary; next turn restores primary', async (t) => {
  const cwd = tmpDir(t, 'ox-v4b-429-');
  const primary = await statusServer(t, 429, 'Too Many Requests', 'rate limited');
  let secondaryHits = 0;
  const secondary = await startServerRaw(t, (b, res) => {
    secondaryHits++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(turn({ text: 'SECONDARY_OK answer' }));
  });

  const baseOpts = {
    messages: [{ role: 'user', content: 'hi' }],
    ctx: { cwd, fallbackTargets: [mkTarget(secondary.port)] },
    auxTarget: null,
  };

  // ---- turn 1 ----
  const events1 = await collectEvents({ ...baseOpts, target: mkTarget(primary.port) });
  const fb1 = events1.filter((e) => e.type === 'fallback');
  assert.equal(fb1.length, 1, `exactly one bounce in turn 1: ${JSON.stringify(fb1)}`);
  assert.match(fb1[0].from, new RegExp(String(primary.port)));
  assert.match(fb1[0].to, new RegExp(String(secondary.port)));
  assert.match(fb1[0].reason, /429|rate/i);
  assert.deepEqual(
    events1.filter((e) => e.type === 'continuation-retry').map((e) => e.attempt),
    [1, 2, 3],
    'primary consumed its retry budget before the bounce'
  );
  const final1 = events1.find((e) => e.type === 'final');
  assert.ok(final1, 'turn completed via fallback');
  assert.equal(final1.message.content, 'SECONDARY_OK answer');
  assert.equal(events1.some((e) => e.type === 'error'), false, 'no terminal error after successful bounce');
  assert.equal(primary.bodies.length, 4, 'initial + 3 retries against primary only');
  assert.equal(secondaryHits, 1);

  // ---- turn 2 (next user message): primary is restored and bounces again ----
  const beforePrimary = primary.bodies.length;
  const events2 = await collectEvents({ ...baseOpts, target: mkTarget(primary.port) });
  const fb2 = events2.filter((e) => e.type === 'fallback');
  assert.equal(fb2.length, 1, 'turn-scoped budget resets per user message');
  assert.ok(events2.find((e) => e.type === 'final'), 'second turn also completed');
  assert.ok(primary.bodies.length > beforePrimary, 'primary received fresh requests — restoration proven');
});

test('401 skips retries and bounces immediately (one request to primary)', async (t) => {
  const cwd = tmpDir(t, 'ox-v4b-401-');
  const primary = await statusServer(t, 401, 'Unauthorized', 'bad api key');
  const secondary = await startServerRaw(t, (b, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(turn({ text: 'AUTH_FALLBACK_OK' }));
  });

  const events = await collectEvents({
    target: mkTarget(primary.port),
    messages: [{ role: 'user', content: 'hi' }],
    ctx: { cwd, fallbackTargets: [mkTarget(secondary.port)] },
    auxTarget: null,
  });

  assert.equal(primary.bodies.length, 1, 'no pointless auth retries against primary');
  assert.equal(events.filter((e) => e.type === 'continuation-retry').length, 0);
  const fb = events.find((e) => e.type === 'fallback');
  assert.ok(fb, 'fallback event emitted');
  assert.equal(fb.kind, 'auth');
  assert.equal(events.find((e) => e.type === 'final')?.message.content, 'AUTH_FALLBACK_OK');
});

test('max one bounce per turn: failing secondary ends with a clean error', async (t) => {
  const cwd = tmpDir(t, 'ox-v4b-once-');
  const primary = await statusServer(t, 401, 'Unauthorized', 'nope');
  const secondary = await statusServer(t, 401, 'Unauthorized', 'also nope');

  const events = await collectEvents({
    target: mkTarget(primary.port),
    messages: [{ role: 'user', content: 'hi' }],
    ctx: { cwd, fallbackTargets: [mkTarget(secondary.port)] },
    auxTarget: null,
  });

  assert.equal(events.filter((e) => e.type === 'fallback').length, 1, 'single bounce');
  const errs = events.filter((e) => e.type === 'error');
  assert.equal(errs.length, 1, 'terminal error after fallback also fails');
  assert.match(errs[0].error, /provider auth failure/);
  assert.equal(secondary.bodies.length, 1, 'secondary tried exactly once');
  assert.ok(!events.some((e) => e.type === 'final'));
});

test('no fallbacks configured → clean error as today (no fallback events)', async (t) => {
  const cwd = tmpDir(t, 'ox-v4b-none-');
  const primary = await statusServer(t, 429, 'Too Many Requests', 'limited');

  const events = await collectEvents({
    target: mkTarget(primary.port),
    messages: [{ role: 'user', content: 'hi' }],
    ctx: { cwd },
    auxTarget: null,
  });

  assert.equal(events.some((e) => e.type === 'fallback'), false);
  const errs = events.filter((e) => e.type === 'error');
  assert.equal(errs.length, 1);
  assert.match(errs[0].error, /stream died after 3 retries/);
  assert.match(errs[0].error, /\(rate-limit\)/);
  assert.equal(events.some((e) => e.type === 'final'), false);
  assert.ok(events.some((e) => e.type === 'usage-total'), 'usage totals still emitted');
});

test('cost math uses the ACTIVE target pricing (secondary haiku rates)', async (t) => {
  const cwd = tmpDir(t, 'ox-v4b-cost-');
  const primary = await statusServer(t, 429, 'Too Many Requests', 'limited');
  const secondary = await startServerRaw(t, (b, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(turn({ text: 'priced!', usage: { prompt_tokens: 1_000_000, completion_tokens: 0 } }));
  });

  const events = await collectEvents({
    target: mkTarget(primary.port),
    messages: [{ role: 'user', content: 'hi' }],
    ctx: { cwd, fallbackTargets: [mkTarget(secondary.port, 'claude-haiku-4-5')] },
    auxTarget: null,
  });

  const final = events.find((e) => e.type === 'final');
  assert.ok(final, 'completed on secondary');
  const usageEvts = events.filter((e) => e.type === 'usage');
  assert.ok(usageEvts.length >= 1);
  for (const u of usageEvts) {
    assert.equal(u.model, 'claude-haiku-4-5', 'usage attributed to active (fallback) model');
    assert.equal(u.costUsd, 1, '1M input tokens at $1/M haiku pricing');
  }
  const total = events.find((e) => e.type === 'usage-total');
  assert.ok(total, 'usage-total present');
  assert.equal(total.costUsd, 1, 'total cost at secondary pricing');
  assert.equal(total.fellBack, true, 'usage-total flags the bounce');
  assert.match(total.servedBy, new RegExp(String(secondary.port)));
});

// ---------- config + ctx wiring ----------

test('loadConfig parses fallback_bots from file array and OX_FALLBACK_BOTS comma-list', () => {
  const cfgFile = path.join(home, '.ox', 'config.json');
  fs.writeFileSync(cfgFile, `${JSON.stringify({ fallback_bots: ['ox-gemini'] }, null, 2)}\n`);
  assert.deepEqual(loadConfig().fallbackBots, ['ox-gemini']);

  process.env.OX_FALLBACK_BOTS = 'ox-claude, ox-flash ,';
  try {
    assert.deepEqual(loadConfig().fallbackBots, ['ox-claude', 'ox-flash']);
  } finally {
    delete process.env.OX_FALLBACK_BOTS;
  }

  fs.writeFileSync(cfgFile, '{}\n');
  assert.deepEqual(loadConfig().fallbackBots, []);
  assert.deepEqual(loadConfig().curator, { stale_after_days: 30, archive_after_days: 90 });
  assert.deepEqual(loadConfig().skillPins, []);
});

test('assembleCtx resolves ctx.fallbackTargets and warns once on unusable specs', async (t) => {
  const dir = tmpDir(t, 'ox-v4b-ctx-');
  const errWrites = [];
  const origErrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    errWrites.push(String(chunk));
    return origErrWrite(chunk, ...rest);
  };
  let assembled;
  try {
    assembled = await assembleCtx({
      config: {
        cwd: dir,
        baseUrl: 'http://127.0.0.1:9/v1',
        fallbackBots: ['custom:fb-model', 'nosuchprovider:m'],
      },
      target: { provider: 'custom', baseUrl: 'http://127.0.0.1:9/v1', model: 'main-model' },
      opts: {},
    });
  } finally {
    process.stderr.write = origErrWrite;
  }
  try {
    const fbt = assembled.ctx.fallbackTargets;
    assert.equal(fbt.length, 1, JSON.stringify(fbt));
    assert.equal(fbt[0].provider, 'custom');
    assert.equal(fbt[0].model, 'fb-model');
    assert.equal(errWrites.filter((w) => w.includes("fallback bot 'nosuchprovider:m' unusable")).length, 1);
  } finally {
    await cleanupCtx(assembled);
  }
});
