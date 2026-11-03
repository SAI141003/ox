// Your own web search, open source and keyless: SearXNG, run on this machine.
// It asks Google, Bing, DuckDuckGo, Brave and others at once and answers in
// JSON, so web_search works with no account and no key.
//
//   ox search setup    download SearXNG into ~/.ox/searxng and start it
//   ox search status   installed? running? where?
//   ox search stop
//
// Once installed, web_search starts it on demand (start()), so it is there
// after a restart without a login item. OX_SEARXNG_URL still points at any
// other SearXNG you run (a server, a Docker container) and wins over this one.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

const REPO = 'https://github.com/searxng/searxng';
export const dir = () => path.join(process.env.OX_HOME || path.join(os.homedir(), '.ox'), 'searxng');
const port = () => Number(process.env.OX_SEARXNG_PORT) || 8888;
export const localUrl = () => `http://127.0.0.1:${port()}`;
const py = () => path.join(dir(), 'venv', process.platform === 'win32' ? 'Scripts\\python.exe' : 'bin/python');
const pidFile = () => path.join(dir(), 'server.pid');

export function installed() {
  // Written as setup's last step, so a half-finished setup is not "installed".
  return fs.existsSync(py()) && fs.existsSync(path.join(dir(), 'ready'));
}

// The URL web_search should use: yours if you set one, else the local install.
export function searxngUrl(env = process.env) {
  if (env.OX_SEARXNG_URL) return String(env.OX_SEARXNG_URL).replace(/\/+$/, '');
  // Tests never start a real search server.
  if (env.NODE_TEST_CONTEXT || env.OX_NO_LOCAL_SEARXNG === '1') return null;
  return installed() ? localUrl() : null;
}

export async function running(url = localUrl(), ms = 1500) {
  try {
    const r = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(ms) });
    return r.ok;
  } catch {
    return false;
  }
}

let starting = null;
// Starts the local SearXNG if it is installed and not answering; resolves true
// once it answers. Concurrent searches share one start.
export function start({ waitMs = 15_000 } = {}) {
  if (!installed()) return Promise.resolve(false);
  starting ??= (async () => {
    if (await running()) return true;
    const log = fs.openSync(path.join(dir(), 'server.log'), 'a');
    const child = spawn(py(), ['-m', 'searx.webapp'], {
      cwd: path.join(dir(), 'src'),
      env: { ...process.env, SEARXNG_SETTINGS_PATH: path.join(dir(), 'settings.yml') },
      stdio: ['ignore', log, log],
      detached: true,
    });
    child.unref();
    fs.writeFileSync(pidFile(), String(child.pid));
    const until = Date.now() + waitMs;
    while (Date.now() < until) {
      if (await running(localUrl(), 1000)) return true;
      if (child.exitCode !== null) return false;
      await new Promise((r) => setTimeout(r, 400));
    }
    return false;
  })().finally(() => { starting = null; });
  return starting;
}

export function stop() {
  try {
    const pid = Number(fs.readFileSync(pidFile(), 'utf8'));
    if (pid) process.kill(pid);
    fs.rmSync(pidFile(), { force: true });
    return true;
  } catch {
    return false;
  }
}

// JSON on, no rate limiter (it is only you), listening on this machine only.
function settingsYml() {
  return [
    'use_default_settings: true',
    'server:',
    `  secret_key: "${crypto.randomBytes(24).toString('hex')}"`,
    '  bind_address: "127.0.0.1"',
    `  port: ${port()}`,
    '  limiter: false',
    '  public_instance: false',
    'search:',
    '  formats: [html, json]',
    '',
  ].join('\n');
}

const has = (bin) => spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { stdio: 'ignore' }).status === 0;

// Downloads SearXNG and its Python packages into ~/.ox/searxng, then starts it.
// say(line) reports each step.
export async function setup({ say = () => {} } = {}) {
  const d = dir();
  fs.mkdirSync(d, { recursive: true });
  const run = (cmd, args, opts = {}) => {
    const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
    if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed`);
  };
  if (!has('git')) throw new Error('git is needed to download SearXNG (on a Mac: xcode-select --install)');
  if (!fs.existsSync(path.join(d, 'src', 'searx'))) {
    say(`downloading SearXNG from ${REPO}`);
    run('git', ['clone', '--depth', '1', REPO, path.join(d, 'src')]);
  }
  const venv = path.join(d, 'venv');
  const uv = has('uv');
  if (!fs.existsSync(py())) {
    say('making its own Python environment');
    // SearXNG supports current Python 3; uv fetches a known-good one if needed.
    if (uv) run('uv', ['venv', '--python', '3.12', venv]);
    else run(process.platform === 'win32' ? 'python' : 'python3', ['-m', 'venv', venv]);
  }
  say('installing its Python packages');
  const reqs = ['requirements.txt', 'requirements-server.txt'].filter((f) => fs.existsSync(path.join(d, 'src', f))).flatMap((f) => ['-r', path.join(d, 'src', f)]);
  if (uv) {
    const env = { ...process.env, VIRTUAL_ENV: venv };
    run('uv', ['pip', 'install', ...reqs], { env });
    // A fresh uv environment has no setuptools, which SearXNG's own install needs.
    run('uv', ['pip', 'install', 'setuptools', 'wheel'], { env });
    run('uv', ['pip', 'install', '--no-build-isolation', '-e', path.join(d, 'src')], { env });
  } else {
    run(py(), ['-m', 'pip', 'install', '-q', '--upgrade', 'pip', 'setuptools', 'wheel']);
    run(py(), ['-m', 'pip', 'install', '-q', ...reqs]);
    run(py(), ['-m', 'pip', 'install', '-q', '--no-build-isolation', '-e', path.join(d, 'src')]);
  }
  const settings = path.join(d, 'settings.yml');
  if (!fs.existsSync(settings)) fs.writeFileSync(settings, settingsYml(), { mode: 0o600 });
  fs.writeFileSync(path.join(d, 'ready'), new Date().toISOString());
  say('starting it');
  if (!(await start({ waitMs: 30_000 }))) throw new Error(`SearXNG did not start: see ${path.join(d, 'server.log')}`);
  return localUrl();
}
