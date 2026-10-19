// Every ox command as a slash command, in one place: the terminal chat
// (/browse, /studio…), the app's "/" menu, and the agents connected to ox
// (Claude Code /ox:browse, Codex prompts, the ox skill they read). Built-in
// chat commands (/model, /goal, /compact…) stay in src/cli.js; this is the
// list of ox's own tools, each with what it does in a line.
//
// app: true means the app may run it inline from its "/" menu: finishes on
// its own, asks nothing, changes nothing you did not just ask for.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
export const COMMANDS = Object.freeze([
  // Make things
  { name: 'studio', usage: '/studio [models [kind] | recipes [name] | connect]', what: 'open image, video and sound models; recipes for productions', group: 'Make', app: true },
  { name: 'create', usage: '/create "<prompt>" [--edit <image>] [--provider fal|hf|openai|openrouter|local] [--model id]', what: 'make an image or a clip now', group: 'Make', app: true, slow: true },
  { name: 'video', usage: '/video captions|cut|vertical|highlights|gif|polish <file> …', what: 'edit a video on this machine (ffmpeg, whisper)', group: 'Make', app: true, slow: true },
  { name: 'theme', usage: '/theme ["<look>" | list | use <name> | reset]', what: 'restyle the app from a sentence (neumorphic, glass, paper…)', group: 'Make', app: true },
  { name: 'clone', usage: '/clone <url>', what: 'rebuild a website as a Next.js, Vite or plain HTML project', group: 'Make' },
  // Web and research
  { name: 'browse', usage: '/browse "<goal>" [--url <page>] [--show]', what: 'the fast browser: does a task on a website, asks before buy, pay or send', group: 'Web', app: true, slow: true },
  { name: 'research', usage: '/research "<topic>" [--on reddit,hn,youtube]', what: 'what Reddit, Hacker News and YouTube say, with links', group: 'Web', app: true, slow: true },
  { name: 'library', usage: '/library [add <link|pdf> | search <words> | read <id> | ask <id> "q"]', what: 'your saved articles and PDFs', group: 'Web', app: true },
  // Code
  { name: 'pr', usage: '/pr open [--title T] [--draft] | status | fix', what: 'branch, checks, push and a pull request; its CI and reviews', group: 'Code' },
  { name: 'env', usage: '/env [show | detect | check]', what: 'how this repo installs, lints, builds and tests', group: 'Code', app: true },
  { name: 'wiki', usage: '/wiki [--out dir]', what: 'a wiki of this project from its code graph', group: 'Code', app: true },
  { name: 'graph', usage: '/graph [update | query "<question>"]', what: 'map the code (files, functions, calls) and ask about it', group: 'Code', app: true },
  { name: 'race', usage: '/race "<task>" --models a,b', what: 'two or more models do the same task in their own worktrees; keep the best', group: 'Code' },
  { name: 'review', usage: '/review', what: 'a code review of your changes', group: 'Code' },
  { name: 'trace', usage: '/trace [<id>] [--signals]', what: 'each run: turns, tokens, cost, tool calls, stuck signals', group: 'Code', app: true },
  { name: 'usage', usage: '/usage [--days n]', what: 'tokens and spend by model and day', group: 'Code', app: true },
  // Agents and work
  { name: 'org', usage: '/org [hire "<sentence>" | tell <id> "…" | team "<sentence>" | timeline]', what: 'a company of agents: hire, give work, follow it', group: 'Agents' },
  { name: 'task', usage: '/task [list | add "<title>" | done <id> | next]', what: 'the task board', group: 'Agents', app: true },
  { name: 'agents', usage: '/agents', what: 'every agent running on this Mac (Claude Code, Codex, ox…)', group: 'Agents', app: true },
  { name: 'schedule', usage: '/schedule [add <cadence> "<text>" | list]', what: 'runs on a timer', group: 'Agents' },
  { name: 'flow', usage: '/flow [list | new "<description>" | run <id> | templates | import <id>]', what: 'automations, and n8n templates turned into ox flows', group: 'Agents', app: true },
  { name: 'mesh', usage: '/mesh [describe | agents | ls machine:path | audit]', what: 'your other machines: what they have and run', group: 'Agents', app: true },
  // Skills and connections
  { name: 'skill', usage: '/skill <name> | add <folder|owner/repo> | from <book.pdf>', what: 'skills: read one, install one, or make one from a book', group: 'Connect', app: true },
  { name: 'market', usage: '/market [<words> | install <name>]', what: 'search and install skills and plugins', group: 'Connect', app: true },
  { name: 'mcp', usage: '/mcp [ls | add <name> | test <name>]', what: 'MCP servers ox uses', group: 'Connect', app: true },
  { name: 'commands', usage: '/commands [install [--claude] [--codex] | list]', what: 'these commands, also inside Claude Code and Codex', group: 'Connect', app: true },
  // Voice and the island
  { name: 'dictation', usage: '/dictation [show | style <as-said|natural|polished> | translate <language|off>]', what: 'how dictated text is written', group: 'Voice', app: true },
  { name: 'speak', usage: '/speak "<text>"', what: 'say it out loud', group: 'Voice', app: true },
  { name: 'island', usage: '/island [start | stop | status | sound <name>]', what: 'the notch island', group: 'Voice', app: true },
  // This Mac
  { name: 'doctor', usage: '/doctor', what: 'checks: keys, models, tools, permissions', group: 'System', app: true },
  { name: 'models', usage: '/models', what: 'the models ox can use right now', group: 'System', app: true },
  { name: 'secure', usage: '/secure [--diff | <paths>]', what: 'find security problems in this code', group: 'System', app: true },
  { name: 'update', usage: '/update', what: 'update ox', group: 'System' },
]);

export const byName = new Map(COMMANDS.map((c) => [c.name, c]));

/** Words of a command line, with "quoted parts" kept whole. */
export function splitArgs(s) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(s ?? '')))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** "/browse find x --url y" → { cmd, args } or null when it is not one of these. */
export function parse(line) {
  const m = /^\/([a-z][\w-]*)(?:\s+([\s\S]*))?$/i.exec(String(line ?? '').trim());
  if (!m) return null;
  const cmd = byName.get(m[1].toLowerCase());
  return cmd ? { cmd, args: splitArgs(m[2] ?? '') } : null;
}

/** For the app's menu: matching commands, best first. */
export function suggest(prefix = '') {
  const q = String(prefix).replace(/^\//, '').toLowerCase();
  if (!q) return [...COMMANDS];
  const starts = COMMANDS.filter((c) => c.name.startsWith(q));
  const inside = COMMANDS.filter((c) => !c.name.startsWith(q) && (c.name.includes(q) || (q.length >= 3 && new RegExp(`\\b${q.replace(/[^\w-]/g, '')}`).test(c.what.toLowerCase()))));
  return [...starts, ...inside];
}

/** The catalog as Markdown, for an agent's skill. */
export function markdown() {
  const groups = [...new Set(COMMANDS.map((c) => c.group))];
  return groups.map((g) => [`## ${g}`, '', ...COMMANDS.filter((c) => c.group === g).map((c) => `- \`ox ${c.usage.slice(1)}\`: ${c.what}`), ''].join('\n')).join('\n');
}

// ------------------------------------------- in the agents connected to ox


/** Where each connected tool keeps commands and skills. Only tools that are installed are touched. */
export function targets(home = os.homedir()) {
  return [
    { tool: 'Claude Code', root: path.join(home, '.claude'), commands: path.join(home, '.claude', 'commands'), skills: path.join(home, '.claude', 'skills'), invoke: (n) => `/ox-${n}` },
    { tool: 'Codex', root: path.join(home, '.codex'), commands: path.join(home, '.codex', 'prompts'), skills: path.join(home, '.codex', 'skills'), invoke: (n) => `/prompts:ox-${n}` },
    { tool: 'Cursor', root: path.join(home, '.cursor'), commands: path.join(home, '.cursor', 'commands'), skills: null, invoke: (n) => `/ox-${n}` },
  ];
}

const commandFile = (c, bin) => `---
description: ${c.what} (ox)
argument-hint: ${c.usage.replace(/^\/\S+\s*/, '') || '(no arguments)'}
allowed-tools: Bash(${bin} ${c.name}:*)
---
Run this with the shell tool and report what it prints, plainly and briefly:

\`\`\`
${bin} ${c.name} $ARGUMENTS
\`\`\`

If it asks for something (a key, an approval, a choice), tell the user what it needs instead of guessing.
`;

/** The ox skill: when an agent should use ox commands, and the whole list. */
export function skillFile(bin = 'ox') {
  return `---
name: ox
description: Use ox's own commands when the user wants a website task done (ox browse), an image, video or sound made (ox studio, ox create), the app restyled (ox theme), saved reading or web research (ox library, ox research), a pull request opened or fixed (ox pr), agents hired or given work (ox org), other machines checked (ox mesh), or anything else listed here. ox is installed on this machine.
---
# ox commands

ox is installed (\`${bin}\`). When a request matches one of these, run the ox command with the shell instead of doing the work by hand: it is faster, it keeps the user's own settings and keys, and it asks before anything that pays, sends or deletes.

${markdown()}
Every command takes \`--help\`. Report what the command printed; do not claim a result it did not print.
`;
}

const MANIFEST = (home) => path.join(home, '.ox', 'commands-installed.json');

/** Put the ox commands and skill into each installed tool. → [{ tool, files, invoke }] */
export function install({ home = os.homedir(), only = null, bin = 'ox' } = {}) {
  const done = [], written = [];
  for (const t of targets(home)) {
    if (only && !only.includes(t.tool.toLowerCase().split(' ')[0])) continue;
    if (!fs.existsSync(t.root)) continue;
    const files = [];
    fs.mkdirSync(t.commands, { recursive: true });
    for (const c of COMMANDS) {
      const f = path.join(t.commands, `ox-${c.name}.md`);
      fs.writeFileSync(f, commandFile(c, bin));
      files.push(f);
    }
    if (t.skills) {
      const f = path.join(t.skills, 'ox', 'SKILL.md');
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, skillFile(bin));
      files.push(f);
    }
    written.push(...files);
    done.push({ tool: t.tool, files: files.length, invoke: t.invoke('browse') });
  }
  fs.mkdirSync(path.dirname(MANIFEST(home)), { recursive: true });
  let prev = [];
  try { prev = JSON.parse(fs.readFileSync(MANIFEST(home), 'utf8')); } catch {}
  fs.writeFileSync(MANIFEST(home), JSON.stringify([...new Set([...prev, ...written])], null, 2));
  return done;
}

/** Remove exactly the files install wrote. → count */
export function uninstall({ home = os.homedir() } = {}) {
  let list = [];
  try { list = JSON.parse(fs.readFileSync(MANIFEST(home), 'utf8')); } catch {}
  let n = 0;
  for (const f of list) {
    // Only ox's own files: ox-<name>.md commands and the ox skill.
    if (!/[/\\](ox-[\w-]+\.md|ox[/\\]SKILL\.md)$/.test(f)) continue;
    try { fs.rmSync(f); n++; } catch {}
    if (f.endsWith(`${path.sep}SKILL.md`)) { try { fs.rmdirSync(path.dirname(f)); } catch {} }
  }
  fs.rmSync(MANIFEST(home), { force: true });
  return n;
}
