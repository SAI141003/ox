import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTrustApprovalWrapper } from '../src/trust-gate.js';
import { checkTrust } from '../src/trust.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OX_BIN = path.join(ROOT, 'bin', 'ox.js');
const CREDENTIAL_ENV = [
  'OX_BASE_URL', 'OX_API_KEY', 'OX_MODEL', 'OX_YOLO', 'OX_MAX_COST',
  'XAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY',
  'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'DEEPSEEK_API_KEY', 'NODE_OPTIONS',
];
let tempCounter = 0;

function makeTemp(t, label) {
  const dir = fs.mkdtempSync(path.join(ROOT, '.ox-test-' + label + '-' + (++tempCounter) + '-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* a throwing hook skips later cleanup: see e2e.test.js */ } });
  return dir;
}

function runOx(t, args) {
  const home = makeTemp(t, 'home');
  const cwd = makeTemp(t, 'cwd');
  const env = { ...process.env };
  for (const key of CREDENTIAL_ENV) delete env[key];
  env.HOME = home;
  env.NO_COLOR = '1';
  const result = spawnSync(process.execPath, [OX_BIN, ...args], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 15000,
  });
  return { ...result, home, cwd };
}

function makeGate(ctx) {
  let approvalCalls = 0;
  let pauseCalls = 0;
  let resumeCalls = 0;
  const wrapper = createTrustApprovalWrapper({
    checkTrust,
    ctx,
    resolveTrust: () => ctx.trustLevel || 'strict',
    baseApprove: async () => {
      approvalCalls += 1;
      return true;
    },
    pause: () => { pauseCalls += 1; },
    resume: () => { resumeCalls += 1; },
  });
  return {
    wrapper,
    state: () => ({ approvalCalls, pauseCalls, resumeCalls }),
  };
}

test('strict write_file reaches the interactive approval path', async (t) => {
  const cwd = makeTemp(t, 'strict-write');
  const ctx = { cwd, trustLevel: 'strict' };
  const gate = makeGate(ctx);
  const result = await gate.wrapper('write_file', { path: 'src/foo.js' }, 'create src/foo.js');
  assert.equal(result, true);
  assert.deepEqual(gate.state(), { approvalCalls: 1, pauseCalls: 1, resumeCalls: 1 });
});

test('strict destructive bash is explicitly an approval ask', async (t) => {
  const cwd = makeTemp(t, 'strict-bash');
  const ctx = { cwd, trustLevel: 'strict' };
  const gate = makeGate(ctx);
  const result = await gate.wrapper('bash', { command: 'rm -rf /' }, 'rm -rf /');
  assert.equal(result, true, 'strict destructive bash must fall through to approval');
  assert.deepEqual(gate.state(), { approvalCalls: 1, pauseCalls: 1, resumeCalls: 1 });
});

test('balanced project-local write auto-allows without a prompt', async (t) => {
  const cwd = makeTemp(t, 'balanced-write');
  const ctx = { cwd, trustLevel: 'balanced' };
  const gate = makeGate(ctx);
  const result = await gate.wrapper('write_file', { path: 'src/foo.js' }, 'create src/foo.js');
  assert.equal(result, true);
  assert.deepEqual(gate.state(), { approvalCalls: 0, pauseCalls: 0, resumeCalls: 0 });
});

test('/trust balanced mutation changes the next tool gate', async (t) => {
  const cwd = makeTemp(t, 'trust-switch');
  const ctx = { cwd, trustLevel: 'strict' };
  const gate = makeGate(ctx);
  await gate.wrapper('write_file', { path: 'src/first.js' }, 'create first file');
  ctx.trustLevel = 'balanced';
  const result = await gate.wrapper('write_file', { path: 'src/second.js' }, 'create second file');
  assert.equal(result, true);
  assert.deepEqual(gate.state(), { approvalCalls: 1, pauseCalls: 1, resumeCalls: 1 });
});

test('--trust badvalue prints valid levels and exits non-zero', (t) => {
  const result = runOx(t, ['--trust', 'badvalue']);
  assert.equal(result.status, 3, 'stdout: ' + result.stdout + '\nstderr: ' + result.stderr);
  assert.match(result.stderr, /invalid trust level "badvalue"/);
  assert.match(result.stderr, /Valid: paranoid, strict, balanced, trusted, yolo/);
});

test('ox aas does not throw the scan alias ReferenceError', (t) => {
  const result = runOx(t, ['aas']);
  const output = result.stdout + '\n' + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(result.stdout, /AAS Status/);
  assert.doesNotMatch(output, /ReferenceError|scanSkillsDir is not defined/);
});

test('ox toc does not throw the missing messages ReferenceError', (t) => {
  const result = runOx(t, ['toc']);
  const output = result.stdout + '\n' + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(result.stdout, /TOC-Comp/);
  assert.doesNotMatch(output, /ReferenceError|messages is not defined/);
});
