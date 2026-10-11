import fs from 'node:fs';
import path from 'node:path';
import { listCheckpoints } from './checkpoints.js';
import { rewindPoints, latestSessionFile } from './session.js';
import { listEpisodes } from './memory.js';
import { c } from './ui.js';

const CHECKPOINT_DIR = path.join('.agent', 'checkpoints');
const MARKS = { checkpoint: '●', rewind: '○', episode: '◆' };

function isoOrNull(v) {
  const ms = Date.parse(String(v ?? ''));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

function parseCheckpointMd(text, file) {
  const pick = (re) => text.match(re)?.[1]?.trim() ?? '';
  const goal = pick(/^- Goal:\s*(.+)$/m) || path.basename(file, '.md');
  const status = pick(/^- Status:\s*(.+)$/m);
  const t = isoOrNull(pick(/^- Date:\s*(.+)$/m));
  if (!t) return null;
  const tok = text.match(/^- Tokens in-out:\s*(\d+)\s*\/\s*(\d+)\s*$/m);
  const cost = text.match(/^- Cost USD:\s*\$([\d.]+)/m);
  return {
    t,
    kind: 'checkpoint',
    label: goal,
    detail: status,
    costUsd: cost ? num(cost[1]) : null,
    tokensIn: tok ? Number(tok[1]) : 0,
    tokensOut: tok ? Number(tok[2]) : 0,
    ref: path.basename(file),
  };
}

function milestoneEvents(cwd) {
  const dir = path.join(cwd, CHECKPOINT_DIR);
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch {}
  const out = [];
  for (const f of files) {
    try {
      const ev = parseCheckpointMd(fs.readFileSync(path.join(dir, f), 'utf8'), f);
      if (ev) out.push(ev);
    } catch {}
  }
  return out;
}

function manifestEvents(cwd) {
  let rows = [];
  try {
    rows = listCheckpoints({ cwd });
  } catch {}
  return rows
    .map((e) => ({
      t: isoOrNull(e.timestamp),
      kind: 'checkpoint',
      label: e.turn != null && e.turn !== '' ? `turn ${e.turn}` : e.id,
      detail: `${e.fileCount} files · ${e.size}`,
      costUsd: null,
      tokensIn: 0,
      tokensOut: 0,
      ref: e.id,
    }))
    .filter((e) => e.t);
}

function rewindEvents(sessionFile) {
  if (!sessionFile) return [];
  let pts = [];
  try {
    pts = rewindPoints(sessionFile);
  } catch {}
  if (!pts.length) return [];
  const tsMap = new Map();
  try {
    for (const line of fs.readFileSync(sessionFile, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line);
        if (ev?.t === 'rewind-point') tsMap.set(String(ev.id), ev.ts ?? null);
      } catch {}
    }
  } catch {}
  let mtime = null;
  try {
    mtime = fs.statSync(sessionFile).mtime.toISOString();
  } catch {}
  return pts
    .map((p) => {
      const t = isoOrNull(tsMap.get(String(p.id))) ?? mtime;
      if (!t) return null;
      return {
        t,
        kind: 'rewind',
        label: String(p.label ?? ''),
        detail: '',
        costUsd: null,
        tokensIn: 0,
        tokensOut: 0,
        ref: `rw-${p.id}`,
      };
    })
    .filter(Boolean);
}

function episodeEvents(cwd) {
  let eps = [];
  try {
    eps = listEpisodes(cwd);
  } catch {}
  return eps
    .map((e) => ({
      t: isoOrNull(`${e.date ?? ''}T00:00:00.000Z`),
      kind: 'episode',
      label: e.goal || '(no goal recorded)',
      detail: e.outcome || '',
      costUsd: null,
      tokensIn: 0,
      tokensOut: 0,
      ref: e.file,
    }))
    .filter((e) => e.t);
}

export function buildTimeline(cwd, { limit = 20, sessionFile } = {}) {
  const root = path.resolve(cwd ?? process.cwd());
  let file = sessionFile ?? null;
  if (!file) {
    try {
      file = latestSessionFile(root);
    } catch {}
  }
  const events = [
    ...manifestEvents(root),
    ...milestoneEvents(root),
    ...rewindEvents(file),
    ...episodeEvents(root),
  ];
  events.sort((a, b) => Date.parse(b.t) - Date.parse(a.t));
  const n = Number(limit);
  const cap = Number.isFinite(n) && n > 0 ? Math.floor(n) : 20;
  return events.slice(0, cap);
}

function fmtTime(t) {
  return String(t ?? '').replace(/^.*T/, '').replace(/\.\d+Z$/, '');
}

function fmtTokens(n) {
  return n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`;
}

export function formatTimeline(events, { max = 20 } = {}) {
  const list = Array.isArray(events) ? events : [];
  const m = Number(max);
  const shown = list.slice(0, Number.isFinite(m) && m > 0 ? Math.floor(m) : 20);
  const rule = c.dim('  ' + '─'.repeat(37));
  const lines = [c.bold('  TIME TRAVEL TIMELINE (newest first)'), rule];
  shown.forEach((e, i) => {
    const kind = String(e?.kind ?? '');
    const mark = MARKS[kind] ?? '·';
    const meta = [];
    if (kind === 'rewind') meta.push(`point ${e.ref ?? '?'}`);
    if (e?.label) meta.push(e.label);
    if (e?.costUsd != null) meta.push(`$${e.costUsd.toFixed(4)}`);
    const tok = (e?.tokensIn ?? 0) + (e?.tokensOut ?? 0);
    if (tok > 0) meta.push(`${fmtTokens(tok)} tok`);
    lines.push(`  ${mark} ${fmtTime(e?.t)}  ${kind.padEnd(10)} ${meta.join(' · ')}`.trimEnd());
    if (e?.detail) {
      const lead = i === shown.length - 1 ? ' ' : '│';
      lines.push(`  ${lead}           "${e.detail}"`);
    }
  });
  lines.push(rule);
  const total = round6(shown.reduce((s, e) => s + (e?.costUsd ?? 0), 0));
  lines.push(c.dim(`  n=${shown.length} · total $${total.toFixed(2)} · rewind to any point with /rewind <id>`));
  return lines.join('\n');
}

export function costPerCheckpoint(events) {
  const items = (Array.isArray(events) ? events : [])
    .filter((e) => e?.kind === 'checkpoint' && e.costUsd != null)
    .map((e) => ({ label: e.label, costUsd: e.costUsd }));
  return { items, total: round6(items.reduce((s, i) => s + i.costUsd, 0)) };
}

export function timelineStats(events) {
  const list = Array.isArray(events) ? events : [];
  const byKind = (k) => list.filter((e) => e?.kind === k).length;
  const totalCostUsd = round6(list.reduce((s, e) => s + (e?.costUsd ?? 0), 0));
  const totalTokens = list.reduce((s, e) => s + (e?.tokensIn ?? 0) + (e?.tokensOut ?? 0), 0);
  const times = list.map((e) => Date.parse(e?.t)).filter(Number.isFinite);
  const spanMs = times.length > 1 ? Math.max(...times) - Math.min(...times) : 0;
  return {
    count: list.length,
    checkpoints: byKind('checkpoint'),
    rewindPoints: byKind('rewind'),
    episodes: byKind('episode'),
    totalCostUsd,
    totalTokens,
    spanMs,
  };
}
