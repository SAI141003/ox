// The bench runner writes RESULTS.md by default unless --out-dir is given, so
// these runs are redirected into a temp sandbox. The baseline is asserted
// UNCHANGED by content, never restored afterwards: writing it back would itself
// be repo mutation, and the point of these tests is that nothing touches it.

import { test, describe, after } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESULTS = path.join(ROOT, 'bench', 'RESULTS.md');
const RUNS = path.join(ROOT, 'bench', 'results');
const RUNNER = path.join(ROOT, 'bench', 'runner.mjs');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-canary-baseline-'));

after(() => fs.rmSync(SANDBOX, { recursive: true, force: true }));

function listRunDirs() {
  return fs.existsSync(RUNS) ? fs.readdirSync(RUNS).sort() : [];
}

describe('bench runner baseline protection', () => {
  test('filtered run does not clobber the full RESULTS.md baseline', () => {
    const original = fs.readFileSync(RESULTS, 'utf8');
    const originalRows = original.split('\n').filter((l) => /^\|\s*\d/.test(l.trim())).length;
    assert.ok(originalRows >= 25, `precondition: full baseline present (found ${originalRows} rows)`);

    const outDir = path.join(SANDBOX, 'filtered');
    // Headroom for contention, not a sleep. A single filtered scenario is ~4s of
    // work on an idle box, but the runner boots a full agent process to run it and
    // this file shares the machine with a sibling test file, so wall time tracks
    // load rather than work: this measured 90s on a box at load average 700. A
    // budget not comfortably clear of the observed worst case turns ordinary
    // contention into a failure that says nothing about the baseline.
    execFileSync(process.execPath, [RUNNER, '--filter', '16-goal-verifier', '--out-dir', outDir], {
      cwd: ROOT, timeout: 600_000, stdio: 'pipe',
    });

    const afterRun = fs.readFileSync(RESULTS, 'utf8');
    assert.strictEqual(afterRun, original, 'a filtered run rewrote the baseline table');
    const rows = afterRun.split('\n').filter((l) => /^\| \d/.test(l.trim()));
    assert.ok(
      rows.length >= originalRows,
      `filtered run shrank the baseline table: ${originalRows} rows before, ${rows.length} after`
    );
    assert.match(afterRun, /01-basic-read/, 'baseline must keep scenario 01');
    assert.match(afterRun, /25-procedural-memory-recall/, 'baseline must keep scenario 25');
    assert.ok(fs.existsSync(path.join(outDir, 'RESULTS.md')), 'the run wrote its artifacts to the sandbox');
  });

  test('unfiltered run writes run-scoped artifacts, not the RESULTS.md baseline', () => {
    const original = fs.readFileSync(RESULTS, 'utf8');
    const runsBefore = listRunDirs();

    // The unfiltered run is the point of this test, so it stays unfiltered: what
    // it guards is that an ORDINARY FULL run leaves bench/RESULTS.md alone. Its
    // cost is therefore accepted and reported rather than scoped away. The old
    // 300s budget was not a real ceiling — the suite wall time was measured at
    // 167s unloaded and 242s on a loaded box, and this test failed by tripping
    // it at 300s. 900s is headroom over the worst case observed, and still
    // catches a genuine hang in a fraction of a second's terms.
    const outDir = path.join(SANDBOX, 'unfiltered');
    execFileSync(process.execPath, [RUNNER, '--out-dir', outDir], { cwd: ROOT, timeout: 900_000, stdio: 'pipe' });

    assert.strictEqual(
      fs.readFileSync(RESULTS, 'utf8'), original,
      'an unfiltered run rewrote the canary baseline; it must write bench/results/<timestamp>/ instead'
    );
    assert.deepStrictEqual(
      listRunDirs(), runsBefore,
      'the run left a timestamped directory under bench/results/ instead of honouring --out-dir'
    );
    assert.ok(fs.existsSync(path.join(outDir, 'RESULTS.md')), 'the run wrote a run-scoped RESULTS.md');
    assert.ok(fs.existsSync(path.join(outDir, 'canary.json')), 'the run wrote a run-scoped canary.json');
  });

  test('--update-baseline is rejected together with --filter', () => {
    const original = fs.readFileSync(RESULTS, 'utf8');
    let status = 0;
    try {
      execFileSync(process.execPath, [RUNNER, '--update-baseline', '--filter', '16-goal-verifier', '--out-dir', path.join(SANDBOX, 'rejected')], {
        cwd: ROOT, timeout: 600_000, stdio: 'pipe',
      });
    } catch (err) {
      status = err.status ?? 0;
    }
    assert.strictEqual(status, 3, 'a filtered run must not be able to replace the full-suite baseline');
    assert.strictEqual(fs.readFileSync(RESULTS, 'utf8'), original, 'baseline must be untouched');
  });
});
