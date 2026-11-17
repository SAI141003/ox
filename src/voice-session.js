// "Start Claude in ox and tell it to fix the failing test": an agent session in
// one of your projects, from a sentence. The project is found by its folder
// name, your terminal opens there with Claude Code or Codex, and the rest of the
// sentence is its first prompt. After Coucou 0.6's "start a session from the
// notch" (its ⌃⌥N), here by voice and with no model in between.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BUILDERS, binOf, openInTerminal } from './make-app.js';

const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
const TOOL = '(claude(?: code)?|codex)';
// start | open | new … <tool> … in|on|for <project> [, and tell it to | to | : <prompt>]
const SAID = [
  new RegExp(`^(?:start|open|launch|begin|run|new|make|create)\\s+(?:a\\s+|an\\s+)?(?:new\\s+)?${TOOL}(?:\\s+session)?\\s+(?:in|on|for|inside)\\s+(?:the\\s+|my\\s+)?(.+?)(?:\\s+(?:project|repo|folder|directory))?(?:\\s*(?:,|:|\\band\\b)?\\s*(?:tell|ask) (?:it|him|her|claude|codex)(?: to)?\\s+(.+)|\\s*:\\s*(.+)|\\s+(?:and|to)\\s+(.+))?$`, 'i'),
  new RegExp(`^(?:start|open|begin|new|make|create)\\s+(?:a\\s+)?(?:new\\s+)?(?:coding\\s+|agent\\s+)?session\\s+(?:in|on|for|inside)\\s+(?:the\\s+|my\\s+)?(.+?)(?:\\s+(?:project|repo|folder|directory))?\\s+(?:with|using)\\s+${TOOL}(?:\\s*(?:,|:|\\band\\b)?\\s*(?:tell|ask) (?:it|him|her|claude|codex)(?: to)?\\s+(.+)|\\s*:\\s*(.+)|\\s+(?:and|to)\\s+(.+))?$`, 'i'),
];

/** { intent: 'session', tool, project, prompt } or null. */
export function parseSession(text) {
  const t = String(text ?? '').trim().replace(/[.!?]+$/, '').replace(/^(?:hey,?\s+|can you\s+|could you\s+|please\s+)+/i, '');
  let m = SAID[0].exec(t);
  if (m) return { intent: 'session', tool: /codex/i.test(m[1]) ? 'codex' : 'claude', project: m[2].trim(), prompt: (m[3] ?? m[4] ?? m[5] ?? '').trim() };
  m = SAID[1].exec(t);
  if (m) return { intent: 'session', tool: /codex/i.test(m[2]) ? 'codex' : 'claude', project: m[1].trim(), prompt: (m[3] ?? m[4] ?? m[5] ?? '').trim() };
  return null;
}

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');

/** Folders that could be the project: your home's own folders and the usual places code is kept. */
export function projectFolders({ home = os.homedir() } = {}) {
  const out = [], seen = new Set();
  for (const root of [home, ...['Projects', 'projects', 'Developer', 'Code', 'code', 'dev', 'src', 'repos', 'Documents', 'Desktop', 'work'].map((d) => path.join(home, d))]) {
    let list = [];
    try { list = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const e of list) if (e.isDirectory() && !e.name.startsWith('.') && !/^(Library|Applications|Movies|Music|Pictures|Public)$/.test(e.name)) {
      // "Projects" and "projects" are one folder on a Mac: listed once.
      const dir = path.join(root, e.name);
      let real = dir; try { real = fs.realpathSync.native(dir); } catch {}
      if (!seen.has(real)) { seen.add(real); out.push(dir); }
    }
  }
  return out;
}

/**
 * The folder a spoken name means. Speech writes "gadget swap" for gadget-swap
 * and "ox" for ox: names are compared with spaces and dashes taken out. An
 * exact name wins; else a single folder whose name starts with it; two that
 * fit are not guessed between.
 */
export function findProject(said, folders = projectFolders()) {
  const want = norm(said);
  if (!want) return { error: 'which project?' };
  const named = folders.map((dir) => ({ dir, key: norm(path.basename(dir)) }));
  // A real project (it has git) is preferred over a folder that only shares the name.
  const pick = (list) => list.find((x) => fs.existsSync(path.join(x.dir, '.git'))) ?? list[0];
  const exact = named.filter((x) => x.key === want);
  if (exact.length) return { dir: pick(exact).dir };
  const starts = named.filter((x) => want.length >= 3 && x.key.startsWith(want));
  if (starts.length === 1) return { dir: starts[0].dir };
  if (starts.length > 1) return { error: `"${said}" could be ${starts.slice(0, 3).map((x) => path.basename(x.dir)).join(', ')}: say the whole name` };
  return { error: `no project folder called "${said}" in your home, Projects, Developer, Code or Documents` };
}

/** The line the terminal runs: the folder, the tool, and your words as its first prompt (quoted whole). */
export function sessionCommand(dir, tool, prompt, { bin = binOf } = {}) {
  const b = BUILDERS[tool] ?? BUILDERS.claude;
  return `cd ${q(dir)} && ${bin(b.bin)}${prompt ? ` ${q(prompt)}` : ''}`;
}

export function startSession(it, { dryRun = false, folders, open = openInTerminal } = {}) {
  const found = findProject(it.project, folders);
  const label = (BUILDERS[it.tool] ?? BUILDERS.claude).label;
  if (found.error) return { ok: false, message: found.error };
  const name = path.basename(found.dir);
  if (dryRun || process.env.NODE_TEST_CONTEXT || process.env.OX_OPERATOR_DRY === '1') return { ok: true, message: `dry run: would open ${label} in ${name}${it.prompt ? ` with "${it.prompt}"` : ''}` };
  const r = open(sessionCommand(found.dir, it.tool, it.prompt));
  return r.error ? { ok: false, message: r.error } : { ok: true, message: `${label} is open in ${name}${it.prompt ? `, working on: ${it.prompt}` : ''}` };
}
