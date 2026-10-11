import { spawn, execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

export const BACKEND_SCHEMA_VERSION = '1.0.0';

const LOCAL = {
  name: 'local',
  detect: () => true,
  connect: () => ({ ok: true, backend: 'local' }),
  async execute(command, opts = {}) {
    return new Promise((resolve, reject) => {
      const p = spawn(command, opts.args ?? [], { shell: true, stdio: ['ignore', 'pipe', 'pipe'], cwd: opts.cwd });
      let out = '', err = '';
      p.stdout.on('data', (d) => { out += d; });
      p.stderr.on('data', (d) => { err += d; });
      p.on('close', (code) => resolve({ ok: code === 0, stdout: out, stderr: err, exitCode: code }));
      p.on('error', reject);
    });
  },
  disconnect: () => ({ ok: true }),
};

const DOCKER = {
  name: 'docker',
  detect: () => { try { execSync('docker info', { stdio: 'ignore' }); return true; } catch { return false; } },
  connect: (cfg = {}) => ({ ok: true, backend: 'docker', socket: cfg.socket || '/var/run/docker.sock' }),
  async execute(command, opts = {}) {
    const args = ['run', '--rm', '-i', ...(opts.args ?? []), 'ox', 'sh', '-c', command];
    return LOCAL.execute(`docker ${args.join(' ')}`, { cwd: opts.cwd, args: [] });
  },
  disconnect: () => ({ ok: true }),
};

const SSH = {
  name: 'ssh',
  detect: () => { try { execSync('which ssh', { stdio: 'ignore' }); return true; } catch { return false; } },
  connect: (cfg = {}) => { if (!cfg.host) return { ok: false, error: 'host required' }; return { ok: true, backend: 'ssh', host: cfg.host, user: cfg.user || 'root', port: cfg.port || 22 }; },
  async execute(command, opts = {}) {
    const host = opts.host || 'localhost';
    const args = ['-o', 'StrictHostKeyChecking=no', `${opts.user || 'root'}@${host}`, command];
    return LOCAL.execute(`ssh ${args.join(' ')}`, { cwd: opts.cwd });
  },
  disconnect: () => ({ ok: true }),
};

const SINGULARITY = {
  name: 'singularity',
  detect: () => { try { execSync('singularity --version', { stdio: 'ignore' }); return true; } catch { return false; } },
  connect: (cfg = {}) => ({ ok: true, backend: 'singularity', image: cfg.image || '' }),
  async execute(command, opts = {}) { return LOCAL.execute(`singularity exec ${opts.image ?? 'ox.sif'} bash -c "${command}"`, { cwd: opts.cwd }); },
  disconnect: () => ({ ok: true }),
};

const MODAL = {
  name: 'modal',
  detect: () => { try { execSync('modal --version', { stdio: 'ignore' }); return true; } catch { return false; } },
  connect: (cfg = {}) => ({ ok: true, backend: 'modal', project: cfg.project || '' }),
  async execute(command, opts = {}) { return LOCAL.execute(`modal run ${opts.script ?? 'ox.py'} -- ${command}`, { cwd: opts.cwd }); },
  disconnect: () => ({ ok: true }),
};

const DAYTONA = {
  name: 'daytona',
  detect: () => { try { execSync('daytona version', { stdio: 'ignore' }); return true; } catch { return false; } },
  connect: (cfg = {}) => ({ ok: true, backend: 'daytona', server: cfg.server || 'default' }),
  async execute(command, opts = {}) { return LOCAL.execute(`daytona run ${command}`, { cwd: opts.cwd }); },
  disconnect: () => ({ ok: true }),
};

const VERCEL = {
  name: 'vercel',
  detect: () => { try { execSync('vercel --version', { stdio: 'ignore' }); return true; } catch { return false; } },
  connect: (cfg = {}) => ({ ok: true, backend: 'vercel', team: cfg.team || '' }),
  async execute(command, opts = {}) { return LOCAL.execute(`vercel ${command}`, { cwd: opts.cwd }); },
  disconnect: () => ({ ok: true }),
};

export const BACKENDS = { local: LOCAL, docker: DOCKER, ssh: SSH, singularity: SINGULARITY, modal: MODAL, daytona: DAYTONA, vercel: VERCEL };

export function resolveBackend(name) { return BACKENDS[String(name).toLowerCase()] ?? null; }

export function createBackendManager(cwd) {
  const connected = new Map();

  function detect() {
    const out = [];
    for (const [name, backend] of Object.entries(BACKENDS)) { if (backend.detect()) out.push(name); }
    return out;
  }

  function connect(name, config = {}) {
    const backend = resolveBackend(name);
    if (!backend) return { ok: false, error: `unknown backend: ${name}` };
    const info = backend.connect(config);
    if (info.ok) connected.set(name, { backend, config });
    return info;
  }

  async function execute(command, opts = {}) {
    const target = opts.backend || (connected.size === 1 ? [...connected.keys()][0] : 'local');
    const entry = connected.get(target);
    if (!entry) return LOCAL.execute(command, opts);
    return entry.backend.execute(command, { ...opts, host: opts.host });
  }

  function disconnect(name) {
    const target = name || (connected.size === 1 ? [...connected.keys()][0] : null);
    if (!target) return { ok: false };
    const entry = connected.get(target);
    if (!entry) return { ok: false };
    connected.delete(target);
    return entry.backend.disconnect();
  }

  function listConnected() { return [...connected.entries()].map(([n, e]) => ({ name: n, backend: e.backend.name, config: e.config })); }
  function getCurrent() { return connected.size > 0 ? [...connected.entries()][0] : null; }

  return { detect, connect, execute, disconnect, listConnected, getCurrent };
}
