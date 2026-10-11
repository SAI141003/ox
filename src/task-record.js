import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { extractPatterns, reflect } from './self-improve.js';
import { recordPattern, detectTaskType } from './procedural-memory.js';

export const RECORDINGS_DIR = '.agent/recordings';

function recordingsDir(cwd) {
  return path.join(cwd || process.cwd(), RECORDINGS_DIR);
}

function timestamp() {
  return new Date().toISOString();
}

function recordingId() {
  return Date.now().toString(36) + '-' + crypto.randomBytes(6).toString('hex');
}

function taskNameToSlug(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'task';
}

export function startRecording({ taskName, cwd }) {
  const id = recordingId();
  const events = [];
  const recorder = new TaskRecorder({ id, taskName, events, cwd: cwd || process.cwd() });
  events.push({ t: 'recording-start', id, taskName, ts: timestamp() });
  return recorder;
}

export class TaskRecorder {
  #id;
  #taskName;
  #events;
  #cwd;
  #startTime;

  constructor({ id, taskName, events, cwd }) {
    this.#id = id;
    this.#taskName = taskName;
    this.#events = events;
    this.#cwd = cwd;
    this.#startTime = Date.now();
  }

  get id() {
    return this.#id;
  }

  get taskName() {
    return this.#taskName;
  }

  get events() {
    return this.#events;
  }

  get cwd() {
    return this.#cwd;
  }

  recordToolStart(name, args) {
    this.#events.push({ t: 'tool-start', name, args: JSON.stringify(args), ts: timestamp() });
  }

  recordToolEnd(name, result, isError, meta) {
    const entry = { t: 'tool-end', name, result: JSON.stringify(result), isError: !!isError, ts: timestamp() };
    if (meta !== undefined && meta !== null) {
      entry.meta = meta;
    }
    this.#events.push(entry);
  }

  recordFinal(text) {
    this.#events.push({ t: 'final', text, ts: timestamp() });
  }

  recordReflection(text) {
    this.#events.push({ t: 'reflection', text, ts: timestamp() });
  }

  recordDecision(decision) {
    this.#events.push({ t: 'decision', decision, ts: timestamp() });
  }

  recordError(error) {
    this.#events.push({ t: 'error', error: String(error), ts: timestamp() });
  }

  recordUsage({ inputTokens, outputTokens, costUsd }) {
    this.#events.push({ t: 'usage', inputTokens, outputTokens, costUsd, ts: timestamp() });
  }

  stop() {
    const data = {
      id: this.#id,
      taskName: this.#taskName,
      events: this.#events,
      startTime: this.#startTime,
      endTime: Date.now(),
    };
    this.#events.push({ t: 'recording-end', id: this.#id, ts: timestamp() });
    return data;
  }
}

export function saveRecording(recorder, cwd) {
  const dir = recordingsDir(cwd || recorder.cwd || process.cwd());
  fs.mkdirSync(dir, { recursive: true });
  const data = recorder.stop();
  const slug = taskNameToSlug(data.taskName);
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(dir, `task-${slug}-${data.id}.jsonl`);
  const lines = data.events.map((ev) => JSON.stringify(ev));
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  return file;
}

export function loadRecording(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  return content
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

export function listRecordings(cwd) {
  const dir = recordingsDir(cwd || process.cwd());
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.startsWith('task-') && f.endsWith('.jsonl'));
  const recordings = [];
  for (const file of files) {
    const fullPath = path.join(dir, file);
    const lines = fs.readFileSync(fullPath, 'utf8').split('\n').filter((l) => l.trim());
    let id = file;
    let taskName = '';
    let date = '';
    if (lines.length > 0) {
      try {
        const first = JSON.parse(lines[0]);
        id = first.id || id;
        taskName = first.taskName || '';
        date = first.ts ? first.ts.slice(0, 19) : '';
      } catch {
        // ignore parse errors on first line
      }
    }
    recordings.push({
      id,
      taskName,
      date,
      eventCount: lines.length,
      file: fullPath,
    });
  }
  recordings.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  return recordings;
}

export async function learnFromRecording(recordingPath, { cwd, config = {}, target } = {}) {
  const events = loadRecording(recordingPath);
  const sessionSummary = {
    task: events.find((e) => e.t === 'recording-start')?.taskName || '',
    outcome: events.some((e) => e.t === 'error') ? 'had errors' : 'completed',
    events,
  };
  const result = await reflect({
    cwd: cwd || process.cwd(),
    config,
    target,
    sessionSummary,
  });
  return result;
}

export function getRecordingSummary(recording) {
  const events = Array.isArray(recording) ? recording : recording.events || [];
  const toolCalls = events.filter((e) => e.t === 'tool-start').length;
  const errors = events.filter((e) => e.t === 'error' || (e.t === 'tool-end' && e.isError)).length;
  const startEv = events.find((e) => e.t === 'recording-start');
  const endEv = events.find((e) => e.t === 'recording-end');
  const startTs = startEv?.ts ? new Date(startEv.ts).getTime() : recording?.startTime || 0;
  const endTs = endEv?.ts ? new Date(endEv.ts).getTime() : recording?.endTime || 0;
  const duration = endTs > startTs ? endTs - startTs : 0;
  const successRate = toolCalls > 0 ? ((toolCalls - errors) / toolCalls) * 100 : 100;
  return {
    taskName: startEv?.taskName || recording?.taskName || '',
    duration,
    toolCalls,
    errors,
    successRate: Math.max(0, Math.min(100, successRate)),
  };
}
