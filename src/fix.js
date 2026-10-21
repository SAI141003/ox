// ox fix "<the bug>": reproduce it with a failing test, fix it, prove the test
// now passes. The agent writes the test and the fix; ox itself runs the test
// before and after, so "fixed" is never the agent's word alone:
//
//   1. repro   the agent writes ONE focused test that fails because of the bug,
//              and names it (FILE: …, TEST: <command that runs only it>).
//   2. check   ox runs that command: it must FAIL. A test that passes before the
//              fix proves nothing, so the agent gets one try to make it bite.
//   3. fix     the agent changes the code, not the test (ox compares the test
//              file's hash before and after).
//   4. prove   ox runs the same command: it must PASS. Then the project's own
//              test command, when there is one, so the fix broke nothing else.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const hashFile = (f) => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return null; } };
const tail = (s, n = 1200) => String(s ?? '').trim().slice(-n);

/** The FILE: / TEST: lines the agent ends with. */
export function parseRepro(reply) {
  const text = String(reply ?? '');
  const file = [...text.matchAll(/^\s*FILE:\s*`?([^\s`]+)`?\s*$/gim)].pop()?.[1] ?? null;
  const test = [...text.matchAll(/^\s*TEST:\s*`?(.+?)`?\s*$/gim)].pop()?.[1]?.trim() ?? null;
  return { file, test };
}

/** A test command: run in the project, with a time limit. → { pass, code, out } */
export function runTest(cmd, cwd, { timeoutMs = 5 * 60_000 } = {}) {
  // A clean environment: a NODE_TEST_CONTEXT inherited from a parent test run
  // makes `node --test` report to that parent and exit 0 even when it fails.
  const env = { ...process.env, CI: '1', FORCE_COLOR: '0' };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(cmd, { cwd, shell: true, encoding: 'utf8', timeout: timeoutMs, env });
  return { pass: r.status === 0, code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

export const REPRO_PROMPT = (bug) => `Reproduce this bug with a test. Do NOT fix it yet.
The bug: ${bug}

Find the code involved, then write ONE small, focused test that FAILS because of this bug and would pass once it is fixed. Put it where this project keeps its tests, in its test framework.
Do not change any code other than the new test.
End your reply with exactly these two lines:
FILE: <path of the test file, from the project root>
TEST: <a shell command that runs only that test, from the project root>`;

export const BITE_PROMPT = (bug, file, test, out) => `The test in ${file} PASSES before any fix (\`${test}\`), so it does not reproduce the bug.
The bug: ${bug}
Its output:
${tail(out, 800)}
Change the test so it fails because of the bug (do not fix the bug). End with the same FILE: and TEST: lines.`;

export const FIX_PROMPT = (bug, file, test, out) => `Fix this bug: ${bug}
A test reproduces it: ${file}, run with \`${test}\`. It fails now:
${tail(out, 1500)}
Change the code so that test passes. Do NOT edit ${file} or weaken the test. Keep the change small and in the style of the code around it. Reply with what you changed and why, in a few lines.`;

/**
 * The whole flow. ask(prompt) runs one agent turn in cwd and returns its reply
 * text. → { ok, stage, file, test, before, after, suite, message }
 */
export async function fixBug(bug, { cwd = process.cwd(), ask, suite = null, onStep = () => {} } = {}) {
  if (!String(bug ?? '').trim()) throw new Error('say what the bug is: ox fix "the total is wrong when the cart is empty"');
  onStep('repro', 'writing a test that shows the bug');
  let reply = await ask(REPRO_PROMPT(bug));
  let { file, test } = parseRepro(reply);
  if (!file || !test) return { ok: false, stage: 'repro', message: 'the agent did not name the test (FILE: and TEST: lines)', reply: tail(reply, 600) };
  onStep('check', `${test} (it must fail)`);
  let before = runTest(test, cwd);
  if (before.pass) {
    onStep('repro', 'the test passed before any fix: making it bite');
    reply = await ask(BITE_PROMPT(bug, file, test, before.out));
    const again = parseRepro(reply);
    file = again.file ?? file;
    test = again.test ?? test;
    before = runTest(test, cwd);
    if (before.pass) return { ok: false, stage: 'repro', file, test, before, message: 'could not write a test that fails because of the bug; nothing was changed beyond the test' };
  }
  const abs = path.resolve(cwd, file);
  const testHash = hashFile(abs);
  onStep('fix', 'changing the code, not the test');
  await ask(FIX_PROMPT(bug, file, test, before.out));
  if (testHash && hashFile(abs) !== testHash) return { ok: false, stage: 'fix', file, test, before, message: `the test file ${file} was edited during the fix, so the result does not count` };
  onStep('prove', `${test} (it must pass now)`);
  const after = runTest(test, cwd);
  if (!after.pass) return { ok: false, stage: 'prove', file, test, before, after, message: 'the test still fails after the fix' };
  let suiteRun = null;
  if (suite) { onStep('suite', suite); suiteRun = runTest(suite, cwd, { timeoutMs: 20 * 60_000 }); }
  return {
    ok: !suiteRun || suiteRun.pass, stage: 'done', file, test, before, after, suite: suiteRun,
    message: suiteRun && !suiteRun.pass ? `fixed (the test passes) but the project's tests (${suite}) now fail` : `fixed and proven: ${test} failed before and passes now${suiteRun ? `; ${suite} passes` : ''}`,
  };
}

/** The project's own test command, when it has one (package.json "test", or the env recipe). */
export function projectSuite(cwd) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    if (pkg.scripts?.test && !/no test specified/.test(pkg.scripts.test)) return 'npm test --silent';
  } catch {}
  if (fs.existsSync(path.join(cwd, 'Cargo.toml'))) return 'cargo test -q';
  if (fs.existsSync(path.join(cwd, 'go.mod'))) return 'go test ./...';
  if (fs.existsSync(path.join(cwd, 'pyproject.toml')) || fs.existsSync(path.join(cwd, 'pytest.ini'))) return 'python -m pytest -q';
  return null;
}
