// The CLI path to the plan gate must not bypass the gate when nobody is watching.
//
// src/plan-first.js already fails closed on a non-TTY stdin (see
// test/plan-gate-non-tty.test.js). But src/cli.js only ever CALLED that gate
// behind `if (process.stdin.isTTY)`; on a non-TTY it printed
//   non-interactive: continuing with plan
// — directly under the "Approve (A) - Edit (E) - Reject (R) - Skip (S)" menu —
// and applied the plan with no gate at all. Per-tool approval still declined, so
// writes were blocked, but the plan was never confirmed and the message read as
// though it had been. This file covers the CLI path itself: the non-TTY cases
// run the real binary over a real pipe, the TTY cases drive main() in a real
// child process whose stdin reports isTTY (no pty, no timing guess).
//
// Contract pinned here:
//   non-TTY --plan, no -y   => REFUSED: exit 4, no plan built, nothing applied,
//                              and the message says no review ran
//   non-TTY --plan, with -y => proceeds, and says the gate was SKIPPED
//   neither message may imply a review/approval happened
//   every flag the message names is accepted by the parser (and `--yolo`, which
//     the parser does NOT accept, is never named)
//   TTY --plan => unchanged: the gate still runs, r rejects, a approves
//
// No disk access outside a per-test tmp sandbox: every child gets HOME pointed
// at a fresh temp dir and --cwd at a temp work dir, so the real ~/.ox and the
// repo tree are never touched. No API keys and no OX_BASE_URL are passed, so the
// plan build falls back to the local heuristic and the run fails fast without
// reaching the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const OX_BIN = new URL('../bin/ox.js', import.meta.url).pathname;
const CLI_JS = new URL('../src/cli.js', import.meta.url).pathname;

// Phrases that would claim a review/approval happened. None may appear on a
// path where no gate ran.
const FALSE_CLAIMS = [
  /continuing with plan/i,
  /plan (was )?approved/i,
  /plan (was )?reviewed/i,
  /plan (was )?confirmed/i,
  /review (passed|succeeded)/i,
  /gate (passed|ok|green)/i,
];

function assertNoFalseClaim(text, where) {
  for (const re of FALSE_CLAIMS) {
    assert.ok(!re.test(text), `${where}: message makes a false claim matching ${re}\n--- ${text}`);
  }
}

function sandbox(t, tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ox-${tag}-`));
  const home = path.join(root, 'home');
  const work = path.join(root, 'work');
  fs.mkdirSync(home);
  fs.mkdirSync(work);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // Proof the sandbox is a different directory from the real home, so "the real
  // ~/.ox is untouched" holds by construction and not by hope.
  assert.notEqual(fs.realpathSync(home), fs.realpathSync(os.homedir()));
  return { root, home, work };
}

// A whitelisted env: PATH, and nothing that could reach a provider or the real
// config dir. No *API_KEY, no OX_BASE_URL, HOME forced to the sandbox.
function childEnv(home) {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
    TMPDIR: os.tmpdir(),
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    HOME: home,
    NO_COLOR: '1',
    // These tests pin the no-model path: ox must not fall back to a model that
    // happens to run on this machine (a local Ollama, a signed-in plan).
    OX_NO_FALLBACK: '1',
  };
}

function runNode(t, argv, { home, work, timeoutMs = 60000 } = {}) {
  const child = spawn(process.execPath, argv, {
    cwd: work,
    env: childEnv(home),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  child.stdin.end();
  const done = new Promise((resolve) => {
    const killer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      resolve({ code: null, stdout, stderr: `${stderr}\n[timed out after ${timeoutMs}ms]` });
    }, timeoutMs);
    child.on('error', (err) => { clearTimeout(killer); resolve({ code: null, stdout, stderr: `${stderr}\n${err.message}` }); });
    child.on('close', (code) => { clearTimeout(killer); resolve({ code, stdout, stderr }); });
  });
  t.after(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } });
  return done.then((r) => ({ ...r, all: `${r.stdout}\n${r.stderr}` }));
}

// A stdin pipe that carries no answer: the shape that used to print
// "non-interactive: continuing with plan" and apply the plan ungated.
const runOx = (t, args, opts) => runNode(t, [OX_BIN, ...args], opts);

const plansIn = (work) => {
  const dir = path.join(work, '.agent', 'plans');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
};

// ---------------------------------------------------------------------------
// 1. non-TTY --plan without -y: the plan is saved, the run stays read-only
// ---------------------------------------------------------------------------
//
// It used to be refused outright. But the run after the plan is in plan mode,
// where every write and command is refused at dispatch, so nothing unreviewed
// can be applied: the safe answer is to keep the plan and stay read-only, and
// to say plainly that nobody reviewed it.

test('cli --plan: non-TTY without -y saves the plan and stays read-only, and says nobody reviewed it', async (t) => {
  const { home, work } = sandbox(t, 'plan-readonly');
  fs.writeFileSync(path.join(work, 'keep.txt'), 'original\n');
  const r = await runOx(t, ['-p', '--plan', 'build a test and fix the bug'], { home, work });

  assert.match(r.stdout, /building plan/, r.stdout);
  assert.equal(plansIn(work).length, 1, `the plan should be saved, got ${JSON.stringify(plansIn(work))}`);
  assert.match(r.stdout, /nobody reviewed this plan/i, r.stdout);
  assert.match(r.stdout, /read-only \(plan mode\), so nothing is changed/i, r.stdout);
  assert.equal(fs.readFileSync(path.join(work, 'keep.txt'), 'utf8'), 'original\n');
  assert.ok(!/continuing with plan/i.test(r.all), r.all);
  assertNoFalseClaim(r.all, 'non-TTY read-only');
});

// ---------------------------------------------------------------------------
// 2. non-TTY --plan WITH -y: proceeds
// ---------------------------------------------------------------------------

test('cli --plan: non-TTY WITH -y proceeds (plan built, saved, agent started)', async (t) => {
  const { home, work } = sandbox(t, 'plan-yolo');
  const r = await runOx(t, ['-p', '--plan', '-y', 'build a test and fix the bug'], { home, work });

  assert.ok(!/--plan refused/.test(r.stderr), `-y must not be refused\n--- stderr\n${r.stderr}`);
  assert.match(r.stdout, /building plan/, r.stdout);
  assert.match(r.stdout, /Plan: build a test and fix the bug/, r.stdout);
  assert.equal(plansIn(work).length, 1, `-y should have saved the plan, got ${JSON.stringify(plansIn(work))}`);
  // It went on to actually run the agent, which dies on the absent API key —
  // that is the sandbox, not the gate.
  // A missing key is terminal (not retried), so the run stops on the first attempt.
  assert.match(r.all, /provider auth failure: Missing API key/, r.all);
  assertNoFalseClaim(r.all, 'non-TTY with -y');
});

// ---------------------------------------------------------------------------
// 3. the message never claims a gate ran when none did
// ---------------------------------------------------------------------------

test('cli --plan: the non-TTY messages say no review happened, never that one passed', async (t) => {
  const { home, work } = sandbox(t, 'plan-truthful');
  const ro = await runOx(t, ['-p', '--plan', 'build a test'], { home, work });
  const yolo = await runOx(t, ['-p', '--plan', '-y', 'build a test'], { home, work });

  assert.match(yolo.stdout, /plan review SKIPPED/i, yolo.stdout);
  assert.match(yolo.stdout, /no gate ran/i, yolo.stdout);
  assert.match(yolo.stdout, /nobody approved this plan/i, yolo.stdout);
  assert.ok(!/approving|auto-approved|approved the plan/i.test(yolo.all), yolo.all);

  assert.match(ro.stdout, /nobody reviewed this plan/i, ro.stdout);
  assert.ok(!/(?<!nobody )approved/i.test(ro.all), `the read-only path implies an approval:\n${ro.all}`);
  assert.ok(!/applied (it|the plan)/i.test(ro.all), `the read-only path implies it applied the plan:\n${ro.all}`);

  for (const [where, text] of [['read-only', ro.all], ['-y', yolo.all]]) {
    for (const re of FALSE_CLAIMS) {
      assert.ok(!re.test(text), `${where}: false claim ${re}\n--- ${text}`);
    }
  }
});

// ---------------------------------------------------------------------------
// 4. the skip-review flags really do open the unattended path
// ---------------------------------------------------------------------------

test('cli --plan: -y and --dangerously-skip-approvals both skip the review, and say so', async (t) => {
  const { home, work } = sandbox(t, 'plan-flagrun');
  for (const flag of ['-y', '--dangerously-skip-approvals']) {
    const dir = path.join(work, flag.replace(/^-+/, ''));
    fs.mkdirSync(dir, { recursive: true });
    const r = await runOx(t, ['-p', '--plan', flag, 'build a test'], { home, work: dir });
    assert.match(r.stdout, /plan review SKIPPED/i, `${flag}: ${r.stdout}`);
    assert.equal(plansIn(dir).length, 1, `${flag} did not save the plan`);
  }
});

test('cli --plan: --yolo is NOT a flag', async (t) => {
  const { home, work } = sandbox(t, 'plan-yoloflag');
  const r = await runOx(t, ['-p', '--plan', '--yolo', 'build a test'], { home, work });
  assert.equal(r.code, 3, r.all);
  assert.match(r.stderr, /unknown flag '--yolo'/, r.stderr);
  assert.deepEqual(plansIn(work), [], '--yolo should never have run anything');
});

// ---------------------------------------------------------------------------
// 5. TTY --plan behaviour unchanged
// ---------------------------------------------------------------------------
//
// A pty is not needed: the gate reads process.stdin, so a child process whose
// stdin is a PassThrough reporting isTTY exercises the real TTY branch. The key
// is sent as soon as the gate has printed its menu — the gate attaches its
// listener in the same tick — so there is no sleep and no timing guess. The
// driver runs in its own process precisely so capturing its output cannot
// interfere with the test runner.

const TTY_DRIVER = `
import fs from 'node:fs';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';

const [cliPath, work, key, capturePath] = process.argv.slice(2);
const stdin = new PassThrough();
stdin.isTTY = true;
stdin.isRaw = false;
stdin.setRawMode = () => {};
Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });

let out = '';
let err = '';
process.stdout.write = (chunk) => { out += String(chunk); return true; };
process.stderr.write = (chunk) => { err += String(chunk); return true; };

let sent = false;
const send = () => { if (sent) return; sent = true; stdin.write(key); };
const fallback = setTimeout(send, 20000);
const realLog = console.log;
console.log = (...a) => { out += a.join(' ') + '\\\\n'; if (/Approve \\\\(A\\\\)/.test(out)) setImmediate(send); };

const { main } = await import(pathToFileURL(cliPath).href);
try {
  await main(['-p', '--plan', '--cwd', work, 'build a test and fix the bug']);
} catch (e) {
  err += '\\\\nDRIVER THREW: ' + (e?.stack ?? e) + '\\\\n';
}
clearTimeout(fallback);
fs.writeFileSync(capturePath, JSON.stringify({ code: process.exitCode ?? 0, out, err }));
process.exit(0);
`;

function runOxOnTty(t, key, { home, work, timeoutMs = 60000 } = {}) {
  const driver = path.join(work, '..', `tty-driver-${key}.mjs`);
  const capture = path.join(work, '..', `tty-capture-${key}.json`);
  fs.writeFileSync(driver, TTY_DRIVER);
  t.after(() => {
    for (const f of [driver, capture]) { try { fs.rmSync(f, { force: true }); } catch { /* gone */ } }
  });
  return runNode(t, [driver, CLI_JS, work, key, capture], { home, work, timeoutMs }).then((r) => {
    let cap = null;
    try { cap = JSON.parse(fs.readFileSync(capture, 'utf8')); } catch { /* driver died */ }
    assert.ok(cap, `the TTY driver produced no capture\n--- stdout\n${r.stdout}\n--- stderr\n${r.stderr}`);
    assert.equal(r.code, 0, `the TTY driver itself failed\n--- stderr\n${r.stderr}`);
    return {
      code: cap.code,
      stdout: cap.out,
      stderr: cap.err,
      all: `${cap.out}\n${cap.err}`,
    };
  });
}

test('cli --plan: TTY still gates — "r" rejects, nothing is applied', async (t) => {
  const { home, work } = sandbox(t, 'plan-tty-reject');
  const r = await runOxOnTty(t, 'r', { home, work });

  assert.equal(r.stderr, '', `the TTY run raised: ${r.stderr}`);
  assert.match(r.stdout, /Approve \(A\).*Edit \(E\).*Reject \(R\).*Skip \(S\)/, r.stdout);
  assert.match(r.stdout, /plan rejected — exiting/, r.stdout);
  assert.equal(r.code, 4, r.stdout);
  assert.deepEqual(plansIn(work), [], 'a rejected plan must not be saved');
  // The gate ran, so the non-TTY wording must be absent.
  assert.ok(!/non-interactive/i.test(r.stdout), r.stdout);
  assert.ok(!/plan review SKIPPED/i.test(r.stdout), r.stdout);
});

test('cli --plan: TTY still gates — "a" approves and applies', async (t) => {
  const { home, work } = sandbox(t, 'plan-tty-approve');
  const r = await runOxOnTty(t, 'a', { home, work });

  assert.ok(!/plan rejected/.test(r.stdout), r.stdout);
  assert.ok(!/--plan refused/.test(r.stdout), r.stdout);
  assert.equal(plansIn(work).length, 1, `an approved plan must be saved; stdout=${r.stdout}`);
  // It went on to run the agent, which dies on the absent API key — sandbox, not gate.
  // A missing key is terminal (not retried), so the run stops on the first attempt.
  assert.match(r.all, /provider auth failure: Missing API key/, r.all);
  assert.ok(!/non-interactive/i.test(r.stdout), r.stdout);
});
