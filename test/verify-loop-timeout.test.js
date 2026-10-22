import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const previousHome = process.env.HOME;
const previousAudit = process.env.OX_AUDIT;
const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-verify-home-'));
process.env.HOME = isolatedHome;
process.env.OX_AUDIT = '0';

const { createVerifier, VERIFY_TEST_TIMEOUT_MS, formatVerificationReport } = await import('../src/verify-loop.js');

after(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousAudit === undefined) delete process.env.OX_AUDIT;
  else process.env.OX_AUDIT = previousAudit;
  fs.rmSync(isolatedHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('project test verification allows the full suite to exceed the shell default timeout', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-verify-project-'));
  const calls = [];
  try {
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'node test.js' } }));
    const verifier = createVerifier(cwd, {
      ctx: { yolo: true },
      execute: async (name, args) => {
        calls.push({ name, args });
        return { content: 'exit 0\n', isError: false };
      },
    });

    const result = await verifier.verifyTests();
    assert.equal(result.passed, true);
    assert.equal(calls[0].name, 'bash');
    assert.equal(calls[0].args.command, 'npm test');
    assert.equal(calls[0].args.timeout_ms, VERIFY_TEST_TIMEOUT_MS);
    assert.ok(VERIFY_TEST_TIMEOUT_MS > 120_000);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('verification reports do not render an unknown exit code as zero', () => {
  const rendered = formatVerificationReport({
    task: 'suite', result: '', timestamp: 0, passed: false,
    checks: [{ name: 'tests', passed: false, exitCode: null, output: 'terminated by timeout' }],
  });
  assert.match(rendered, /\[FAIL\] tests \(exit n\/a\)/);
  assert.doesNotMatch(rendered, /\[FAIL\] tests \(exit 0\)/);
});
