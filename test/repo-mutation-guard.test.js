// A test suite that mutates the repository it runs against is a suite that can
// change its own verdict: it plants notes, archives, bench artifacts, or
// overwrites the canary baseline, and the damage lands in the working tree
// instead of a temp dir. Those writes then feed the NEXT run's inputs.
//
// This guard makes that a test failure. `node --test` gives each test/*.test.js
// file its own process, so a top-level before/after here could only ever observe
// itself. Instead the guard drives every OTHER test file as a child process,
// one at a time, and diffs the whole working tree around each run. That makes it
// a real detector rather than a self-check.
//
// Cost: the suite runs twice (once normally, once under the guard). Set
// OX_SKIP_REPO_GUARD=1 to skip the per-file sweep in fast local loops.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_DIR = path.join(ROOT, 'test');
const SELF = fileURLToPath(import.meta.url);
const AGENT = path.join(ROOT, '.agent');

// VCS and dependency trees are not the repo's own source, and a guard that
// flagged them would be noise rather than signal.
// .claude holds agent worktrees (whole separate checkouts), never this tree.
const IGNORED = new Set(['node_modules', '.git', '.claude']);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

// path -> size:mtimeMs. A rewrite that preserves both is invisible to any
// observer, and hashing every file twice per test file would cost more than the
// suite under test.
function snapshot(root = ROOT) {
  const map = new Map();
  for (const file of walk(root)) {
    const st = fs.statSync(file);
    map.set(path.relative(root, file), `${st.size}:${st.mtimeMs}`);
  }
  return map;
}

function diff(before, after) {
  const added = [];
  const removed = [];
  const changed = [];
  for (const [k, v] of after) {
    if (!before.has(k)) added.push(k);
    else if (before.get(k) !== v) changed.push(k);
  }
  for (const k of before.keys()) if (!after.has(k)) removed.push(k);
  return { added, removed, changed };
}

function list(lines, limit = 10) {
  if (!lines.length) return '';
  const shown = lines.slice(0, limit).map((l) => `\n        ${l}`).join('');
  return shown + (lines.length > limit ? `\n        ...and ${lines.length - limit} more` : '');
}

function describeDiff(label, d) {
  const parts = [
    d.added.length ? `created${list(d.added)}` : '',
    d.changed.length ? `modified${list(d.changed)}` : '',
    d.removed.length ? `deleted${list(d.removed)}` : '',
  ].filter(Boolean);
  return `${label} mutated the repo: ${parts.join('; ') || '(no visible change)'}`;
}

function noteCounts() {
  const notes = path.join(AGENT, 'notes');
  const read = (p) => (fs.existsSync(p) ? fs.readdirSync(p).length : 0);
  return { live: read(notes), archived: read(path.join(notes, 'archive')) };
}

// `node --test` sets NODE_TEST_CONTEXT in the environment of every test process.
// Inherited by a child, it makes that child's `node --test` run report nothing
// and exit 0, so the guard would silently pass on a file that never ran. Strip
// it or the detector is a no-op.
function childEnv(home) {
  const env = { ...process.env, HOME: home };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

describe('the suite must not mutate the repository', () => {
  let tmpHome;

  before(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-guard-home-'));
  });

  after(() => fs.rmSync(tmpHome, { recursive: true, force: true }));

  const files = fs.readdirSync(TEST_DIR)
    .filter((f) => f.endsWith('.test.js'))
    .sort()
    .filter((f) => path.join(TEST_DIR, f) !== SELF);

  test('there is at least one other test file to guard', () => {
    assert.ok(files.length > 0, 'no other test files found; the guard would pass vacuously');
  });

  // Proof of mechanism. A deliberately polluting child writes into the real
  // .agent/notes/archive; the guard must see it, and must then clean up after
  // itself so the proof is not itself pollution.
  test('the detector reports a file that writes into .agent/notes', (t) => {
    const planted = path.join(AGENT, 'notes', 'archive', 'ZZ-GUARD-PROOF-polluter.md');
    const relative = path.relative(ROOT, planted);
    const polluter = path.join(tmpHome, 'deliberate-polluter.mjs');

    assert.equal(fs.existsSync(planted), false, `stale proof artifact left behind at ${relative}`);

    fs.writeFileSync(polluter, [
      `import fs from 'node:fs';`,
      `fs.writeFileSync(${JSON.stringify(planted)}, 'planted by repo-mutation-guard\\n');`,
      '',
    ].join('\n'));

    // .agent/ is gitignored, so a fresh checkout has no notes/archive dir for
    // the polluter to write into. Create what is missing; remove it after.
    const createdDirs = [];
    for (const dir of [AGENT, path.join(AGENT, 'notes'), path.dirname(planted)]) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir);
        createdDirs.push(dir);
      }
    }
    t.after(() => {
      for (const dir of createdDirs.reverse()) fs.rmSync(dir, { recursive: true, force: true });
    });

    const notesBefore = noteCounts();
    const before = snapshot();
    try {
      execFileSync(process.execPath, [polluter], { cwd: ROOT, env: childEnv(tmpHome), stdio: 'pipe' });

      const notesAfter = noteCounts();
      assert.notDeepEqual(
        notesAfter, notesBefore,
        'precondition: the deliberate polluter did not change the repo .agent/notes counts'
      );

      const d = diff(before, snapshot());
      assert.ok(
        d.added.includes(relative),
        `the detector missed its own planted file ${relative}\n${describeDiff('detector', d)}`
      );
    } finally {
      fs.rmSync(planted, { force: true });
    }

    assert.equal(fs.existsSync(planted), false, 'the guard failed to clean up its proof artifact');
    assert.deepEqual(noteCounts(), notesBefore, 'the guard left the repo .agent/notes counts moved');
  });

  const sweep = process.env.OX_SKIP_REPO_GUARD === '1'
    ? test.skip
    : test;

  for (const file of files) {
    sweep(`${file} leaves the repository untouched`, () => {
      const notesBefore = noteCounts();
      const before = snapshot();

      try {
        execFileSync(process.execPath, ['--test', path.join(TEST_DIR, file)], {
          cwd: ROOT,
          env: childEnv(tmpHome),
          stdio: 'pipe',
          timeout: 900_000,
        });
      } catch {
        // A pre-existing failure in that file is a separate concern; mutation
        // detection still has to hold, so the diff below is what decides here.
      }

      const d = diff(before, snapshot());
      assert.deepEqual(d, { added: [], changed: [], removed: [] }, describeDiff(file, d));

      const notesAfter = noteCounts();
      assert.deepEqual(
        notesAfter, notesBefore,
        `${file} changed .agent/notes (live ${notesBefore.live}->${notesAfter.live}, archived ${notesBefore.archived}->${notesAfter.archived})`
      );
    });
  }
});
