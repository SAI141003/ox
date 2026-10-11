// /learn -- distill a completed session into a reusable skill.
//
// The transcript is the evidence. A tool call that actually reached the model
// and returned a non-error result is promoted into a reusable skill through the
// same evidence gate (verified=true) used by `ox episode promote`. A failed call
// (isError=true) or a call that never happened is intentionally skipped.
//
// Reads-only: nothing is rewritten in the session transcript.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { homedir } from 'node:os';
import { createMemoryStore, autoCreateSkill } from './memory-learn.js';
import { loadSessionWithStatus } from './session.js';

// Locate the most recently modified session on disk. Returns an absolute path,
// or null when no session exists.
export function findRecentSession({ home = homedir() } = {}) {
  const dir = path.join(home, '.ox', 'sessions');
  let best = null;
  let bestMtime = -Infinity;
  try {
    const entries = fs.readdirSync(dir);
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue;
      const full = path.join(dir, entry);
      const st = fs.statSync(full);
      if (st.mtimeMs > bestMtime) {
        bestMtime = st.mtimeMs;
        best = full;
      }
    }
  } catch {
    return null;
  }
  return best;
}

// Extract the last successful tool call from a transcript.
//
// Returns { task, solution, verified } when a learnable call exists, otherwise
// null. `verified` is always true here because the gate is entered only when a
// non-error tool result is found in the transcript itself.
export function extractLesson(sessionEvents) {
  // Collect the non-error tool results, keyed by call id.
  const results = new Map();
  for (const ev of sessionEvents) {
    if (ev.t === 'tool-result' && ev.callId != null && !ev.isError) {
      results.set(ev.callId, ev);
    }
  }
  // Walk the transcript newest-first so the most recent successful call wins.
  for (let i = sessionEvents.length - 1; i >= 0; i--) {
    const ev = sessionEvents[i];
    if (ev.t === 'assistant' && Array.isArray(ev.tool_calls)) {
      for (let j = ev.tool_calls.length - 1; j >= 0; j--) {
        const tc = ev.tool_calls[j];
        const name = tc.function?.name;
        if (name && results.has(tc.id)) {
          const result = results.get(tc.id);
          return {
            task: `run ${name}`,
            solution: String(result.content ?? '').trim() || '[tool executed, no output]',
            verified: true,
          };
        }
      }
    }
  }
  return null;
}

export function learnFromSession({ sessionFile, cwd = process.cwd(), home = homedir() } = {}) {
  const loaded = loadSessionWithStatus(sessionFile);
  if (loaded.status !== 'ok') {
    return { ok: false, kind: 'no-session', message: `cannot read session: ${sessionFile}` };
  }
  const lesson = extractLesson(loaded.messages);
  if (!lesson) {
    return { ok: false, kind: 'not-learned', message: 'no successful (non-error) tool call in this session' };
  }
  const store = createMemoryStore(cwd);
  const skill = autoCreateSkill(store, lesson.task, lesson.solution, { verified: true });
  return {
    ok: true,
    name: skill.name,
    file: skill.file,
    message: `learnt "${lesson.task}" -> ${skill.name}`,
  };
}
