// ox learns from its own work. When a run finishes a task in several
// successful steps, those steps become a draft skill in this project. A draft
// is never used until you accept it: learned instructions shape every later
// run, so a person decides which ones are worth keeping.
//
//   ox self-improve run       read this project's past sessions: lessons + drafts
//   ox self-improve drafts    what was drafted, and from which session
//   ox self-improve accept <name> | reject <name>
//
// Drafts live in .agent/skill-drafts/<name>/SKILL.md; an accepted one moves to
// .agents/skills/<name>/, where ox (and Claude Code) load skills from.
//
// A draft is kept without you only when it passes the gate (gateDraft): a second
// finished run did the same task the same way, a test, build or lint command
// passed in it, no step is one ox would ask you about (deleting, sudo, pushing,
// publishing, piping a download into a shell), and it holds no secret and no
// text written to steer an agent. Anything else waits for you.
//   ox self-improve learned         what was kept that way
//   ox self-improve forget <name>   remove one
//   OX_AUTO_SKILLS=0                never keep one without you
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { screenSkillBody } from './skills.js';

const DRAFTS = (cwd) => path.join(cwd, '.agent', 'skill-drafts');
const SKILLS = (cwd) => path.join(cwd, '.agents', 'skills');
// Which sessions were already read: kept in ~/.ox, so a run that drafts
// nothing never writes into your project.
const SEEN = () => path.join(os.homedir(), '.ox', 'skill-drafts-seen.json');

// One session transcript: the task, the tool calls with how each went, the end.
export function readSession(file) {
  let lines;
  try { lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch { return null; }
  const evs = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const meta = evs.find((e) => e.t === 'meta') ?? {};
  const task = String(evs.find((e) => e.t === 'user')?.text ?? '').trim();
  const calls = [];
  const byId = new Map();
  for (const e of evs) {
    if (e.t === 'assistant' && Array.isArray(e.tool_calls)) {
      for (const tc of e.tool_calls) {
        let args = {};
        try { args = JSON.parse(tc.function?.arguments ?? '{}'); } catch {}
        const call = { id: tc.id, name: tc.function?.name ?? '?', args, ok: null };
        calls.push(call);
        if (tc.id) byId.set(tc.id, call);
      }
    }
    if (e.t === 'tool-result') {
      const c = byId.get(e.callId) ?? calls.findLast?.((x) => x.name === e.name && x.ok === null);
      if (c) c.ok = !e.isError;
    }
  }
  const last = [...evs].reverse().find((e) => e.t === 'assistant' && String(e.text ?? '').trim());
  return { id: path.basename(file, '.jsonl'), cwd: meta.cwd ?? null, task, calls, answer: String(last?.text ?? '').trim() };
}

export function worthASkill(s) {
  if (!s?.task) return false;
  const good = s.calls.filter((c) => c.ok === true);
  const failedAtEnd = s.calls.length && s.calls.at(-1).ok === false;
  return good.length >= 3 && new Set(good.map((c) => c.name)).size >= 2 && !failedAtEnd;
}

export function slugFor(task) {
  const words = String(task).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter((w) => w && !['the', 'a', 'an', 'to', 'and', 'of', 'in', 'for', 'please', 'can', 'you', 'my', 'it', 'this', 'that'].includes(w));
  return words.slice(0, 5).join('-').slice(0, 48) || 'learned-skill';
}

function stepLine(c) {
  const a = c.args ?? {};
  const what = a.command ?? a.path ?? a.file_path ?? a.pattern ?? a.query ?? a.url ?? '';
  return `${c.name}${what ? ` — \`${String(what).replace(/`/g, "'").slice(0, 100)}\`` : ''}`;
}

export function renderDraft(s, name, date = new Date()) {
  const good = s.calls.filter((c) => c.ok === true);
  const steps = good.map((c, i) => `${i + 1}. ${stepLine(c)}`).join('\n');
  const checks = good.filter((c) => c.name === 'bash' && CHECK.test(String(c.args?.command ?? '')));
  const oneLine = s.task.split('\n')[0].slice(0, 140).replace(/"/g, "'");
  return [
    '---',
    `name: ${name}`,
    `description: "How this project got this done before: ${oneLine}"`,
    'draft: true',
    `learned-from: ${s.id}`,
    '---',
    '',
    `# ${oneLine}`,
    '',
    `Learned on ${date.toISOString().slice(0, 10)} from a run that finished this task. These are the steps that`,
    'worked there, in order; adapt them, do not replay them blindly.',
    '',
    '## Steps that worked',
    steps,
    ...(checks.length ? ['', '## How it was checked', ...checks.map((c) => `- \`${String(c.args.command).slice(0, 120)}\` passed`)] : []),
    '',
  ].join('\n');
}

// Steps a person is asked about when ox runs them: not something to learn as routine.
const RISKY = [
  [/\brm\s+-[a-z]*[rf]/i, 'deletes files'],
  [/\bsudo\b|\bdoas\b/, 'runs as administrator'],
  [/\bgit\s+(push|reset\s+--hard|clean\s+-[a-z]*f|branch\s+-D)\b/, 'pushes or discards git work'],
  [/\b(npm|pnpm|yarn|cargo|gem|twine)\s+publish\b|\bgh\s+release\b|\b(vercel|netlify|fly|firebase)\b.*\b(deploy|--prod)\b/i, 'publishes or deploys'],
  [/\b(curl|wget)\b[^|\n]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/i, 'pipes a download into a shell'],
  [/\b(ssh|scp|rsync)\s|\bdd\s+if=|\bmkfs\b|\bchmod\s+(-R\s+)?777\b|>\s*\/dev\/(sd|disk)/i, 'reaches another machine or a disk'],
  [/\b(drop\s+(table|database)|truncate\s+table|delete\s+from)\b/i, 'deletes data'],
  [/\bkill(all)?\s+-9\b|\bpkill\b/, 'kills processes'],
];
const SECRET = /\b(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,})|\b[A-Z0-9_]*(?:API_?KEY|TOKEN|SECRET|PASSWORD)\s*=\s*['"]?[^\s'"$]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const CHECK = /\b(test|check|lint|build|verify|typecheck|tsc|pytest|vitest|jest)\b/i;

const field = (text, key) => new RegExp(`^${key}: (.*)$`, 'm').exec(text)?.[1]?.trim() ?? '';
const sessionsOf = (text) => [field(text, 'learned-from'), ...field(text, 'confirmed-by').split(/\s+/)].filter(Boolean);
const stepsOf = (text) => (text.match(/^\d+\. .*$/gm) ?? []).map((l) => l.replace(/^\d+\. /, ''));

/**
 * May this draft be kept without a person? { ok, reasons }: every reason is one
 * thing that holds it back, in words a person can act on.
 */
export function gateDraft(text, { minRuns = 2 } = {}) {
  const reasons = [];
  const runs = new Set(sessionsOf(text)).size;
  if (runs < minRuns) reasons.push(`seen in ${runs} finished run${runs === 1 ? '' : 's'}, needs ${minRuns}`);
  if (!/^## How it was checked$/m.test(text)) reasons.push('no test, build or lint command passed in the run');
  const steps = stepsOf(text);
  if (steps.length > 40) reasons.push('more than 40 steps');
  for (const [re, why] of RISKY) { const hit = steps.find((l) => re.test(l)); if (hit) reasons.push(`a step ${why}: ${hit.slice(0, 80)}`); }
  if (SECRET.test(text)) reasons.push('it contains what looks like a secret');
  const screened = screenSkillBody(text.replace(/^---[\s\S]*?\n---\n/, ''));
  if (screened.withheld > 0) reasons.push('it contains text written to steer an agent');
  return { ok: reasons.length === 0, reasons, runs };
}

/** The share of a draft's steps (by tool) that a later run also took. */
function sameWay(text, s) {
  const tools = stepsOf(text).map((l) => l.split(' — ')[0]);
  if (!tools.length) return 0;
  const did = new Set(s.calls.filter((c) => c.ok === true).map((c) => c.name));
  return tools.filter((n) => did.has(n)).length / tools.length;
}

const autoOn = (env = process.env) => env.OX_AUTO_SKILLS !== '0' && env.OX_INCOGNITO !== '1';

/**
 * What one finished run teaches: a new draft, or a second sighting of one, and
 * the draft kept on its own when it passes the gate.
 * → { drafted, confirmed, kept, held } (names, or null; held: why it was not kept).
 */
export function learnFromRun(s, cwd, { env = process.env } = {}) {
  const out = { drafted: null, confirmed: null, kept: null, held: [] };
  const seen = loadSeen();
  if (!s || seen.has(s.id)) return out;
  seen.add(s.id);
  saveSeen(seen);
  if (!worthASkill(s)) return out;
  const name = slugFor(s.task);
  if (fs.existsSync(path.join(SKILLS(cwd), name))) return out;
  const file = path.join(DRAFTS(cwd), name, 'SKILL.md');
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, renderDraft(s, name));
    out.drafted = name;
  } else {
    let text = fs.readFileSync(file, 'utf8');
    if (sameWay(text, s) < 0.6 || sessionsOf(text).includes(s.id)) return out;
    const by = [...field(text, 'confirmed-by').split(/\s+/).filter(Boolean), s.id].slice(-10).join(' ');
    text = /^confirmed-by: /m.test(text) ? text.replace(/^confirmed-by: .*$/m, `confirmed-by: ${by}`) : text.replace(/^(learned-from: .*)$/m, `$1\nconfirmed-by: ${by}`);
    // A check that passed in either run counts: the first may have been done before tests existed.
    if (!/^## How it was checked$/m.test(text)) {
      const checks = s.calls.filter((c) => c.ok === true && c.name === 'bash' && CHECK.test(String(c.args?.command ?? '')));
      if (checks.length) text = `${text.trimEnd()}\n\n## How it was checked\n${checks.map((c) => `- \`${String(c.args.command).slice(0, 120)}\` passed`).join('\n')}\n`;
    }
    fs.writeFileSync(file, text);
    out.confirmed = name;
  }
  const gate = gateDraft(fs.readFileSync(file, 'utf8'));
  if (gate.ok && autoOn(env) && acceptDraft(cwd, name, { auto: true })) out.kept = name;
  else out.held = gate.reasons;
  return out;
}

/** Skills here that were kept without a person. */
export function listLearned(cwd) {
  let names = [];
  try { names = fs.readdirSync(SKILLS(cwd)); } catch {}
  const out = [];
  for (const name of names) {
    let text = '';
    try { text = fs.readFileSync(path.join(SKILLS(cwd), name, 'SKILL.md'), 'utf8'); } catch { continue; }
    if (field(text, 'learned') !== 'auto') continue;
    out.push({ name, kept: field(text, 'kept'), runs: new Set(sessionsOf(text)).size, steps: stepsOf(text).length });
  }
  return out;
}

/** Remove a skill ox kept on its own. One a person wrote or accepted is never touched. */
export function forgetLearned(cwd, name) {
  const dir = path.join(SKILLS(cwd), path.basename(String(name)));
  let text = '';
  try { text = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'); } catch { return false; }
  if (field(text, 'learned') !== 'auto') return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

function loadSeen() {
  try { return new Set(JSON.parse(fs.readFileSync(SEEN(), 'utf8'))); } catch { return new Set(); }
}
function saveSeen(seen) {
  try {
    fs.mkdirSync(path.dirname(SEEN()), { recursive: true });
    fs.writeFileSync(SEEN(), JSON.stringify([...seen].slice(-2000)));
  } catch {}
}

// Draft a skill from one finished session. Returns the draft's name, or null.
export function draftFromSession(file, cwd) {
  return draftFromRecord(readSession(file), cwd);
}

// The same from a run's own record ({ id, task, calls, answer }): `ox -p`
// keeps no transcript, so it hands over what it just did.
export function draftFromRecord(s, cwd) {
  const seen = loadSeen();
  if (!s || seen.has(s.id)) return null;
  seen.add(s.id);
  saveSeen(seen);
  if (!worthASkill(s)) return null;
  const name = slugFor(s.task);
  if (fs.existsSync(path.join(DRAFTS(cwd), name)) || fs.existsSync(path.join(SKILLS(cwd), name))) return null;
  fs.mkdirSync(path.join(DRAFTS(cwd), name), { recursive: true });
  fs.writeFileSync(path.join(DRAFTS(cwd), name, 'SKILL.md'), renderDraft(s, name));
  return name;
}

export function listDrafts(cwd) {
  let names = [];
  try { names = fs.readdirSync(DRAFTS(cwd)).filter((n) => !n.startsWith('.') && fs.existsSync(path.join(DRAFTS(cwd), n, 'SKILL.md'))); } catch {}
  return names.map((name) => {
    const text = fs.readFileSync(path.join(DRAFTS(cwd), name, 'SKILL.md'), 'utf8');
    const gate = gateDraft(text);
    return { name, from: /learned-from: (\S+)/.exec(text)?.[1] ?? '?', steps: (text.match(/^\d+\. /gm) ?? []).length, runs: gate.runs, held: gate.reasons };
  });
}

export function acceptDraft(cwd, name, { auto = false, date = new Date() } = {}) {
  const from = path.join(DRAFTS(cwd), path.basename(name));
  if (!fs.existsSync(path.join(from, 'SKILL.md'))) return false;
  const to = path.join(SKILLS(cwd), path.basename(name));
  fs.mkdirSync(SKILLS(cwd), { recursive: true });
  const text = fs.readFileSync(path.join(from, 'SKILL.md'), 'utf8').replace(/^draft: true\n/m, auto ? `learned: auto\nkept: ${date.toISOString().slice(0, 10)}\n` : '');
  fs.mkdirSync(to, { recursive: true });
  fs.writeFileSync(path.join(to, 'SKILL.md'), text);
  fs.rmSync(from, { recursive: true, force: true });
  return true;
}

export function rejectDraft(cwd, name) {
  const from = path.join(DRAFTS(cwd), path.basename(name));
  if (!fs.existsSync(from)) return false;
  fs.rmSync(from, { recursive: true, force: true });
  return true;
}

// Read this project's past sessions: lessons into procedural memory, skill drafts.
export async function learnFromProject(cwd, { sessionsDir, limit = 30 } = {}) {
  const { recordPattern } = await import('./procedural-memory.js');
  const { extractHeuristicPatterns } = await import('./self-improve.js');
  let files = [];
  try { files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(sessionsDir, f)); } catch {}
  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  let read = 0, lessons = 0;
  const drafted = [], kept = [];
  // Oldest first, so the run that drafted a skill is read before the one that confirms it.
  const picked = [];
  for (const f of files) {
    if (picked.length >= limit) break;
    const s = readSession(f);
    if (!s || (s.cwd && path.resolve(s.cwd) !== path.resolve(cwd))) continue;
    picked.push(s);
  }
  for (const s of picked.reverse()) {
    read++;
    const events = s.calls.filter((c) => c.ok !== null).map((c) => ({ t: 'tool-end', name: c.name, isError: !c.ok }));
    for (const p of extractHeuristicPatterns(events)) {
      const r = recordPattern({ cwd, taskType: p.taskType, pattern: p.pattern, success: p.type === 'success' });
      if (r?.recorded) lessons++;
    }
    const r = learnFromRun(s, cwd);
    if (r.drafted) drafted.push(r.drafted);
    if (r.kept) kept.push(r.kept);
  }
  return { read, lessons, drafted, kept };
}
