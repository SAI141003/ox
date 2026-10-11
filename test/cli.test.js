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

// Fresh HOME sandbox per invocation so ~/.ox state never touches the real one;
// children inherit the parent env with HOME overridden BEFORE spawn.
function childEnv(home, extra = {}) {
  const env = { ...process.env };
  for (const k of SCRUB) delete env[k];
  env.HOME = home;
  env.NO_COLOR = '1';
  return { ...env, ...extra };
}

function runOx(t, args) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-cli-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const started = Date.now();
  const r = spawnSync(process.execPath, [OX_BIN, ...args], {
    cwd: ROOT,
    env: childEnv(home),
    encoding: 'utf8',
  });
  return { ...r, ms: Date.now() - started };
}

test('--version prints "ox 0.1.0" exactly and fast', (t) => {
  const r = runOx(t, ['--version']);
  console.log(`[measure] ox --version took ${r.ms}ms`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'ox 0.1.0');
  assert.ok(r.ms < 1000, `--version took ${r.ms}ms (budget <1000ms)`);
});

test('bots exits 0 listing grok and claude rows', (t) => {
  const r = runOx(t, ['bots']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\box-grok\b/);
  assert.match(r.stdout, /\box-claude\b/);
});

test('--bot does-not-exist -p x exits 3 naming available bots', (t) => {
  const r = runOx(t, ['--bot', 'does-not-exist', '-p', 'x']);
  assert.equal(r.status, 3, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stderr, /unknown bot 'does-not-exist'/);
  assert.match(r.stderr, /available bots:/);
  assert.match(r.stderr, /\box-grok\b/);
});

test('unknown flag exits 3 with usage hint', (t) => {
  const r = runOx(t, ['--definitely-not-a-flag']);
  assert.equal(r.status, 3, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stderr, /unknown flag '--definitely-not-a-flag'/);
  assert.match(r.stdout, /usage:/);
});

test('doctor exits 0 printing check rows (local discovery may find nothing)', (t) => {
  const r = runOx(t, ['doctor']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('✓'), 'expected at least one ✓ row');
  assert.ok(r.stdout.includes('✗'), 'expected at least one ✗ row');
  assert.match(r.stdout, /node >= 18/);
  // The old row was `ollama reachable at 127.0.0.1:11434`, a status-only check
  // that passed for ANY process answering 200 on that port. Discovery now
  // requires a positive identification, and names the runtime it identified.
  assert.match(r.stdout, /local model server identified|no local model server identified/);
  assert.doesNotMatch(r.stdout, /ollama reachable at/, 'the status-only probe must be gone');
  assert.match(r.stdout, /local model discovery|not approved|APPROVED|approve with: ox local/);
});

// The slash-command switch lives inside the REPL, which needs a TTY and a
// provider, so dispatch is exercised through the real binary via piped stdin
// instead of VM-extracting the switch source (fragment slicing breaks syntax).
test('/init dispatches to the power-command handler, not /team', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-cli-init-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const proc = spawnSync(process.execPath, [OX_BIN], {
    cwd: home,
    env: childEnv(home),
    input: '/init\n/exit\n',
    encoding: 'utf8',
    timeout: 30_000,
  });
  const out = `${proc.stdout ?? ''}${proc.stderr ?? ''}`;
  assert.doesNotMatch(out, /usage: \/team/, `/init must not fall through to /team:\n${out}`);
});

test('/commit without a git repo reports the power-command error', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-cli-commit-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const proc = spawnSync(process.execPath, [OX_BIN], {
    cwd: home,
    env: childEnv(home),
    input: '/commit\n/exit\n',
    encoding: 'utf8',
    timeout: 30_000,
  });
  const out = `${proc.stdout ?? ''}${proc.stderr ?? ''}`;
  assert.match(out, /not in a git repository/, `expected cmdCommit error:\n${out}`);
});

test('/team with no task prints its own usage, not the power handler', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-cli-team-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const proc = spawnSync(process.execPath, [OX_BIN], {
    cwd: home,
    env: childEnv(home),
    input: '/team\n/exit\n',
    encoding: 'utf8',
    timeout: 30_000,
  });
  const out = `${proc.stdout ?? ''}${proc.stderr ?? ''}`;
  assert.match(out, /usage: \/team/, `expected /team usage:\n${out}`);
  assert.doesNotMatch(out, /unknown power command/);
});

test('ox local prints a recommendation row without undefined fields', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-cli-local-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const proc = spawnSync(process.execPath, [OX_BIN, 'local'], {
    cwd: home,
    env: childEnv(home),
    encoding: 'utf8',
    timeout: 30_000,
  });
  const out = `${proc.stdout ?? ''}${proc.stderr ?? ''}`;
  assert.notEqual(proc.status, null, 'ox local must exit (no hang)');
  assert.doesNotMatch(out, /\bundefined\b/, `no undefined fields allowed:\n${out}`);
});

// --- ox local models -------------------------------------------------------
// The LOCAL_MODELS catalogue had a formatter and no surface: `ox local` only
// ever printed models on a port that was already answering, so a user with
// nothing installed could not see what ox supports or what each one costs in RAM.
test('ox local models lists the supported catalogue, not just what is installed', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-cli-localmodels-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const proc = spawnSync(process.execPath, [OX_BIN, 'local', 'models'], {
    cwd: home,
    env: childEnv(home),
    encoding: 'utf8',
    timeout: 30_000,
  });
  const out = `${proc.stdout ?? ''}${proc.stderr ?? ''}`;
  assert.equal(proc.status, 0, out);
  assert.doesNotMatch(out, /\bundefined\b/, `no undefined fields allowed:\n${out}`);
  // Every catalogue row carries name, size, minRAM and bestFor -- the four facts
  // a user needs to choose, and all four came from formatLocalModelList().
  assert.match(out, /local model catalogue \(\d+\)/);
  assert.match(out, /\(\d+GB, \d+GB min\) — \S/, `rows must carry size+minRAM+bestFor:\n${out}`);
  // The machine fit line is what makes the catalogue actionable rather than a
  // table of numbers.
  assert.match(out, /this machine: [\d.]+GB total, [\d.]+GB free/);
});

test('ox local models --json emits the raw catalogue and never scans a port', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-cli-localjson-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const proc = spawnSync(process.execPath, [OX_BIN, 'local', 'models', '--json'], {
    cwd: home,
    env: childEnv(home),
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(proc.status, 0, proc.stderr);
  const parsed = JSON.parse(proc.stdout);
  assert.ok(Array.isArray(parsed.models) && parsed.models.length > 0);
  for (const key of ['id', 'name', 'size', 'minRAM', 'bestFor', 'ollamaName']) {
    assert.ok(key in parsed.models[0], `catalogue entry is missing ${key}`);
  }
});

// --- ox arch context -------------------------------------------------------
// `ox arch record` and `ox arch list` could write and enumerate architecture
// decisions but never read the reasoning back out.
test('ox arch context returns the recorded decisions as one block', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-cli-archctx-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = childEnv(home);
  const record = spawnSync(process.execPath, [OX_BIN, 'arch', 'record', 'sandbox', 'seatbelt first'], {
    cwd: home, env, encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(record.status, 0, record.stderr);

  const proc = spawnSync(process.execPath, [OX_BIN, 'arch', 'context'], {
    cwd: home, env, encoding: 'utf8', timeout: 30_000,
  });
  const out = `${proc.stdout ?? ''}${proc.stderr ?? ''}`;
  assert.equal(proc.status, 0, out);
  assert.doesNotMatch(out, /\bundefined\b/, `no undefined fields allowed:\n${out}`);
  assert.match(out, /seatbelt first/, `the decision must be readable back:\n${out}`);
  const body = out.split('\n').slice(1).join('\n');
  const parsed = JSON.parse(body);
  assert.equal(parsed.components[0].name, 'sandbox');
});

test('ox arch context --max caps the emitted block', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-cli-archmax-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = childEnv(home);
  for (const [comp, dec] of [['a', 'first decision recorded'], ['b', 'second decision recorded'], ['c', 'third decision recorded']]) {
    const r = spawnSync(process.execPath, [OX_BIN, 'arch', 'record', comp, dec], {
      cwd: home, env, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(r.status, 0, r.stderr);
  }
  const full = spawnSync(process.execPath, [OX_BIN, 'arch', 'context'], {
    cwd: home, env, encoding: 'utf8', timeout: 30_000,
  });
  const capped = spawnSync(process.execPath, [OX_BIN, 'arch', 'context', '--max', '200'], {
    cwd: home, env, encoding: 'utf8', timeout: 30_000,
  });
  const fullOut = full.stdout ?? '';
  const capOut = capped.stdout ?? '';
  assert.match(fullOut, /chars total, (\d+) emitted \(cap 4000\)/);
  assert.match(capOut, /chars total, 200 emitted \(cap 200\)/);
  assert.ok(capOut.length < fullOut.length, 'a smaller cap must emit fewer bytes');
  // A non-numeric cap is ignored rather than silently zeroing the block.
  const bogus = spawnSync(process.execPath, [OX_BIN, 'arch', 'context', '--max', 'abc'], {
    cwd: home, env, encoding: 'utf8', timeout: 30_000,
  });
  assert.match(bogus.stdout ?? '', /cap 4000/, 'a bad --max falls back to the default');
});

test('ox arch context on an empty store explains how to fill it', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-cli-archempty-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const proc = spawnSync(process.execPath, [OX_BIN, 'arch', 'context'], {
    cwd: home, env: childEnv(home), encoding: 'utf8', timeout: 30_000,
  });
  const out = `${proc.stdout ?? ''}${proc.stderr ?? ''}`;
  assert.equal(proc.status, 0, out);
  assert.match(out, /no components recorded/);
  assert.match(out, /ox arch record/, 'an empty store must say how to populate it');
});

test('ox arch advertises every verb it actually implements', (t) => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'cli.js'), 'utf8');
  const block = src.slice(src.indexOf("case 'arch':"), src.indexOf("case 'regression':"));
  for (const verb of ['ox arch record', 'ox arch list', 'ox arch context']) {
    assert.match(block, new RegExp(verb.replace(/ /g, ' ')), `usage must mention ${verb}`);
  }
});

// --- /mem [query] ----------------------------------------------------------
// The store at ~/.ox/memory/memory.jsonl could be counted by `/mem` but never
// searched: searchMemory() -- the TF-IDF ranker, the only reason the store is
// worth keeping -- had no caller. HOME is sandboxed per test, so the store is
// seeded here rather than read from the operator's real one.
function seedMemoryStore(home, entries) {
  const dir = path.join(home, '.ox', 'memory');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'memory.jsonl'),
    entries.map(e => JSON.stringify(e)).join('\n') + '\n',
    'utf8',
  );
}

function runSlash(home, input) {
  return spawnSync(process.execPath, [OX_BIN], {
    cwd: home, env: childEnv(home), input: `${input}\n/exit\n`,
    encoding: 'utf8', timeout: 30_000,
  });
}

test('/mem with no query still prints the tally, unchanged', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-cli-membare-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  seedMemoryStore(home, [
    { id: 'a', type: 'preference', content: 'prefer local models', timestamp: 1, source: 'user', confidence: 0.9 },
    { id: 'b', type: 'skill', content: 'handle errors gracefully', timestamp: 2, source: 'user', confidence: 0.8 },
  ]);
  const proc = runSlash(home, '/mem');
  const out = `${proc.stdout ?? ''}${proc.stderr ?? ''}`;
  assert.match(out, /memory: 2 entries/);
  assert.match(out, /types: /);
  assert.match(out, /last consolidated:/);
});

test('/mem <query> ranks the store and names the match', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-cli-memq-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  seedMemoryStore(home, [
    { id: 'a', type: 'preference', content: 'prefer local models for coding tasks', timestamp: 1, source: 'user', confidence: 0.9 },
    { id: 'b', type: 'skill', content: 'handle errors gracefully with try catch', timestamp: 2, source: 'user', confidence: 0.8 },
    { id: 'c', type: 'pattern', content: 'always run the test suite before committing', timestamp: 3, source: 'session', confidence: 0.7 },
  ]);
  const proc = runSlash(home, '/mem errors');
  const out = `${proc.stdout ?? ''}${proc.stderr ?? ''}`;
  assert.match(out, /match\(es\) for "errors"/, out);
  assert.match(out, /handle errors gracefully/, 'the matching entry must be printed:\n' + out);
  assert.doesNotMatch(out, /always run the test suite/, 'a non-matching entry must not be:\n' + out);
  // The score is what makes this ranking rather than a substring filter.
  assert.match(out, /\d\.\d{3} · conf 0\.8 · user/);
});

test('/mem <query> with no hit says so instead of printing nothing', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-cli-memmiss-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  seedMemoryStore(home, [
    { id: 'a', type: 'preference', content: 'prefer local models', timestamp: 1, source: 'user', confidence: 0.9 },
  ]);
  const proc = runSlash(home, '/mem zzzznothingmatchesthis');
  const out = `${proc.stdout ?? ''}${proc.stderr ?? ''}`;
  assert.match(out, /no memory entry matches/);
});
