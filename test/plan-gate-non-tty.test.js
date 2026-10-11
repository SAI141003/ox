// The plan gate must fail CLOSED when nobody is watching.
//
// Regression cover for the 100ms timer in src/plan-first.js that resolved
// { action: 'approve' } on a non-TTY stdin: plan mode exists to stop the agent
// editing before a human approves, and a self-approving timer failed open in
// exactly the environment where a human is NOT present.
//
// Contract pinned here:
//   non-TTY, no --yolo            => NOT approved (declined)
//   non-TTY, --yolo (autoApprove) => approved
//   no approval deadline exists   => silence can never become an approval
//   TTY                           => unchanged (A/E/R/S, any other key = approve)
//
// No disk access: nothing here reads or writes a HOME, so the real ~/.ox is
// never touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { interactivePlanReview } from '../src/plan-first.js';
import { makeApprover } from '../src/approval.js';

const PLAN = { goal: 'rewrite the deploy script', steps: [{ title: 'edit deploy.sh' }] };

// A non-TTY stdin nobody ever writes to and never closes: the shape that used
// to be approved by the 100ms timer.
function silentPipe() {
  const stdin = new PassThrough();
  stdin.isTTY = false;
  return stdin;
}

function ttyPipe() {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.rawModeCalls = [];
  stdin.setRawMode = (on) => { stdin.rawModeCalls.push(!!on); };
  return stdin;
}

function sink() {
  const stdout = new PassThrough();
  let buf = '';
  stdout.on('data', (c) => { buf += c.toString(); });
  return { stdout, text: () => buf };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Resolves { resolved, action } where action is null if nothing settled in time.
function settleWithin(promise, ms) {
  return Promise.race([
    promise.then((r) => ({ resolved: true, action: r.action, result: r })),
    sleep(ms).then(() => ({ resolved: false, action: null, result: null })),
  ]);
}

// ---------------------------------------------------------------------------
// 1. non-TTY, no --yolo => NOT approved
// ---------------------------------------------------------------------------

test('plan gate: non-TTY without --yolo is NOT approved (nobody answered)', async () => {
  const stdin = silentPipe();
  const { stdout, text } = sink();
  const r = await interactivePlanReview(PLAN, { stdin, stdout });

  assert.notEqual(r.action, 'approve', 'a silent non-TTY stdin must never approve the plan');
  assert.equal(r.action, 'reject');
  assert.equal(r.reason, 'no-plan-approver');

  const msg = text();
  assert.match(msg, /not a TTY/);
  assert.match(msg, /--yolo/, 'the decline must name the flag that would let it through');
  assert.match(msg, /--yes-edits/);
});

test('plan gate: non-TTY, stdin closed with no answer, is NOT approved', async () => {
  // The `< /dev/null` shape: EOF, not silence. Still nobody approving.
  const stdin = silentPipe();
  const { stdout, text } = sink();
  const pending = interactivePlanReview(PLAN, { stdin, stdout });
  setImmediate(() => stdin.end());
  const r = await pending;

  assert.notEqual(r.action, 'approve');
  assert.equal(r.action, 'reject');
  assert.match(text(), /no approver/);
});

test('plan gate: unrecognised non-TTY input is NOT an approval', async () => {
  for (const chunk of ['\n', 'zzz', ' ', '?']) {
    const stdin = silentPipe();
    const { stdout } = sink();
    const pending = interactivePlanReview(PLAN, { stdin, stdout });
    setImmediate(() => stdin.write(chunk));
    const r = await pending;
    assert.notEqual(r.action, 'approve', `input ${JSON.stringify(chunk)} approved the gate`);
    assert.equal(r.action, 'reject');
  }
});

// ---------------------------------------------------------------------------
// 2. non-TTY WITH --yolo => approved
// ---------------------------------------------------------------------------

test('plan gate: non-TTY with --yolo is approved', async () => {
  // Exactly what src/cli.js passes for --yolo / -y / --dangerously-skip-approvals.
  const stdin = silentPipe();
  const { stdout } = sink();
  const t0 = Date.now();
  const r = await interactivePlanReview(PLAN, { stdin, stdout, autoApprove: true });

  assert.equal(r.action, 'approve');
  assert.ok(Date.now() - t0 < 500, 'the flag approves immediately; it does not wait on stdin');
});

test('plan gate: --yolo approves even when the gate also has a TTY stdin', async () => {
  const stdin = ttyPipe();
  const { stdout } = sink();
  const r = await interactivePlanReview(PLAN, { stdin, stdout, autoApprove: true });
  assert.equal(r.action, 'approve');
  assert.deepEqual(stdin.rawModeCalls, [], 'the flag short-circuits before any raw mode');
});

// ---------------------------------------------------------------------------
// 3. the 100ms timer path cannot approve
// ---------------------------------------------------------------------------

test('plan gate: no approval deadline exists — the old 100ms timer cannot fire', async () => {
  const stdin = silentPipe();
  const { stdout, text } = sink();

  // The old code resolved { action: 'approve' } 100ms after entry. Nothing may
  // settle at that deadline now; only the bounded decline may settle, later.
  const early = await settleWithin(interactivePlanReview(PLAN, { stdin, stdout }), 400);
  assert.equal(early.resolved, false, 'the gate settled within the old 100ms auto-approve window');

  const r = await interactivePlanReview(PLAN, { stdin, stdout });
  assert.notEqual(r.action, 'approve');
  assert.equal(r.action, 'reject');
  assert.match(text(), /no approver/);
});

test('plan gate: a stdin that answers only after the old deadline still decides on its own', async () => {
  // A late 'a' is a real answer and is honoured; a late no-op is still a decline.
  const late = silentPipe();
  const lateSink = sink();
  const lateReview = interactivePlanReview(PLAN, { stdin: late, stdout: lateSink.stdout });
  setTimeout(() => late.write('a\n'), 250);
  assert.equal((await lateReview).action, 'approve');

  const late2 = silentPipe();
  const late2Sink = sink();
  const late2Review = interactivePlanReview(PLAN, { stdin: late2, stdout: late2Sink.stdout });
  setTimeout(() => late2.write('\n'), 250);
  const r2 = await late2Review;
  assert.notEqual(r2.action, 'approve', 'late input that is not an approval must not approve');
});

test('plan gate: 200 silent non-TTY gates in a row never approve', async () => {
  // Every one of these would have been approved by the timer.
  const { stdout } = sink();
  const results = await Promise.all(
    Array.from({ length: 200 }, () => interactivePlanReview(PLAN, { stdin: silentPipe(), stdout })),
  );
  const approved = results.filter((r) => r.action === 'approve').length;
  assert.equal(approved, 0, `${approved}/200 silent non-TTY gates self-approved`);
});

// ---------------------------------------------------------------------------
// 4. TTY behaviour unchanged
// ---------------------------------------------------------------------------

test('plan gate: TTY maps A/E/R/S exactly as before', async () => {
  const expected = { a: 'approve', A: 'approve', e: 'edit', E: 'edit', r: 'reject', R: 'reject', s: 'skip', S: 'skip' };
  for (const [key, action] of Object.entries(expected)) {
    const stdin = ttyPipe();
    const { stdout } = sink();
    const pending = interactivePlanReview(PLAN, { stdin, stdout });
    setImmediate(() => stdin.write(`${key}\n`));
    const r = await pending;
    assert.equal(r.action, action, `TTY key ${key}`);
    assert.deepEqual(stdin.rawModeCalls, [true, false], `raw mode around key ${key}`);
  }
});

test('plan gate: TTY keeps the any-other-key-means-approve UX', async () => {
  // Deliberately different from the non-TTY branch, and unchanged: at a real
  // terminal Enter/any other key is the documented "Approve (A)" default.
  for (const key of ['\n', 'q']) {
    const stdin = ttyPipe();
    const { stdout } = sink();
    const pending = interactivePlanReview(PLAN, { stdin, stdout });
    setImmediate(() => stdin.write(key));
    assert.equal((await pending).action, 'approve', `TTY key ${JSON.stringify(key)}`);
  }
});

test('plan gate: TTY still waits for a human — no timer on that path', async () => {
  const stdin = ttyPipe();
  const { stdout } = sink();
  const early = await settleWithin(interactivePlanReview(PLAN, { stdin, stdout }), 400);
  assert.equal(early.resolved, false, 'the TTY path resolved without any input');
  setImmediate(() => stdin.write('r'));
  const r = await interactivePlanReview(PLAN, { stdin, stdout });
  assert.equal(r.action, 'reject');
});

// ---------------------------------------------------------------------------
// Parity: the gate is no more permissive than the general approver
// ---------------------------------------------------------------------------

test('plan gate: non-TTY gate and the general approver both decline', async () => {
  const desc = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true, writable: true });
  const realWrite = process.stdout.write.bind(process.stdout);
  let captured = '';
  process.stdout.write = (chunk, ...rest) => { captured += String(chunk); return true; };
  try {
    const approve = makeApprover({ mode: 'default', yolo: false });
    const allowed = await approve('write_file', { path: 'src/x.js', content: 'boom' });
    const withYolo = await makeApprover({ mode: 'default', yolo: true })(
      'write_file', { path: 'src/x.js', content: 'boom' },
    );

    assert.equal(allowed, false, 'the general approver declined');
    assert.equal(withYolo, true, '--yolo still approves at the general approver');
    assert.match(captured, /not a TTY/);
  } finally {
    process.stdout.write = realWrite;
    if (desc) Object.defineProperty(process.stdin, 'isTTY', desc);
    else delete process.stdin.isTTY;
  }

  // Same environment, same rules, one gate: neither may approve on silence.
  const { stdout } = sink();
  assert.notEqual((await interactivePlanReview(PLAN, { stdin: silentPipe(), stdout })).action, 'approve');
});
