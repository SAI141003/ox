// ox make "<idea>" (Vovy's "build me a pumpkin carver game with Claude"):
// a fresh project folder, the idea turned into a full brief, Claude Code (or
// Codex) opened in a new Terminal tab with that brief, each step narrated in
// the notch, and the app opened in your browser once the agent has finished.
// The agent runs in its own visible terminal, so you can watch and step in;
// its approvals come to the notch through the hooks like any other session.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveCli } from './subscriptions.js';
import { codexModelArgs } from './session-transfer.js';

// In the new, empty project folder the agent writes files without asking about
// each one; commands still ask (in the notch, through the hooks).
export const BUILDERS = {
  claude: { label: 'Claude Code', bin: 'claude', args: '--permission-mode acceptEdits' },
  codex: { label: 'Codex', bin: 'codex', args: '--sandbox workspace-write --ask-for-approval on-request' },
};

/** "build me a pumpkin carver game" → "Pumpkin Carver" (the name in the notch and the folder). */
export function nameOf(idea) {
  const words = String(idea).toLowerCase()
    .replace(/^(?:please\s+)?(?:can you\s+)?(?:build|make|create|write|code)\s+(?:me\s+)?/, '')
    .replace(/^(?:a|an|the)\s+/, '')
    .replace(/\b(?:with|using|in|for)\s+(?:claude(?: code)?|codex)\b.*$/, '')
    .replace(/\b(?:web|browser|simple|small|little|quick|fun|basic)\b/g, ' ')
    .replace(/\b(?:game|app|application|website|site|page|tool)\b.*$/, '')
    .replace(/[^a-z0-9 ]/g, ' ').trim().split(/\s+/).filter(Boolean).slice(0, 4);
  const name = words.map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
  return name || 'New App';
}

export const slugOf = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'app';

/** The idea as a brief an agent can build from without asking (Vovy's long prompt). */
export function briefOf(idea, name) {
  return [
    `Build "${name}": ${String(idea).trim().replace(/\s+/g, ' ')}.`,
    'Make it a web app that runs in the browser with plain HTML, CSS and JavaScript and no build step: index.html with a separate script.js and style.css.',
    'Make it look finished and polished (a clear title, good spacing, colours that fit the idea), and make it work with a mouse and on a phone.',
    'If it is a game, include a way to start over and a short line telling the player what to do.',
    'Add a README.md with what it is and how to open it.',
    'Start with a short plan, build it, then check it runs (open index.html) and fix anything broken. Keep it to these files.',
  ].join(' ');
}

const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

/**
 * The command to start a tool: its own name when that works, else a working
 * copy inside an app (Codex inside the ChatGPT extension or the ChatGPT / Codex
 * app when the codex command line is missing or broken).
 */
export function binOf(name, { resolve = (b) => resolveCli({ bin: b }), extra = (tool, b) => (tool === 'codex' ? codexModelArgs(b) : []) } = {}) {
  let where = name, cmd = name;
  try { const r = resolve(name); if (r?.from === 'app') { where = r.where; cmd = q(r.where); } } catch {}
  // Codex signed in with ChatGPT may not run the model its config names: use one the account allows.
  let more = [];
  try { more = extra(name, where) ?? []; } catch {}
  return [cmd, ...more.map((a) => (/^[\w.:/-]+$/.test(a) ? a : q(a)))].join(' ');
}

/** The Terminal command that opens the agent in the folder with the brief. */
export function terminalCommand(dir, brief, builder = 'claude', { bin = binOf } = {}) {
  const b = BUILDERS[builder] ?? BUILDERS.claude;
  return `cd ${q(dir)} && ${bin(b.bin)} ${b.args} ${q(brief)}`;
}

/** The project's entry page, if the agent has written one. */
export function entryOf(dir) {
  for (const f of ['index.html', 'public/index.html', 'dist/index.html', 'src/index.html']) {
    const p = path.join(dir, f);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Run it. `say(step, done?)` narrates (the notch); `open` and `terminal` are
 * replaceable for tests; `live` reads the agents' sessions (src/agents-live.js).
 * → { dir, name, entry, opened }
 */
export async function make(idea, {
  builder = 'claude', dir = null, home = os.homedir(), say = () => {}, bin = binOf,
  terminal = openInTerminal, open = (p) => spawnSync('open', [p]), live = null,
  quietSec = 25, timeoutMs = 45 * 60_000, pollMs = 3000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  if (!String(idea ?? '').trim()) throw new Error('usage: ox make "<what to build>" [--with claude|codex] [--dir <folder>]');
  const b = BUILDERS[builder];
  if (!b) throw new Error(`ox make builds with ${Object.keys(BUILDERS).join(' or ')}`);
  const name = nameOf(idea);
  say('Checking your project setup');
  const where = dir ?? path.join(home, 'ox-builds', slugOf(name));
  fs.mkdirSync(where, { recursive: true });
  if (!fs.existsSync(path.join(where, '.git'))) spawnSync('git', ['init', '-q'], { cwd: where });
  const brief = briefOf(idea, name);
  fs.writeFileSync(path.join(where, '.ox-brief.md'), `${brief}\n`);
  say(`Opening ${b.label} in a new tab`);
  const t = terminal(terminalCommand(where, brief, builder, { bin }));
  if (t?.error) throw new Error(`could not open Terminal: ${t.error}`);
  say(`Handing ${b.label === 'Codex' ? 'Codex' : 'Claude'} your prompt`);
  const sessions = live ?? (async () => (await import('./agents-live.js')).liveAgents({ fresh: true }));
  const resolved = fs.realpathSync(where);
  const started = Date.now();
  let seen = false, asked = false;
  while (Date.now() - started < timeoutMs) {
    await sleep(pollMs);
    let rows = [];
    try { rows = (await sessions()) ?? []; } catch {}
    const mine = rows.find((s) => s.cwd && (s.cwd === where || s.cwd === resolved));
    if (mine && !seen) { seen = true; say(`${b.label} is building`); }
    // A new folder: Claude Code first asks whether you trust it. That is your
    // answer to give (ox never answers a trust question), so say why it waits.
    if (!seen && !asked && builder === 'claude' && Date.now() - started > 20_000) { asked = true; say('Claude Code asks whether to trust the new folder: choose Yes in Terminal'); }
    const entry = entryOf(where);
    // Finished: the page exists and the agent has been quiet a while (or has left).
    if (entry && ((mine && mine.idleSec >= quietSec) || (seen && !mine))) {
      say(`${b.label} is building`, true);
      open(entry);
      say(`${name} is live`, true);
      return { dir: where, name, entry, opened: true };
    }
  }
  say(`${name} is still being built: open ${where} when it is done`, true);
  return { dir: where, name, entry: entryOf(where), opened: false };
}

/** A new Terminal tab (window if none) running the command. */
export function openInTerminal(command) {
  if (process.platform !== 'darwin') return { error: 'opening a terminal tab works on macOS for now' };
  const esc = command.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const r = spawnSync('osascript', ['-e', `tell application "Terminal"\nactivate\ndo script "${esc}"\nend tell`], { encoding: 'utf8', timeout: 15_000 });
  return r.status === 0 ? { ok: true } : { error: String(r.stderr || 'osascript failed').trim().split('\n').pop() };
}
