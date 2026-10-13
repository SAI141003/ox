// ox arena: the same task, several models, one winner.
//
//   ox arena "<task>" --bots claude,ox-grok,local [--test "npm test"] [--max-cost 0.50] [--apply]
//
// Each bot works in its own git worktree (a copy of this project at HEAD),
// headless, approvals on yes-to-all but confined by the workspace sandbox, so
// none of them can touch the real project or each other. Afterwards every
// copy is judged the same way: did the run succeed, does the --test command
// pass in that copy, how big is the change, what did it cost. The winner's
// patch can be applied to the real project with --apply. Worktrees are always
// removed; every patch is kept under ~/.ox/arena/<run>/.

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { shellArgv } from './shell.js';

const OX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ox.js');
const git = (cwd, args, opts = {}) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, ...opts });

export function parseArenaArgs(args) {
  const out = { task: '', bots: [], test: null, maxCost: null, apply: false, timeoutMs: 15 * 60_000 };
  const words = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--bots') out.bots = String(args[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--test') out.test = args[++i] ?? null;
    else if (a === '--max-cost') out.maxCost = Number(args[++i]);
    else if (a === '--timeout') out.timeoutMs = Number(args[++i]) * 1000;
    else if (a === '--apply') out.apply = true;
    else words.push(a);
  }
  out.task = words.join(' ').trim();
  return out;
}

/** Ranking: tests pass, then the run succeeded, then the smaller change, then the cheaper run. */
export function rankEntries(entries) {
  const key = (e) => [
    e.changedLines > 0 ? 0 : 1, // a run that changed nothing is last, whatever else
    e.test === true ? 0 : e.test === null ? 1 : 2,
    e.ok ? 0 : 1,
    e.changedLines === 0 ? Infinity : e.changedLines,
    e.costUsd ?? Infinity,
  ];
  return [...entries].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
    return 0;
  });
}

function runIn(cwd, cmd, args, { env, timeoutMs }) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('close', (code) => { clearTimeout(t); resolve({ code, out }); });
    p.on('error', () => { clearTimeout(t); resolve({ code: -1, out }); });
  });
}

function shell(cwd, command, timeoutMs) {
  const argv = shellArgv(command);
  return runIn(cwd, argv[0], argv.slice(1), { env: process.env, timeoutMs });
}

/**
 * Run the arena. `log(line)` reports progress. Returns
 * { id, entries (ranked), winner, patchDir }.
 */
export async function runArena(opts, { cwd = process.cwd(), log = () => {}, env = process.env } = {}) {
  const { task, bots, test, maxCost, apply, timeoutMs } = opts;
  if (!task) throw new Error('usage: ox arena "<task>" --bots a,b[,c] [--test "<command>"] [--max-cost <usd>] [--apply]');
  if (bots.length < 2) throw new Error('give at least two bots to compare: --bots claude,ox-grok (see: ox bots)');
  let root;
  try { root = git(cwd, ['rev-parse', '--show-toplevel']).trim(); } catch { throw new Error('ox arena needs a git repository (each bot works in its own worktree)'); }
  if (git(root, ['status', '--porcelain']).trim()) log('note: uncommitted changes are not part of the arena; every bot starts from HEAD');

  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 6)}`;
  const patchDir = path.join(os.homedir(), '.ox', 'arena', id);
  fs.mkdirSync(patchDir, { recursive: true });
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-arena-'));

  const entries = await Promise.all(bots.map(async (bot, i) => {
    const dir = path.join(base, `${i}-${bot.replace(/[^\w.-]/g, '_')}`);
    const e = { bot, ok: false, test: null, changedLines: 0, files: 0, costUsd: null, seconds: 0, patch: null, error: null };
    try {
      git(root, ['worktree', 'add', '--detach', dir, 'HEAD']);
      log(`▸ ${bot}: working in its own copy`);
      const t0 = Date.now();
      const args = [OX, '-p', task, '--bot', bot, '-y', '--sandbox', 'workspace', '--json', ...(maxCost > 0 ? ['--max-cost', String(maxCost)] : [])];
      const r = await runIn(dir, process.execPath, args, { env: { ...env, OX_ISLAND: '0' }, timeoutMs });
      e.seconds = Math.round((Date.now() - t0) / 1000);
      e.ok = r.code === 0;
      if (!e.ok) e.error = r.out.trim().split('\n').filter((l) => !l.startsWith('{')).slice(-1)[0]?.slice(0, 160) || `exit ${r.code}`;
      for (const line of r.out.split('\n')) {
        if (!line.startsWith('{')) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.t === 'ledger' && ev.totals?.costUsd != null) e.costUsd = ev.totals.costUsd;
        } catch {}
      }
      git(dir, ['add', '-A']);
      const diff = git(dir, ['diff', '--cached', '--binary', 'HEAD']);
      const stat = git(dir, ['diff', '--cached', '--numstat', 'HEAD']).trim().split('\n').filter(Boolean);
      e.files = stat.length;
      e.changedLines = stat.reduce((n, l) => n + (Number(l.split('\t')[0]) || 0) + (Number(l.split('\t')[1]) || 0), 0);
      if (diff) { e.patch = path.join(patchDir, `${bot.replace(/[^\w.-]/g, '_')}.patch`); fs.writeFileSync(e.patch, diff); }
      if (test && e.changedLines > 0) {
        const tr = await shell(dir, test, 10 * 60_000);
        e.test = tr.code === 0;
      }
      log(`  ${bot}: ${e.ok ? 'done' : 'failed'} · ${e.files} file(s), ${e.changedLines} line(s)${e.test === null ? '' : ` · tests ${e.test ? 'pass' : 'fail'}`}`);
    } catch (err) {
      e.error = String(err?.message ?? err).split('\n')[0].slice(0, 160);
    } finally {
      try { git(root, ['worktree', 'remove', '--force', dir]); } catch {}
    }
    return e;
  }));
  fs.rmSync(base, { recursive: true, force: true });

  const ranked = rankEntries(entries);
  const winner = ranked.find((e) => e.patch && e.ok) ?? null;
  fs.writeFileSync(path.join(patchDir, 'result.json'), JSON.stringify({ id, task, test, entries: ranked, winner: winner?.bot ?? null }, null, 2));
  if (apply && winner) {
    try {
      git(root, ['apply', '--3way', winner.patch]);
      winner.applied = true;
    } catch (err) {
      winner.applied = false;
      winner.applyError = String(err?.stderr ?? err?.message ?? err).trim().split('\n')[0];
    }
  }
  return { id, entries: ranked, winner, patchDir };
}

/** The platform subsystem handle (src/platform.js): past runs and a runner. */
export function createArena(cwd = process.cwd()) {
  const dir = path.join(os.homedir(), '.ox', 'arena');
  return {
    run: (opts, extra = {}) => runArena(opts, { cwd, ...extra }),
    history() {
      try {
        return fs.readdirSync(dir).sort().reverse().map((id) => {
          try { return JSON.parse(fs.readFileSync(path.join(dir, id, 'result.json'), 'utf8')); } catch { return null; }
        }).filter(Boolean);
      } catch { return []; }
    },
  };
}
