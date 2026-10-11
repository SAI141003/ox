import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { HISTORY_STATUS, noteUnavailableHistory } from './session.js';

export const SESSION_INDEX_SCHEMA_VERSION = '1.0.0';

function indexFile() {
  return join(homedir(), '.ox', 'sessions', 'index.json');
}

function terms(value) {
  return String(value ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function queryTerms(value) {
  return String(value ?? '').toLowerCase().match(/-?[\p{L}\p{N}]+/gu) ?? [];
}

function textOf(value, output = []) {
  if (value === null || value === undefined) return output;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    output.push(String(value));
  } else if (Array.isArray(value)) {
    for (const item of value) textOf(item, output);
  } else if (typeof value === 'object') {
    for (const item of Object.values(value)) textOf(item, output);
  }
  return output;
}

function normalizeSession(session = {}) {
  const text = textOf(session).join(' ');
  const messages = Array.isArray(session.messages) ? session.messages : [{ role: 'system', content: text }];
  return {
    id: String(session.id || session.session_id || randomUUID()),
    timestamp: session.timestamp ?? Date.now(),
    messages,
    metadata: session.metadata && typeof session.metadata === 'object' ? { ...session.metadata } : {},
    text,
    tokenCount: terms(text).length,
  };
}

function removeSession(state, id) {
  const session = state.sessions.get(id);
  if (!session) return;
  for (const term of new Set(terms(session.text))) {
    const postings = state.postings.get(term);
    if (!postings) continue;
    postings.delete(id);
    if (!postings.size) state.postings.delete(term);
  }
  state.sessions.delete(id);
  state.totalTokens = Math.max(0, state.totalTokens - session.tokenCount);
}

function snippet(text, queryTerms) {
  const cleaned = String(text).replace(/\s+/g, ' ').trim();
  const lower = cleaned.toLowerCase();
  const position = queryTerms.map((term) => lower.indexOf(term)).filter((index) => index >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, position - 80);
  const excerpt = cleaned.slice(start, start + 240);
  return `${start ? '…' : ''}${excerpt}${start + 240 < cleaned.length ? '…' : ''}`;
}

export function createSessionIndex(cwd = process.cwd()) {
  const file = indexFile();
  const state = {
    cwd,
    file,
    sessions: new Map(),
    postings: new Map(),
    totalTokens: 0,
    lastIndexed: null,
    lastLoadStatus: null,
    lastLoadReason: null,
    index(session) {
      return indexSession(state, session);
    },
    search(query, limit = 20) {
      return searchSessions(state, query, limit);
    },
    scroll(sessionId, offset = 0) {
      const session = state.sessions.get(sessionId);
      if (!session) return null;
      const start = Math.max(0, Number(offset) || 0);
      return { session_id: session.id, offset: start, limit: 20, messages: session.messages.slice(start, start + 20) };
    },
    browse(sessionId) {
      const session = state.sessions.get(sessionId);
      return session ? { ...session, messages: [...session.messages] } : null;
    },
    save() {
      mkdirSync(join(homedir(), '.ox', 'sessions'), { recursive: true });
      const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
      writeFileSync(temp, `${JSON.stringify({
        schemaVersion: SESSION_INDEX_SCHEMA_VERSION,
        sessions: [...state.sessions.values()],
        lastIndexed: state.lastIndexed,
      })}\n`);
      renameSync(temp, file);
    },
    load() {
      state.sessions.clear();
      state.postings.clear();
      state.totalTokens = 0;
      state.lastIndexed = null;
      state.lastLoadStatus = HISTORY_STATUS.EMPTY;
      state.lastLoadReason = null;
      if (!existsSync(file)) return 0;
      // A corrupt index used to read as "zero indexed sessions" with no signal
      // at all. Both failure shapes below now report 'unavailable' and record
      // the gap so the system prompt says history is unreadable.
      const fail = (reason) => {
        state.lastLoadStatus = HISTORY_STATUS.UNAVAILABLE;
        state.lastLoadReason = reason;
        noteUnavailableHistory(file, reason);
        return 0;
      };
      try {
        const value = JSON.parse(readFileSync(file, 'utf8'));
        const sessions = Array.isArray(value) ? value : value.sessions;
        if (!Array.isArray(sessions)) return fail('session index has no sessions array');
        for (const session of sessions) indexSession(state, session);
        state.lastIndexed = value.lastIndexed ?? state.lastIndexed;
        state.lastLoadStatus = state.sessions.size ? HISTORY_STATUS.OK : HISTORY_STATUS.EMPTY;
        return state.sessions.size;
      } catch (err) {
        return fail(`session index unreadable: ${err?.message ?? err}`);
      }
    },
    stats() {
      return getIndexStats(state, file);
    },
    loadStatus() {
      return { status: state.lastLoadStatus, reason: state.lastLoadReason };
    },
  };
  state.load();
  return state;
}

export function indexSession(idx, session = {}) {
  const normalized = normalizeSession(session);
  removeSession(idx, normalized.id);
  idx.sessions.set(normalized.id, normalized);
  const sessionTerms = terms(normalized.text);
  for (const term of new Set(sessionTerms)) {
    if (!idx.postings.has(term)) idx.postings.set(term, new Map());
    const count = sessionTerms.filter((word) => word === term).length;
    idx.postings.get(term).set(normalized.id, count);
  }
  idx.totalTokens += normalized.tokenCount;
  idx.lastIndexed = normalized.timestamp;
  return { session_id: normalized.id, tokens: normalized.tokenCount };
}

export function searchSessions(idx, query = '', limit = 20) {
  const requested = [...new Set(queryTerms(query))];
  if (!requested.length) return [];
  const negative = new Set();
  const positive = requested.filter((term) => {
    if (term.startsWith('-')) {
      negative.add(term.slice(1));
      return false;
    }
    return true;
  });
  const scores = new Map();
  const totalDocuments = Math.max(1, idx.sessions.size);
  for (const term of positive) {
    const postings = idx.postings.get(term);
    if (!postings) continue;
    const documentFrequency = postings.size;
    const inverseFrequency = Math.log(1 + (totalDocuments - documentFrequency + 0.5) / (documentFrequency + 0.5));
    for (const [sessionId, frequency] of postings) {
      const documentLength = idx.sessions.get(sessionId)?.tokenCount ?? 1;
      const score = (frequency * 2.2 / (frequency + 1.2 * (0.25 + 0.75 * documentLength))) * (inverseFrequency + 1);
      scores.set(sessionId, (scores.get(sessionId) ?? 0) + score);
    }
  }
  return [...scores]
    .filter(([sessionId]) => ![...negative].some((term) => idx.postings.get(term)?.has(sessionId)))
    .map(([sessionId, score]) => {
      const session = idx.sessions.get(sessionId);
      return { session_id: sessionId, score: Number(score.toFixed(6)), snippet: snippet(session.text, positive), timestamp: session.timestamp };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, Math.floor(Number(limit) || 20)));
}

export function getIndexStats(idx, file = idx.file) {
  return {
    totalSessions: idx.sessions.size,
    totalTokens: idx.totalTokens,
    indexSize: idx.postings.size,
    postingEntries: [...idx.postings.values()].reduce((size, postings) => size + postings.size, 0),
    lastIndexed: idx.lastIndexed,
    storageBytes: existsSync(file) ? statSync(file).size : 0,
  };
}
// Status of the last index load: 'ok' | 'empty' | 'unavailable'.
export function indexLoadStatus(idx) {
  return { status: idx?.lastLoadStatus ?? HISTORY_STATUS.EMPTY, reason: idx?.lastLoadReason ?? null };
}
export { getIndexStats as getStats };
