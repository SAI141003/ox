// `--backend docker`: the agent's shell commands run inside a container, the
// way OpenHands sandboxes its agent, while ox itself stays on the host.
//
// One long-lived container per ox process, started lazily on the first `bash`
// call (a turn that never runs a command never pays for Docker):
//
//   docker run -d --rm --label ox.session=<pid> -v <project>:/workspace -w /workspace <image> sleep infinity
//   docker exec -i -w /workspace/<subdir> <id> sh -lc '<command>'
//
// The project is bind-mounted, so ox's file tools (read/write/edit, which run
// on the host) and the commands in the container see the same files. Nothing
// else from the host is visible inside: not $HOME, not ~/.ssh, not the host's
// environment variables. `--network none` is available for fully offline
// runs. The container is removed when ox exits.
//
// OX_DOCKER_BIN overrides the docker executable (podman works); tests use it
// to record exactly what ox asks Docker to do.

import { execFile, execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const DEFAULT_DOCKER_IMAGE = 'node:22-bookworm';
const WORKSPACE = '/workspace';

const dockerBin = (env = process.env) => env.OX_DOCKER_BIN || 'docker';

/** Parse `docker`, `docker:<image>`, or `docker:<image>:offline` into a backend spec. */
export function parseBackendSpec(spec, env = process.env) {
  const raw = String(spec ?? '').trim();
  if (!raw || raw === 'local') return null;
  const m = /^docker(?::(.+))?$/i.exec(raw);
  if (!m) throw new Error(`unknown backend '${raw}' (use local, docker, or docker:<image>)`);
  let image = m[1] || env.OX_DOCKER_IMAGE || DEFAULT_DOCKER_IMAGE;
  let network = 'bridge';
  if (/:offline$/.test(image)) {
    image = image.replace(/:offline$/, '') || DEFAULT_DOCKER_IMAGE;
    network = 'none';
  }
  if (!/^[\w./:@-]+$/.test(image)) throw new Error(`invalid image name '${image}'`);
  return { kind: 'docker', image, network, session: null };
}

/** Why Docker can't be used right now, or null when it can. */
export function dockerProblem(env = process.env) {
  const r = spawnSync(dockerBin(env), ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8', timeout: 15_000 });
  if (r.error?.code === 'ENOENT') return 'Docker is not installed (install Docker Desktop, or set OX_DOCKER_BIN)';
  // Docker Desktop's client has been observed to exit 0 while it writes
  // "Cannot connect to the Docker daemon" to stderr and leaves Server.Version
  // blank. A zero client exit is not a usable isolation engine.
  const version = String(r.stdout ?? '').trim();
  const detail = String(r.stderr || r.stdout || r.error?.message || '').trim().split('\n').pop();
  if (r.status !== 0 || !version || /cannot connect|is the docker daemon running/i.test(detail)) return `the Docker engine is not running: start Docker Desktop (${detail || 'no server version returned'})`;
  return null;
}

/**
 * Start the session container for `root`. Returns the session record.
 * Asynchronous: the first run may pull the image, and ox must stay responsive.
 */
export async function startSession(backend, root, env = process.env) {
  const args = [
    'run', '-d', '--rm',
    '--label', `ox.session=${process.pid}`,
    '--network', backend.network,
    '-v', `${root}:${WORKSPACE}`,
    '-w', WORKSPACE,
  ];
  // Files the container writes into the bind mount should belong to the user,
  // not root (Docker Desktop on macOS maps this itself).
  if (process.platform === 'linux' && typeof process.getuid === 'function') args.push('--user', `${process.getuid()}:${process.getgid()}`);
  args.push(backend.image, 'sleep', 'infinity');
  let id;
  try {
    const { stdout } = await execFileAsync(dockerBin(env), args, { encoding: 'utf8', timeout: 600_000, maxBuffer: 4 * 1024 * 1024 });
    id = String(stdout).trim().split('\n').pop() ?? '';
  } catch (e) {
    const why = String(e?.stderr || e?.message || e).trim().split('\n').pop();
    throw new Error(`could not start the ${backend.image} container: ${why}`);
  }
  if (!/^[0-9a-f]{12,64}$/i.test(id)) throw new Error(`docker run printed no container id (got '${id.slice(0, 80)}')`);
  backend.session = { id, root };
  // Removed on any exit, including Ctrl-C: `docker rm -f` is synchronous.
  const cleanup = () => stopSession(backend, env);
  process.once('exit', cleanup);
  return backend.session;
}

/**
 * The session for this backend, started once even when parallel commands
 * (subagents) arrive together. Throws a message a user can act on.
 */
export function ensureSession(backend, root, env = process.env) {
  if (backend.session) return Promise.resolve(backend.session);
  backend.starting ??= (async () => {
    const problem = dockerProblem(env);
    if (problem) throw new Error(problem);
    return startSession(backend, root, env);
  })().finally(() => { backend.starting = null; });
  return backend.starting;
}

export function stopSession(backend, env = process.env) {
  const s = backend?.session;
  if (!s) return;
  backend.session = null;
  try { execFileSync(dockerBin(env), ['rm', '-f', s.id], { stdio: 'ignore', timeout: 30_000 }); } catch {}
}

/** The container directory that mirrors host `cwd` (the workspace root when outside the project). */
export function containerCwd(root, cwd) {
  const rel = path.relative(root, cwd);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return WORKSPACE;
  return path.posix.join(WORKSPACE, ...rel.split(path.sep));
}

/** argv that runs `command` in the session container, from host `cwd`. */
export function execArgv(backend, cwd, command, env = process.env) {
  const s = backend.session;
  return [dockerBin(env), 'exec', '-i', '-w', containerCwd(s.root, cwd), s.id, 'sh', '-lc', command];
}

/**
 * Stop what a killed `docker exec` left running: killing the client does not
 * reach processes inside the container. `kill -TERM -1` signals every process
 * the container user may, except PID 1 (`sleep infinity`) which keeps the
 * session alive for the next command.
 */
export function interruptSession(backend, env = process.env) {
  const s = backend?.session;
  if (!s) return;
  try { execFileSync(dockerBin(env), ['exec', s.id, 'sh', '-c', 'kill -TERM -1 2>/dev/null; true'], { stdio: 'ignore', timeout: 10_000 }); } catch {}
}
