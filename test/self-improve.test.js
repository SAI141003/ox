import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  buildReflectionPrompt,
  generateCritique,
  extractPatterns,
  reflect,
} from '../src/self-improve.js';
import { SelfImproveCycle } from '../src/self-improve-loop.js';

function tmpCwd() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'self-improve-'));
}
function rm(cwd) { try { fs.rmSync(cwd, { recursive: true }); } catch {} }

test('buildReflectionPrompt: includes tool, args, error, and attempts', () => {
  const p = buildReflectionPrompt({
    failure: { tool: 'bash', args: { command: 'rm foo' }, error: 'permission denied' },
    attempts: 2,
  });
  assert.match(p, /self-reflection/);
  assert.match(p, /bash/);
  assert.match(p, /permission denied/);
  assert.match(p, /Attempts: 2/);
});

test('buildReflectionPrompt: includes recent history', () => {
  const p = buildReflectionPrompt({
    failure: { tool: 'edit_file', error: 'not found' },
    history: ['read src/foo.js', 'tried to edit nonexistent line'],
    attempts: 1,
  });
  assert.match(p, /read src\/foo\.js/);
  assert.match(p, /nonexistent line/);
});

test('buildReflectionPrompt: handles missing fields gracefully', () => {
  const p = buildReflectionPrompt({ failure: {}, attempts: 0 });
  assert.match(p, /unknown/);
});

test('generateCritique: uses heuristic when no model is available', async () => {
  const r = await generateCritique({
    failure: { tool: 'bash', error: 'permission denied' },
    attempts: 1,
    config: {},
    target: null,
    cwd: process.cwd(),
  });
  assert.ok(r.critique);
  assert.ok(r.suggestedApproach);
  assert.match(r.critique, /permission/i);
});

test('generateCritique: after 3+ attempts suggests stopping', async () => {
  const r = await generateCritique({
    failure: { tool: 'bash', error: 'some error' },
    attempts: 4,
    config: {},
    target: null,
    cwd: process.cwd(),
  });
  assert.match(r.suggestedApproach, /stop|report|blocker/i);
});

test('generateCritique: not-found error suggests verification', async () => {
  const r = await generateCritique({
    failure: { tool: 'read_file', error: 'file not found' },
    attempts: 1,
    config: {},
    target: null,
    cwd: process.cwd(),
  });
  assert.match(r.suggestedApproach, /list_dir|glob|typo|verify/i);
});

test('generateCritique: timeout error suggests reducing scope', async () => {
  const r = await generateCritique({
    failure: { tool: 'bash', error: 'command timed out' },
    attempts: 1,
    config: {},
    target: null,
    cwd: process.cwd(),
  });
  assert.match(r.suggestedApproach, /scope|smaller|timeout|break/i);
});

test('generateCritique: generic error suggests varying input', async () => {
  const r = await generateCritique({
    failure: { tool: 'edit_file', error: 'syntax error' },
    attempts: 1,
    config: {},
    target: null,
    cwd: process.cwd(),
  });
  assert.ok(r.critique);
  assert.ok(r.suggestedApproach);
});

test('extractPatterns: extracts read-before-edit pattern', async () => {
  const events = [
    { t: 'tool-start', name: 'read_file' },
    { t: 'tool-end', name: 'read_file', isError: false },
    { t: 'tool-start', name: 'edit_file' },
    { t: 'tool-end', name: 'edit_file', isError: false },
  ];
  const patterns = await extractPatterns({ sessionEvents: events, config: {}, target: null, cwd: process.cwd() });
  const readEdit = patterns.find((p) => p.pattern.includes('Read the file before editing'));
  assert.ok(readEdit, 'expected read-before-edit pattern');
  assert.equal(readEdit.type, 'success');
});

test('extractPatterns: extracts grep-before-read pattern', async () => {
  const events = [
    { t: 'tool-start', name: 'grep' },
    { t: 'tool-end', name: 'grep', isError: false },
    { t: 'tool-start', name: 'read_file' },
    { t: 'tool-end', name: 'read_file', isError: false },
  ];
  const patterns = await extractPatterns({ sessionEvents: events, config: {}, target: null, cwd: process.cwd() });
  const grepRead = patterns.find((p) => p.pattern.includes('grep'));
  assert.ok(grepRead);
  assert.equal(grepRead.taskType, 'research');
});

test('extractPatterns: returns empty for empty events', async () => {
  const patterns = await extractPatterns({ sessionEvents: [], config: {}, target: null, cwd: process.cwd() });
  assert.ok(Array.isArray(patterns));
});

test('extractPatterns: detects write_file for new files', async () => {
  const events = [
    { t: 'tool-start', name: 'write_file' },
    { t: 'tool-end', name: 'write_file', isError: false },
  ];
  const patterns = await extractPatterns({ sessionEvents: events, config: {}, target: null, cwd: process.cwd() });
  const writeP = patterns.find((p) => p.pattern.includes('write_file'));
  assert.ok(writeP);
});

test('reflect: records extracted patterns to procedural memory', async () => {
  const cwd = tmpCwd();
  const events = [
    { t: 'tool-start', name: 'read_file' },
    { t: 'tool-end', name: 'read_file', isError: false },
    { t: 'tool-start', name: 'edit_file' },
    { t: 'tool-end', name: 'edit_file', isError: false },
  ];
  const result = await reflect({
    cwd,
    config: {},
    target: null,
    sessionSummary: { task: 'fix bug', outcome: 'completed', events },
  });
  assert.ok(result.total > 0);
  const f = path.join(cwd, '.agent', 'procedural.md');
  assert.ok(fs.existsSync(f));
  const content = fs.readFileSync(f, 'utf8');
  assert.match(content, /Read the file before editing/);
  rm(cwd);
});

test('reflect: handles empty session gracefully', async () => {
  const cwd = tmpCwd();
  const result = await reflect({
    cwd,
    config: {},
    target: null,
    sessionSummary: { task: '', outcome: '', events: [] },
  });
  assert.equal(typeof result.recorded, 'number');
  rm(cwd);
});

test('SelfImproveCycle.apply: safe proposal with no file/diff is pending-implementation', () => {
  const cycle = new SelfImproveCycle({}, {});
  const proposals = [{ id: 'p1', safe: true, action: 'test action' }];
  const result = cycle.apply(proposals);
  return result.then(applied => {
    assert.equal(applied.length, 1);
    assert.equal(applied[0].status, 'pending-implementation');
    assert.notEqual(applied[0].status, 'applied');
    assert.ok(applied[0].appliedAt);
  });
});

test('SelfImproveCycle.verify: without verifyFn, pending-implementation is not verified', () => {
  const cycle = new SelfImproveCycle({}, {});
  const results = [{ id: 'p1', status: 'pending-implementation' }];
  const result = cycle.verify(results);
  return result.then(verified => {
    assert.equal(verified.length, 1);
    assert.equal(verified[0].verified, false);
    assert.notEqual(verified[0].verified, true);
    assert.equal(verified[0].verification, 'unverified');
  });
});

test('SelfImproveCycle.verify: without verifyFn, applied is not verified either', () => {
  const cycle = new SelfImproveCycle({}, {});
  const results = [{ id: 'p1', status: 'applied' }];
  const result = cycle.verify(results);
  return result.then(verified => {
    assert.equal(verified.length, 1);
    assert.equal(verified[0].verified, false);
    assert.notEqual(verified[0].verified, true);
    assert.equal(verified[0].verification, 'unverified');
  });
});
