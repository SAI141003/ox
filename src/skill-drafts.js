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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
  const checks = good.filter((c) => c.name === 'bash' && /\b(test|check|lint|build|verify)\b/i.test(String(c.args?.command ?? '')));
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
    return { name, from: /learned-from: (\S+)/.exec(text)?.[1] ?? '?', steps: (text.match(/^\d+\. /gm) ?? []).length };
  });
}

export function acceptDraft(cwd, name) {
  const from = path.join(DRAFTS(cwd), path.basename(name));
  if (!fs.existsSync(path.join(from, 'SKILL.md'))) return false;
  const to = path.join(SKILLS(cwd), path.basename(name));
  fs.mkdirSync(SKILLS(cwd), { recursive: true });
  const text = fs.readFileSync(path.join(from, 'SKILL.md'), 'utf8').replace(/^draft: true\n/m, '');
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
  const drafted = [];
  for (const f of files) {
    if (read >= limit) break;
    const s = readSession(f);
    if (!s || (s.cwd && path.resolve(s.cwd) !== path.resolve(cwd))) continue;
    read++;
    const events = s.calls.filter((c) => c.ok !== null).map((c) => ({ t: 'tool-end', name: c.name, isError: !c.ok }));
    for (const p of extractHeuristicPatterns(events)) {
      const r = recordPattern({ cwd, taskType: p.taskType, pattern: p.pattern, success: p.type === 'success' });
      if (r?.recorded) lessons++;
    }
    const d = draftFromSession(f, cwd);
    if (d) drafted.push(d);
  }
  return { read, lessons, drafted };
}
