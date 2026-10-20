#!/usr/bin/env node
// ox verify — the one gate every change goes through.
//
// Why this exists: a botched paste once left src/cli.js unparseable, every
// command except --version died behind "interface layer not built yet", and a
// status file still claimed 1649 passing tests. No single check ran the parts
// together. This script does, in order of cost, and stops at the first red
// stage unless --keep-going:
//
//   1. syntax   `node --check` on every shipped .js/.mjs file
//   2. smoke    real CLI entry points exit 0 and print what they promise
//   3. unit     the node:test suite
//   4. bench    the deterministic agent-loop scenarios (mock provider)
//   5. live     one real local-model turn, only when Ollama answers (else skipped)
//
// Usage:
//   node scripts/verify.mjs                 all stages
//   node scripts/verify.mjs --quick         syntax + smoke only (seconds)
//   node scripts/verify.mjs --only unit     one stage
//   node scripts/verify.mjs --loop          rerun every time a file in src/ bin/ test/ changes
//   node scripts/verify.mjs --keep-going    run every stage even after a failure
//   node scripts/verify.mjs --json          machine-readable summary on stdout
//
// Exit code: 0 all green (skips allowed), 1 any stage failed.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OX = path.join(ROOT, 'bin', 'ox.js');
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const JSON_OUT = flag('--json');
const log = JSON_OUT ? () => {} : (s) => process.stdout.write(s);
const color = process.stdout.isTTY && !process.env.NO_COLOR && !JSON_OUT;
const paint = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);

function run(cmd, argv, { timeoutMs = 600_000, env = {}, cwd = ROOT, plain = true } = {}) {
  return new Promise((resolve) => {
    // Plain output for CLI smoke parsing; the unit suite gets the caller's real
    // env, because its colour tests assert on what NO_COLOR unset produces.
    const base = { ...process.env };
    if (plain) Object.assign(base, { NO_COLOR: '1', OX_NO_ANIM: '1' });
    else delete base.NO_COLOR;
    const child = spawn(cmd, argv, { cwd, env: { ...base, ...env } });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code: signal ? 124 : code, out });
    });
  });
}

function shippedFiles() {
  const roots = ['bin', 'src', 'scripts', 'bench', 'test'];
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'results' || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(m?js)$/.test(e.name)) files.push(full);
    }
  };
  for (const r of roots) if (fs.existsSync(path.join(ROOT, r))) walk(path.join(ROOT, r));
  return files;
}

const STAGES = {
  async syntax() {
    const files = shippedFiles();
    const bad = [];
    // Batched so 500 files do not mean 500 sequential process launches.
    for (let i = 0; i < files.length; i += 16) {
      const batch = files.slice(i, i + 16);
      const results = await Promise.all(batch.map((f) => run(process.execPath, ['--check', f], { timeoutMs: 30_000 })));
      results.forEach((r, j) => {
        if (r.code !== 0) bad.push(`${path.relative(ROOT, batch[j])}\n${r.out.split('\n').slice(0, 5).join('\n')}`);
      });
    }
    return bad.length ? { ok: false, detail: bad.join('\n\n') } : { ok: true, detail: `${files.length} files parse` };
  },

  async smoke() {
    const checks = [
      { argv: ['--version'], expect: /^ox \d+\.\d+\.\d+/m },
      { argv: ['help'], expect: /featherweight coding agent/ },
      { argv: ['bots'], expect: /ox-ollama/ },
      { argv: ['prompt'], expect: /You are ox/ },
      { argv: ['skill', 'ls'], expect: /./ },
      { argv: ['mcp'], expect: /./ },
    ];
    const fails = [];
    for (const c of checks) {
      const r = await run(process.execPath, [OX, ...c.argv], { timeoutMs: 30_000 });
      if (r.code !== 0 || !c.expect.test(r.out) || /failed to load CLI|interface layer not built/.test(r.out)) {
        fails.push(`ox ${c.argv.join(' ')} -> exit ${r.code}\n${r.out.slice(0, 400)}`);
      }
    }
    return fails.length ? { ok: false, detail: fails.join('\n\n') } : { ok: true, detail: `${checks.length} entry points` };
  },

  async unit() {
    const files = fs.readdirSync(path.join(ROOT, 'test')).filter((f) => f.endsWith('.test.js')).map((f) => path.join('test', f));
    // TAP explicitly: newer Node prints its "spec" summary (ℹ pass N) to a pipe,
    // and the counts below are parsed from TAP's "# pass N".
    const r = await run(process.execPath, ['--test', '--test-reporter=tap', '--test-concurrency=4', ...files], {
      timeoutMs: 2_400_000,
      plain: false,
      // The per-file repo guard reruns the whole suite; the dedicated full run
      // (`npm test`) still covers it. Here we want the fast inner loop.
      env: { OX_SKIP_REPO_GUARD: '1', OX_NO_BUILTIN_SKILLS: '1', OX_NO_PLUGINS: '1', OX_ISLAND: '0', OX_LEARN: '0', OX_NO_KEYSTORE: '1', OX_USAGE_LOG: '0', OX_MEMORY_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'ox-test-memory-')) },
    });
    const num = (k) => Number((r.out.match(new RegExp(`^# ${k} (\\d+)`, 'm')) ?? [])[1] ?? NaN);
    const pass = num('pass');
    const fail = num('fail');
    const cancelled = num('cancelled');
    // Each failure with the first line of its error, so a CI log says why, not only what.
    const failing = [...r.out.matchAll(/^\s*not ok \d+ - (.+)$/gm)].map((m) => {
      const after = r.out.slice(m.index, m.index + 4000);
      const why = /^\s*error: \|?-?\s*\n?\s*(.+)$/m.exec(after.split('\n').slice(1).join('\n'))?.[1]?.trim().replace(/^['"]|['"]$/g, '');
      return why ? `${m[1]}\n      ${why.slice(0, 300)}` : m[1];
    }).filter((x, i, a) => a.indexOf(x) === i).slice(0, 20);
    const list = failing.length ? `\n  - ${failing.join('\n  - ')}` : '';
    if (Number.isNaN(pass)) {
      // No summary: the run never finished (killed at the ceiling, or crashed).
      const why = r.code === 124 ? `timed out after ${Math.round(2_400_000 / 60_000)} min (is the machine overloaded?)` : `exited ${r.code} before its summary`;
      return { ok: false, detail: `the suite ${why}; failures seen so far: ${failing.length}${list}` };
    }
    const ok = r.code === 0 && fail === 0 && !cancelled;
    return { ok, detail: `${pass} pass · ${fail} fail · ${cancelled} cancelled${list}` };
  },

  async bench() {
    const r = await run(process.execPath, ['bench/runner.mjs'], { timeoutMs: 600_000, env: { OX_NO_BACKUPS: '1', OX_LEARN: '0' } });
    const totals = (r.out.match(/^.*\d+\/\d+ passed.*$/m) ?? r.out.match(/Totals?:?.*$/m) ?? [r.out.trim().split('\n').pop()])[0];
    return { ok: r.code === 0, detail: totals };
  },

  async live() {
    let up = false;
    try {
      const res = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(1500) });
      up = res.ok;
    } catch { /* not running */ }
    if (!up) return { ok: true, skipped: true, detail: 'Ollama not running — skipped' };
    const r = await run(process.execPath, [OX, '-p', 'Reply with only the word PONG.', '--model', 'ollama:auto'], { timeoutMs: 180_000 });
    return { ok: r.code === 0 && /PONG/i.test(r.out), detail: r.out.trim().split('\n').slice(-3).join(' | ').slice(0, 300) };
  },
};

const ORDER = ['syntax', 'smoke', 'unit', 'bench', 'live'];

async function once() {
  const plan = only ? [only] : flag('--quick') ? ['syntax', 'smoke'] : ORDER;
  for (const s of plan) if (!STAGES[s]) throw new Error(`unknown stage '${s}' (stages: ${ORDER.join(', ')})`);
  const results = [];
  for (const name of plan) {
    if (process.stdout.isTTY) log(`${paint('2', '…')} ${name.padEnd(7)}`);
    const t0 = Date.now();
    let res;
    try {
      res = await STAGES[name]();
    } catch (err) {
      res = { ok: false, detail: String(err?.stack ?? err) };
    }
    const ms = Date.now() - t0;
    results.push({ stage: name, ...res, ms });
    const mark = res.skipped ? paint('33', 'SKIP') : res.ok ? paint('32', 'PASS') : paint('31', 'FAIL');
    log(`${process.stdout.isTTY ? '\r' : ''}${mark} ${name.padEnd(7)} ${paint('2', `${(ms / 1000).toFixed(1)}s`)}  ${res.detail.split('\n')[0]}\n`);
    if (!res.ok) {
      log(`${res.detail.split('\n').slice(1).join('\n')}\n`);
      if (!flag('--keep-going')) break;
    }
  }
  const ok = results.every((r) => r.ok) && results.length === plan.length;
  const report = { ok, at: new Date().toISOString(), results };
  try {
    fs.mkdirSync(path.join(ROOT, '.ox-verify'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, '.ox-verify', 'last.json'), JSON.stringify(report, null, 2));
  } catch { /* report file is a convenience */ }
  if (JSON_OUT) process.stdout.write(JSON.stringify(report) + '\n');
  else log(ok ? paint('32', '\n✓ all green\n') : paint('31', '\n✗ verify failed\n'));
  return ok;
}

if (flag('--loop')) {
  // The loop method: change -> verify -> read the red stage -> fix -> repeat.
  let running = false;
  let queued = false;
  const trigger = async () => {
    if (running) {
      queued = true;
      return;
    }
    running = true;
    log(paint('2', `\n── verify @ ${new Date().toLocaleTimeString()} ──\n`));
    await once();
    running = false;
    if (queued) {
      queued = false;
      trigger();
    }
  };
  let debounce = null;
  for (const dir of ['src', 'bin', 'test']) {
    fs.watch(path.join(ROOT, dir), { recursive: true }, () => {
      clearTimeout(debounce);
      debounce = setTimeout(trigger, 400);
    });
  }
  log(paint('2', 'watching src/ bin/ test/ — Ctrl-C to stop\n'));
  trigger();
} else {
  process.exitCode = (await once()) ? 0 : 1;
}
