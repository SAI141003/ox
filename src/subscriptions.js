// Bring your own subscription. Someone already paying for Claude, ChatGPT,
// Gemini, Qwen, Kimi, Copilot or Cursor has that vendor's official CLI signed
// in on their machine. ox hands the turn to that CLI, in the project, and turns
// its output into ox's own events, so the REPL, `ox -p`, arena and the island
// all work with it unchanged.
//
// What ox does NOT do: read, copy or reuse anyone's login tokens. The vendor's
// own program does the talking, under the vendor's own terms, on the plan its
// owner signed in with. That is also why tools run inside that CLI (with its
// own permission rules) rather than through ox's tool loop.
//
// Bots: `<id>-plan` (claude-plan, chatgpt-plan, ...), optionally `:<model>`.
// More CLIs: config `subscriptions: { name: { bin, args: [..., "{prompt}"], format: "text" } }`.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// format: how the CLI's stdout is read.
//   claude-stream  Claude Code `--output-format stream-json`
//   codex-jsonl    Codex `exec --json`
//   gemini-stream  Gemini CLI / Qwen Code `--output-format stream-json`
//   text           anything else: stdout is the answer, verbatim
export const SUBSCRIPTION_CLIS = Object.freeze({
  claude: {
    label: 'Claude (Pro / Max) via Claude Code',
    bin: 'claude',
    install: 'npm install -g @anthropic-ai/claude-code',
    login: 'run `claude` once and sign in with your Claude account',
    format: 'claude-stream',
    args: ({ prompt, model, approval }) => [
      '-p', prompt, '--output-format', 'stream-json', '--verbose',
      '--permission-mode', approval === 'yolo' ? 'bypassPermissions' : approval === 'edits' ? 'acceptEdits' : approval === 'read' ? 'plan' : 'default',
      ...(model ? ['--model', model] : []),
    ],
  },
  chatgpt: {
    label: 'ChatGPT (Plus / Pro / Team) via Codex',
    bin: 'codex',
    install: 'npm install -g @openai/codex',
    login: 'run `codex login` and choose "Sign in with ChatGPT"',
    format: 'codex-jsonl',
    args: ({ prompt, model, approval }) => [
      'exec', '--json', '--skip-git-repo-check',
      '--sandbox', approval === 'read' ? 'read-only' : 'workspace-write',
      ...(approval === 'yolo' ? ['--full-auto'] : []),
      ...(model ? ['--model', model] : []),
      prompt,
    ],
  },
  gemini: {
    label: 'Gemini (Google account / AI Pro) via Gemini CLI',
    bin: 'gemini',
    install: 'npm install -g @google/gemini-cli',
    login: 'run `gemini` once and choose "Login with Google"',
    format: 'gemini-stream',
    args: ({ prompt, model, approval }) => [
      '-p', prompt, '--output-format', 'stream-json',
      ...(approval === 'yolo' ? ['--yolo'] : approval === 'edits' ? ['--approval-mode', 'auto_edit'] : []),
      ...(model ? ['--model', model] : []),
    ],
  },
  qwen: {
    label: 'Qwen (Alibaba account) via Qwen Code',
    bin: 'qwen',
    install: 'npm install -g @qwen-code/qwen-code',
    login: 'run `qwen` once and sign in with Qwen OAuth',
    format: 'text',
    args: ({ prompt, model, approval }) => [
      '-p', prompt,
      ...(approval === 'yolo' ? ['--yolo'] : approval === 'edits' ? ['--approval-mode', 'auto-edit'] : []),
      ...(model ? ['--model', model] : []),
    ],
  },
  kimi: {
    label: 'Kimi (Moonshot account) via Kimi CLI',
    bin: 'kimi',
    install: 'uv tool install kimi-cli',
    login: 'run `kimi` once and run /setup',
    format: 'text',
    args: ({ prompt, approval }) => ['--print', '-c', prompt, ...(approval === 'yolo' ? ['--yolo'] : [])],
  },
  copilot: {
    label: 'GitHub Copilot (Pro / Business) via Copilot CLI',
    bin: 'copilot',
    install: 'npm install -g @github/copilot',
    login: 'run `copilot` once and /login with GitHub',
    format: 'text',
    args: ({ prompt, model, approval }) => [
      '-p', prompt,
      ...(approval === 'yolo' ? ['--allow-all-tools'] : []),
      ...(model ? ['--model', model] : []),
    ],
  },
  cursor: {
    label: 'Cursor (Pro) via Cursor CLI',
    bin: 'cursor-agent',
    install: 'curl https://cursor.com/install -fsS | bash',
    login: 'run `cursor-agent login`',
    format: 'text',
    args: ({ prompt, model, approval }) => [
      '-p', prompt, '--output-format', 'text',
      ...(approval === 'yolo' ? ['--force'] : []),
      ...(model ? ['--model', model] : []),
    ],
  },
  // Open-source agents: each brings whatever provider or plan it is set up with.
  opencode: {
    label: 'opencode (open source; any provider it is signed in to)',
    bin: 'opencode',
    install: 'npm install -g opencode-ai',
    login: 'run `opencode auth login`',
    format: 'text',
    args: ({ prompt, model }) => ['run', ...(model ? ['--model', model] : []), prompt],
  },
  aider: {
    label: 'aider (open source; uses the keys aider is set up with)',
    bin: 'aider',
    install: 'python -m pip install aider-install && aider-install',
    login: 'set the provider key aider uses (see aider --help)',
    format: 'text',
    args: ({ prompt, model, approval }) => [
      '--message', prompt, '--no-stream', '--no-pretty',
      ...(approval === 'yolo' || approval === 'edits' ? ['--yes-always'] : []),
      ...(model ? ['--model', model] : []),
    ],
  },
  goose: {
    label: 'goose (open source, by Block)',
    bin: 'goose',
    install: 'brew install block-goose-cli',
    login: 'run `goose configure`',
    format: 'text',
    args: ({ prompt }) => ['run', '--no-session', '-t', prompt],
  },
  crush: {
    label: 'Crush (open source, by Charm)',
    bin: 'crush',
    install: 'brew install charmbracelet/tap/crush',
    login: 'run `crush` once and pick a provider',
    format: 'text',
    args: ({ prompt }) => ['run', prompt],
  },
  openhands: {
    label: 'OpenHands CLI (open source)',
    bin: 'openhands',
    install: 'uv tool install openhands',
    login: 'run `openhands` once and set a provider',
    format: 'text',
    args: ({ prompt }) => ['--headless', '-t', prompt],
  },
  iflow: {
    label: 'iFlow (open source; free iFlow account)',
    bin: 'iflow',
    install: 'npm install -g @iflow-ai/iflow-cli',
    login: 'run `iflow` once and sign in',
    format: 'text',
    args: ({ prompt, approval }) => ['-p', prompt, ...(approval === 'yolo' ? ['--yolo'] : [])],
  },
  amp: {
    label: 'Amp (Sourcegraph account)',
    bin: 'amp',
    install: 'npm install -g @sourcegraph/amp',
    login: 'run `amp login`',
    format: 'text',
    args: ({ prompt, approval }) => ['-x', prompt, ...(approval === 'yolo' ? ['--dangerously-allow-all'] : [])],
  },
  droid: {
    label: 'Droid (Factory account)',
    bin: 'droid',
    install: 'curl -fsSL https://app.factory.ai/cli | sh',
    login: 'run `droid` once and sign in',
    format: 'text',
    args: ({ prompt, model, approval }) => ['exec', ...(approval === 'yolo' ? ['--auto', 'high'] : approval === 'edits' ? ['--auto', 'low'] : []), ...(model ? ['-m', model] : []), prompt],
  },
  auggie: {
    label: 'Auggie (Augment account)',
    bin: 'auggie',
    install: 'npm install -g @augmentcode/auggie',
    login: 'run `auggie login`',
    format: 'text',
    args: ({ prompt }) => ['--print', prompt],
  },
});

// Config-defined CLIs: args are strings with {prompt} / {model} placeholders.
function userClis(config) {
  const out = {};
  const raw = config?.subscriptions;
  if (!raw || typeof raw !== 'object') return out;
  for (const [id, d] of Object.entries(raw)) {
    if (!d || typeof d.bin !== 'string' || !Array.isArray(d.args)) continue;
    out[id] = {
      label: d.label ?? `${id} via ${d.bin}`,
      bin: d.bin,
      install: d.install ?? `install ${d.bin}`,
      login: d.login ?? `sign in to ${d.bin}`,
      format: ['claude-stream', 'codex-jsonl', 'gemini-stream'].includes(d.format) ? d.format : 'text',
      args: ({ prompt, model }) => d.args.flatMap((a) => {
        const s = String(a);
        if (s === '{model}' || s.includes('{model}')) return model ? [s.replaceAll('{model}', model)] : [];
        return [s.replaceAll('{prompt}', prompt)];
      }),
      custom: true,
    };
  }
  return out;
}

export function allClis(config) {
  return { ...SUBSCRIPTION_CLIS, ...userClis(config) };
}

const PLAN_RE = /^([a-z][a-z0-9_-]*?)-plan(?::(.+))?$/i;

// `claude-plan` / `chatgpt-plan:gpt-5` → the target ox runs a turn against.
export function subscriptionTarget(spec, config = {}) {
  const m = PLAN_RE.exec(String(spec ?? '').trim());
  if (!m) return null;
  const id = m[1].toLowerCase();
  const cli = allClis(config)[id];
  if (!cli) return null;
  return {
    bot: `${id}-plan`,
    provider: 'subscription',
    subscription: id,
    model: m[2]?.trim() || null,
    baseUrl: null,
    keyEnv: null,
    pricing: null,
    window: 200000,
    desc: cli.label,
  };
}

export function findOnPath(bin, env = process.env, platform = process.platform) {
  if (bin.includes('/') || bin.includes('\\')) return fs.existsSync(bin) ? bin : null;
  // Windows finds `claude` as claude.cmd / claude.exe: try each PATHEXT ending.
  const exts = platform === 'win32'
    ? String(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase())
    : [''];
  for (const dir of String(env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, bin + ext);
      try {
        if (platform !== 'win32') fs.accessSync(p, fs.constants.X_OK);
        if (fs.statSync(p).isFile()) return p;
      } catch {}
    }
  }
  return null;
}

// How to start a found CLI without a shell. A Windows .cmd/.bat cannot be
// spawned directly (Node refuses since CVE-2024-27980), and running it through
// cmd.exe would let a prompt's & or | become commands. npm's .cmd shims name
// the script they run, so ox runs that script with node instead; any other
// batch file is refused rather than handed a prompt.
export function execPlan(where, platform = process.platform) {
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(where)) return { cmd: where, pre: [] };
  let text = '';
  try { text = fs.readFileSync(where, 'utf8'); } catch {}
  const m = /"%(?:~)?dp0%?\\([^"]+?\.(?:c?js|mjs))"/i.exec(text);
  if (!m) return { error: `${path.basename(where)} is a batch file ox cannot run safely; install the CLI's .exe or set its full path in config subscriptions.` };
  return { cmd: process.execPath, pre: [path.join(path.dirname(where), m[1])] };
}

// Where apps put their own copy of a CLI. Seen on a real Mac: the `claude` on
// PATH was a 500-byte stub from an install that never finished and the npm
// `codex` had lost its native part, while VS Code's Claude and ChatGPT
// extensions and the Claude app each carried a working copy. Newest first.
export function knownCopies(bin, home = os.homedir()) {
  const pick = (dir, re, tail) => {
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => re.test(n)); } catch { return []; }
    return names.sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).map((n) => path.join(dir, n, ...tail));
  };
  const exts = [path.join(home, '.vscode', 'extensions'), path.join(home, '.cursor', 'extensions'), path.join(home, '.vscode-insiders', 'extensions')];
  if (bin === 'claude') {
    const appDir = path.join(home, 'Library', 'Application Support', 'Claude', 'claude-code');
    const fromApp = pick(appDir, /^\d/, []).flatMap((v) => pick(v, /./, ['claude.app', 'Contents', 'MacOS', 'claude']));
    return [...exts.flatMap((d) => pick(d, /^anthropic\.claude-code-/, ['resources', 'native-binary', 'claude'])), ...fromApp];
  }
  if (bin === 'codex') {
    // openai.chatgpt-*/bin/<platform>/codex
    return exts.flatMap((d) => pick(d, /^openai\.chatgpt-/, ['bin'])).flatMap((binDir) => {
      try { return fs.readdirSync(binDir).map((plat) => path.join(binDir, plat, 'codex')); } catch { return []; }
    });
  }
  return [];
}

const versionOf = (file, env) => {
  const r = spawnSync(file, ['--version'], { encoding: 'utf8', timeout: 8000, env, windowsHide: true });
  return r.status === 0 ? ((r.stdout || '').trim().split('\n')[0] || 'ok') : null;
};

// Signed in? Answering --version is not enough: a CLI that is not signed in
// fails every prompt ("Not logged in"). Only CLIs that report it cheaply are
// asked; for the rest the answer is null (unknown), never a guess.
export function signInState(id, where, env = process.env) {
  if (id === 'claude') {
    const r = spawnSync(where, ['auth', 'status'], { encoding: 'utf8', timeout: 15000, env, windowsHide: true });
    try { return JSON.parse(r.stdout).loggedIn === true; } catch { return null; }
  }
  if (id === 'chatgpt') {
    const r = spawnSync(where, ['login', 'status'], { encoding: 'utf8', timeout: 15000, env, windowsHide: true });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    return /logged in/i.test(out) && !/not logged in/i.test(out) ? true : /not logged in/i.test(out) ? false : null;
  }
  return null;
}
export function signInHow(id, where, cli) {
  const q = /\s/.test(where) ? `"${where}"` : where;
  if (id === 'claude') return `in a terminal run ${q} then type /login and sign in with your Claude account (once)`;
  if (id === 'chatgpt') return `in a terminal run ${q} login and choose Sign in with ChatGPT (once)`;
  return cli.login;
}

// The copy ox will run: PATH first, else the first app copy that answers --version.
const resolved = new Map();
export function resolveCli(cli, env = process.env) {
  if (resolved.has(cli.bin)) return resolved.get(cli.bin);
  let out = null;
  const onPath = findOnPath(cli.bin, env);
  if (onPath && execPlan(onPath).error == null && versionOf(execPlan(onPath).cmd, env)) out = { where: onPath, from: 'PATH' };
  if (!out) {
    for (const p of knownCopies(cli.bin)) {
      if (fs.existsSync(p) && versionOf(p, env)) { out = { where: p, from: 'app' }; break; }
    }
  }
  if (out) resolved.set(cli.bin, out);
  return out;
}

// Installed is not enough: a half-installed CLI (a stub with no binary) is
// common, so each one has to answer --version before it counts as connected.
export function checkCli(id, config = {}, env = process.env) {
  const cli = allClis(config)[id];
  if (!cli) return { id, known: false };
  // A working copy inside an app or editor extension counts: use it.
  const app = resolveCli(cli, env);
  if (app?.from === 'app') {
    const version = versionOf(app.where, env);
    const signedIn = signInState(id, app.where, env);
    if (signedIn === false) return { id, label: cli.label, bin: cli.bin, path: app.where, installed: true, works: false, signedIn, version, via: 'app', problem: 'installed and working, but not signed in', fix: signInHow(id, app.where, cli) };
    return { id, label: cli.label, bin: cli.bin, path: app.where, installed: true, works: true, signedIn, version, via: 'app', login: cli.login };
  }
  const where = findOnPath(cli.bin, env);
  if (!where) {
    // On PATH but not runnable: a package whose install step never finished
    // leaves exactly this (a stub without the execute bit).
    const stub = String(env.PATH ?? '').split(path.delimiter).filter(Boolean).map((d) => path.join(d, cli.bin)).find((p) => fs.existsSync(p));
    if (stub) return { id, label: cli.label, bin: cli.bin, path: stub, installed: true, works: false, problem: `${stub} is there but cannot run (an unfinished install)`, fix: `reinstall: ${cli.install}` };
    return { id, label: cli.label, bin: cli.bin, installed: false, works: false, fix: cli.install, login: cli.login };
  }
  const plan = execPlan(where);
  if (plan.error) return { id, label: cli.label, bin: cli.bin, path: where, installed: true, works: false, problem: plan.error, fix: `reinstall: ${cli.install}` };
  const r = spawnSync(plan.cmd, [...plan.pre, '--version'], { encoding: 'utf8', timeout: 8000, env, windowsHide: true });
  const works = r.status === 0;
  const version = (r.stdout || '').trim().split('\n')[0] || null;
  const why = r.error?.code ?? (r.stderr || '').trim().split('\n').find(Boolean) ?? `exit ${r.status}`;
  return {
    id, label: cli.label, bin: cli.bin, path: where, installed: true, works, version,
    ...(works ? { login: cli.login } : { problem: String(why).slice(0, 160), fix: `reinstall: ${cli.install}` }),
  };
}

export function checkAll(config = {}, env = process.env) {
  return Object.keys(allClis(config)).map((id) => checkCli(id, config, env));
}

// ---- output parsers: one line in, ox events out ----

const preview = (v) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v ?? '');
  return s.length > 120 ? `${s.slice(0, 117)}...` : s;
};
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => p?.text ?? '').join('') : '');

function claudeLine(j, st) {
  const ev = [];
  if (j.type === 'system' && j.subtype === 'init' && j.model) st.model = j.model;
  if (j.type === 'assistant') {
    for (const part of j.message?.content ?? []) {
      if (part.type === 'text' && part.text) { ev.push({ type: 'text-delta', text: part.text }); st.text += part.text; }
      if (part.type === 'tool_use') { st.tools.set(part.id, Date.now()); ev.push({ type: 'tool-start', id: part.id, name: part.name, argsPreview: preview(part.input) }); }
    }
  }
  if (j.type === 'user') {
    for (const part of j.message?.content ?? []) {
      if (part.type !== 'tool_result') continue;
      const content = textOf(part.content);
      const t0 = st.tools.get(part.tool_use_id);
      ev.push({ type: 'tool-end', id: part.tool_use_id, name: null, ok: !part.is_error, isError: !!part.is_error, ms: t0 ? Date.now() - t0 : 0, bytes: content.length, content });
    }
  }
  if (j.type === 'result') {
    st.done = true;
    if (j.is_error) st.error = String(j.result ?? j.subtype ?? 'error');
    else if (!st.text && j.result) { ev.push({ type: 'text-delta', text: j.result }); st.text = j.result; }
    if (j.usage) st.usage = { inputTokens: j.usage.input_tokens ?? 0, outputTokens: j.usage.output_tokens ?? 0 };
    // The CLI's own estimate of what the turn would cost at API prices; on a
    // plan it is not billed per token, so it is reported as an estimate only.
    if (typeof j.total_cost_usd === 'number') st.estimateUsd = j.total_cost_usd;
  }
  return ev;
}

function codexLine(j, st) {
  const ev = [];
  const it = j.item ?? {};
  if (j.type === 'item.started' && it.type === 'command_execution') {
    st.tools.set(it.id, Date.now());
    ev.push({ type: 'tool-start', id: it.id, name: 'shell', argsPreview: preview(it.command) });
  }
  if (j.type === 'item.completed') {
    if (it.type === 'agent_message' && it.text) { ev.push({ type: 'text-delta', text: it.text }); st.text += it.text; }
    if (it.type === 'command_execution') {
      const content = String(it.aggregated_output ?? '');
      const t0 = st.tools.get(it.id);
      if (!t0) ev.push({ type: 'tool-start', id: it.id, name: 'shell', argsPreview: preview(it.command) });
      const ok = (it.exit_code ?? 0) === 0;
      ev.push({ type: 'tool-end', id: it.id, name: 'shell', ok, isError: !ok, ms: t0 ? Date.now() - t0 : 0, bytes: content.length, content });
    }
    if (it.type === 'file_change') {
      const files = (it.changes ?? []).map((c) => `${c.kind ?? 'edit'} ${c.path}`).join(', ');
      ev.push({ type: 'tool-start', id: it.id, name: 'edit', argsPreview: preview(files) });
      ev.push({ type: 'tool-end', id: it.id, name: 'edit', ok: it.status !== 'failed', isError: it.status === 'failed', ms: 0, bytes: files.length, content: files });
    }
  }
  if (j.type === 'turn.completed') {
    st.done = true;
    if (j.usage) st.usage = { inputTokens: j.usage.input_tokens ?? 0, outputTokens: j.usage.output_tokens ?? 0 };
  }
  if (j.type === 'turn.failed' || j.type === 'error') st.error = String(j.error?.message ?? j.message ?? 'codex failed');
  return ev;
}

function geminiLine(j, st) {
  const ev = [];
  if (j.type === 'message' && j.role === 'assistant' && j.content) { ev.push({ type: 'text-delta', text: j.content }); st.text += j.content; }
  if (j.type === 'tool_use') { st.tools.set(j.tool_id, Date.now()); ev.push({ type: 'tool-start', id: j.tool_id, name: j.tool_name, argsPreview: preview(j.parameters) }); }
  if (j.type === 'tool_result') {
    const content = typeof j.output === 'string' ? j.output : JSON.stringify(j.output ?? j.error ?? '');
    const ok = j.status !== 'error';
    const t0 = st.tools.get(j.tool_id);
    ev.push({ type: 'tool-end', id: j.tool_id, name: null, ok, isError: !ok, ms: t0 ? Date.now() - t0 : 0, bytes: content.length, content });
  }
  if (j.type === 'result') {
    st.done = true;
    if (j.status === 'error') st.error = String(j.error?.message ?? 'gemini failed');
    const s = j.stats ?? {};
    if (s.input_tokens != null || s.output_tokens != null) st.usage = { inputTokens: s.input_tokens ?? 0, outputTokens: s.output_tokens ?? 0 };
  }
  return ev;
}

const PARSERS = { 'claude-stream': claudeLine, 'codex-jsonl': codexLine, 'gemini-stream': geminiLine };

export function parseLine(format, line, st) {
  const fn = PARSERS[format];
  if (!fn) return [];
  let j;
  try { j = JSON.parse(line); } catch { return []; }
  return j && typeof j === 'object' ? fn(j, st) : [];
}

// The transcript so far, folded into one prompt: these CLIs take a single
// message, so earlier turns ride along as context rather than being lost.
export function foldPrompt(messages = []) {
  const turns = messages.filter((m) => (m?.role === 'user' || m?.role === 'assistant') && typeof m.content === 'string' && m.content.trim());
  const last = turns.at(-1);
  if (!last) return '';
  const earlier = turns.slice(0, -1).slice(-8);
  if (!earlier.length) return last.content;
  const ctx = earlier.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 4000)}`).join('\n\n');
  return `Earlier in this conversation:\n\n${ctx}\n\n---\n\n${last.content}`;
}

function approvalFor(ctx = {}) {
  if (ctx.mode === 'ask' || ctx.mode === 'plan' || ctx.approval === 'plan') return 'read';
  if (ctx.yolo) return 'yolo';
  if (ctx.approval === 'accept-edits') return 'edits';
  return 'default';
}

// One turn, run by the vendor's CLI, as ox events.
// Codex refuses a model a ChatGPT account cannot use (seen: its own config
// said gpt-5.5; the account allowed gpt-6-luna). With no model asked for, ox
// reads Codex's catalog, retries once with the first listed model and says so.
const CHATGPT_MODEL_REFUSED = /model is not supported when using Codex with a ChatGPT account/i;
export function codexListedModel(where, env = process.env) {
  const r = spawnSync(where, ['debug', 'models'], { encoding: 'utf8', timeout: 15000, env, windowsHide: true });
  if (r.status !== 0) return null;
  try {
    const j = JSON.parse(r.stdout);
    const list = Array.isArray(j) ? j : j.models ?? Object.values(j);
    return list.find((m) => (m.visibility ?? m.show_in_picker) === 'list')?.slug ?? null;
  } catch { return null; }
}

export async function* runSubscriptionTurn(opts = {}) {
  const { target, config = {}, ctx = {} } = opts;
  const held = [];
  let refused = null;
  for await (const ev of runSubscriptionOnce(opts)) {
    if (ev.type === 'error' && CHATGPT_MODEL_REFUSED.test(ev.error) && target?.subscription === 'chatgpt' && !target.model) { refused = ev; continue; }
    if (refused && (ev.type === 'history' || ev.type === 'turn-end')) { held.push(ev); continue; }
    yield ev;
  }
  if (!refused) return;
  const cli = allClis(config).chatgpt;
  const env = { ...process.env, ...(ctx.env ?? {}) };
  const where = cli && resolveCli(cli, env)?.where;
  const model = where ? codexListedModel(where, env) : null;
  if (!model) { yield refused; for (const ev of held) yield ev; return; }
  process.stderr.write(`ox: Codex's own setting asks for a model your ChatGPT account cannot use (${String(refused.error).match(/'([^']+)'/)?.[1] ?? 'its default'}); used ${model} instead. Set it in ~/.codex/config.toml or pick one: ox --bot chatgpt-plan:${model}\n`);
  yield* runSubscriptionOnce({ ...opts, target: { ...target, model } });
}

async function* runSubscriptionOnce({ target, messages = [], ctx = {}, config = {}, signal } = {}) {
  const cli = allClis(config)[target.subscription];
  const cwd = ctx.cwd ?? config.cwd ?? process.cwd();
  const env = { ...process.env, ...(ctx.env ?? {}) };
  const where = cli ? (resolveCli(cli, env)?.where ?? findOnPath(cli.bin, env)) : null;
  if (!where) {
    yield { type: 'error', error: `${target.bot}: ${cli?.bin ?? target.subscription} is not installed. Install: ${cli?.install ?? '?'} — then ${cli?.login ?? 'sign in'}. Check with: ox connect` };
    yield { type: 'turn-end', stopReason: 'error', iters: 0 };
    return;
  }
  const prompt = foldPrompt(messages);
  const approval = approvalFor(ctx);
  const args = cli.args({ prompt, model: target.model, approval });
  const st = { text: '', tools: new Map(), done: false, error: null, usage: null, estimateUsd: null, model: null };
  const plan = execPlan(where);
  if (plan.error) {
    yield { type: 'error', error: `${target.bot}: ${plan.error}` };
    yield { type: 'turn-end', stopReason: 'error', iters: 0 };
    return;
  }
  const child = spawn(plan.cmd, [...plan.pre, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const onAbort = () => { try { child.kill('SIGTERM'); } catch {} };
  signal?.addEventListener?.('abort', onAbort, { once: true });

  // Line-by-line, as it arrives: the user sees the vendor's agent work live.
  const queue = [];
  let wake = null;
  let closed = false;
  let exitCode = null;
  let stderr = '';
  let pending = '';
  let spawnError = null;
  const push = (evs) => { if (evs.length) { queue.push(...evs); wake?.(); } };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    if (cli.format === 'text') { st.text += d; push([{ type: 'text-delta', text: d }]); return; }
    pending += d;
    let nl;
    while ((nl = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, nl).trim();
      pending = pending.slice(nl + 1);
      if (line) push(parseLine(cli.format, line, st));
    }
  });
  child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
  child.on('error', (e) => { spawnError = e; });
  child.on('close', (code) => {
    if (pending.trim() && cli.format !== 'text') push(parseLine(cli.format, pending.trim(), st));
    exitCode = code;
    closed = true;
    wake?.();
  });

  while (true) {
    while (queue.length) yield queue.shift();
    if (closed) break;
    await new Promise((r) => (wake = r));
    wake = null;
  }
  signal?.removeEventListener?.('abort', onAbort);

  if (st.usage) yield { type: 'usage', ...st.usage, costUsd: null, model: st.model ?? target.model ?? target.bot, ...(st.estimateUsd != null ? { estimateUsd: st.estimateUsd } : {}), plan: target.subscription };
  const failed = spawnError || st.error || (exitCode !== 0 && !signal?.aborted);
  if (failed) {
    const why = spawnError?.message ?? st.error ?? (stderr.trim().split('\n').slice(-3).join(' ') || `exit ${exitCode}`);
    yield { type: 'error', error: `${target.bot} (${cli.bin}): ${why}` };
  }
  const message = { role: 'assistant', content: st.text.trim() };
  if (message.content) yield { type: 'final', message };
  yield { type: 'history', messages: [...messages.filter((m) => m?.role !== 'system'), ...(message.content ? [message] : [])] };
  yield { type: 'turn-end', stopReason: failed ? 'error' : signal?.aborted ? 'aborted' : 'end_turn', iters: 1 };
}
