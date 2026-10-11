import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OX_BIN = path.join(ROOT, 'bin', 'ox.js');

const SCRUB = [
  'OX_BASE_URL', 'OX_API_KEY', 'OX_MODEL', 'OX_YOLO', 'OX_MAX_COST',
  'XAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY',
  'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'DEEPSEEK_API_KEY', 'NODE_OPTIONS',
];

function childEnv(home, extra = {}) {
  const env = { ...process.env };
  for (const k of SCRUB) delete env[k];
  env.HOME = home;
  env.NO_COLOR = '1';
  return { ...env, ...extra };
}

function runOx(t, args, opts = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-cli-def-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const r = spawnSync(process.execPath, [OX_BIN, ...args], {
    cwd: opts.cwd ?? ROOT,
    env: childEnv(home),
    encoding: 'utf8',
    timeout: opts.timeout ?? 30_000,
  });
  return { ...r, home };
}

// --- BUG 1: ox index build must actually index ---
test('ox index build indexes files and reports non-zero stats', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-index-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  // known files with indexable extensions
  fs.writeFileSync(path.join(home, 'a.js'), 'const answer = 42;\n');
  fs.writeFileSync(path.join(home, 'b.md'), '# Hello world\n');
  fs.mkdirSync(path.join(home, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(home, 'sub', 'c.py'), 'print("hi")\n');

  const r = spawnSync(process.execPath, [OX_BIN, 'index', 'build'], {
    cwd: home,
    env: childEnv(home),
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(r.status, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stdout, /indexed:/);
  const m = r.stdout.match(/indexed:\s+(\d+)\s+files,\s+(\d+)\s+terms/);
  assert.ok(m, `expected "indexed: N files, M terms" in output:\n${r.stdout}`);
  assert.ok(Number(m[1]) > 0, `files should be > 0, got ${m[1]}`);
  assert.ok(Number(m[2]) > 0, `terms should be > 0, got ${m[2]}`);
  // persisted to ~/.ox/codebase-index.json
  const persisted = fs.readFileSync(path.join(home, '.ox', 'codebase-index.json'), 'utf8');
  const parsed = JSON.parse(persisted);
  assert.ok(Object.keys(parsed.files).length > 0, 'persisted index should contain files');
});

test('ox index build usage string advertises only build|search', (t) => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'cli.js'), 'utf8');
  const start = src.indexOf("case 'index':");
  const end = src.indexOf("case 'voice-mode':", start);
  const idxBlock = src.slice(start, end);
  assert.match(idxBlock, /usage: ox index build \| ox index search/);
  // the build branch must report the real stats field (terms), not a fabricated 'tokens' field
  assert.match(idxBlock, /indexed:.*\$\{stats\.files\}.*\$\{stats\.terms\}/);
  assert.doesNotMatch(idxBlock, /stats\.tokens/);
});

// --- BUG 2a: ox cron run <id> ---
test('ox cron run <id> runs a scheduled job and reports the run', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-cron-run-'));
  // `ox cron run` dispatches through the daemon (one execution path), so this
  // test starts a supervisor. It is stopped BEFORE the home directory is removed:
  // `ox daemon stop` reads the pidfile out of that directory, so rm-first would
  // leave the supervisor running with nothing left to stop it by. No assertion
  // below depends on this — it is teardown for a process the command creates.
  t.after(() => {
    spawnSync(process.execPath, [OX_BIN, 'daemon', 'stop'], {
      cwd: ROOT,
      env: childEnv(home),
      encoding: 'utf8',
      timeout: 20_000,
    });
    fs.rmSync(home, { recursive: true, force: true });
  });
  const add = spawnSync(process.execPath, [OX_BIN, 'cron', 'add', 'every minute'], {
    cwd: home,
    env: childEnv(home),
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(add.status, 0, `stdout: ${add.stdout}\nstderr: ${add.stderr}`);
  const idMatch = add.stdout.match(/scheduled job ([0-9a-f]{8})/);
  assert.ok(idMatch, `expected job id in output:\n${add.stdout}`);
  const id = idMatch[1];

  const run = spawnSync(process.execPath, [OX_BIN, 'cron', 'run', id], {
    cwd: home,
    env: childEnv(home),
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(run.status, 0, `stdout: ${run.stdout}\nstderr: ${run.stderr}`);
  assert.match(run.stdout, /ran job/);
  assert.match(run.stdout, new RegExp(id));
});

test('ox cron run with missing id exits 3 with usage', (t) => {
  const r = runOx(t, ['cron', 'run']);
  assert.equal(r.status, 3, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stdout + r.stderr, /usage: ox cron run <id>/);
});

test('ox cron run with unknown id exits 1 with clear error', (t) => {
  const r = runOx(t, ['cron', 'run', 'deadbeef']);
  assert.equal(r.status, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stdout + r.stderr, /no scheduled job with id/);
});

// --- BUG 2b/c: usage strings corrected ---
test('ox benchmark usage advertises only list', (t) => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'cli.js'), 'utf8');
  const block = src.slice(src.indexOf("case 'benchmark':"), src.indexOf("case 'platform':"));
  assert.match(block, /usage: ox benchmark list/);
  assert.doesNotMatch(block, /ox benchmark run/);
});

test('ox backend usage advertises only list', (t) => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'cli.js'), 'utf8');
  const block = src.slice(src.indexOf("case 'backend':"), src.indexOf("case 'inspect':"));
  assert.match(block, /usage: ox backend list/);
  assert.doesNotMatch(block, /ox backend use/);
});

test('ox bundles usage advertises only list', (t) => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'cli.js'), 'utf8');
  const block = src.slice(src.indexOf("case 'bundles':"), src.indexOf("case 'index':"));
  assert.match(block, /usage: ox bundles list/);
  assert.doesNotMatch(block, /ox bundles load/);
});

// --- BUG 3: a command advertised in --help must be ROUTABLE -------------------
// `ox heartbeat` shipped broken: it was printed by `--help` but missing from
// SUBCOMMANDS, so main()'s dispatch check fell through to "unknown command" and
// exited 3. Nothing caught it, because nothing cross-referenced the two lists --
// the help text and the router were only ever reviewed by eye. This does that,
// so the defect class fails loudly instead of shipping.

// SUBCOMMANDS is not exported (it is routing state, not API), so it is parsed
// out of the source rather than hand-copied. A hand-copied list drifts the
// moment anyone adds a command, and a stale list here would make this guard
// bless exactly the bug it exists to catch.
function routableSubcommands(src) {
  const m = src.match(/const SUBCOMMANDS = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(m, 'could not find the SUBCOMMANDS literal in src/cli.js');
  return new Set([...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]));
}

// Both places --help documents a subcommand:
//
//   1. the sectioned body, "  ox prompt              the assembled system ...";
//   2. the usage synopsis, "ox <subcommand>  version | help | ... | agent".
//
// The synopsis is read with bracketed groups stripped BEFORE splitting on "|",
// otherwise the sub-options inside "skill [name|ls|new|rm|path|add]" are parsed
// as top-level command names and the guard cries wolf on `ls` and `rm`.
function documentedCommands(help) {
  const out = new Set();
  for (const m of help.matchAll(/^\s*ox ([a-z][a-z0-9-]*)(?=\s|$)/gm)) out.add(m[1]);
  const synopsis = help.match(/^\s*ox <subcommand>\s+(.*)$/m);
  assert.ok(synopsis, '--help no longer prints a usage synopsis; this guard needs updating');
  for (const part of synopsis[1].replace(/\[[^\]]*\]/g, ' ').split('|')) {
    const name = part.trim().match(/^[a-z][a-z0-9-]*/);
    if (name) out.add(name[0]);
  }
  return out;
}

test('every command advertised in --help is routable', (t) => {
  const r = runOx(t, ['--help']);
  assert.equal(r.status, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);

  const documented = documentedCommands(r.stdout);
  // A cross-reference that extracts nothing passes vacuously, and a help layout
  // change would silently disarm this guard instead of reporting it. Pin a floor
  // well below today's count so a real regression is still a clear failure.
  assert.ok(
    documented.size >= 20,
    `--help parsing regressed: only ${documented.size} command name(s) extracted, expected at least 20`
  );

  const routable = routableSubcommands(fs.readFileSync(path.join(ROOT, 'src', 'cli.js'), 'utf8'));
  assert.ok(routable.size >= 20, `SUBCOMMANDS parsing regressed: only ${routable.size} entries`);

  const unrouted = [...documented].filter((c) => !routable.has(c)).sort();
  assert.deepEqual(
    unrouted,
    [],
    `documented in --help but not routable: ${unrouted.join(', ')} -- add each to SUBCOMMANDS in src/cli.js or drop it from the help text`
  );
});
