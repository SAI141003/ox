#!/usr/bin/env node
// Launch check: run every `ox` subcommand and every chat slash command the way
// a brand-new user would (empty HOME, empty project, no API keys) and report
// anything that crashes, hangs, or prints a stack trace.
//
//   node scripts/launch-check.mjs            all checks
//   node scripts/launch-check.mjs --json     machine-readable
//
// A command is OK when it exits within its time limit with no stack trace and
// no "TypeError/ReferenceError/Cannot read properties" in its output. A
// non-zero exit is fine when the command explains itself (missing argument,
// missing key) — that is a correct answer for a fresh machine.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OX = path.join(ROOT, 'bin', 'ox.js');
const JSON_OUT = process.argv.includes('--json');

const src = fs.readFileSync(path.join(ROOT, 'src', 'cli.js'), 'utf8');
const SUBS = [...src.match(/const SUBCOMMANDS = new Set\(\[([\s\S]*?)\]\);/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
// The slash commands the chat documents: the SLASH_HELP block in src/cli.js.
const SLASH_SRC = (s) => s.slice(s.indexOf('const SLASH_HELP'), s.indexOf("].join('\\n')", s.indexOf('const SLASH_HELP')));
const SLASH = [...new Set([...SLASH_SRC(src).matchAll(/'\s*(\/[a-z][a-z-]*)\b/g)].map((m) => m[1]))];

// Subcommands that would start a long-running server or wait on stdin when run
// bare: run them with a harmless argument instead.
const ARGS = {
  serve: ['--port', '0', '--help'], daemon: ['status'], attach: ['--help'], acp: ['--help'], listen: [],
  'voice-mode': ['status'], ipc: ['status'], island: ['status'], schedule: ['--help'], cron: ['list'],
  gateway: ['--help'], heartbeat: ['--help'], auto: ['--help'], agent: [], agents: [], shutdown: ['--help'],
  clicky: ['--help'], task: ['list'], spec: ['--help'], workflow: ['--help'], review: ['--help'],
  'self-improve': ['--help'], verify: ['--help'], regression: ['--help'], arch: ['--help'], refine: ['--help'],
  bench: ['--help'], benchmark: ['--help'], arena: ['--help'], brain: ['--help'], video: ['--help'],
  import: ['--help'], clone: ['--help'], plugin: ['ls'], plugins: ['ls'], index: ['--help'], inspect: [],
  model: [], models: ['--help'], local: ['--no-prompt'], platform: [], aas: ['--help'], kanban: ['--help'],
  backend: ['list'], bundles: ['--help'], toc: ['--help'], reason: ['--help'], hmem: [], 'plan-cache': ['--help'],
  mem: [], 'memory-loss': [], episode: ['ls'], skill: ['ls'], mcp: ['ls'], doctor: [], prompt: [],
  history: [], session: [], sessions: [], bots: [], help: [], version: [],
};
const BAD = /\n\s+at .+\(.+:\d+:\d+\)|TypeError|ReferenceError|SyntaxError|Cannot read properties|is not a function|Unhandled|ERR_/;

function fresh() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-launch-home-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-launch-proj-'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/_API_KEY$|^OX_|^OPENAI_|^ANTHROPIC_/.test(k)));
  Object.assign(env, { HOME: home, OX_ISLAND: '0', NO_COLOR: '1', OX_NO_PLUGINS: '1' });
  return { home, cwd, env };
}

function run(args, { input = '', timeout = 45_000 } = {}) {
  const { cwd, env } = fresh();
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [OX, ...args], { cwd, env, input, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const hung = r.error?.code === 'ETIMEDOUT' || r.signal === 'SIGTERM';
  const crash = BAD.exec(out);
  return { ok: !hung && !crash, code: r.status, ms: Date.now() - t0, hung, crash: crash?.[0] ?? null, tail: out.trim().split('\n').slice(-3).join(' | ').slice(0, 220) };
}

const results = [];
for (const sub of SUBS) results.push({ kind: 'command', name: `ox ${sub} ${(ARGS[sub] ?? ['--help']).join(' ')}`.trim(), ...run([sub, ...(ARGS[sub] ?? ['--help'])]) });
for (const cmd of SLASH) {
  if (['/exit', '/quit'].includes(cmd)) continue;
  results.push({ kind: 'slash', name: cmd, ...run([], { input: `${cmd}\n/exit\n` }) });
}
results.push({ kind: 'first-run', name: 'ox -p "hello" (no API key)', ...run(['-p', 'hello']) });

const bad = results.filter((r) => !r.ok);
if (JSON_OUT) console.log(JSON.stringify({ total: results.length, failed: bad.length, results }, null, 2));
else {
  for (const r of bad) console.log(`FAIL ${r.kind.padEnd(9)} ${r.name}\n     ${r.hung ? 'hung (timed out)' : `crash: ${r.crash}`}\n     ${r.tail}`);
  console.log(`\n${results.length - bad.length}/${results.length} ok (${SUBS.length} commands, ${SLASH.length} slash commands, first run)`);
}
process.exitCode = bad.length ? 1 : 0;
