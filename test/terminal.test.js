import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TerminalSession, formatTerminalOutput, createTerminalSession } from '../src/terminal.js';

function fakeSession() {
  const children = [];
  const t = new TerminalSession(dir, {
    spawnProcess: (...args) => {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdin = { write() {}, end() {} };
      proc.kill = () => { proc.killed = true; };
      proc.args = args;
      children.push(proc);
      return proc;
    },
  });
  return { t, children };
}

let dir;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'ox-terminal-test-'));
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('terminal session', () => {
  test('run() captures command output', async () => {
    const t = createTerminalSession(dir);
    const r = await t.run('echo marker-123');
    assert.equal(r.exitCode, 0);
    assert.match(r.output, /marker-123/);
    t.kill();
  });

  test('run() rejects nonzero exit with message', async () => {
    const t = createTerminalSession(dir);
    await assert.rejects(() => t.run('exit 7'), /exited with code 7/);
    t.kill();
  });

  test('runAgent resolves module relative to src/, consumes the generator, and surfaces error events', async () => {
    const t = createTerminalSession(dir);
    const outputs = [];
    t.onOutput((s) => outputs.push(s));
    await assert.rejects(t.runAgent('hi', { target: {} }), /unknown provider/);
    const joined = outputs.join('');
    assert.ok(!joined.includes('Directory import'), 'agent module must resolve');
    assert.ok(!joined.includes('Cannot find module'), 'agent module must exist');
    assert.match(joined, /unknown provider/, 'provider error surfaced in streamed output');
    assert.equal(t._proc, null);
    assert.equal(t._closed, true);
    t.kill();
  });

  test('kill() clears tracked process state', async () => {
    const t = createTerminalSession(dir);
    const p = t.run('sleep 30');
    // give spawn a tick
    await new Promise((r) => setTimeout(r, 50));
    t.kill();
    await assert.rejects(() => p);
  });

  test('sequential commands reset output and preserve ANSI bytes', async () => {
    const t = createTerminalSession(dir);
    assert.equal((await t.run("printf '\\033[31mfirst\\033[0m'")).output, '\x1b[31mfirst\x1b[0m');
    assert.equal((await t.run("printf 'second'")).output, 'second');
    assert.deepEqual(t.getOutput(), ['second']);
    assert.equal(t._proc, null);
    assert.equal(t._closed, true);
  });

  test('command chunks concatenate without artificial newlines', async () => {
    const { t, children } = fakeSession();
    const result = t.run('fake');
    children[0].stdout.emit('data', Buffer.from('fir'));
    children[0].stderr.emit('data', Buffer.from('st'));
    children[0].emit('close', 0);
    assert.equal((await result).output, 'first');
    assert.deepEqual(children[0].args[2].stdio, ['pipe', 'pipe', 'pipe']);
  });

  for (const method of ['run', 'runAgent']) {
    test(`${method} cancellation and stale events cannot corrupt a newer process`, async () => {
      const { t, children } = fakeSession();
      const output = [];
      t.onOutput(text => output.push(text));
      const first = t[method]('first');
      const rejected = assert.rejects(first, /cancel/i);
      const second = t.run('second');
      children[1].stdout.emit('data', Buffer.from('second'));
      children[0].stdout.emit('data', Buffer.from('stale'));
      children[0].stderr.emit('data', Buffer.from('stale error'));
      children[0].emit('close', 0);
      assert.equal(t._proc, children[1]);
      assert.equal(t._closed, false);
      assert.deepEqual(t.getOutput(), ['second']);
      assert.deepEqual(output, ['second']);
      children[1].emit('close', 0);
      await rejected;
      assert.equal((await second).output, 'second');
    });

    test(`${method} spawn error rejects without unhandled session error`, async () => {
      const { t, children } = fakeSession();
      const result = t[method]('fake');
      const rejected = assert.rejects(result, /spawn failed/);
      assert.doesNotThrow(() => children[0].emit('error', new Error('spawn failed')));
      await rejected;
      assert.equal(t._proc, null);
      assert.equal(t._closed, true);
      children[0].emit('close', -2);
    });

    test(`${method} synchronous spawn failure leaves closed state`, async () => {
      const t = new TerminalSession(dir, { spawnProcess() { throw new Error('sync spawn failed'); } });
      await assert.rejects(t[method]('fake'), /sync spawn failed/);
      assert.equal(t._proc, null);
      assert.equal(t._closed, true);
      assert.deepEqual(t.getOutput(), []);
    });

    test(`${method} kill rejects even if child never closes`, async () => {
      const { t, children } = fakeSession();
      const result = t[method]('fake');
      const rejected = assert.rejects(result, /cancel/i);
      t.kill();
      await rejected;
      assert.equal(children[0].killed, true);
      assert.equal(t._proc, null);
      assert.equal(t._closed, true);
    });
  }

  test('agent handles every byte boundary, UTF8, and trailing unterminated final', async () => {
    const wire = Buffer.from('{"t":"delta","text":"café"}\n{"t":"final","text":"café"}');
    for (let split = 1; split < wire.length; split++) {
      const { t, children } = fakeSession();
      const output = [];
      t.onOutput(text => output.push(text));
      const result = t.runAgent('fake');
      children[0].stdout.emit('data', wire.subarray(0, split));
      children[0].stdout.emit('data', wire.subarray(split));
      children[0].emit('close', 0);
      assert.deepEqual(await result, { exitCode: 0, output: 'café' });
      assert.equal(output.join(''), wire.toString());
      assert.equal(t._proc, null);
      assert.equal(t._closed, true);
    }
  });

  test('agent preserves final empty string instead of delta or raw output', async () => {
    const { t, children } = fakeSession();
    const result = t.runAgent('fake');
    children[0].stdout.emit('data', Buffer.from('{"t":"final","text":"earlier"}\n{"t":"final","text":""}\n'));
    children[0].emit('close', 0);
    assert.deepEqual(await result, { exitCode: 0, output: '' });
  });

  for (const error of ['', null, undefined, 'failure']) {
    test(`agent error ${String(error)} rejects even with final and zero close`, async () => {
      const { t, children } = fakeSession();
      const result = t.runAgent('fake');
      const rejected = assert.rejects(result, /Agent error/);
      children[0].stdout.emit('data', Buffer.from(`${JSON.stringify({ t: 'error', error })}\n{"t":"final","text":"success"}\n`));
      children[0].emit('close', 0);
      await rejected;
    });
  }

  for (const wire of ['', '{"t":"delta","text":"partial"}\n', '{"t":"final"', '{"t":"final","text":"ok"}\ngarbage\n', '{"t":"final","text":42}\n', 'null\n', '{"t":"unknown"}\n']) {
    test(`agent rejects incomplete or malformed protocol ${JSON.stringify(wire)}`, async () => {
      const { t, children } = fakeSession();
      const result = t.runAgent('fake');
      const rejected = assert.rejects(result, /protocol|final result/);
      children[0].stdout.emit('data', Buffer.from(wire));
      children[0].emit('close', 0);
      await rejected;
    });
  }

  test('agent final does not override nonzero exit', async () => {
    const { t, children } = fakeSession();
    const result = t.runAgent('fake');
    const rejected = assert.rejects(result, /code 7/);
    children[0].stdout.emit('data', Buffer.from('{"t":"final","text":"ok"}\n'));
    children[0].emit('close', 7);
    await rejected;
  });

  test('agent spawn resets public output from a previous command', async () => {
    const { t, children } = fakeSession();
    const first = t.run('first');
    children[0].stdout.emit('data', Buffer.from('first'));
    children[0].emit('close', 0);
    await first;
    const second = t.runAgent('second');
    assert.deepEqual(t.getOutput(), []);
    children[1].stdout.emit('data', Buffer.from('{"t":"final","text":"second"}\n'));
    children[1].emit('close', 0);
    assert.equal((await second).output, 'second');
  });

  test('command output is bounded by lines within one large chunk', async () => {
    const { t, children } = fakeSession();
    const result = t.run('fake');
    children[0].stdout.emit('data', Buffer.from(Array.from({ length: 1200 }, (_, i) => `line-${i}`).join('\n')));
    children[0].emit('close', 0);
    assert.equal(t.getOutput().length, 1000);
    assert.equal((await result).output.split('\n').length, 1000);
  });

  test('formatTerminalOutput strips ANSI', () => {
    const out = formatTerminalOutput('\x1b[31mred\x1b[0m plain');
    assert.equal(out, 'red plain');
  });
});
