// `--backend ssh:user@host[:/dir]`: the agent's shell commands run on another
// machine, over the ssh you already have set up, while ox stays here.
//
//   ssh -o BatchMode=yes -o ControlMaster=auto ... user@host -- 'cd <dir> && sh -lc <command>'
//
// One connection is opened on the first `bash` call and reused by every later
// one (ControlMaster), so a command does not pay for a new login each time.
//
// What it never does:
//   - accept a host key for you (no StrictHostKeyChecking=no): a host you have
//     not connected to yourself is refused, with the command to run once;
//   - ask for a password (BatchMode): it uses your keys or agent, or it stops;
//   - send this machine's environment variables to the host.
//
// ox's file tools (read, write, edit) still act on this machine's files; the
// agent is told so, and uses commands for files on the host.
//
// OX_SSH_BIN overrides the ssh executable; tests use it to record what ox asks ssh to do.

import { execFile, execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const sshBin = (env = process.env) => env.OX_SSH_BIN || 'ssh';

/** 'text' → a single-quoted shell word. */
export const shq = (text) => `'${String(text).replace(/'/g, `'\\''`)}'`;

/** Parse `ssh:[user@]host[:port][:/dir]` into a backend spec. Throws on anything ssh could read as an option. */
export function parseSshSpec(spec) {
  const m = /^ssh:([^:]+)(?::(\d{1,5}))?(?::(.+))?$/i.exec(String(spec ?? '').trim());
  if (!m) throw new Error(`invalid ssh backend '${spec}' (use ssh:user@host, ssh:user@host:/dir or ssh:user@host:2222:/dir)`);
  const [, dest, port, dir = '~'] = m;
  // A destination starting with '-' would be read by ssh as an option.
  if (!/^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*@)?[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(dest)) throw new Error(`invalid ssh destination '${dest}' (use user@host or a Host from ~/.ssh/config)`);
  if (port && (Number(port) < 1 || Number(port) > 65535)) throw new Error(`invalid ssh port '${port}'`);
  if (!/^(?:~|~\/|\/)[\w./ @+-]*$/.test(dir) || dir.split('/').includes('..')) throw new Error(`invalid remote directory '${dir}' (an absolute path, or one under ~)`);
  return { kind: 'ssh', dest, port: port ? Number(port) : null, dir, session: null };
}

function controlDir() {
  const dir = path.join(os.homedir(), '.ox', 'ssh');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** The options every ssh call of this backend uses. */
export function sshOptions(backend) {
  return [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=15',
    '-o', 'ControlMaster=auto',
    '-o', `ControlPath=${path.join(controlDir(), '%C')}`,
    '-o', 'ControlPersist=600',
    '-o', 'ServerAliveInterval=30',
    ...(backend.port ? ['-p', String(backend.port)] : []),
  ];
}

const cdTo = (dir) => (dir === '~' ? 'cd' : dir.startsWith('~/') ? `cd "$HOME"/${shq(dir.slice(2))}` : `cd ${shq(dir)}`);

/** ssh's own error, as something a person can act on. */
export function explainSshFailure(backend, detail) {
  const d = String(detail ?? '').trim().split('\n').filter(Boolean).pop() ?? '';
  if (/host key verification failed|no .* host key is known|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(String(detail))) return `ox does not accept a host key for you. Connect once yourself, check the key, then try again: ssh ${backend.port ? `-p ${backend.port} ` : ''}${backend.dest}`;
  if (/permission denied/i.test(d)) return `${backend.dest} refused the login. ox uses your ssh keys or agent and never asks for a password: check that \`ssh ${backend.dest}\` works without one`;
  if (/could not resolve hostname|connection refused|timed out|no route to host|network is unreachable/i.test(d)) return `could not reach ${backend.dest}: ${d}`;
  if (/no such file or directory|can't cd|cannot cd|not a directory/i.test(d)) return `the directory ${backend.dir} does not exist on ${backend.dest}`;
  return d || 'ssh failed with no message';
}

/** Why this host can't be used right now, or null when it can. Opens the shared connection. */
export function sshProblem(backend, env = process.env) {
  const r = spawnSync(sshBin(env), [...sshOptions(backend), backend.dest, '--', `${cdTo(backend.dir)} && pwd`], { encoding: 'utf8', timeout: 30_000 });
  if (r.error?.code === 'ENOENT') return 'ssh is not installed (or set OX_SSH_BIN)';
  if (r.error) return `ssh did not answer: ${r.error.message}`;
  if (r.status !== 0) return explainSshFailure(backend, r.stderr || r.stdout);
  const where = String(r.stdout ?? '').trim().split('\n').pop() ?? '';
  if (!where.startsWith('/')) return `ssh connected but ${backend.dir} could not be opened on ${backend.dest}`;
  backend.session = { dir: where, n: 0 };
  return null;
}

/** The session for this backend, opened once even when commands arrive together. */
export function ensureSshSession(backend, env = process.env) {
  if (backend.session) return Promise.resolve(backend.session);
  backend.starting ??= (async () => {
    const problem = sshProblem(backend, env);
    if (problem) throw new Error(problem);
    process.once('exit', () => closeSshSession(backend, env));
    return backend.session;
  })().finally(() => { backend.starting = null; });
  return backend.starting;
}

const pidFile = (n) => `/tmp/ox-ssh-${process.pid}-${n}.pid`;

/**
 * argv that runs `command` on the host, in the session directory. `id` is this
 * command's number: its remote process group is written down so a timeout or a
 * stop can end it (closing the ssh client alone leaves it running).
 */
export function sshExecArgv(backend, command, env = process.env) {
  const id = ++backend.session.n;
  const f = pidFile(id);
  const remote = `${cdTo(backend.session.dir)} && echo $$ > ${f}; sh -lc ${shq(command)}; s=$?; rm -f ${f}; exit $s`;
  return { id, argv: [sshBin(env), ...sshOptions(backend), backend.dest, '--', remote] };
}

/** Stop what command `id` left running on the host. */
export function interruptSsh(backend, id, env = process.env) {
  if (!backend?.session || !id) return;
  const f = pidFile(id);
  const remote = `p=$(cat ${f} 2>/dev/null) && { kill -TERM -- -"$p" 2>/dev/null || kill -TERM "$p" 2>/dev/null; }; rm -f ${f}; true`;
  try { execFileSync(sshBin(env), [...sshOptions(backend), backend.dest, '--', remote], { stdio: 'ignore', timeout: 15_000 }); } catch {}
}

/** Close the shared connection. */
export function closeSshSession(backend, env = process.env) {
  if (!backend?.session) return;
  backend.session = null;
  try { execFileSync(sshBin(env), [...sshOptions(backend), '-O', 'exit', backend.dest], { stdio: 'ignore', timeout: 10_000 }); } catch {}
}

/** One command, start to finish (for `ox backend check` and callers outside the agent loop). */
export async function sshRun(backend, command, env = process.env) {
  await ensureSshSession(backend, env);
  const { argv } = sshExecArgv(backend, command, env);
  try {
    const { stdout, stderr } = await execFileAsync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 600_000, maxBuffer: 16 * 1024 * 1024 });
    return { ok: true, stdout, stderr, exitCode: 0 };
  } catch (e) {
    return { ok: false, stdout: String(e?.stdout ?? ''), stderr: String(e?.stderr ?? e?.message ?? ''), exitCode: typeof e?.code === 'number' ? e.code : null };
  }
}

/** What the agent is told when its commands run on another machine. */
export function sshNote(backend) {
  return `Your shell commands (bash) run on another machine, ${backend.dest}, in ${backend.session?.dir ?? backend.dir}, not on this one. ` +
    'The file tools (read_file, write_file, edit_file, grep, list_dir) act on THIS machine\'s files. For a file on that machine, use a command (cat, sed, a heredoc). ' +
    'Paths from one machine mean nothing on the other.';
}
