// ox's idle promise, checked: a running `ox serve` that nobody talks to uses
// (almost) no CPU and does not grow (docs/PROVIDER_ACCESS.md's sibling promise in
// the README: no polling, timers unref'd, file changes by the system's notices).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';

const BIN = path.join(import.meta.dirname, '..', 'bin', 'ox.js');
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
// CPU seconds and resident KB of a process, from ps (macOS and Linux).
function usage(pid) {
  const out = spawnSync('ps', ['-o', 'time=,rss=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim().split(/\s+/);
  const [clock, rss] = out;
  const parts = clock.split(/[:.-]/).map(Number);
  // [[dd-]hh:]mm:ss.cc
  const secs = clock.includes('.') ? parts.slice(0, -1).reduce((a, n) => a * 60 + n, 0) + parts.at(-1) / 100 : parts.reduce((a, n) => a * 60 + n, 0);
  return { cpu: secs, rss: Number(rss) };
}

test('idle: ox serve with no clients stays under 0.5% CPU and does not grow', { skip: process.platform === 'win32' ? 'ps is not on Windows' : false, timeout: 120_000 }, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-idle-'));
  const port = await freePort();
  const env = { ...process.env, HOME: home, OX_HOME: path.join(home, '.ox'), OX_ISLAND: '0', OX_LEARN: '0', OX_NO_KEYSTORE: '1', OX_USAGE_LOG: '0', OX_NO_PLUGINS: '1', OX_NO_BUILTIN_SKILLS: '1', OX_NO_PLAN_CHECK: '1' };
  delete env.NODE_TEST_CONTEXT; delete env.OX_APP; delete env.OX_ISLAND_SERVER;
  const p = spawn(process.execPath, [BIN, 'serve', '--port', String(port)], { env, stdio: 'ignore' });
  try {
    // Ready, then settled (start-up work: model warm-up, the first reads).
    for (let i = 0; i < 50; i++) { try { const r = await fetch(`http://127.0.0.1:${port}/v1/models`); if (r.ok) break; } catch {} await new Promise((r) => setTimeout(r, 200)); }
    await new Promise((r) => setTimeout(r, 6000));
    const a = usage(p.pid);
    const windowS = 20;
    await new Promise((r) => setTimeout(r, windowS * 1000));
    const b = usage(p.pid);
    const pct = ((b.cpu - a.cpu) / windowS) * 100;
    t.diagnostic(`idle CPU ${pct.toFixed(2)}% (${(b.cpu - a.cpu).toFixed(2)} s in ${windowS} s), memory ${Math.round(a.rss / 1024)} → ${Math.round(b.rss / 1024)} MB`);
    assert.ok(pct < 0.5, `idle CPU ${pct.toFixed(2)}% over ${windowS} s (${(b.cpu - a.cpu).toFixed(2)} s)`);
    assert.ok(b.rss - a.rss < 20_000, `memory grew ${b.rss - a.rss} KB in ${windowS} s idle`);
    assert.ok(b.rss < 250_000, `resident ${Math.round(b.rss / 1024)} MB`);
  } finally {
    p.kill();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
