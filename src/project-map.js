// The project map: what the plan says, against what the files show.
//
// Reads PLAN.md in agenttrail's convention (github.com/sodiumsun/agenttrail,
// MIT, © 2026 Kelly Sun — parser and plan checks ported from bin/agenttrail.mjs),
// so a repo set up for agenttrail works here unchanged:
//
//   ## Capture the audio {#capture}
//   files: [src/audio/**]
//   needs: [other-component]
//   - [x] Grab the mic feed {#capture-mic}     [ ] todo  [~] working  [x] done  [!] stuck
//     tech: coreaudio tap                       (the evidence for a done task)
//
// What ox adds: the activity comes from git (changed and untracked files) and
// file times, so it works with any agent — ox, Claude Code, Codex, Cursor —
// without hooks; and every component shows when its files last moved, so work
// on "done" components stays visible.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const NODE_RE = /^##\s+(.+?)\s*\{#([a-z0-9][a-z0-9-]*)\}\s*$/i;
const TASK_RE = /^\s*[-*]\s+\[( |x|~|!)\]\s+(.+?)\s*\{#([a-z0-9][a-z0-9-]*)\}\s*$/i;
const NEEDS_RE = /^needs:\s*\[([^\]]*)\]\s*$/i;
const LINKS_RE = /^links:\s*\[([^\]]*)\]\s*$/i;
const FILES_RE = /^files:\s*\[([^\]]*)\]\s*$/i;
const TECH_RE = /^\s*tech:\s*(.+?)\s*$/i;
const BY_RE = /^\s*by:\s*(.+?)\s*$/i;
const FROM_RE = /^\s*(?:from|horizon):\s*(agent|roadmap|now|backlog)\s*$/i;
const KIND_RE = /^\s*kind:\s*([a-z][a-z-]*)\s*$/i;
const URL_RE = /^\s*url:\s*(\S+)\s*$/i;
const DECISIONS_RE = /^##\s+decisions\s*$/i;
const idList = (s) => String(s).split(',').map((x) => x.trim()).filter(Boolean);

export function parsePlan(text = '') {
  const nodes = [];
  const decisions = [];
  let title = '';
  let cur = null;
  let last = null;
  let inDecisions = false;
  for (const raw of String(text).split('\n')) {
    const line = raw.trimEnd();
    if (!title && /^#\s+/.test(line)) { title = line.replace(/^#\s+/, ''); continue; }
    if (DECISIONS_RE.test(line)) { inDecisions = true; cur = null; last = null; continue; }
    let m;
    if ((m = line.match(NODE_RE))) {
      inDecisions = false;
      cur = { id: m[2], title: m[1], level: 'component', parent: null, needs: [], links: [], files: [], tech: '', by: '', kind: '', url: '', status: 'pending' };
      last = cur; nodes.push(cur); continue;
    }
    if (inDecisions) { if (/^\s*[-*]\s+/.test(line)) decisions.push(line.replace(/^\s*[-*]\s+/, '')); continue; }
    if ((m = line.match(TASK_RE))) {
      const status = m[1] === 'x' ? 'done' : m[1] === '~' ? 'active' : m[1] === '!' ? 'blocked' : 'pending';
      last = { id: m[3], title: m[2], level: 'task', parent: cur ? cur.id : null, needs: [], links: [], tech: '', by: '', src: '', status };
      nodes.push(last); continue;
    }
    if ((m = line.match(TECH_RE))) { if (last) last.tech = m[1]; continue; }
    if ((m = line.match(KIND_RE))) { if (cur) cur.kind = m[1].toLowerCase(); continue; }
    if ((m = line.match(URL_RE))) { if (cur) cur.url = m[1]; continue; }
    if ((m = line.match(BY_RE))) { if (last) last.by = m[1]; continue; }
    if ((m = line.match(FROM_RE))) { if (last) { const v = m[1].toLowerCase(); last.src = v === 'now' ? 'agent' : v === 'backlog' ? 'roadmap' : v; } continue; }
    if ((m = line.match(NEEDS_RE))) { if (cur) cur.needs = idList(m[1]); continue; }
    if ((m = line.match(LINKS_RE))) { if (cur) cur.links = idList(m[1]); continue; }
    if ((m = line.match(FILES_RE))) { if (cur) cur.files = idList(m[1]); continue; }
  }
  // A component's status comes from its tasks; stuck wins, it needs attention.
  for (const c of nodes.filter((n) => n.level === 'component')) {
    const kids = nodes.filter((n) => n.parent === c.id);
    if (kids.some((k) => k.status === 'blocked')) c.status = 'blocked';
    else if (kids.some((k) => k.status === 'active')) c.status = 'active';
    else if (kids.length && kids.every((k) => k.status === 'done')) c.status = 'done';
  }
  return { nodes, decisions, title };
}

export function globToRe(g) {
  if (!/[*?]/.test(g)) return new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&')}(/|$)`);
  const esc = g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '.*');
  return new RegExp(`^${esc}$`);
}

export function lintPlan(parsed, text = '') {
  const out = [];
  const comps = parsed.nodes.filter((n) => n.level === 'component');
  const tasks = parsed.nodes.filter((n) => n.level === 'task');
  if (!text.length || (comps.length === 1 && tasks.length <= 1)) return out;
  const ids = new Set();
  for (const n of parsed.nodes) { if (ids.has(n.id)) out.push(`duplicate id {#${n.id}}`); ids.add(n.id); }
  const compIds = new Set(comps.map((c) => c.id));
  for (const c of comps) {
    for (const e of [...c.needs, ...c.links]) if (!compIds.has(e)) out.push(`${c.id}: points at an unknown component "${e}"`);
    if (!c.files.length) out.push(`${c.id}: no files: globs, so file activity can't be pinned to it`);
  }
  for (const t of tasks) if (t.status === 'done' && !t.tech) out.push(`[x] "${t.title}" cites no evidence (add a tech: line)`);
  if (comps.length > 9) out.push(`${comps.length} components. More than 9 is hard to follow, consider merging`);
  return out.slice(0, 12);
}

// Files that changed: git's view (modified, added, untracked) with their times.
export function changedFiles(cwd, { limit = 200 } = {}) {
  const r = spawnSync('git', ['-C', cwd, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8', timeout: 10_000 });
  if (r.status !== 0) return { git: false, files: [] };
  const files = r.stdout.split('\n').filter(Boolean).slice(0, limit).map((l) => {
    const file = l.slice(3).replace(/^.* -> /, '').replace(/^"|"$/g, '');
    let at = null;
    try { at = fs.statSync(path.join(cwd, file)).mtimeMs; } catch {}
    return { file, state: l.slice(0, 2).trim() || 'M', at };
  });
  files.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  return { git: true, files };
}

export function projectMap(cwd = process.cwd(), { now = Date.now() } = {}) {
  const planPath = path.join(cwd, 'PLAN.md');
  let text = '';
  try { text = fs.readFileSync(planPath, 'utf8'); } catch {}
  const parsed = parsePlan(text);
  const changes = changedFiles(cwd);
  const comps = parsed.nodes.filter((n) => n.level === 'component').map((c) => {
    const res = c.files.map(globToRe);
    const recent = changes.files.filter((f) => res.some((re) => re.test(f.file))).slice(0, 8);
    const touchedAt = recent.reduce((m, f) => Math.max(m, f.at ?? 0), 0) || null;
    return { ...c, tasks: parsed.nodes.filter((n) => n.parent === c.id), recent, touchedAt, live: touchedAt != null && now - touchedAt < 10 * 60_000 };
  });
  const pinned = new Set(comps.flatMap((c) => c.recent.map((f) => f.file)));
  let planMtime = null; try { planMtime = fs.statSync(planPath).mtimeMs; } catch {}
  const newest = changes.files.find((f) => f.file !== 'PLAN.md')?.at ?? null;
  return {
    hasPlan: !!text, title: parsed.title || path.basename(cwd), cwd,
    components: comps, decisions: parsed.decisions, lints: lintPlan(parsed, text),
    changes: changes.files, git: changes.git,
    unplanned: changes.files.filter((f) => !pinned.has(f.file) && f.file !== 'PLAN.md').slice(0, 20),
    // Code moving while the plan sits untouched: the drift that makes a board lie.
    planStale: planMtime && newest && newest - planMtime > 20 * 60_000 && now - newest < 15 * 60_000 ? Math.round((newest - planMtime) / 60_000) : null,
    progress: (() => { const t = parsed.nodes.filter((n) => n.level === 'task'); return { done: t.filter((x) => x.status === 'done').length, total: t.length }; })(),
  };
}
