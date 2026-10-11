import { describe, it } from 'node:test';
import assert from 'node:assert';
import { LlmFailure, normalizeFailure } from '../src/llm-failure.js';
import { evaluateToolPolicy, isReadOnlyCommand, READONLY_TOOLS } from '../src/guards.js';
import { collisionHash } from '../src/mcp.js';
import { classifySandboxExit } from '../src/sandbox.js';

describe('normalizeFailure', () => {
  it('AbortError → TIMEOUT', () => {
    const e = new Error('aborted');
    e.name = 'AbortError';
    const r = normalizeFailure(e);
    assert.strictEqual(r.code, LlmFailure.TIMEOUT);
    assert.strictEqual(r.retryable, true);
  });

  it('status 429 → RATE_LIMITED + retryable + retryAfterMs', () => {
    const r = normalizeFailure({ status: 429, headers: { 'retry-after': '3' } });
    assert.strictEqual(r.code, LlmFailure.RATE_LIMITED);
    assert.strictEqual(r.httpStatus, 429);
    assert.strictEqual(r.retryable, true);
    assert.strictEqual(r.retryAfterMs, 3000);
  });

  it('401 → AUTH + !retryable', () => {
    const r = normalizeFailure({ status: 401 });
    assert.strictEqual(r.code, LlmFailure.AUTH);
    assert.strictEqual(r.httpStatus, 401);
    assert.strictEqual(r.retryable, false);
  });

  it('500 → SERVER + retryable', () => {
    const r = normalizeFailure({ status: 500 });
    assert.strictEqual(r.code, LlmFailure.SERVER);
    assert.strictEqual(r.httpStatus, 500);
    assert.strictEqual(r.retryable, true);
  });

  it('code ECONNRESET → NETWORK', () => {
    const r = normalizeFailure({ code: 'ECONNRESET' });
    assert.strictEqual(r.code, LlmFailure.NETWORK);
    assert.strictEqual(r.httpStatus, null);
    assert.strictEqual(r.retryable, true);
  });

  it('message "context window exceeded" → CONTEXT_WINDOW_EXCEEDED', () => {
    const r = normalizeFailure(new Error('context window exceeded'));
    assert.strictEqual(r.code, LlmFailure.CONTEXT_WINDOW_EXCEEDED);
    assert.strictEqual(r.retryable, false);
  });

  it('empty message → EMPTY_RESPONSE', () => {
    const r = normalizeFailure(new Error('empty response from model'));
    assert.strictEqual(r.code, LlmFailure.EMPTY_RESPONSE);
    assert.strictEqual(r.retryable, true);
  });

  it('null → UNKNOWN', () => {
    const r = normalizeFailure(null);
    assert.strictEqual(r.code, LlmFailure.UNKNOWN);
    assert.strictEqual(r.httpStatus, null);
    assert.strictEqual(r.retryAfterMs, null);
    assert.strictEqual(r.retryable, false);
  });
});

describe('evaluateToolPolicy (monotonic guards)', () => {
  it('deny-wins over allow: sandbox deny beats yolo allow', () => {
    const { decision } = evaluateToolPolicy({
      name: 'bash',
      args: { command: 'ls' },
      ctx: { sandbox: { blocksTool: () => true }, approval: 'yolo' },
    });
    assert.strictEqual(decision, 'deny');
  });

  it('plan mode denies bash but allows read_file', () => {
    assert.strictEqual(evaluateToolPolicy({ name: 'bash', args: {}, ctx: { approval: 'plan' } }).decision, 'deny');
    assert.strictEqual(evaluateToolPolicy({ name: 'read_file', args: {}, ctx: { approval: 'plan' } }).decision, 'ask');
  });

  it('mcpPolicy deny/allow/ask', () => {
    assert.strictEqual(evaluateToolPolicy({ name: 'mcp__s__t', args: {}, ctx: { mcpPolicy: { s: 'deny' } } }).decision, 'deny');
    assert.strictEqual(evaluateToolPolicy({ name: 'mcp__s__t', args: {}, ctx: { mcpPolicy: { s: 'allow' } } }).decision, 'allow');
    assert.strictEqual(evaluateToolPolicy({ name: 'mcp__s__t', args: {}, ctx: {} }).decision, 'ask');
  });

  it('strict-approvals forces ask even for readonly bash', () => {
    assert.strictEqual(evaluateToolPolicy({ name: 'bash', args: { command: 'pwd' }, ctx: { strictApprovals: true } }).decision, 'ask');
    assert.strictEqual(evaluateToolPolicy({ name: 'bash', args: { command: 'ls' }, ctx: { strictApprovals: true } }).decision, 'ask');
  });

  it('readonly classifier allows pwd in default mode', () => {
    const { decision, rule } = evaluateToolPolicy({ name: 'bash', args: { command: 'pwd' }, ctx: { approval: 'default' } });
    assert.strictEqual(decision, 'allow');
    assert.strictEqual(rule, 'readonly-classifier');
  });

  it('yolo allows bash', () => {
    assert.strictEqual(evaluateToolPolicy({ name: 'bash', args: { command: 'rm -rf /' }, ctx: { approval: 'yolo' } }).decision, 'allow');
  });
});

describe('READONLY_TOOLS', () => {
  it('includes memory and read tools', () => {
    assert.ok(READONLY_TOOLS.includes('read_file'));
    assert.ok(READONLY_TOOLS.includes('memory_search'));
    assert.ok(!READONLY_TOOLS.includes('bash'));
  });
});

describe('collisionHash', () => {
  it('is 12 hex chars and deterministic', () => {
    const h = collisionHash('mcp__utils__search');
    assert.match(h, /^[0-9a-f]{12}$/);
    assert.strictEqual(h, collisionHash('mcp__utils__search'));
    assert.notStrictEqual(h, collisionHash('mcp__utils__other'));
  });
});

describe('classifySandboxExit (denied-vs-failed)', () => {
  it('maps EACCES stderr to sandbox-denied', () => {
    const r = classifySandboxExit({ code: 1, signal: null, stderr: 'bash: /etc/shadow: Permission denied', backend: 'bwrap' });
    assert.strictEqual(r.kind, 'sandbox-denied');
    assert.strictEqual(r.signature, 'EACCES');
  });

  it('maps EROFS to sandbox-denied', () => {
    const r = classifySandboxExit({ code: 1, signal: null, stderr: 'Read-only file system', backend: 'bwrap' });
    assert.strictEqual(r.kind, 'sandbox-denied');
    assert.strictEqual(r.signature, 'EROFS');
  });

  it('maps clean exit to command-failed', () => {
    const r = classifySandboxExit({ code: 0, signal: null, stderr: '', backend: 'bwrap' });
    assert.strictEqual(r.kind, 'command-failed');
    assert.strictEqual(r.signature, null);
  });
});
