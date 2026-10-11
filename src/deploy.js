// src/deploy.js — One-click deploy previews.
// ESM, node built-ins only.
// Operations use per-target executables and argument arrays; failures are
// propagated honestly. preview() only reports readiness on an explicit signal.

import { execFileSync, spawn } from 'node:child_process';

export const DEPLOY_SCHEMA_VERSION = '1.0.0';

// Each target declares the executable and argv for every operation. A target
// without a given operation's entry is unsupported for that operation.
export const DEPLOY_TARGETS = {
  vercel: {
    name: 'Vercel', env: ['VERCEL_TOKEN'],
    deploy: { cmd: 'vercel', args: ['--prod', '--yes'] },
    preview: { cmd: 'vercel', args: ['dev'] },
    status: { cmd: 'vercel', args: ['ls'] },
    rollback: { cmd: 'vercel', args: ['rollback'] },
    list: { cmd: 'vercel', args: ['ls'] },
  },
  netlify: {
    name: 'Netlify', env: ['NETLIFY_AUTH_TOKEN'],
    deploy: { cmd: 'netlify', args: ['deploy', '--prod'] },
    preview: { cmd: 'netlify', args: ['dev'] },
    status: { cmd: 'netlify', args: ['status'] },
    list: { cmd: 'netlify', args: ['api', 'listSites'] },
  },
  docker: {
    name: 'Docker', env: ['DOCKER_HOST'],
    deploy: { cmd: 'docker', args: ['build', '-t', 'app', '.'] },
    status: { cmd: 'docker', args: ['ps'] },
    list: { cmd: 'docker', args: ['ps', '-a'] },
  },
  githubPages: {
    name: 'GitHub Pages', env: ['GITHUB_TOKEN'],
    deploy: { cmd: 'gh-pages', args: ['-d', 'dist'] },
  },
  render: {
    name: 'Render', env: ['RENDER_API_KEY'],
    deploy: { cmd: 'render', args: ['deploy'] },
    status: { cmd: 'render', args: ['services'] },
    rollback: { cmd: 'render', args: ['deploys', 'rollback'] },
    list: { cmd: 'render', args: ['deploys', 'list'] },
  },
  fly: {
    name: 'Fly.io', env: ['FLY_API_TOKEN'],
    deploy: { cmd: 'fly', args: ['deploy'] },
    status: { cmd: 'fly', args: ['status'] },
    rollback: { cmd: 'fly', args: ['releases', 'rollback'] },
    list: { cmd: 'fly', args: ['releases', 'list'] },
  },
};

function missingCli(t) {
  return { success: false, unavailable: true, reason: `no deploy operation wired for this target (is the CLI installed?)` };
}

export class Deployer {
  constructor(cwd, { execFile = execFileSync, spawnProcess = spawn } = {}) {
    this.cwd = cwd || process.cwd();
    this.execFile = execFile;
    this.spawnProcess = spawnProcess;
  }

  listTargets() {
    return Object.entries(DEPLOY_TARGETS).map(([id, t]) => ({
      id, name: t.name,
      operations: Object.keys(t).filter((k) => k !== 'name' && k !== 'env'),
    }));
  }

  _run(t, op) {
    const spec = t[op];
    if (!spec) return { ok: false, output: `${op} is not supported for this target`, unsupported: true };
    try {
      const output = this.execFile(spec.cmd, spec.args, {
        cwd: this.cwd, stdio: 'pipe', maxBuffer: 50 * 1024 * 1024,
        env: { ...process.env },
      }).toString();
      return { ok: true, output };
    } catch (e) {
      const errOut = (e.stdout ? e.stdout.toString() : '') + (e.stderr ? e.stderr.toString() : '');
      return { ok: false, output: errOut || e.message, code: e.status };
    }
  }

  deploy(target, opts = {}) {
    const t = DEPLOY_TARGETS[target];
    if (!t) throw new Error(`Unknown target: ${target}`);
    const start = Date.now();
    const r = this._run(t, 'deploy');
    const duration = Date.now() - start;
    if (!r.ok) return { success: false, url: null, output: r.output, duration };
    return { success: true, url: this._extractUrl(r.output), output: r.output, duration };
  }

  _extractUrl(output) {
    const match = String(output).match(/https?:\/\/[^\s]+/);
    return match ? match[0] : null;
  }

  getStatus(target) {
    const t = DEPLOY_TARGETS[target];
    if (!t) throw new Error(`Unknown target: ${target}`);
    const r = this._run(t, 'status');
    if (!r.ok) return { target, status: null, error: r.output };
    return { target, status: r.output.trim() };
  }

  rollback(target) {
    const t = DEPLOY_TARGETS[target];
    if (!t) throw new Error(`Unknown target: ${target}`);
    const r = this._run(t, 'rollback');
    if (!r.ok) return { rolledBack: false, target, error: r.output };
    return { rolledBack: true, target, output: r.output.trim() };
  }

  getDeployments(target) {
    const t = DEPLOY_TARGETS[target];
    if (!t) throw new Error(`Unknown target: ${target}`);
    const r = this._run(t, 'list');
    if (!r.ok) return { target, deployments: [], error: r.output };
    return { target, deployments: r.output.split('\n').filter(Boolean) };
  }

  // Resolves only after a complete output line advertises the local preview
  // URL at the requested port. This is CLI readiness, not an HTTP health check.
  // The returned process belongs to the caller, who must stop it when done.
  // Never fall back to the production deploy operation.
  preview(target, opts = {}) {
    const t = DEPLOY_TARGETS[target];
    if (!t) return Promise.reject(new Error(`Unknown target: ${target}`));
    const spec = t.preview;
    if (!spec) return Promise.reject(new Error(`preview is not supported for ${target}`));
    const port = Number(opts.port ?? 3000);
    const timeoutMs = Number(opts.timeoutMs ?? 10_000);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return Promise.reject(new Error('preview port must be an integer between 1 and 65535'));
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
      return Promise.reject(new Error('preview timeout must be a finite positive timer duration'));
    }
    const args = [...spec.args, target === 'vercel' ? '--listen' : '--port', String(port)];
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      const proc = this.spawnProcess(spec.cmd, args, {
        cwd: this.cwd,
        env: { ...process.env, PORT: String(port) },
        stdio: 'pipe',
      });
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        proc.stdout.off('data', onStdout);
        proc.stderr.off('data', onStderr);
        fn(value);
      };
      const check = (line) => {
        const text = line.replace(/\x1b\[[0-9;]*m/g, '');
        if (!/\b(?:ready|local|server (?:now )?(?:running|listening))\b/i.test(text)) return;
        for (const match of text.matchAll(/https?:\/\/[^\s<>]+/g)) {
          try {
            const url = new URL(match[0]);
            const actualPort = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
            if (!['localhost', '127.0.0.1', '[::1]', '0.0.0.0'].includes(url.hostname) || actualPort !== port) continue;
            finish(resolve, { ready: true, url: match[0], port, pid: proc.pid, process: proc });
            return;
          } catch { /* Ignore non-URL diagnostics. */ }
        }
      };
      const reader = () => {
        let pending = '';
        return (chunk) => {
          pending += chunk.toString();
          const lines = pending.split(/[\r\n]/);
          pending = lines.pop().slice(-8192);
          for (const line of lines) {
            if (settled) break;
            check(line);
          }
        };
      };
      const onStdout = reader();
      const onStderr = reader();
      proc.stdout.on('data', onStdout);
      proc.stderr.on('data', onStderr);
      // Keep error handling after settlement so a late child error cannot
      // become an unhandled EventEmitter error. Data listeners are removed.
      proc.on('error', (e) => finish(reject, e));
      proc.once('close', (code) => {
        finish(reject, new Error(`${target} preview exited early with code ${code}`));
      });
      timer = setTimeout(() => {
        finish(reject, new Error(`${target} preview produced no readiness signal within ${timeoutMs}ms`));
        try { proc.kill('SIGTERM'); } catch {}
      }, timeoutMs);
    });
  }
}

export function createDeployer(cwd) {
  return new Deployer(cwd);
}

export function formatDeployResult(result) {
  if (!result) return '';
  const lines = [];
  if (result.success !== undefined) lines.push(`Success: ${result.success ? 'yes' : 'no'}`);
  if (result.ready !== undefined) lines.push(`Ready: ${result.ready ? 'yes' : 'no'}`);
  if (result.url) lines.push(`URL: ${result.url}`);
  if (result.duration !== undefined) lines.push(`Duration: ${result.duration}ms`);
  if (result.error) lines.push(`Error: ${result.error}`);
  if (result.output) lines.push('Output:', result.output);
  return lines.join('\n');
}
