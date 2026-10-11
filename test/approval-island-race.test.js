// On a TTY with OX Island connected, the terminal prompt and the island are
// asked at once; the first answer wins, and only a literal 'allow' from the
// island can allow.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApprover } from '../src/approval.js';

function withFakeTTY(fn) {
  return async () => {
    const prev = process.stdin.isTTY;
    process.stdin.isTTY = true;
    try {
      await fn();
    } finally {
      process.stdin.isTTY = prev;
      process.stdin.pause();
    }
  };
}

function gui(decision, delayMs = 5) {
  const calls = { ask: 0, cancel: [] };
  return {
    calls,
    hasClient: () => true,
    ask: async () => {
      calls.ask++;
      await new Promise((r) => setTimeout(r, delayMs));
      return { decision };
    },
    cancel: (reason) => calls.cancel.push(reason),
  };
}

test('island allow resolves the terminal prompt', withFakeTTY(async () => {
  const g = gui('allow');
  const approve = makeApprover({ external: g });
  assert.equal(await approve('bash', { command: 'rm -rf build' }), true);
  assert.equal(g.calls.ask, 1);
  assert.deepEqual(g.calls.cancel, ['answered-in-terminal']);
}));

test('island deny declines', withFakeTTY(async () => {
  const approve = makeApprover({ external: gui('deny') });
  assert.equal(await approve('bash', { command: 'rm -rf build' }), false);
}));

test('island silence (ask) never allows: the terminal keeps waiting', withFakeTTY(async () => {
  const approve = makeApprover({ external: gui('ask') });
  const outcome = await Promise.race([
    approve('bash', { command: 'rm -rf build' }).then((v) => `resolved:${v}`),
    new Promise((r) => setTimeout(() => r('still-waiting'), 80)),
  ]);
  assert.equal(outcome, 'still-waiting');
}));
