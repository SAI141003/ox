import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { screenReadLines, screenReadTexts } from './memory.js';
import { pluginSkillRoots } from './plugins.js';

export const MAX_INDEX_SKILLS = 25;
export const MAX_DESCRIPTION_CHARS = 1024;

export const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function skillScanDirs({ cwd = process.cwd(), home = os.homedir() } = {}) {
  return [
    path.join(path.resolve(home), '.agents', 'skills'),
    path.join(path.resolve(cwd), '.agents', 'skills'),
    path.join(path.resolve(home), '.claude', 'skills'),
    path.join(path.resolve(cwd), '.claude', 'skills'),
  ];
}

function parseScalar(raw) {
  let v = String(raw ?? '').trim();
  if (!v || v.startsWith('#')) return '';
  const hash = v.search(/\s#/);
  if (hash !== -1) v = v.slice(0, hash).trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    v = v.slice(1, -1);
  }
  return v.trim();
}

export function parseYamlish(text) {
  const out = {};
  let container = null;
  let containerKey = null;
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    if (rawLine.trimStart().startsWith('#')) continue;
    const indent = rawLine.length - rawLine.trimStart().length;
    const line = rawLine.trim();

    if (line.startsWith('- ') || line === '-') {
      const item = line === '-' ? '' : parseScalar(line.slice(2));
      const key = containerKey;
      if (!key) continue;
      const cur = out[key];
      if (Array.isArray(cur)) cur.push(item);
      else if (cur === undefined || (cur && typeof cur === 'object' && Object.keys(cur).length === 0)) {
        out[key] = [item];
      } else if (typeof cur === 'string') {
        out[key] = [cur, item];
      }
      continue;
    }

    if (indent > 0) {
      const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (!m || !containerKey) continue;
      if (container && typeof container === 'object' && !Array.isArray(container)) {
        container[m[1]] = parseScalar(m[2]);
      } else if (out[containerKey] === undefined || typeof out[containerKey] === 'string') {
        if (typeof out[containerKey] !== 'object' || out[containerKey] === null) out[containerKey] = {};
        out[containerKey][m[1]] = parseScalar(m[2]);
      }
      continue;
    }

    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const val = parseScalar(m[2]);
    containerKey = key;
    if (val === '') {
      if (out[key] === undefined) out[key] = {};
      container = out[key] && typeof out[key] === 'object' && !Array.isArray(out[key]) ? out[key] : null;
    } else {
      out[key] = val;
      container = null;
    }
  }
  return out;
}

function splitFrontmatter(rawText) {
  const lines = String(rawText ?? '').split(/\r?\n/);
  if ((lines[0] ?? '').trim() !== '---') return null;
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) return null;
  return { frontmatter: lines.slice(1, close).join('\n'), body: lines.slice(close + 1).join('\n') };
}

function extractBody(rawText) {
  const parts = splitFrontmatter(rawText);
  if (!parts) return '';
  return parts.body.replace(/^\n+/, '').replace(/\s+$/, '');
}

function listFileNames(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

export function parseSkillMd(rawText, skillMdPath) {
  const parts = splitFrontmatter(rawText);
  if (!parts) return { ok: false, warning: 'SKILL.md must start with a --- frontmatter fence and close it' };
  let meta;
  try {
    meta = parseYamlish(parts.frontmatter);
  } catch (e) {
    return { ok: false, warning: `frontmatter unparseable: ${String((e && e.message) || e)}` };
  }
  const name = typeof meta.name === 'string' ? meta.name.trim() : '';
  const descriptionRaw = typeof meta.description === 'string' ? meta.description : '';
  const description = descriptionRaw.replace(/\s+/g, ' ').trim();
  if (!name) return { ok: false, warning: 'missing name in frontmatter' };
  if (!NAME_RE.test(name)) {
    return { ok: false, warning: `invalid name '${name.slice(0, 40)}' (must be lowercase [a-z0-9-])` };
  }
  if (!description) return { ok: false, warning: 'missing description in frontmatter' };
  if (description.length > MAX_DESCRIPTION_CHARS) {
    return { ok: false, warning: `description too long (${description.length} > ${MAX_DESCRIPTION_CHARS} chars)` };
  }
  const absPath = path.resolve(String(skillMdPath ?? 'unknown/SKILL.md'));
  const dir = path.dirname(absPath);
  const metadata =
    meta.metadata && typeof meta.metadata === 'object' && !Array.isArray(meta.metadata) ? meta.metadata : {};
  const skill = {
    name,
    description,
    body: extractBody(rawText),
    path: absPath,
    dir,
    metadata,
    trigger: metadata.trigger === 'command',
    scripts: listFileNames(path.join(dir, 'scripts')),
    references: listFileNames(path.join(dir, 'references')),
  };
  return { ok: true, skill };
}

// Read-side screen for the SKILL INDEX.
//
// `description` (and `name`) come from SKILL.md frontmatter in whatever
// directory a user, a plugin or a cloned repo dropped a skill into -- it is
// third-party text, and the index is re-injected into '# SKILLS' on EVERY turn.
// So a skill whose frontmatter carries a credential shape or an injection
// payload replays that payload into every later prompt, the same leak class
// .agent/MEMORY.md already closes.
//
// The shared screen from src/memory.js decides; this module only decides how to
// render the verdict, and the counters + OX_AUDIT ledger land through
// screenReadTexts, so no pattern table or notice wording is re-derived here.
// Only the frontmatter is screened: the path in the line comes from the
// filesystem layout the user already sees in `ox skill ls`, and it is what
// makes a withheld skill actionable ("inspect THIS one").
//
// When nothing is withheld the returned string is byte-identical to what it has
// always been, so the common path costs ZERO extra bytes per turn.
const SKILL_SCREEN_SOURCE = 'SKILL.md frontmatter';

function withheldSkillLine(skill) {
  return (
    '- [withheld skill] — credential or prompt-injection shape, screened on read. ' +
    'The SKILL.md on disk is UNCHANGED and was not shown here — inspect and remove it yourself: ' +
    `${skill?.path ?? '(unknown path)'}`
  );
}

export function renderSkillIndex(skills, cap = MAX_INDEX_SKILLS) {
  const list = Array.isArray(skills) ? skills : [];
  // Screen the CAPPED slice: an entry past the cap is never injected, so it must
  // not inflate the withheld count either.
  const capped = list.slice(0, Math.max(0, cap));
  const { flags, withheld } = screenReadTexts(
    capped.map((s) => `${s?.name ?? ''} ${s?.description ?? ''}`),
    SKILL_SCREEN_SOURCE,
    'skill index'
  );
  if (!withheld) {
    return capped.map((s) => `- ${s.name} — ${s.description} (read path to invoke: ${s.path})`).join('\n');
  }
  const lines = [];
  for (let i = 0; i < capped.length; i++) {
    lines.push(flags[i] ? `- ${capped[i].name} — ${capped[i].description} (read path to invoke: ${capped[i].path})` : withheldSkillLine(capped[i]));
  }
  return lines.join('\n');
}

// ox's own skills ship in <repo>/skills. Scanned FIRST so that any user or
// project skill with the same name overrides the built-in one. OX_NO_BUILTIN_SKILLS=1
// turns them off (tests that count skills exactly use it).
export const BUILTIN_SKILLS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills');

export function discoverSkills({ cwd = process.cwd(), home = os.homedir(), builtin = process.env.OX_NO_BUILTIN_SKILLS !== '1' } = {}) {
  const warnings = [];
  const byName = new Map();
  const roots = builtin ? [BUILTIN_SKILLS_DIR, ...skillScanDirs({ cwd, home })] : skillScanDirs({ cwd, home });
  for (const dir of roots) {
    let dirents;
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of dirents) {
      if (!ent.isDirectory()) continue;
      const skillMd = path.join(dir, ent.name, 'SKILL.md');
      let raw;
      try {
        raw = fs.readFileSync(skillMd, 'utf8');
      } catch {
        continue;
      }
      const parsed = parseSkillMd(raw, skillMd);
      if (!parsed.ok) {
        warnings.push(`${skillMd}: skipped — ${parsed.warning}`);
        continue;
      }
      byName.set(parsed.skill.name, dir === BUILTIN_SKILLS_DIR ? { ...parsed.skill, builtin: true } : parsed.skill);
    }
  }
  // Plugin skills (src/plugins.js): namespaced `<plugin>:<skill>` so a plugin
  // can never shadow one of your own, and read-only (no usage sidecars).
  for (const { plugin, dir } of pluginSkillRoots(home)) {
    let dirents;
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of dirents) {
      if (!ent.isDirectory()) continue;
      const skillMd = path.join(dir, ent.name, 'SKILL.md');
      let raw;
      try {
        raw = fs.readFileSync(skillMd, 'utf8');
      } catch {
        continue;
      }
      const parsed = parseSkillMd(raw, skillMd);
      if (!parsed.ok) {
        warnings.push(`${skillMd}: skipped — ${parsed.warning}`);
        continue;
      }
      const name = `${plugin}:${parsed.skill.name}`;
      if (!byName.has(name)) byName.set(name, { ...parsed.skill, name, plugin });
    }
  }
  const skills = [...byName.values()];
  skills.warnings = warnings;
  skills.index = renderSkillIndex(skills);
  return skills;
}

export function readSkillBody(skillOrName, list = []) {
  let skill = null;
  if (skillOrName && typeof skillOrName === 'object') {
    skill = skillOrName;
  } else if (typeof skillOrName === 'string') {
    const q = skillOrName.trim().toLowerCase();
    const pool = Array.isArray(list) ? list : [];
    skill = pool.find((s) => s && typeof s.name === 'string' && s.name.toLowerCase() === q) ?? null;
  }
  if (!skill || typeof skill.path !== 'string') return null;
  let body = null;
  if (typeof skill.body === 'string' && skill.body) body = skill.body;
  else {
    try {
      body = extractBody(fs.readFileSync(skill.path, 'utf8'));
    } catch {}
  }
  if (body == null) return null;
  const dir = skill.dir ?? path.dirname(skill.path);
  // Plugin skill folders belong to the plugin (often Claude Code's own cache).
  if (!skill.plugin && !skill.builtin) {
    try {
      recordSkillUse(skill.name ?? '', dir);
    } catch {}
  }
  return body;
}

// ---- read-side screen for a SKILL BODY --------------------------------------
//
// `renderSkillIndex` above screens the frontmatter, but the BODY is a separate
// path with its own channel: `/skill <name>` pushes it into `messages[]` as a
// user message, so every line of it reaches the provider on this turn and is
// replayed for the rest of the session. A SKILL.md body is third-party text
// from a cloned repo, a plugin, or a teammate's `.agents/skills/` drop -- the
// same trust level as the frontmatter, and a far larger surface.
//
// The shared screen from src/memory.js decides; this module only decides how to
// report the verdict, so no pattern table or notice wording is re-derived here.
// COUNT and OX_AUDIT ledger rows land through screenReadLines exactly as they do
// for the index, the lessons block and the session replay.
//
// Cost when nothing is withheld: ZERO bytes. `String.split('\n').join('\n')` is
// the identity on every string, so a clean body round-trips byte-identically
// and the pushed message is exactly what it has always been.
const SKILL_BODY_SCREEN_SOURCE = 'SKILL.md body';

// The user-visible reason a skill contributed nothing at all. Deliberately NOT
// the long memory-screen notice: this one rides the TERMINAL, not a prompt, so
// it can afford to name the file to go and fix (a withheld skill is only
// actionable if you are told which SKILL.md to open). It never names the
// offending text -- the same contract screenMatch keeps.
export function withheldSkillBodyNotice(skill) {
  return (
    'withheld: this skill\'s body contains a credential or prompt-injection shape, ' +
    'so none of its instructions were loaded into context. ' +
    'The SKILL.md on disk is UNCHANGED \u2014 inspect and remove the offending line yourself: ' +
    `${skill?.path ?? '(unknown path)'}`
  );
}

// Screens a skill body for a prompt push. Returns:
//   body          -- the body to push (byte-identical to the input when nothing
//                    was withheld)
//   withheld      -- how many lines the screen dropped (0 on the common path)
//   fullyWithheld -- true only when the screen dropped something AND nothing
//                    non-blank survived. The caller MUST NOT push in that case:
//                    an instruction block with no instructions is worse than no
//                    block, because it reads to the model as a skill that was
//                    loaded and silently has nothing to say.
// A body that was ALREADY blank (frontmatter-only SKILL.md) is not
// fullyWithheld -- nothing was withheld, so this is not the screen's call to
// make and the pre-existing behaviour stands.
export function screenSkillBody(body, skill = null) {
  const lines = String(body ?? '').split('\n');
  const { kept, withheld } = screenReadLines(lines, SKILL_BODY_SCREEN_SOURCE, 'skill body');
  const keptText = kept.join('\n');
  return {
    body: keptText,
    withheld,
    fullyWithheld: withheld > 0 && !kept.some((l) => String(l).trim()),
  };
}

// ---------------------------------------------------------------------------
// F1 — skill lifecycle curator: usage sidecars, snapshots, ledger, transitions
// ---------------------------------------------------------------------------

export const USAGE_FILE = '.usage.json';
export const ARCHIVE_DIRNAME = '.archive';
export const SNAPSHOTS_SUBDIR = '.snapshots';
export const LEDGER_NAME = 'skill-ledger.jsonl';
export const MAX_SNAPSHOTS_PER_SKILL = 5;
export const STALE_GRACE_FLOOR = 3;
export const CURATOR_DEFAULTS = Object.freeze({ stale_after_days: 30, archive_after_days: 90 });
const DAY_MS = 86_400_000;
const SCHEDULE_MARKER = '# ox-schedule';

// Frozen-clock test hook: assign _now.value = ms | Date | (() => ms) to pin
// "now" for sidecar stamps and curator age math. Null restores wall clock.
export const _now = { value: null };

function nowMs() {
  const v = _now.value;
  if (typeof v === 'function') return Number(v()) || 0;
  if (v != null) return Number(v instanceof Date ? v.getTime() : v) || 0;
  return Date.now();
}

function sha256File(p) {
  try {
    return createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  } catch {
    return null;
  }
}

function readJsonSafe(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

export function readUsageSidecar(dir) {
  if (!dir) return null;
  const raw = readJsonSafe(path.join(dir, USAGE_FILE));
  if (!raw) return null;
  return {
    use_count: Number(raw.use_count) || 0,
    view_count: Number(raw.view_count) || 0,
    last_used: typeof raw.last_used === 'string' ? raw.last_used : null,
  };
}

function writeUsageSidecar(dir, data) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, USAGE_FILE), `${JSON.stringify(data, null, 2)}\n`);
}

function bumpSidecar(dir, field) {
  if (!dir) return null;
  const cur = readUsageSidecar(dir) ?? { use_count: 0, view_count: 0, last_used: null };
  cur[field] = (Number(cur[field]) || 0) + 1;
  cur.last_used = new Date(nowMs()).toISOString();
  try {
    writeUsageSidecar(dir, cur);
  } catch {
    return null;
  }
  return cur;
}

export function recordSkillUse(name, dir) {
  return bumpSidecar(dir, 'use_count');
}

export function recordSkillView(name, dir) {
  return bumpSidecar(dir, 'view_count');
}

export function adoptSkill({ home = os.homedir(), cwd = process.cwd() } = {}, name) {
  const n = String(name ?? '').trim();
  if (!n) return { ok: false, kind: 'invalid', message: 'skill adopt: a skill name is required.' };
  const dir = findSkillDir({ home, cwd }, n);
  if (!dir) {
    return { ok: false, kind: 'not-found', message: `skill adopt: no skill '${n}' in any scan dir.` };
  }
  if (readUsageSidecar(dir)) {
    return { ok: false, kind: 'managed', message: `skill adopt: '${n}' already has a ${USAGE_FILE} sidecar.` };
  }
  const fresh = { use_count: 0, view_count: 0, last_used: new Date(nowMs()).toISOString() };
  try {
    writeUsageSidecar(dir, fresh);
  } catch (e) {
    return { ok: false, kind: 'error', message: `skill adopt: cannot write sidecar: ${String((e && e.message) || e)}` };
  }
  appendSkillLedger({ home }, { actor: 'user', action: 'adopt', name: n, details: { dir } });
  return { ok: true, kind: 'adopted', name: n, dir };
}

export function snapshotsRoot(home) {
  return path.join(path.resolve(home), '.agents', SNAPSHOTS_SUBDIR);
}

export function ledgerPath(home) {
  return path.join(path.resolve(home), '.agents', LEDGER_NAME);
}

// Copy a skill dir into <home>/.agents/.snapshots/<name>-<ts>/ with a meta
// file recording origin + ts; prunes to the newest MAX_SNAPSHOTS_PER_SKILL.
export function snapshotSkillDir({ home = os.homedir() } = {}, srcDir, name, tsMs = nowMs()) {
  const stamp = new Date(tsMs).toISOString().replace(/[:.]/g, '-');
  const dest = path.join(snapshotsRoot(home), `${name}-${stamp}`);
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(srcDir, dest, { recursive: true });
  fs.writeFileSync(
    path.join(dest, '.snapshot-meta.json'),
    `${JSON.stringify({ name, ts: new Date(tsMs).toISOString(), origin: path.resolve(srcDir) }, null, 2)}\n`
  );
  pruneSnapshots(home, name);
  return dest;
}

export function listSnapshots(home, name) {
  const root = snapshotsRoot(home);
  let ents;
  try {
    ents = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const prefix = `${name}-`;
  return ents
    .filter((e) => e.isDirectory() && e.name.startsWith(prefix))
    .map((e) => path.join(root, e.name))
    .sort();
}

function pruneSnapshots(home, name) {
  const all = listSnapshots(home, name).filter((d) => fs.existsSync(path.join(d, 'SKILL.md')));
  while (all.length > MAX_SNAPSHOTS_PER_SKILL) {
    const victim = all.shift();
    try {
      fs.rmSync(victim, { recursive: true, force: true });
    } catch {}
  }
}

export function appendSkillLedger({ home = os.homedir() } = {}, entry) {
  const rec = {
    ts: entry.ts ?? new Date(nowMs()).toISOString(),
    actor: entry.actor ?? 'curator',
    action: entry.action,
    name: entry.name,
    before_sha256: entry.before_sha256 ?? null,
    after_sha256: entry.after_sha256 ?? null,
    details: entry.details ?? {},
  };
  fs.mkdirSync(path.dirname(ledgerPath(home)), { recursive: true });
  fs.appendFileSync(ledgerPath(home), `${JSON.stringify(rec)}\n`);
  return rec;
}

export function readSkillLedger(home = os.homedir()) {
  try {
    return fs
      .readFileSync(ledgerPath(home), 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// Project-first lookup of an active (non-archived) skill dir by name.
export function findSkillDir({ home = os.homedir(), cwd = process.cwd() } = {}, name) {
  const dirs = skillScanDirs({ cwd, home });
  const cwdRoots = new Set([
    path.join(path.resolve(cwd), '.agents', 'skills'),
    path.join(path.resolve(cwd), '.claude', 'skills'),
  ]);
  const ordered = [...dirs.filter((d) => cwdRoots.has(d)), ...dirs.filter((d) => !cwdRoots.has(d))];
  for (const d of ordered) {
    const p = path.join(d, name);
    if (fs.existsSync(path.join(p, 'SKILL.md'))) return p;
  }
  return null;
}

// Restore the newest snapshot of `name` back to its recorded active path,
// removing archived copies across all scan roots.
export function restoreSkill({ home = os.homedir(), cwd = process.cwd() } = {}, name, opts = {}) {
  const n = String(name ?? '').trim();
  if (!n) return { ok: false, kind: 'invalid', message: 'skill restore: a skill name is required.' };
  const snaps = listSnapshots(home, n).filter((d) => fs.existsSync(path.join(d, 'SKILL.md')));
  if (!snaps.length) {
    return { ok: false, kind: 'not-found', message: `skill restore: no snapshots for '${n}'.` };
  }
  const snap = snaps[snaps.length - 1];
  const meta = readJsonSafe(path.join(snap, '.snapshot-meta.json')) ?? {};
  const roots = skillScanDirs({ cwd, home });
  let origin = typeof meta.origin === 'string' ? meta.origin : null;
  if (!origin || !roots.some((r) => !path.relative(r, origin).startsWith('..') && path.isAbsolute(origin))) {
    origin = path.join(roots[0], n);
  }
  const before = sha256File(path.join(origin, 'SKILL.md'));
  try {
    fs.mkdirSync(path.dirname(origin), { recursive: true });
    fs.cpSync(snap, origin, { recursive: true });
  } catch (e) {
    return { ok: false, kind: 'error', message: `skill restore: copy failed: ${String((e && e.message) || e)}` };
  }
  const after = sha256File(path.join(origin, 'SKILL.md'));
  const removedArchives = [];
  for (const r of roots) {
    const a = path.join(r, ARCHIVE_DIRNAME, n);
    if (fs.existsSync(a)) {
      try {
        fs.rmSync(a, { recursive: true, force: true });
        removedArchives.push(a);
      } catch {}
    }
  }
  appendSkillLedger(
    { home },
    {
      actor: opts.actor ?? 'user',
      action: 'restore',
      name: n,
      before_sha256: before,
      after_sha256: after,
      details: { snapshot: snap, restored_to: origin, removed_archives: removedArchives },
    }
  );
  return { ok: true, kind: 'restored', name: n, dest: origin, snapshot: snap, removedArchives };
}

// Delete every archived copy of `name` plus its older snapshots. A final
// safety snapshot is taken first and kept (newest survivor).
export function purgeSkill({ home = os.homedir(), cwd = process.cwd() } = {}, name, opts = {}) {
  const n = String(name ?? '').trim();
  if (!n) return { ok: false, kind: 'invalid', message: 'skill purge: a skill name is required.' };
  const roots = skillScanDirs({ cwd, home });
  const archived = [];
  for (const r of roots) {
    const p = path.join(r, ARCHIVE_DIRNAME, n);
    if (fs.existsSync(p)) archived.push(p);
  }
  if (!archived.length) {
    return {
      ok: false,
      kind: 'not-archived',
      message: `skill purge: no archived copy of '${n}' — only archived skills can be purged.`,
    };
  }
  const before = sha256File(path.join(archived[0], 'SKILL.md'));
  const keptSnapshot = snapshotSkillDir({ home }, archived[0], n);
  for (const p of archived) {
    try {
      fs.rmSync(p, { recursive: true, force: true });
    } catch {}
  }
  const snaps = listSnapshots(home, n).filter((d) => d !== keptSnapshot);
  for (const s of snaps) {
    try {
      fs.rmSync(s, { recursive: true, force: true });
    } catch {}
  }
  appendSkillLedger(
    { home },
    {
      actor: opts.actor ?? 'user',
      action: 'purge',
      name: n,
      before_sha256: before,
      after_sha256: sha256File(path.join(keptSnapshot, 'SKILL.md')),
      details: { removed_archives: archived, kept_snapshot: keptSnapshot },
    }
  );
  return { ok: true, kind: 'purged', name: n, removedArchives: archived, removedSnapshots: snaps, keptSnapshot };
}

function mtimeAgeDays(p, nowTs) {
  try {
    return (nowTs - fs.statSync(p).mtimeMs) / DAY_MS;
  } catch {
    return 0;
  }
}

// Lines that carry schedule context: every '# ox-schedule' marker line plus
// the crontab line immediately after it (the generated command itself).
function scheduleHaystackLines(crontabText) {
  const lines = String(crontabText ?? '').split(/\r?\n/);
  const hay = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes(SCHEDULE_MARKER)) continue;
    hay.push(lines[i]);
    if (i + 1 < lines.length) hay.push(lines[i + 1]);
  }
  return hay;
}

function parseSkillDir(dir) {
  const p = path.join(dir, 'SKILL.md');
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch {
    return { ok: false, warning: 'no SKILL.md' };
  }
  const parsed = parseSkillMd(raw, p);
  return parsed.ok ? { ok: true, name: parsed.skill.name } : { ok: false, warning: parsed.warning };
}

function posNum(v, dflt) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

// One curator pass over every scan dir. apply=false reports transitions
// without touching anything (dry-run / doctor); apply=true performs archive
// mutations with snapshots + ledger lines.
export function curateSkills({ home = os.homedir(), cwd = process.cwd() } = {}, opts = {}) {
  const warnings = [];
  const nowTs = opts.now instanceof Date ? opts.now.getTime() : Number(opts.now ?? nowMs()) || nowMs();
  const knobsRaw = opts.config?.curator;
  const staleAfterDays = posNum(knobsRaw?.stale_after_days, CURATOR_DEFAULTS.stale_after_days);
  const archiveAfterDays = posNum(knobsRaw?.archive_after_days, CURATOR_DEFAULTS.archive_after_days);
  const pinsRaw = opts.config?.skillPins ?? opts.config?.skill_pins;
  const pinned = new Set((Array.isArray(pinsRaw) ? pinsRaw : []).map((s) => String(s).trim()).filter(Boolean));
  const hay = scheduleHaystackLines(opts.crontab);
  const isScheduled = (name) => hay.some((l) => l.includes(name));
  const apply = opts.apply === true;
  const rows = [];

  for (const root of skillScanDirs({ cwd, home })) {
    let dirents;
    try {
      dirents = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of dirents) {
      if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
      const dir = path.join(root, ent.name);
      const parsed = parseSkillDir(dir);
      if (!parsed.ok) {
        warnings.push(`${dir}: skipped — ${parsed.warning}`);
        continue;
      }
      rows.push(evaluateRow(parsed.name, dir, false));
    }
    let archivedEnts;
    try {
      archivedEnts = fs.readdirSync(path.join(root, ARCHIVE_DIRNAME), { withFileTypes: true });
    } catch {
      archivedEnts = [];
    }
    for (const ent of archivedEnts) {
      if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
      const dir = path.join(root, ARCHIVE_DIRNAME, ent.name);
      const parsed = parseSkillDir(dir);
      if (!parsed.ok) {
        warnings.push(`${dir}: skipped — ${parsed.warning}`);
        continue;
      }
      rows.push({ name: parsed.name, dir, state: 'archived', action: null, reason: 'in .archive' });
    }
  }

  function evaluateRow(name, dir, _unusedArchived) {
    const immuneBecause = pinned.has(name) ? 'pinned' : isScheduled(name) ? 'crontab-schedule' : null;
    const sidecar = readUsageSidecar(dir);
    let state = 'active';
    let action = null;
    let reason = immuneBecause ?? '';
    if (sidecar) {
      const lastMs = Date.parse(sidecar.last_used ?? '');
      const idleDays = Number.isFinite(lastMs)
        ? (nowTs - lastMs) / DAY_MS
        : mtimeAgeDays(path.join(dir, 'SKILL.md'), nowTs);
      if (idleDays > archiveAfterDays) {
        state = 'stale';
        if (!immuneBecause) action = 'would-archive';
        reason =
          immuneBecause
            ? `${immuneBecause}; idle ${Math.floor(idleDays)}d would exceed archive_after_days ${archiveAfterDays}d`
            : `idle ${Math.floor(idleDays)}d > archive_after_days ${archiveAfterDays}d`;
      } else if (idleDays > staleAfterDays && sidecar.use_count < STALE_GRACE_FLOOR) {
        state = 'stale';
        reason = `idle ${Math.floor(idleDays)}d > stale_after_days ${staleAfterDays}d, use_count ${sidecar.use_count} < ${STALE_GRACE_FLOOR}`;
      } else if (!reason) {
        reason = `idle ${Math.max(0, Math.floor(idleDays))}d, use_count ${sidecar.use_count}`;
      }
    } else {
      state = 'unmanaged';
      const age = mtimeAgeDays(path.join(dir, 'SKILL.md'), nowTs);
      if (age > archiveAfterDays && !immuneBecause) {
        action = 'would-archive';
        reason = `unmanaged, mtime age ${Math.floor(age)}d > archive_after_days ${archiveAfterDays}d`;
      } else if (age > archiveAfterDays) {
        reason = `unmanaged but ${immuneBecause}`;
      } else if (!reason) {
        reason = 'unmanaged, recently modified';
      }
    }
    return { name, dir, state, action, reason };
  }

  if (apply) {
    for (const row of rows) {
      if (row.action !== 'would-archive') continue;
      row.action = archiveRow(row);
    }
  }

  function archiveRow(row) {
    const skillMd = path.join(row.dir, 'SKILL.md');
    const beforeSha = sha256File(skillMd);
    let snap = null;
    try {
      snap = snapshotSkillDir({ home }, row.dir, row.name);
    } catch (e) {
      warnings.push(`${row.name}: snapshot failed (${String((e && e.message) || e)}) — skipping archive`);
      return 'snapshot-failed';
    }
    const parent = path.dirname(row.dir);
    const archivedTo = path.join(parent, ARCHIVE_DIRNAME, row.name);
    try {
      fs.mkdirSync(path.dirname(archivedTo), { recursive: true });
      if (fs.existsSync(archivedTo)) throw new Error(`destination already exists: ${archivedTo}`);
      fs.renameSync(row.dir, archivedTo);
    } catch (e) {
      warnings.push(`${row.name}: move failed (${String((e && e.message) || e)})`);
      return 'move-failed';
    }
    const afterSha = sha256File(path.join(archivedTo, 'SKILL.md'));
    row.state = 'archived';
    row.archivedTo = archivedTo;
    row.snapshot = snap;
    appendSkillLedger(
      { home },
      {
        actor: opts.actor ?? 'curator',
        action: 'archive',
        name: row.name,
        before_sha256: beforeSha,
        after_sha256: afterSha,
        details: { from: row.dir, to: archivedTo, snapshot: snap },
      }
    );
    return 'archived';
  }

  return { rows, warnings };
}
