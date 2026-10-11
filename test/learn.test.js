import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'os';
import path from 'path';

import {
  findRecentSession,
  extractLesson,
  learnFromSession,
} from '../src/learn.js';

// Run with a throwaway HOME so the skill land lands in tmpdir, never in the
// real ~/.agents or ~/.ox.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-learn-'));
const home = path.join(root, 'home');
const sessionsDir = path.join(home, '.ox', 'sessions');
fs.mkdirSync(sessionsDir, { recursive: true });
process.env.HOME = home;

function plantSession(name, events) {
  const file = path.join(sessionsDir, `${name}.jsonl`);
  fs.writeFileSync(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return file;
}

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.HOME;
});

test('findRecentSession returns the newest session on disk', () => {
  plantSession('old', [
    { t: 'user', text: 'help' },
    { t: 'assistant', text: 'ok', tool_calls: [{ id: 'a1', function: { name: 'read_file', arguments: '{}' } }] },
    { t: 'tool-result', callId: 'a1', name: 'read_file', content: 'x = 1' },
  ]);
  plantSession('new', [
    { t: 'user', text: 'refactor' },
    { t: 'assistant', text: 'ok', tool_calls: [{ id: 'b1', function: { name: 'edit_file', arguments: '{"path":"x"}' } }] },
    { t: 'tool-result', callId: 'b1', name: 'edit_file', content: 'edited' },
  ]);
  const latest = findRecentSession({ home });
  assert.equal(path.basename(latest), 'new.jsonl');
});

test('extractLesson returns the most recent successful tool call', () => {
  const events = [
    { t: 'user', text: 'help' },
    { t: 'assistant', text: 'ok', tool_calls: [{ id: 'a1', function: { name: 'read_file', arguments: '{}' } }] },
    { t: 'tool-result', callId: 'a1', name: 'read_file', content: 'x = 1' },
    { t: 'user', text: 'refactor' },
    { t: 'assistant', text: 'ok', tool_calls: [{ id: 'b1', function: { name: 'edit_file', arguments: '{"path":"x"}' } }] },
    { t: 'tool-result', callId: 'b1', name: 'edit_file', content: 'edited' },
  ];
  const lesson = extractLesson(events);
  assert.equal(lesson.task, 'run edit_file');
  assert.equal(lesson.solution, 'edited');
  assert.equal(lesson.verified, true);
});

test('extractLesson skips failed (isError) results', () => {
  const events = [
    { t: 'assistant', text: 'ok', tool_calls: [{ id: 'a1', function: { name: 'read_file', arguments: '{}' } }] },
    { t: 'tool-result', callId: 'a1', name: 'read_file', isError: true, content: 'ENOENT' },
  ];
  assert.equal(extractLesson(events), null);
});

test('learnFromSession writes a SKILL.md through the verified gate', () => {
  const file = plantSession('session', [
    { t: 'user', text: 'help' },
    { t: 'assistant', text: 'ok', tool_calls: [{ id: 'a1', function: { name: 'read_file', arguments: '{}' } }] },
    { t: 'tool-result', callId: 'a1', name: 'read_file', content: 'x = 1' },
  ]);
  const result = learnFromSession({ sessionFile: file });
  assert.equal(result.ok, true);
  assert.match(result.name, /^run-read-file$/);
  assert.ok(result.file.endsWith('run-read-file/SKILL.md'));
  const skillMd = fs.readFileSync(result.file, 'utf8');
  assert.ok(skillMd.includes('name: run-read-file'));
  assert.ok(skillMd.includes('Reusable procedure for run-read-file'));
  assert.ok(skillMd.includes('# run read_file'));
  assert.ok(skillMd.includes('x = 1'));
});
