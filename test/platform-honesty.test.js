import { test, describe, before, after, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import childProcess from 'node:child_process';
import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';

let createPlatform;
let PlatformError;
let root;
let originalEnv;
let originalCwd;
let platforms;

before(async () => {
  assert.ok(process.env.NODE_TEST_CONTEXT);
  originalEnv = { ...process.env };
  originalCwd = process.cwd();
  root = mkdtempSync(join(tmpdir(), 'ox-platform-'));
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, { HOME: root, TMPDIR: root, NODE_TEST_CONTEXT: originalEnv.NODE_TEST_CONTEXT });
  process.chdir(root);
  assert.equal(homedir(), root);
  mock.method(childProcess, 'execSync', () => { throw new Error('external commands disabled'); });
  mock.method(childProcess, 'spawn', () => { throw new Error('external processes disabled'); });
  syncBuiltinESMExports();
  ({ createPlatform, PlatformError } = await import('../src/platform.js'));
});

beforeEach(() => { platforms = []; });

afterEach(async () => {
  await Promise.all(platforms.map(p => p.close()));
});

after(() => {
  mock.restoreAll();
  syncBuiltinESMExports();
  if (originalCwd) process.chdir(originalCwd);
  if (originalEnv) {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, originalEnv);
  }
  if (root) rmSync(root, { recursive: true, force: true });
});

function platform(opts = {}) {
  const p = createPlatform(opts);
  platforms.push(p);
  return p;
}

function clock(t) {
  const timers = new Map();
  let now = 0;
  function add(fn, delay, repeat) {
    const handle = { unref() { return this; } };
    timers.set(handle, { fn, at: now + delay, delay, repeat });
    return handle;
  }
  t.mock.method(globalThis, 'setTimeout', (fn, delay) => add(fn, delay, false));
  t.mock.method(globalThis, 'setInterval', (fn, delay) => add(fn, delay, true));
  t.mock.method(globalThis, 'clearTimeout', handle => timers.delete(handle));
  t.mock.method(globalThis, 'clearInterval', handle => timers.delete(handle));
  t.mock.method(Math, 'random', () => 0);
  return {
    timers,
    tick(ms) {
      const end = now + ms;
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [handle, timer] = next;
        now = timer.at;
        if (timer.repeat) timer.at += timer.delay;
        else timers.delete(handle);
        timer.fn();
      }
      now = end;
    },
  };
}

describe('platform honesty contract', () => {
  test('speak() refuses with explicit unavailable error, never fabricates audioPath', async () => {
    const p = platform();
    await assert.rejects(() => p.voice.speak('hello'), err => {
      assert.ok(err instanceof PlatformError);
      assert.match(err.message, /no TTS backend is wired/);
      return true;
    });
  });

  test('listen() refuses instead of returning placeholder transcription', async () => {
    await assert.rejects(() => platform().voice.listen(), /no STT backend is wired/);
  });

  test('dictate() and conversation() yield no fabricated content', async () => {
    const p = platform();
    const chunks = [];
    for await (const c of p.voice.dictate({})) chunks.push(c);
    for await (const c of p.voice.conversation({ maxTurns: 2 })) chunks.push(c);
    assert.deepEqual(chunks, []);
  });

  for (const localOnly of [true, false]) {
    test(`video errors honestly with localOnly=${localOnly}`, async t => {
      const time = clock(t);
      const p = platform({ localOnly });
      const { jobId } = await p.video.generate('a windmill in the fog');
      time.tick(5010);
      const job = await p.video.status(jobId);
      assert.equal(job.status, 'error');
      assert.match(job.error, localOnly ? /binary not found/ : /no generator invocation wired/);
      assert.equal(job.output, null);
      assert.equal(time.timers.size, 0);
      await p.close();
      assert.deepEqual(await p.video.status(jobId), job);
    });
  }

  test('skills preserve metadata and refuse unwired execution', async () => {
    const p = platform({ skills: [{ name: 'demo', description: 'test skill', path: '/tmp/x' }] });
    assert.equal(p.skills.list().length, 1);
    assert.equal(p.skills.search('test').length, 1);
    await assert.rejects(() => p.skills.invoke('demo', {}), /skill execution is not wired/);
  });

  test('benchmark returns zero trials rather than fabricated passes', async t => {
    const time = clock(t);
    const p = platform({ benchmarks: [{ id: 'b1', name: 'bench-one' }] });
    const pending = p.benchmark.run('b1');
    time.tick(100);
    await Promise.resolve();
    time.tick(100);
    const result = await pending;
    assert.equal(result.stats.trials, 0);
    assert.deepEqual(result.results, []);
  });
});

describe('platform lifecycle', () => {
  for (const running of [false, true]) {
    test(`close cancels ${running ? 'running' : 'queued'} video and every timer`, async t => {
      const time = clock(t);
      const events = [];
      const p = platform({ onProgress: event => events.push(event) });
      const { jobId } = await p.video.generate('close test');
      if (running) time.tick(510);
      await p.close();
      const job = await p.video.status(jobId);
      const eventCount = events.length;
      assert.equal(job.status, 'cancelled');
      assert.equal(time.timers.size, 0);
      time.tick(10000);
      assert.deepEqual(await p.video.status(jobId), job);
      assert.equal(events.length, eventCount);
      await assert.rejects(() => p.video.generate('after close'), /closed/);
      await assert.rejects(() => p.video.imageToVideo('image.png', { prompt: 'after close' }), /closed/);
    });
  }

  test('video.close is independently idempotent', async t => {
    const time = clock(t);
    const p = platform();
    const { jobId } = await p.video.imageToVideo('image.png', { prompt: 'close' });
    p.video.close();
    p.video.close();
    assert.equal((await p.video.status(jobId)).status, 'cancelled');
    assert.equal(time.timers.size, 0);
  });

  test('close settles pending and queued progress reads without later events', async () => {
    const events = [];
    const p = platform({ onProgress: event => events.push(event) });
    let settled = false;
    const pending = p.progress.next().then(result => { settled = true; return result; });
    const second = p.progress.next();
    await p.close();
    for (let i = 0; i < 8; i++) await Promise.resolve();
    assert.equal(settled, true);
    assert.deepEqual(await pending, { value: undefined, done: true });
    assert.deepEqual(await second, { value: undefined, done: true });
    p.skills.list();
    for await (const chunk of p.voice.dictate()) assert.fail(String(chunk));
    assert.deepEqual(events, []);
    assert.deepEqual(await p.progress.next(), { value: undefined, done: true });
  });

  test('progress delivers buffered and waiting events before close', async () => {
    const p = platform();
    p.skills.list();
    const buffered = await p.progress.next();
    assert.equal(buffered.done, false);
    assert.equal(buffered.value.phase, 'skills:skills');
    const waiting = p.progress.next();
    p.skills.search('demo');
    const delivered = await waiting;
    assert.equal(delivered.done, false);
    assert.match(delivered.value.message, /matching "demo"/);
    await p.close();
    assert.deepEqual(await p.progress.next(), { value: undefined, done: true });
  });

  test('close discards buffered progress before iteration starts', async () => {
    const p = platform({ verbose: true });
    p.skills.list();
    await p.close();
    assert.deepEqual(await p.progress.next(), { value: undefined, done: true });
  });

  // WHY THIS ASSERTION CHANGED, because the old one encoded a data-loss bug.
  //
  // It used to read:
  //
  //     assert.equal(p.subsystems.cron.getJob(cronJob.id), null);
  //
  // asserting that close() DELETED the schedule. That was true and correct for
  // the object `cron` used to be: `createScheduler(cwd)` owned a private
  // `~/.ox/cron/jobs.json`, rows nobody else could read, in a file that existed
  // only to be thrown away with the process. `close()` owning that file meant
  // deleting its rows.
  //
  // `cron` is now a THIN ADAPTER over the shared append-only schedule store
  // (src/schedule.js), and `createPlatform()` is constructed by tests, by
  // embedders and by short-lived CLI paths. So those rows are the user's, they
  // outlive this process, and every other reader sees the deletions. The same
  // assertion, in the new world, means: any component that happens to build a
  // platform — including a test — destroys the user's entire schedule set on
  // teardown, with no error and no log line. An append-only store deleted
  // wholesale by an unrelated subsystem's shutdown.
  //
  // What is REAL and is asserted instead: close() leaves no timer behind, so
  // nothing this platform started can fire after it closes; and the schedules
  // survive it. Ownership of the rows belongs to the store, not to the object
  // that happened to read them.
  test('close stops cron execution without destroying the schedules, and stops gateway and voice mode', async t => {
    const time = clock(t);
    const p = platform();
    const cronJob = p.subsystems.cron.schedule('every minute');
    let serverClosed = 0;
    t.mock.method(http, 'createServer', () => ({
      listen(port, ready) { ready(); },
      close(done) { serverClosed++; done(); },
    }));
    await p.subsystems.gateway.start([{ name: 'webhook', enabled: true, webhook: 'http://127.0.0.1:8080' }]);
    await p.subsystems.voiceMode.start();
    assert.equal(p.subsystems.voiceMode.isRunning(), true);
    assert.equal(p.subsystems.gateway.getStatus().webhook.status, 'active');
    // Compared as a set against the state immediately before close(), not against
    // a fixed count: the store is shared and deliberately survives, so an earlier
    // test's rows are still legitimately there. The guarantee is "close removes
    // nothing", not "close leaves exactly this one".
    const before = p.subsystems.cron.listJobs().map((j) => j.id).sort();
    await p.close();
    // The row is still there, with its prompt and cadence intact.
    const kept = p.subsystems.cron.getJob(cronJob.id);
    assert.ok(kept, 'close() must not delete a schedule — the store is shared and append-only');
    assert.equal(kept.prompt, 'every minute');
    assert.equal(kept.cadence.kind, 'interval');
    assert.deepEqual(p.subsystems.cron.listJobs().map((j) => j.id).sort(), before, 'close() removed a schedule');
    // And it is still dispatchable: a surviving row that nothing can claim would
    // be its own kind of data loss.
    assert.ok(kept.enabled, 'a schedule must survive close() still able to run');
    // The real teardown guarantee: no timer outlives the platform.
    assert.equal(time.timers.size, 0);
    assert.deepEqual(p.subsystems.gateway.getStatus(), {});
    assert.equal(p.subsystems.voiceMode.isRunning(), false);
    assert.equal(serverClosed, 1);
  });

  // Same two guarantees as before — every subsystem gets its turn, one failure
  // does not stop the others, and a second close() shares the first one's
  // completion — with the crontab half restated honestly.
  //
  // This used to mock `deleteJob` and assert it was called once per job. It is
  // now `close()`, called once, and the assertion is that it left BOTH jobs
  // alone. The isolation being graded is unchanged: a throwing cleanup must not
  // prevent `gateway.stop` and `voiceMode.stop` from running.
  test('cleanup failures are isolated and concurrent closes share completion', async t => {
    const time = clock(t);
    const p = platform();
    const first = p.subsystems.cron.schedule('every minute');
    const second = p.subsystems.cron.schedule('every minute');
    const calls = [];
    t.mock.method(p.subsystems.cron, 'close', () => {
      calls.push('cron');
      throw new Error('cron failure');
    });
    let release;
    t.mock.method(p.subsystems.gateway, 'stop', () => {
      calls.push('gateway');
      return new Promise(resolve => { release = resolve; });
    });
    t.mock.method(p.subsystems.voiceMode, 'stop', async () => {
      calls.push('voiceMode');
      throw new Error('voice failure');
    });
    const before = p.subsystems.cron.listJobs().map((j) => j.id).sort();
    const closing = p.close();
    assert.equal(p.close(), closing);
    let finished = false;
    closing.then(() => { finished = true; });
    await Promise.resolve();
    assert.equal(finished, false);
    assert.deepEqual(calls, ['cron', 'gateway', 'voiceMode']);
    assert.equal(time.timers.size, 0);
    release();
    await closing;
    await p.close();
    assert.deepEqual(calls, ['cron', 'gateway', 'voiceMode']);
    // A failing cron teardown still must not have destroyed anything: the store
    // is untouched, so both rows are still readable — through the real
    // subsystem, not the mock that threw.
    assert.deepEqual(p.subsystems.cron.listJobs().map((j) => j.id).sort(), before, 'close() removed a schedule');
    assert.ok(p.subsystems.cron.getJob(first.id), 'the first job must survive a failed teardown');
    assert.ok(p.subsystems.cron.getJob(second.id), 'the second job must survive a failed teardown');
  });
});
