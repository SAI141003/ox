import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  startRecording,
  TaskRecorder,
  saveRecording,
  loadRecording,
  listRecordings,
  learnFromRecording,
  getRecordingSummary,
  RECORDINGS_DIR,
} from '../src/task-record.js';

function tmpCwd() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'task-record-'));
}

function rm(cwd) {
  try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
}

test('startRecording creates a recorder with expected fields', () => {
  const cwd = tmpCwd();
  const recorder = startRecording({ taskName: 'do something', cwd });
  assert.equal(typeof recorder.id, 'string');
  assert.ok(recorder.id.length > 0);
  assert.equal(recorder.taskName, 'do something');
  assert.ok(Array.isArray(recorder.events));
  assert.ok(recorder.events.length >= 1);
  const start = recorder.events[0];
  assert.equal(start.t, 'recording-start');
  assert.equal(start.taskName, 'do something');
  assert.ok(typeof start.ts, 'string');
  rm(cwd);
});

test('recordToolStart/recordToolEnd capture correct data', () => {
  const cwd = tmpCwd();
  const recorder = startRecording({ taskName: 'use tools', cwd });
  recorder.recordToolStart('read_file', { path: '/tmp/x.txt' });
  recorder.recordToolEnd('read_file', { content: 'hello' }, false, { ms: 12 });
  recorder.recordError('something broke');
  assert.equal(recorder.events.length, 4);
  const toolStart = recorder.events[1];
  assert.equal(toolStart.t, 'tool-start');
  assert.equal(toolStart.name, 'read_file');
  assert.equal(toolStart.args, JSON.stringify({ path: '/tmp/x.txt' }));
  const toolEnd = recorder.events[2];
  assert.equal(toolEnd.t, 'tool-end');
  assert.equal(toolEnd.name, 'read_file');
  assert.equal(toolEnd.isError, false);
  assert.deepEqual(JSON.parse(toolEnd.result), { content: 'hello' });
  assert.deepEqual(toolEnd.meta, { ms: 12 });
  const errorEv = recorder.events[3];
  assert.equal(errorEv.t, 'error');
  assert.equal(errorEv.error, 'something broke');
  rm(cwd);
});

test('saveRecording writes valid JSONL', () => {
  const cwd = tmpCwd();
  const recorder = startRecording({ taskName: 'save test', cwd });
  recorder.recordFinal('done');
  const file = saveRecording(recorder, cwd);
  assert.ok(fs.existsSync(file));
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n').filter((l) => l.trim());
  assert.ok(lines.length >= 2, 'expected at least recording-start and recording-end');
  const first = JSON.parse(lines[0]);
  assert.equal(first.t, 'recording-start');
  const last = JSON.parse(lines[lines.length - 1]);
  assert.equal(last.t, 'recording-end');
  rm(cwd);
});

test('loadRecording reads it back', () => {
  const cwd = tmpCwd();
  const recorder = startRecording({ taskName: 'load test', cwd });
  recorder.recordFinal('answer');
  const file = saveRecording(recorder, cwd);
  const loaded = loadRecording(file);
  assert.ok(Array.isArray(loaded));
  assert.ok(loaded.length >= 2);
  assert.equal(loaded[0].t, 'recording-start');
  assert.equal(loaded[loaded.length - 1].t, 'recording-end');
  const finalEv = loaded.find((e) => e.t === 'final');
  assert.ok(finalEv);
  assert.equal(finalEv.text, 'answer');
  rm(cwd);
});

test('listRecordings finds saved recordings', () => {
  const cwd = tmpCwd();
  const recorder = startRecording({ taskName: 'listable task', cwd });
  saveRecording(recorder, cwd);
  const recordings = listRecordings(cwd);
  assert.ok(Array.isArray(recordings));
  assert.ok(recordings.length >= 1);
  const found = recordings.find((r) => r.taskName === 'listable task');
  assert.ok(found);
  assert.ok(typeof found.id === 'string');
  assert.ok(found.file.endsWith('.jsonl'));
  assert.equal(typeof found.eventCount, 'number');
  rm(cwd);
});

test('getRecordingSummary returns correct stats', () => {
  const cwd = tmpCwd();
  const recorder = startRecording({ taskName: 'stats', cwd });
  recorder.recordToolStart('read_file', { path: '/tmp/a' });
  recorder.recordToolEnd('read_file', 'ok', false);
  recorder.recordToolStart('edit_file', { path: '/tmp/a' });
  recorder.recordToolEnd('edit_file', 'err', true);
  const data = recorder.stop();
  const summary = getRecordingSummary(data);
  assert.equal(summary.taskName, 'stats');
  assert.equal(summary.toolCalls, 2);
  assert.equal(summary.errors, 1);
  assert.ok(summary.duration >= 0);
  assert.equal(Math.round(summary.successRate), 50);
  rm(cwd);
});

test('learnFromRecording extracts and stores patterns', async () => {
  const cwd = tmpCwd();
  const recorder = startRecording({ taskName: 'learn test', cwd });
  recorder.recordToolStart('read_file', { path: '/tmp/a' });
  recorder.recordToolEnd('read_file', 'ok', false);
  recorder.recordToolStart('edit_file', { path: '/tmp/a' });
  recorder.recordToolEnd('edit_file', 'ok', false);
  recorder.recordFinal('done');
  const file = saveRecording(recorder, cwd);
  const result = await learnFromRecording(file, { cwd, config: {}, target: null });
  assert.ok(typeof result.recorded, 'number');
  assert.ok(typeof result.total, 'number');
  assert.ok(Array.isArray(result.patterns));
  const proceduralPath = path.join(cwd, '.agent', 'procedural.md');
  if (result.total > 0) {
    assert.ok(fs.existsSync(proceduralPath));
    const content = fs.readFileSync(proceduralPath, 'utf8');
    assert.ok(content.length > 0);
  }
  rm(cwd);
});

test('learnFromRecording handles errors gracefully', async () => {
  const cwd = tmpCwd();
  const recorder = startRecording({ taskName: 'error task', cwd });
  recorder.recordError('something broke');
  const file = saveRecording(recorder, cwd);
  const result = await learnFromRecording(file, { cwd, config: {}, target: null });
  assert.ok(typeof result.recorded, 'number');
  assert.ok(typeof result.total, 'number');
  rm(cwd);
});
