import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  TRUST_LEVELS,
  resolveTrustLevel,
  checkTrust,
  saveTrustLevel,
  describeTrustLevel,
} from '../src/trust.js';

// ---------------------------------------------------------------------------
// TRUST_LEVELS
// ---------------------------------------------------------------------------

test('TRUST_LEVELS: contains all five levels in order', () => {
  assert.deepEqual(TRUST_LEVELS, ['paranoid', 'strict', 'balanced', 'trusted', 'yolo']);
});

// ---------------------------------------------------------------------------
// resolveTrustLevel: priority chain
// ---------------------------------------------------------------------------

test('resolveTrustLevel: defaults to strict', () => {
  const r = resolveTrustLevel({ config: {}, env: {}, flags: {} });
  assert.equal(r.level, 'strict');
  assert.equal(r.source, 'default');
});

test('resolveTrustLevel: flag takes priority', () => {
  const r = resolveTrustLevel({ config: { trust: 'yolo' }, env: { OX_TRUST: 'balanced' }, flags: { trust: 'paranoid' } });
  assert.equal(r.level, 'paranoid');
  assert.equal(r.source, 'flag');
});

test('resolveTrustLevel: yolo flag short-circuits', () => {
  const r = resolveTrustLevel({ flags: { yolo: true } });
  assert.equal(r.level, 'yolo');
  assert.equal(r.source, 'flag');
});

test('resolveTrustLevel: env overrides config', () => {
  const r = resolveTrustLevel({ config: { trust: 'strict' }, env: { OX_TRUST: 'balanced' }, flags: {} });
  assert.equal(r.level, 'balanced');
  assert.equal(r.source, 'env');
});

test('resolveTrustLevel: config overrides default', () => {
  const r = resolveTrustLevel({ config: { trust: 'trusted' }, env: {}, flags: {} });
  assert.equal(r.level, 'trusted');
  assert.equal(r.source, 'config');
});

test('resolveTrustLevel: config.yolo=true maps to yolo', () => {
  const r = resolveTrustLevel({ config: { yolo: true } });
  assert.equal(r.level, 'yolo');
  assert.equal(r.source, 'config');
});

test('resolveTrustLevel: invalid env falls through', () => {
  const r = resolveTrustLevel({ env: { OX_TRUST: 'invalid' } });
  assert.equal(r.level, 'strict');
});

// ---------------------------------------------------------------------------
// checkTrust: per-level behavior
// ---------------------------------------------------------------------------

test('checkTrust: paranoid requires approval for everything', () => {
  const r = checkTrust({ name: 'read_file', trustLevel: 'paranoid' });
  assert.equal(r.allowed, false);
  assert.equal(r.requiresApproval, true);
});

test('checkTrust: yolo allows everything', () => {
  const r = checkTrust({ name: 'bash', args: { command: 'rm -rf /' }, trustLevel: 'yolo' });
  assert.equal(r.allowed, true);
  assert.equal(r.requiresApproval, false);
});

test('checkTrust: strict auto-allows read_file', () => {
  const r = checkTrust({ name: 'read_file', trustLevel: 'strict' });
  assert.equal(r.allowed, true);
  assert.equal(r.requiresApproval, false);
});

test('checkTrust: strict requires approval for write_file', () => {
  const r = checkTrust({ name: 'write_file', args: { path: 'foo.js' }, trustLevel: 'strict' });
  assert.equal(r.allowed, false);
  assert.equal(r.requiresApproval, true);
});

test('checkTrust: strict requires approval for bash', () => {
  const r = checkTrust({ name: 'bash', args: { command: 'ls' }, trustLevel: 'strict' });
  assert.equal(r.allowed, false);
  assert.equal(r.requiresApproval, true);
});

test('checkTrust: balanced auto-allows project-local writes', () => {
  const r = checkTrust({ name: 'write_file', args: { path: 'src/foo.js' }, trustLevel: 'balanced' });
  assert.equal(r.allowed, true);
});

test('checkTrust: balanced requires approval for external writes', () => {
  const r = checkTrust({ name: 'write_file', args: { path: '/etc/passwd' }, trustLevel: 'balanced' });
  assert.equal(r.allowed, false);
});

test('checkTrust: balanced auto-allows local shell, requires approval for network', () => {
  const local = checkTrust({ name: 'bash', args: { command: 'ls' }, trustLevel: 'balanced' });
  assert.equal(local.allowed, true);
  const network = checkTrust({ name: 'bash', args: { command: 'curl https://example.com' }, trustLevel: 'balanced' });
  assert.equal(network.allowed, false);
});

test('checkTrust: trusted auto-allows non-destructive shell', () => {
  const r = checkTrust({ name: 'bash', args: { command: 'ls' }, trustLevel: 'trusted' });
  assert.equal(r.allowed, true);
});

test('checkTrust: trusted requires approval for rm -rf', () => {
  const r = checkTrust({ name: 'bash', args: { command: 'rm -rf /' }, trustLevel: 'trusted' });
  assert.equal(r.allowed, false);
});

test('checkTrust: trusted requires approval for drop table', () => {
  const r = checkTrust({ name: 'bash', args: { command: 'psql -c "drop table users"' }, trustLevel: 'trusted' });
  assert.equal(r.allowed, false);
});

test('checkTrust: detects rm with star as destructive', () => {
  const r = checkTrust({ name: 'bash', args: { command: 'rm -rf *' }, trustLevel: 'trusted' });
  assert.equal(r.allowed, false);
});

test('checkTrust: detects fork bomb as destructive', () => {
  const r = checkTrust({ name: 'bash', args: { command: ':(){ :|:& };:' }, trustLevel: 'trusted' });
  assert.equal(r.allowed, false);
});

test('checkTrust: detects force push as destructive', () => {
  const r = checkTrust({ name: 'bash', args: { command: 'git push --force' }, trustLevel: 'trusted' });
  assert.equal(r.allowed, false);
});

test('checkTrust: unknown tool requires approval', () => {
  const r = checkTrust({ name: 'mystery_tool', trustLevel: 'trusted' });
  assert.equal(r.allowed, false);
  assert.equal(r.requiresApproval, true);
});

// ---------------------------------------------------------------------------
// describeTrustLevel
// ---------------------------------------------------------------------------

test('describeTrustLevel: returns description for each level', () => {
  for (const level of TRUST_LEVELS) {
    const d = describeTrustLevel(level);
    assert.ok(d.name);
    assert.ok(d.description);
  }
});

test('describeTrustLevel: returns placeholder for unknown level', () => {
  const d = describeTrustLevel('nonexistent');
  assert.equal(d.name, 'nonexistent');
});

// ---------------------------------------------------------------------------
// saveTrustLevel
// ---------------------------------------------------------------------------

test('saveTrustLevel: rejects invalid level', () => {
  const r = saveTrustLevel('invalid');
  assert.equal(r.saved, false);
});

test('saveTrustLevel: persists to ~/.ox/config.json', () => {
  // Use a custom homedir by setting HOME
  const origHome = process.env.HOME;
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-home-'));
  process.env.HOME = tmpHome;
  try {
    const r = saveTrustLevel('balanced');
    assert.equal(r.saved, true);
    assert.ok(fs.existsSync(r.path));
    const data = JSON.parse(fs.readFileSync(r.path, 'utf8'));
    assert.equal(data.trust, 'balanced');
  } finally {
    process.env.HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('saveTrustLevel: yolo also sets yolo=true for backward compat', () => {
  const origHome = process.env.HOME;
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-home-'));
  process.env.HOME = tmpHome;
  try {
    saveTrustLevel('yolo');
    const data = JSON.parse(fs.readFileSync(path.join(tmpHome, '.ox', 'config.json'), 'utf8'));
    assert.equal(data.trust, 'yolo');
    assert.equal(data.yolo, true);
  } finally {
    process.env.HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});
