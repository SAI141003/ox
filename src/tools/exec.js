import { spawn } from 'node:child_process';
import path from 'node:path';
import { prepareSandbox, appendSandboxEvent } from '../sandbox.js';
import { sanitizeEnv } from '../env-sanitize.js';
import { ensureSession, execArgv, interruptSession } from '../docker-backend.js';
import { gitToplevel } from '../git-fast.js';
import { redactSecrets } from '../memory.js';
import { shellArgv } from '../shell.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 25_000;
const KILL_GRACE_MS = 3_000;
const COLLECT_HARD_CAP = 200_000;
const TRUNCATION_MARK = '\n[output truncated at 25,000 characters]';

// CATASTROPHIC: enforced unconditionally, even when ctx.yolo === true.
const CATASTROPHIC = [
  { re: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?\s*:/, reason: 'fork bomb' },
  { re: /(?<![\w-])mkfs(?:\.[a-z0-9]+)?\b/, reason: 'mkfs filesystem destruction' },
  { re: /(?<![\w-])dd\b[^|;&]*\bof=\/dev\//, reason: 'dd writing to a raw device' },
  { re: /(?<![\w-])find\b[^|;&]*\s-delete\b/, reason: 'find … -delete bulk deletion' },
  // Running code nobody has seen is how an injected instruction becomes code
  // execution, so these hold even under -y (bench/compare-features.mjs: Hermes
  // and ox both ran `curl … | sh` in permissive mode). Download the script to a
  // file, read it, then run it: three visible steps instead of one blind one.
  {
    re: /(?<![\w-])(?:curl|wget)\b[^|;&]*\|\s*(?:sudo\s+)?(?:ba|z|da|fi)?sh\b/,
    // ox-secure-ignore: the message of the rule that blocks this pattern.
    reason: 'piping remote content into a shell (curl/wget | sh) — save it to a file and read it before running it',
  },
  {
    re: /(?<![\w-])(?:base64|xxd|openssl\s+enc)\b[^|;&]*\|\s*(?:sudo\s+)?(?:ba|z|da|fi)?sh\b/,
    reason: 'decoded content piped into a shell (base64/hex | sh)',
  },
];

// EXTENDED: lifted when ctx.yolo === true.
const EXTENDED = [
  { re: /(?<![\w-])sudo(?![\w-])/, reason: 'use of sudo' },
  {
    re: /(?<![\w-])base64\b[^|;&]*(?:-d|--decode)[^|;&]*\|\s*(?:python3?|node)\b/,
    reason: 'decoded content piped into an interpreter (base64 -d | python/node)',
  },
];

function err(message) {
  return { content: message, isError: true };
}

function normalizeCommand(command) {
  return String(command)
    .replace(/\\(.)/g, '$1')
    .replace(/["'`]/g, '');
}

// ---- wave5a C: chain-aware bash analysis ------------------------------------

const WRAPPER_WORDS = new Set(['env', 'timeout', 'nice', 'ionice', 'chrt', 'stdbuf']);
const ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

// Quote-aware chain splitter: splits on && || ; | newline (and bare &),
// peeling wrapper prefixes (env/timeout/nice/ionice/chrt/stdbuf + their
// flags) and leading VAR=val assignments. words are fully unquoted.
export function parseChain(cmd) {
  const s = String(cmd ?? '');
  const segments = [];
  let words = [];
  let cur = '';
  let pendingOp = ';';
  let redirect = false;
  const flushWord = () => {
    if (cur !== '') {
      words.push(cur);
      cur = '';
    }
  };
  const flushSeg = () => {
    flushWord();
    segments.push({ op: pendingOp, words, redirect });
    words = [];
    redirect = false;
  };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "'") {
      let j = i + 1;
      while (j < s.length && s[j] !== "'") cur += s[j++];
      i = j;
      continue;
    }
    if (ch === '"') {
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\' && i + 1 < s.length && '"\\$`'.includes(s[i + 1])) {
          cur += s[i + 1];
          i += 2;
        } else {
          cur += s[i];
          i++;
        }
      }
      continue;
    }
    if (ch === '\\') {
      if (i + 1 < s.length) {
        cur += s[i + 1];
        i++;
      }
      continue;
    }
    if (ch === '&') {
      if (s[i + 1] === '&') {
        flushSeg();
        pendingOp = 'and';
        i++;
      } else {
        flushSeg();
        pendingOp = ';';
      }
      continue;
    }
    if (ch === '|') {
      if (s[i + 1] === '|') {
        flushSeg();
        pendingOp = 'or';
        i++;
      } else {
        flushSeg();
        pendingOp = '|';
      }
      continue;
    }
    if (ch === ';') {
      flushSeg();
      pendingOp = ';';
      continue;
    }
    if (ch === '\n') {
      flushSeg();
      pendingOp = '\n';
      continue;
    }
    if (ch === '>') {
      redirect = true;
      if (s[i + 1] === '>') i++;
      flushWord();
      continue;
    }
    if (ch === '<') {
      flushWord();
      continue;
    }
    if (/\s/.test(ch)) {
      flushWord();
      continue;
    }
    cur += ch;
  }
  flushSeg();
  while (segments.length && segments[segments.length - 1].words.length === 0 && !segments[segments.length - 1].redirect) {
    segments.pop();
  }
  return segments.map(peelSegment);
}

function peelSegment(seg) {
  let w = [...seg.words];
  for (;;) {
    let changed = false;
    while (w.length && ASSIGN_RE.test(w[0])) {
      w.shift();
      changed = true;
    }
    if (w.length && WRAPPER_WORDS.has(w[0])) {
      const head = w.shift();
      changed = true;
      while (w.length && w[0].startsWith('-') && w[0] !== '-') {
        const f = w.shift();
        if ((f === '-u' || f === '-p' || f === '-n' || f === '-s' || f === '-f') && w.length && !w[0].startsWith('-')) {
          w.shift();
        }
        if (f === '--') break;
      }
      if (head === 'timeout' && w.length >= 2 && /^\d+(?:\.\d+)?[smhd]?$/.test(w[0])) {
        w.shift();
      }
    }
    if (!changed) break;
  }
  return { ...seg, words: w };
}

const READONLY_CMDS = new Set([
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'file',
  'stat',
  'du',
  'df',
  'which',
  'env',
  'printenv',
  'date',
  'uname',
  'whoami',
  'pwd',
  'echo',
  'rg',
  'grep',
  'find',
  'git',
  'node',
  'python3',
  'sort',
  'uniq',
  'diff',
  'cmp',
  'sha256sum',
  'md5sum',
  'tree',
  'jq',
]);
const GIT_READONLY = new Set(['log', 'status', 'diff', 'show', 'branch', 'rev-parse']);
const MUTATING_FLOOR_WORDS = new Set([
  'xargs',
  'tee',
  'chmod',
  'chown',
  'mv',
  'cp',
  'mkdir',
  'touch',
  'kill',
  'pkill',
]);
const VERSION_FLAG_RE = /^(-v|-V|--version)$/;

// 'readonly' only when EVERY segment is provably read-only; anything unknown,
// redirected, or on the mutating floor floors the whole command.
export function classifySegments(segments) {
  let sawAny = false;
  for (const seg of Array.isArray(segments) ? segments : []) {
    const words = seg?.words ?? [];
    if (!words.length) continue;
    sawAny = true;
    if (seg.redirect) return 'mutating';
    if (words.some((w) => MUTATING_FLOOR_WORDS.has(w))) return 'mutating';
    const cmd = words[0];
    const rest = words.slice(1);
    if (!READONLY_CMDS.has(cmd)) return 'mutating';
    if (cmd === 'find' && rest.some((a) => /^(--delete|-delete|-exec|-execdir|-ok|-okdir)$/.test(a))) {
      return 'mutating';
    }
    // sort --compress-program spawns a compressor writing temp files.
    if (cmd === 'sort' && rest.some((a) => a.startsWith('--compress-program'))) {
      return 'mutating';
    }
    if (cmd === 'git') {
      const sub = (rest.find((a) => !a.startsWith('-')) ?? '').toLowerCase();
      if (!GIT_READONLY.has(sub)) return 'mutating';
    }
    if ((cmd === 'node' || cmd === 'python3') && !(rest.length > 0 && rest.every((a) => VERSION_FLAG_RE.test(a)))) {
      return 'mutating';
    }
  }
  return sawAny ? 'readonly' : 'mutating';
}

// Token-aware rm -rf check over parsed words (quote evasion killed).
function rmViolationWords(words) {
  for (let i = 0; i < words.length; i++) {
    if (words[i] !== 'rm') continue;
    const tokens = words.slice(i + 1);
    const flags = tokens.filter((t) => t.startsWith('-'));
    const targets = tokens.filter((t) => !t.startsWith('-'));
    const recursive = flags.some((f) => /^-\w*r/i.test(f) || /^--r/.test(f));
    if (!recursive) continue;
    const bad = targets.find(badRmTarget);
    if (bad != null) return `rm -rf targeting '${bad}'`;
    if (targets.length === 0) {
      return 'recursive rm with no explicit target (e.g. piped into xargs rm -rf)';
    }
  }
  return null;
}

function badRmTarget(t) {
  const s = t.replace(/\/+$/, '');
  if (s === '') return true;
  if (s.startsWith('/')) return true;
  if (s === '.' || s === '..' || s.startsWith('../')) return true;
  if (s.includes('~') || s.includes('*')) return true;
  if (/^\$\{?[A-Za-z_]/.test(s)) return true;
  return false;
}

function rmViolation(command) {
  const re = /(?<![\w@.-])rm\b([^\n|;&]*)/g;
  let m;
  while ((m = re.exec(command)) !== null) {
    const tokens = m[1].trim().split(/\s+/).filter(Boolean);
    const flags = tokens.filter((t) => t.startsWith('-'));
    const targets = tokens.filter((t) => !t.startsWith('-'));
    const recursive = flags.some((f) => /^-\w*r/i.test(f) || /^--r/.test(f));
    if (!recursive) continue;
    const bad = targets.find(badRmTarget);
    if (bad != null) return `rm -rf targeting '${bad}'`;
    if (targets.length === 0) {
      return 'recursive rm with no explicit target (e.g. piped into xargs rm -rf)';
    }
  }
  return null;
}

function killGroup(child, signal) {
  try {
    if (child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try {
      child.kill(signal);
    } catch {}
  }
}

function capCombined(stdout, stderr) {
  if (stdout.length + stderr.length <= MAX_OUTPUT_CHARS) {
    return { stdout, stderr, truncated: false };
  }
  let budget = MAX_OUTPUT_CHARS - TRUNCATION_MARK.length;
  if (budget < 1000) budget = 1000;
  const half = Math.floor(budget / 2);
  let o = Math.min(stdout.length, half);
  let e = Math.min(stderr.length, half);
  o = Math.min(stdout.length, budget - e);
  e = Math.min(stderr.length, budget - o);
  return { stdout: stdout.slice(0, o), stderr: stderr.slice(0, e), truncated: true };
}

export async function bashTool(args = {}, ctx = {}) {
  const command = typeof args.command === 'string' ? args.command : '';
  if (!command.trim()) {
    return err("bash: 'command' is required.");
  }
  const norm = normalizeCommand(command);
  for (const entry of CATASTROPHIC) {
    if (entry.re.test(norm)) {
      return { content: `Blocked by safety policy: ${entry.reason}`, isError: true };
    }
  }
  const rmBad = rmViolation(norm);
  if (rmBad) {
    return { content: `Blocked by safety policy: ${rmBad}`, isError: true };
  }
  if (!ctx.yolo) {
    for (const entry of EXTENDED) {
      if (entry.re.test(norm)) {
        return { content: `Blocked by safety policy: ${entry.reason}`, isError: true };
      }
    }
  }
  // Chain-aware per-segment analysis on parsed, unquoted words (belt #2).
  const segments = parseChain(command);
  for (const seg of segments) {
    const joined = seg.words.join(' ');
    for (const entry of CATASTROPHIC) {
      if (entry.re.test(joined)) {
        return { content: `Blocked by safety policy: ${entry.reason}`, isError: true };
      }
    }
    if (!ctx.yolo) {
      for (const entry of EXTENDED) {
        if (entry.re.test(joined)) {
          return { content: `Blocked by safety policy: ${entry.reason}`, isError: true };
        }
      }
    }
    const segRm = rmViolationWords(seg.words);
    if (segRm) {
      return { content: `Blocked by safety policy: ${segRm}`, isError: true };
    }
  }
  const timeoutRaw = Number(args.timeout_ms ?? args.timeoutMs);
  const timeoutMs =
    Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? Math.min(Math.trunc(timeoutRaw), 3_600_000) : DEFAULT_TIMEOUT_MS;
  const cwd =
    typeof ctx.cwd === 'string' && ctx.cwd && path.isAbsolute(ctx.cwd) ? ctx.cwd : process.cwd();

  // Wave5a A/B: OS sandbox runner (when ctx.sandbox is active) + sanitized
  // child env. The sandbox applies to the CHILD process tree only; in-process
  // node code is unaffected. Degraded runs fall back to userspace confinement.
  const sandboxProfile = ctx.sandbox && typeof ctx.sandbox === 'object' && ctx.sandbox.kind !== 'off' ? ctx.sandbox : null;
  let runner = null;
  if (sandboxProfile) {
    try {
      runner = prepareSandbox(sandboxProfile);
    } catch {}
  }
  const childEnv = sanitizeEnv(process.env, {
    mode: ctx.sandbox?.env_mode ?? 'core',
    exclude: sandboxProfile?.env_exclude,
    include: sandboxProfile?.env_include,
  });
  // The OS's shell: $SHELL on macOS/Linux, Git Bash or PowerShell on Windows.
  const shellCmd = shellArgv(command);
  let argv =
    runner && !runner.degraded && Array.isArray(runner.argvPrefix)
      ? [...runner.argvPrefix, ...shellCmd]
      : shellCmd;

  // --backend docker: the command runs in the session container (the
  // container is the sandbox); the project is mounted there at /workspace.
  const docker = ctx.backend?.kind === 'docker' ? ctx.backend : null;
  if (docker) {
    try {
      await ensureSession(docker, gitToplevel(cwd) ?? cwd);
    } catch (e) {
      return err(`bash (docker backend): ${e?.message ?? e}`);
    }
    argv = execArgv(docker, cwd, command);
  }

  let child;
  try {
    child = spawn(argv[0], argv.slice(1), {
      cwd,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
  } catch (e) {
    return err(`bash: failed to spawn shell — ${e?.message ?? e}`);
  }

  let stdout = '';
  let stderr = '';
  let spawnError = null;
  let timedOut = false;
  let killedWith = null;
  let settled = false;
  child.stdout.on('data', (d) => {
    if (stdout.length < COLLECT_HARD_CAP) stdout += d.toString();
  });
  child.stderr.on('data', (d) => {
    if (stderr.length < COLLECT_HARD_CAP) stderr += d.toString();
  });
  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    killedWith = 'SIGTERM';
    killGroup(child, 'SIGTERM');
    if (docker) interruptSession(docker);
    setTimeout(() => {
      if (!settled) {
        killedWith = 'SIGKILL';
        killGroup(child, 'SIGKILL');
      }
    }, KILL_GRACE_MS).unref?.();
  }, timeoutMs);

  let aborted = false;
  const exit = await new Promise((resolve) => {
    let code = null;
    let signal = null;
    child.on('error', (e) => {
      spawnError = e;
      if (!settled) {
        settled = true;
        resolve({ code: null, signal: null });
      }
    });
    child.on('close', (c, s) => {
      code = c;
      signal = s;
      if (!settled) {
        settled = true;
        resolve({ code, signal });
      }
    });
    if (ctx.signal) {
      const onAbort = () => {
        aborted = true;
        killedWith = 'SIGTERM';
        killGroup(child, 'SIGTERM');
        if (docker) interruptSession(docker);
        if (!settled) {
          settled = true;
          resolve({ code: null, signal: 'SIGTERM' });
        }
      };
      if (ctx.signal.aborted) onAbort();
      else ctx.signal.addEventListener('abort', onAbort, { once: true });
    }
  });
  settled = true;
  clearTimeout(timeoutTimer);

  if (spawnError) {
    return err(`bash: ${spawnError.message ?? spawnError}`);
  }

  // Wave5a A: sandbox violations surface as non-zero exits with stderr; log
  // them best-effort to the sandbox-events ledger (capped at 5MB).
  if (
    sandboxProfile &&
    runner?.backend !== 'none' &&
    !runner?.degraded &&
    exit.code != null &&
    exit.code !== 0 &&
    !timedOut &&
    !aborted
  ) {
    appendSandboxEvent({
      session: ctx.sessionId ?? null,
      'cmd-short': String(command).replace(/\s+/g, ' ').trim().slice(0, 80),
      result: `exit-${exit.code}`,
      backend: runner.backend,
      profile: sandboxProfile.name,
    });
  }

  const capped = capCombined(stdout, stderr);
  const exitLabel =
    exit.code === null
      ? `exit null (${exit.signal ?? (timedOut ? killedWith : 'unknown')})`
      : `exit ${exit.code}`;
  let content = exitLabel;
  if (capped.stdout.trim() !== '') {
    content += `\n--- stdout ---\n${capped.stdout.replace(/\n$/, '')}`;
  }
  if (capped.stderr.trim() !== '') {
    content += `\n--- stderr ---\n${capped.stderr.replace(/\n$/, '')}`;
  }
  if (timedOut) {
    content += `\n[timed out after ${timeoutMs}ms — terminated with ${killedWith}]`;
  }
  if (aborted) {
    content += '\n[aborted]';
  }
  if (capped.truncated) {
    content += TRUNCATION_MARK;
  }
  // A key printed by the command (cat .env, env, a config dump) never reaches the model.
  const red = redactSecrets(content);
  if (red.count) content = `${red.text}\n[ox: ${red.count} credential(s) redacted from this output]`;
  return { content, isError: exit.code !== 0 || timedOut || aborted };
}
