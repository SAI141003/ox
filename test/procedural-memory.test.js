import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  recordPattern,
  recallPatterns,
  formatProceduralContext,
  proceduralStats,
  detectTaskType,
} from '../src/procedural-memory.js';

function tmpCwd() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'proc-mem-'));
  return tmp;
}

function rm(cwd) {
  try { fs.rmSync(cwd, { recursive: true }); } catch {}
}

// ---------------------------------------------------------------------------
// recordPattern: basic recording
// ---------------------------------------------------------------------------

test('recordPattern: records a success', () => {
  const cwd = tmpCwd();
  const r = recordPattern({ cwd, taskType: 'code', pattern: 'Read the test first', success: true });
  assert.equal(r.recorded, true);
  assert.equal(r.count, 1);
  const f = path.join(cwd, '.agent', 'procedural.md');
  assert.ok(fs.existsSync(f));
  const content = fs.readFileSync(f, 'utf8');
  assert.match(content, /## code \(1 successful, 0 failed\)/);
  assert.match(content, /- ✓ \[\d{4}-\d{2}-\d{2}\] Read the test first/);
  rm(cwd);
});

test('recordPattern: records a failure', () => {
  const cwd = tmpCwd();
  const r = recordPattern({ cwd, taskType: 'refactor', pattern: 'Don\'t change behavior', success: false });
  assert.equal(r.recorded, true);
  const content = fs.readFileSync(path.join(cwd, '.agent', 'procedural.md'), 'utf8');
  assert.match(content, /✗/);
  assert.match(content, /0 successful, 1 failed/);
  rm(cwd);
});

test('recordPattern: deduplicates by exact text', () => {
  const cwd = tmpCwd();
  recordPattern({ cwd, taskType: 'code', pattern: 'Same pattern', success: true });
  const r = recordPattern({ cwd, taskType: 'code', pattern: 'Same pattern', success: true });
  assert.equal(r.recorded, true);
  const content = fs.readFileSync(path.join(cwd, '.agent', 'procedural.md'), 'utf8');
  // Should still have only one entry
  const matches = content.match(/Same pattern/g);
  assert.equal(matches.length, 1);
  rm(cwd);
});

test('recordPattern: invalid input returns safe error', () => {
  const cwd = tmpCwd();
  assert.equal(recordPattern({ cwd, taskType: '', pattern: 'x', success: true }).recorded, false);
  assert.equal(recordPattern({ cwd, taskType: 'code', pattern: '', success: true }).recorded, false);
  assert.equal(recordPattern({ cwd, taskType: 'code', pattern: 'x', success: true }).cwd, undefined);
  rm(cwd);
});

test('recordPattern: caps patterns at 20 per type', () => {
  const cwd = tmpCwd();
  for (let i = 0; i < 25; i++) {
    recordPattern({ cwd, taskType: 'code', pattern: `Pattern ${i}`, success: true });
  }
  const content = fs.readFileSync(path.join(cwd, '.agent', 'procedural.md'), 'utf8');
  const matches = content.match(/^-\s+/gm);
  assert.equal(matches.length, 20);
  // Header should show 20 successful (oldest dropped from count)
  assert.match(content, /\(20 successful/);
  rm(cwd);
});

// ---------------------------------------------------------------------------
// recallPatterns: filtering and ordering
// ---------------------------------------------------------------------------

test('recallPatterns: returns empty array when no patterns', () => {
  const cwd = tmpCwd();
  const r = recallPatterns({ cwd, taskType: 'code' });
  assert.deepEqual(r, []);
  rm(cwd);
});

test('recallPatterns: returns patterns for the given taskType only', () => {
  const cwd = tmpCwd();
  recordPattern({ cwd, taskType: 'code', pattern: 'Code pattern', success: true });
  recordPattern({ cwd, taskType: 'refactor', pattern: 'Refactor pattern', success: true });
  const r = recallPatterns({ cwd, taskType: 'code' });
  assert.equal(r.length, 1);
  assert.equal(r[0].taskType, 'code');
  rm(cwd);
});

test('recallPatterns: returns all types when no taskType specified', () => {
  const cwd = tmpCwd();
  recordPattern({ cwd, taskType: 'code', pattern: 'A', success: true });
  recordPattern({ cwd, taskType: 'refactor', pattern: 'B', success: true });
  const r = recallPatterns({ cwd });
  assert.equal(r.length, 2);
  rm(cwd);
});

test('recallPatterns: respects limit', () => {
  const cwd = tmpCwd();
  for (let i = 0; i < 10; i++) {
    recordPattern({ cwd, taskType: 'code', pattern: `P${i}`, success: true });
  }
  const r = recallPatterns({ cwd, taskType: 'code', limit: 3 });
  assert.equal(r.length, 3);
  rm(cwd);
});

test('recallPatterns: results include success/failure type and date', () => {
  const cwd = tmpCwd();
  recordPattern({ cwd, taskType: 'code', pattern: 'Good', success: true });
  recordPattern({ cwd, taskType: 'code', pattern: 'Bad', success: false });
  const r = recallPatterns({ cwd, taskType: 'code' });
  const success = r.find((p) => p.type === 'success');
  const failure = r.find((p) => p.type === 'failure');
  assert.ok(success);
  assert.ok(failure);
  assert.match(success.date, /\d{4}-\d{2}-\d{2}/);
  assert.match(failure.date, /\d{4}-\d{2}-\d{2}/);
  rm(cwd);
});

// ---------------------------------------------------------------------------
// formatProceduralContext: context block formatting
// ---------------------------------------------------------------------------

test('formatProceduralContext: returns empty string when no patterns', () => {
  const cwd = tmpCwd();
  const s = formatProceduralContext({ cwd });
  assert.equal(s, '');
  rm(cwd);
});

test('formatProceduralContext: includes header and grouped patterns', () => {
  const cwd = tmpCwd();
  recordPattern({ cwd, taskType: 'code', pattern: 'Read first', success: true });
  recordPattern({ cwd, taskType: 'refactor', pattern: 'Keep pure', success: true });
  const s = formatProceduralContext({ cwd });
  assert.match(s, /\[procedural memory/);
  assert.match(s, /code: 1 successful, 0 failed/);
  assert.match(s, /refactor: 1 successful, 0 failed/);
  assert.match(s, /✓ Read first/);
  assert.match(s, /✓ Keep pure/);
  rm(cwd);
});

test('formatProceduralContext: filters by taskType', () => {
  const cwd = tmpCwd();
  recordPattern({ cwd, taskType: 'code', pattern: 'Code only', success: true });
  recordPattern({ cwd, taskType: 'refactor', pattern: 'Refactor only', success: true });
  const s = formatProceduralContext({ cwd, taskType: 'code' });
  assert.match(s, /code/);
  assert.doesNotMatch(s, /refactor/);
  rm(cwd);
});

// ---------------------------------------------------------------------------
// proceduralStats: aggregate counts
// ---------------------------------------------------------------------------

test('proceduralStats: returns empty when no patterns', () => {
  const cwd = tmpCwd();
  const s = proceduralStats({ cwd });
  assert.deepEqual(s.types, {});
  assert.equal(s.totalPatterns, 0);
  rm(cwd);
});

test('proceduralStats: counts per type', () => {
  const cwd = tmpCwd();
  recordPattern({ cwd, taskType: 'code', pattern: 'A', success: true });
  recordPattern({ cwd, taskType: 'code', pattern: 'B', success: true });
  recordPattern({ cwd, taskType: 'code', pattern: 'C', success: false });
  recordPattern({ cwd, taskType: 'refactor', pattern: 'D', success: true });
  const s = proceduralStats({ cwd });
  assert.equal(s.types.code.success, 2);
  assert.equal(s.types.code.failed, 1);
  assert.equal(s.types.refactor.success, 1);
  assert.equal(s.totalPatterns, 4);
  rm(cwd);
});

// ---------------------------------------------------------------------------
// detectTaskType: tool usage → task type
// ---------------------------------------------------------------------------

test('detectTaskType: returns "general" for empty input', () => {
  assert.equal(detectTaskType([]), 'general');
  assert.equal(detectTaskType(), 'general');
});

test('detectTaskType: detects code from write_file/edit_file', () => {
  assert.equal(detectTaskType(['read_file', 'edit_file', 'write_file']), 'code');
});

test('detectTaskType: detects research from read-only tools', () => {
  assert.equal(detectTaskType(['read_file', 'grep', 'glob', 'list_dir']), 'research');
});

test('detectTaskType: detects bash from bash tool', () => {
  assert.equal(detectTaskType(['bash', 'read_file']), 'bash');
});

test('detectTaskType: detects planning from todo_write', () => {
  assert.equal(detectTaskType(['todo_write', 'read_file']), 'planning');
});
