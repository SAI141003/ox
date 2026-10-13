// Which shell runs a command, on every OS. One place, so the bash tool, hooks,
// arena tests and the terminal all agree.
//
//   macOS / Linux  $SHELL, else the first of zsh, bash, sh that exists
//   Windows        Git Bash when installed (models write bash), else PowerShell
import fs from 'node:fs';
import path from 'node:path';

let cached = null;

function exists(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function onPath(name, env) {
  for (const dir of String(env.PATH ?? env.Path ?? '').split(';')) {
    if (dir && exists(path.join(dir, name))) return path.join(dir, name);
  }
  return null;
}

// { kind: 'posix' | 'powershell', path }
export function detectShell({ platform = process.platform, env = process.env, fresh = false } = {}) {
  if (cached && !fresh && platform === process.platform && env === process.env) return cached;
  let out;
  if (platform === 'win32') {
    const gitBash = [
      env.OX_SHELL,
      path.join(env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
      path.join(env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
      path.join(env.LOCALAPPDATA ?? '', 'Programs', 'Git', 'bin', 'bash.exe'),
    ].find((p) => p && exists(p));
    if (gitBash) out = { kind: /powershell|pwsh/i.test(gitBash) ? 'powershell' : 'posix', path: gitBash };
    else out = { kind: 'powershell', path: onPath('pwsh.exe', env) ?? 'powershell.exe' };
  } else {
    const p = env.OX_SHELL || env.SHELL || ['/bin/zsh', '/bin/bash', '/bin/sh'].find(exists) || '/bin/sh';
    out = { kind: 'posix', path: p };
  }
  if (platform === process.platform && env === process.env) cached = out;
  return out;
}

// argv for running one command string. `login` sources the profile (PATH from
// nvm, brew and the like), which is what a person's own terminal would have.
export function shellArgv(command, { login = true, ...opts } = {}) {
  const sh = detectShell(opts);
  if (sh.kind === 'powershell') return [sh.path, '-NoProfile', '-NonInteractive', '-Command', command];
  return [sh.path, login ? '-lc' : '-c', command];
}

// One line for the system prompt, so the model writes commands for the shell
// that will actually run them.
export function shellNote(opts = {}) {
  const sh = detectShell(opts);
  if (sh.kind === 'powershell') return 'The bash tool runs PowerShell on this Windows machine (no Git Bash found): write PowerShell commands, not bash.';
  if ((opts.platform ?? process.platform) === 'win32') return 'The bash tool runs Git Bash on Windows: use bash syntax and forward-slash paths.';
  return '';
}
