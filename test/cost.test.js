import { test } from 'node:test';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { PRICING, lookupModel, costOf, formatCost, createCostBudget, assertCostBudget, currentCostBudget, resolveMaxCostUsd } from '../src/cost.js';

test('costOf exact arithmetic for priced models', () => {
  const cases = [
    ['grok-4.6', { inputTokens: 250_000, outputTokens: 125_000 }, 1.25],
    ['gpt-5.6-sol', { inputTokens: 10_000, outputTokens: 2_000 }, 0.08],
    ['claude-opus-5', { inputTokens: 100_000, outputTokens: 40_000 }, 1.5],
    ['gemini-3.7-flash', { inputTokens: 1_000_000, outputTokens: 500_000 }, 1.32],
    ['claude-haiku-4-5', { inputTokens: 333_333, outputTokens: 7_777 }, null],
  ];
  for (const [model, usage, approx] of cases) {
    const p = PRICING[model];
    const expected = (usage.inputTokens * p.in + usage.outputTokens * p.out) / 1_000_000;
    assert.equal(costOf(model, usage), expected, model);
    if (approx !== null) {
      assert.ok(Math.abs(expected - approx) < 1e-9, `${model}: ${expected} ~= ${approx}`);
    }
  }
});

test('costOf returns null for unpriced or invalid models', () => {
  assert.equal(costOf('totally-unknown-model', { inputTokens: 1000 }), null);
  assert.equal(costOf(null, { inputTokens: 1000 }), null);
  assert.equal(costOf(undefined), null);
  assert.deepEqual(lookupModel('grok-4.6'), { in: 2, out: 6, window: 500_000, priced: true });
  assert.deepEqual(lookupModel('nope'), { priced: false });
});

test('costOf defaults missing usage to zero tokens', () => {
  assert.equal(costOf('grok-4.6', {}), 0);
  assert.equal(costOf('grok-4.6'), 0);
});

test('budget scope prices actual models and fails closed at equality or unknown cost', async () => {
  const budget = createCostBudget({ maxCostUsd: 3 });
  await budget.run(async () => {
    assert.equal(currentCostBudget(), budget);
    budget.record('grok-4.6', { inputTokens: 500_000 });
    budget.record('claude-opus-5', { inputTokens: 400_000 });
    assert.equal(budget.snapshot().costUsd, 3);
    assert.throws(() => assertCostBudget(), { code: 'OX_BUDGET_STOP' });
  });
  assert.equal(currentCostBudget(), undefined);
  const unknown = createCostBudget({ maxCostUsd: 10 });
  unknown.record('grok-4.6', { inputTokens: 500_000 });
  unknown.record('unknown', { inputTokens: 1 });
  assert.equal(unknown.snapshot().costUsd, null);
  assert.equal(unknown.snapshot().knownCostUsd, 1);
  assert.throws(() => unknown.assert(), { code: 'OX_BUDGET_STOP' });
  assert.equal(resolveMaxCostUsd({ maxCostUsd: 0, config: { maxCostUsd: 2 }, env: { OX_MAX_COST: '3' } }), 0);
});

// ---------------------------------------------------------------------------
// supervise() - the spawned-CLI watchdog, in the shape bench/harness.mjs
// spawnOx() already uses (captured stdout/stderr + elapsed ms) but STRICT on
// failure. The harness used to arm a bare `setTimeout(() =>
// child.kill('SIGKILL'), 15000)`: when that fired the test failed with a silent
// non-zero exit and NO diagnostic at all, which is why a whole 10-failure run
// could not be diagnosed. Now the kill is followed by a rejection carrying
// elapsed ms, the child's exit/signal, its argv, and everything it printed
// before it stopped - a wedged child becomes a legible failure, not a mystery.
//
// 45s, not 15s: the happy path for these spawns is well under a second (a
// loopback SSE mock, no network, sandboxed HOME). This budget is only a
// watchdog for a child that will never exit, so it wants headroom: the suite
// runs --test-concurrency=2 and other suites deliberately burn 15-33s waiting
// out real timeouts, and a 15s budget has no slack left for external load.
// ---------------------------------------------------------------------------
const CHILD_BUDGET_MS = 45000;
const OUTPUT_CAP = 20_000;   // keep the tail; a runaway child cannot OOM the runner
const OUTPUT_SHOWN = 4_000;  // how much of it a failure message prints

function pushTail(prev, chunk) {
  const next = prev + chunk;
  return next.length > OUTPUT_CAP ? next.slice(next.length - OUTPUT_CAP) : next;
}

function supervise(child, argv, { timeoutMs = CHILD_BUDGET_MS } = {}) {
  const started = Date.now();
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => { stdout = pushTail(stdout, d); });
  child.stderr.on('data', (d) => { stderr = pushTail(stderr, d); });
  const done = new Promise((resolve, reject) => {
    let timedOut = false;
    const killer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(killer);
      reject(err);
    });
    child.on('close', (code, signal) => {
      clearTimeout(killer);
      const ms = Date.now() - started;
      if (!timedOut) return resolve({ code, signal, stdout, stderr, ms });
      reject(new Error([
        `ox CLI did not exit within ${timeoutMs}ms - SIGKILLed after ${ms}ms`,
        `exit=${String(code)} signal=${String(signal)}`,
        `argv: ${argv}`,
        `stdout (last ${OUTPUT_SHOWN} chars):\n${stdout.slice(-OUTPUT_SHOWN)}`,
        `stderr (last ${OUTPUT_SHOWN} chars):\n${stderr.slice(-OUTPUT_SHOWN)}`,
      ].join('\n')));
    });
  });
  child.stdin.end();
  return done;
}

async function runBudgetCli(t, { args = [], config = {}, env = {}, reply } = {}) {  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-budget-'));
  const cwd = path.join(home, 'project');
  fs.mkdirSync(cwd);
  fs.mkdirSync(path.join(home, '.ox'));
  fs.writeFileSync(path.join(home, '.ox', 'config.json'), JSON.stringify(config));
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const data = JSON.parse(body);
    calls.push(data);
    if (reply) return reply(data, res, calls.length);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: 0 } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const childEnv = { HOME: home, PATH: process.env.PATH, NO_COLOR: '1', OX_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`, OX_API_KEY: 'loopback-only', OX_MODEL: 'grok-4.6', ...env };
  const argv = [new URL('../bin/ox.js', import.meta.url).pathname, ...args];
  const child = spawn(process.execPath, argv, { cwd, env: childEnv });
  const { code, stdout, stderr } = await supervise(child, `node ${argv.join(' ')}`);
  return { code, stdout, stderr, calls, events: stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line)) };
}

for (const json of [false, true]) {
  test(`headless stops at configured exact cap before verifier/tools (${json ? 'json' : 'text'})`, async t => {
    const r = await runBudgetCli(t, { args: ['-p', 'hello', '--verify', ...(json ? ['--json'] : [])], config: { maxCostUsd: 0.002 } });
    assert.equal(r.code, 2, r.stdout + r.stderr);
    assert.equal(r.calls.length, 1);
    assert.match(r.stdout, /budget-stop/);
    assert.ok(!r.events.some(ev => ev.t === 'final'));
    if (json) assert.equal(r.events.find(ev => ev.t === 'budget-stop').costUsd, 0.002);
  });
}

test('planning stops between candidates at configured cap', async t => {
  const r = await runBudgetCli(t, { args: ['-p', 'hello', '--max-mode', '3', '--json'], config: { maxCostUsd: 0.002 } });
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.equal(r.calls.length, 1);
  assert.equal(r.events.find(ev => ev.t === 'budget-stop').costUsd, 0.002);
});

test('formatCost formatting incl $0 zero case', () => {
  assert.equal(formatCost(0), '$0');
  assert.equal(formatCost(-0), '$0');
  assert.equal(formatCost(NaN), '$0');
  assert.equal(formatCost(1.25), '$1.25');
  assert.equal(formatCost(120), '$120');
  assert.equal(formatCost(0.08), '$0.08');
  assert.equal(formatCost(0.00125), '$0.00125');
  assert.equal(formatCost(0.000042), '$0.000042');
  assert.equal(formatCost(1234), '$1234');
});

// ---------------------------------------------------------------------------
// model_overrides must reach costOf(), not just routing.
// ---------------------------------------------------------------------------

test('costOf honours a model_overrides price row for a model with no PRICING entry', () => {
  const ov = { m: { window: 4096, in: 0.5, out: 1.5 } };
  assert.equal(PRICING.m, undefined);
  assert.equal(costOf('m', { inputTokens: 1000, outputTokens: 100 }, ov), (1000 * 0.5 + 100 * 1.5) / 1e6);
  assert.deepEqual(lookupModel('m', ov), { in: 0.5, out: 1.5, window: 4096, priced: true });
});

test('costOf without overrides still returns null for that model (no invented numbers)', () => {
  const ov = { m: { window: 4096, in: 0.5, out: 1.5 } };
  assert.equal(costOf('m', { inputTokens: 1000, outputTokens: 100 }), null);
  assert.equal(costOf('m', { inputTokens: 1000, outputTokens: 100 }, null), null);
  // A partial override (window only) is not a price: still null, not 0.
  assert.equal(costOf('m', { inputTokens: 1000 }, { m: { window: 4096 } }), null);
  assert.equal(PRICING.m, undefined);
});

test('an unrelated overrides object leaves a priced model exactly unchanged', () => {
  const usage = { inputTokens: 250_000, outputTokens: 125_000 };
  const base = costOf('grok-4.6', usage);
  assert.equal(costOf('grok-4.6', usage, {}), base);
  assert.equal(costOf('grok-4.6', usage, { someOtherModel: { in: 99, out: 99 } }), base);
  assert.equal(costOf('grok-4.6', usage, { 'grok-4.6': { window: 999_999 } }), base);
});

test('a price override corrects, rather than replaces, the spend a cap sees', () => {
  const ov = { m: { in: 2, out: 6 } };
  const budget = createCostBudget({ maxCostUsd: 0.01, overrides: ov });
  budget.record('m', { inputTokens: 3000, outputTokens: 1000 });
  assert.equal(budget.snapshot().costUsd, 0.012);
  assert.throws(() => budget.assert(), { code: 'OX_BUDGET_STOP' });
  assert.match(budget.explain(), /cost-cap/);
  const sameNoOverride = createCostBudget({ maxCostUsd: 0.01 });
  sameNoOverride.record('m', { inputTokens: 3000, outputTokens: 1000 });
  assert.equal(sameNoOverride.snapshot().costUsd, null);
});

// ---------------------------------------------------------------------------
// --max-cost against a model that can never bill.
// ---------------------------------------------------------------------------

test('a cap on a keyless local endpoint does not abort: it cannot spend', () => {
  const budget = createCostBudget({ maxCostUsd: 1e-7 });
  budget.free('qwen2.5:0.5b');
  budget.record('qwen2.5:0.5b', { inputTokens: 5114, outputTokens: 115 });
  assert.doesNotThrow(() => budget.assert('qwen2.5:0.5b'));
  assert.equal(budget.reason, null);
  assert.equal(budget.snapshot().costUsd, 0);
  assert.equal(budget.snapshot().knownCostUsd, 0);
  assert.deepEqual(budget.skippedModels, ['qwen2.5:0.5b']);
  // Free means free even when the provider reported no usage at all.
  budget.unknown('qwen2.5:0.5b');
  assert.equal(budget.reason, null);
});

test('a billable but unpriced model still fails the cap closed', async () => {
  const budget = createCostBudget({ maxCostUsd: 100 });
  budget.record('ox-cost-bench-no-such-model', { inputTokens: 1000, outputTokens: 100 });
  await budget.run(async () => {
    assert.equal(currentCostBudget(), budget);
    assert.throws(() => assertCostBudget('ox-cost-bench-no-such-model'), { code: 'OX_BUDGET_STOP', exitCode: 2 });
    // Even with no model in hand, a run that already holds an unpriced,
    // billable model cannot be certified as under its cap.
    assert.throws(() => assertCostBudget(), { code: 'OX_BUDGET_STOP' });
  });
  assert.equal(currentCostBudget(), undefined);
  assert.equal(budget.reason, 'unknown-cost');
  assert.equal(budget.snapshot().costUsd, null);
  assert.deepEqual(budget.snapshot().unknownModels, ['ox-cost-bench-no-such-model']);
});

test('the unknown-cost budget stop names the remedy', () => {
  const budget = createCostBudget({ maxCostUsd: 100 });
  budget.record('ox-cost-bench-no-such-model', { inputTokens: 1000, outputTokens: 100 });
  let err = null;
  try { budget.assert('ox-cost-bench-no-such-model'); } catch (e) { err = e; }
  assert.ok(err, 'budget stop throws');
  assert.match(err.message, /model_overrides/);
  assert.match(err.message, /ox-cost-bench-no-such-model/);
  assert.match(err.message, /drop the cap/);
  assert.equal(budget.explain(), err.message);
});

test('declaring the missing price removes the unknown-cost stop for that model', () => {
  const ov = { 'ox-cost-bench-no-such-model': { in: 0.1, out: 0.2 } };
  const budget = createCostBudget({ maxCostUsd: 1, overrides: ov });
  budget.record('ox-cost-bench-no-such-model', { inputTokens: 1000, outputTokens: 100 });
  assert.doesNotThrow(() => budget.assert('ox-cost-bench-no-such-model'));
  assert.equal(budget.reason, null);
  assert.equal(budget.snapshot().costUsd, 0.00012);
});

// ---------------------------------------------------------------------------
// CLI: exit code + the end-to-end local-model behaviour.
// ---------------------------------------------------------------------------

async function runLocalBudgetCli(t, { args = [], config = {}, env = {} } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-local-budget-'));
  const cwd = path.join(home, 'project');
  fs.mkdirSync(cwd);
  fs.mkdirSync(path.join(home, '.ox'));
  fs.writeFileSync(path.join(home, '.ox', 'config.json'), JSON.stringify(config));
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    calls.push(JSON.parse(body));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1200, completion_tokens: 40 } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  // provider ollama -> keyEnv null, i.e. a local keyless endpoint that can never
  // bill; OX_BASE_URL points it at the loopback server. qwen2.5:0.5b has no
  // price row, so it is unpriced AND free at the same time.
  const childEnv = {
    HOME: home,
    PATH: process.env.PATH,
    NO_COLOR: '1',
    OX_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
    ...env,
  };
  const argv = [new URL('../bin/ox.js', import.meta.url).pathname, ...args];
  const child = spawn(process.execPath, argv, { cwd, env: childEnv });
  const { code, stdout, stderr } = await supervise(child, `node ${argv.join(' ')}`);
  return { code, stdout, stderr, calls, events: stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line)) };
}

test('--max-cost does not abort a run against a keyless local endpoint', async t => {
  for (const cap of ['0.0000001', '100']) {
    const r = await runLocalBudgetCli(t, { args: ['-p', 'hello', '--json', '--max-cost', cap, '--bot', 'ox-ollama'] });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.ok(r.calls.length > 0, `cap ${cap}: provider was actually called`);
    assert.ok(!r.events.some(ev => ev.t === 'budget-stop'), `cap ${cap}: no budget stop`);
    const skip = r.events.find(ev => ev.t === 'budget-cap-skipped');
    assert.ok(skip, `cap ${cap}: cap skip is reported, not silent`);
    assert.match(skip.message, /cannot bill/);
    assert.deepEqual(skip.models, ['qwen2.5:0.5b']);
  }
});

test('a billable unpriced model still budget-stops, exits 2, and names the remedy', async t => {
  const r = await runLocalBudgetCli(t, {
    args: ['-p', 'hello', '--json', '--max-cost', '100', '--model', 'local-unpriced-model'],
    env: { OX_API_KEY: 'loopback-only' },
  });
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.equal(r.calls.length, 0, 'aborted before spending');
  const stop = r.events.find(ev => ev.t === 'budget-stop');
  assert.ok(stop, 'budget-stop emitted');
  assert.equal(stop.reason, 'unknown-cost');
  assert.equal(stop.costUsd, null);
  assert.match(stop.message, /model_overrides/);
  assert.match(stop.message, /local-unpriced-model/);
  assert.match(r.stdout, /model_overrides/, 'the remedy reaches stdout, not just stderr');
});

test('the budget-stop exit code is 2 in-process and on the CLI path alike', async t => {
  const budget = createCostBudget({ maxCostUsd: 1e-9 });
  budget.record('ox-cost-bench-no-such-model', { inputTokens: 1000, outputTokens: 100 });
  let thrown = null;
  try { budget.assert('ox-cost-bench-no-such-model'); } catch (e) { thrown = e; }
  assert.equal(thrown.exitCode, 2);
  assert.equal(thrown.code, 'OX_BUDGET_STOP');

  const r = await runBudgetCli(t, { args: ['-p', 'hello', '--json'], config: { maxCostUsd: 0.002 } });
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.equal(r.code, thrown.exitCode, 'CLI and in-process paths agree');
  const stop = r.events.find(ev => ev.t === 'budget-stop');
  assert.equal(stop.reason, 'cost-cap');
  assert.match(stop.message, /cost-cap/);
});
