// Type errors after an edit, from a language server already on this machine. Nothing is
// installed: a project's node_modules/.bin, then PATH. No server, no message, no delay beyond
// a lookup. A server that is slow to answer costs the edit at most a few seconds, and the
// model simply hears nothing. Off: OX_LSP=0, or `"lsp": false` in the config.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SERVERS = [
  { exts: /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i, langs: { '.ts': 'typescript', '.tsx': 'typescriptreact', '.mts': 'typescript', '.cts': 'typescript', '.jsx': 'javascriptreact' }, lang: 'javascript', roots: ['tsconfig.json', 'jsconfig.json', 'package.json'], cmds: [['typescript-language-server', '--stdio']], needsRoot: true },
  { exts: /\.py$/i, lang: 'python', roots: ['pyproject.toml', 'setup.py', 'requirements.txt'], cmds: [['pyright-langserver', '--stdio'], ['basedpyright-langserver', '--stdio'], ['pylsp']] },
  { exts: /\.go$/i, lang: 'go', roots: ['go.mod'], cmds: [['gopls']] },
  { exts: /\.rs$/i, lang: 'rust', roots: ['Cargo.toml'], cmds: [['rust-analyzer']] },
  { exts: /\.(c|h|cc|cpp|hpp|cxx)$/i, langs: { '.c': 'c', '.h': 'c' }, lang: 'cpp', roots: ['compile_commands.json', 'CMakeLists.txt'], cmds: [['clangd']] },
];

const clients = new Map();
const IDLE_MS = 5 * 60_000;

export function lspEnabled(env = process.env, config = {}) {
  if (env.OX_LSP === '0' || config?.lsp === false) return false;
  // A test's folders must not start whatever server this machine has.
  if (env.NODE_TEST_CONTEXT && env.OX_LSP !== '1') return false;
  return true;
}

function which(cmd, cwd, env) {
  if (cmd.includes(path.sep)) return fs.existsSync(cmd) ? cmd : null;
  for (let d = cwd; ; d = path.dirname(d)) {
    const local = path.join(d, 'node_modules', '.bin', cmd);
    if (fs.existsSync(local)) return local;
    if (path.dirname(d) === d) break;
  }
  for (const d of String(env.PATH ?? '').split(path.delimiter)) {
    if (!d) continue;
    const full = path.join(d, cmd);
    try { fs.accessSync(full, fs.constants.X_OK); return full; } catch {}
  }
  return null;
}

function rootOf(file, markers, stop) {
  for (let d = path.dirname(file); ; d = path.dirname(d)) {
    if (markers.some((m) => fs.existsSync(path.join(d, m)))) return d;
    if (d === stop || path.dirname(d) === d) return null;
  }
}

/** Which server would read this file, or null. */
export function serverFor(file, { cwd = process.cwd(), env = process.env } = {}) {
  const abs = path.resolve(cwd, file);
  // A whole path that exists is one command, spaces and all; otherwise "command --flag".
  const raw = String(env.OX_LSP_SERVER ?? '').trim();
  const custom = raw ? [fs.existsSync(raw) ? [raw] : raw.split(/\s+/)] : null;
  for (const s of SERVERS) {
    if (!s.exts.test(abs)) continue;
    const root = rootOf(abs, s.roots, path.resolve(cwd)) ?? path.resolve(cwd);
    if (s.needsRoot && !rootOf(abs, s.roots, path.resolve(cwd))) return null;
    for (const c of custom ?? s.cmds) {
      const bin = which(c[0], root, env);
      if (bin) return { bin, args: c.slice(1), root, languageId: s.langs?.[path.extname(abs).toLowerCase()] ?? s.lang };
    }
  }
  return null;
}

class Client {
  constructor({ bin, args, root, env }) {
    this.root = root;
    this.seq = 0;
    this.pending = new Map();
    this.waiting = new Map();
    this.diags = new Map();
    this.versions = new Map();
    this.buf = Buffer.alloc(0);
    this.dead = false;
    this.p = spawn(bin, args, { cwd: root, env, stdio: ['pipe', 'pipe', 'ignore'] });
    this.p.on('error', () => this.close());
    this.p.on('exit', () => this.close());
    this.p.stdin.on('error', () => this.close());
    this.p.stdout.on('data', (d) => this.receive(d));
    this.p.unref();
    this.p.stdout.unref?.();
    this.p.stdin.unref?.();
    const rootUri = pathToFileURL(root).href;
    this.ready = this.request('initialize', {
      processId: process.pid, rootUri, workspaceFolders: [{ uri: rootUri, name: path.basename(root) }],
      capabilities: { textDocument: { publishDiagnostics: {}, synchronization: { didSave: true } }, workspace: { workspaceFolders: true, configuration: true } },
    }).then(() => { this.notify('initialized', {}); return true; }, () => false);
    this.touch();
  }

  touch() {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.close(), IDLE_MS);
    this.idle.unref?.();
  }

  send(m) {
    if (this.dead) return;
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...m }));
    try { this.p.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body])); } catch { this.close(); }
  }

  request(method, params) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.send({ id, method, params }); });
  }

  notify(method, params) { this.send({ method, params }); }

  receive(d) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      const end = this.buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      const m = /content-length:\s*(\d+)/i.exec(this.buf.subarray(0, end).toString());
      if (!m) { this.buf = this.buf.subarray(end + 4); continue; }
      const len = Number(m[1]);
      if (this.buf.length < end + 4 + len) return;
      let msg = null;
      try { msg = JSON.parse(this.buf.subarray(end + 4, end + 4 + len).toString()); } catch {}
      this.buf = this.buf.subarray(end + 4 + len);
      if (msg) this.handle(msg);
    }
  }

  handle(msg) {
    if (msg.id != null && msg.method) {
      // A server asking us something (configuration, progress tokens): an empty answer is valid.
      const items = msg.method === 'workspace/configuration' ? (msg.params?.items ?? []).map(() => null) : null;
      this.send({ id: msg.id, result: items });
      return;
    }
    if (msg.id != null) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (p) (msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result));
      return;
    }
    if (msg.method === 'textDocument/publishDiagnostics') {
      const { uri, diagnostics } = msg.params ?? {};
      this.diags.set(uri, diagnostics ?? []);
      const w = this.waiting.get(uri);
      if (w) w();
    }
  }

  /** Open or update the file and wait for what the server says about it. */
  async check(abs, text, languageId, { settleMs = 250, timeoutMs = 3000 } = {}) {
    this.touch();
    const uri = pathToFileURL(abs).href;
    const version = (this.versions.get(uri) ?? 0) + 1;
    this.versions.set(uri, version);
    this.diags.delete(uri);
    const got = new Promise((resolve) => {
      let settle = null;
      // These two stay ref'd: they are short, and they keep the process alive while it waits.
      const end = setTimeout(() => { this.waiting.delete(uri); resolve(this.diags.get(uri) ?? null); }, timeoutMs);
      // Servers often publish twice (nothing yet, then the real errors). Errors are the answer
      // at once; an empty list waits a moment for a second publish, so a clean edit costs little.
      this.waiting.set(uri, () => {
        clearTimeout(settle);
        const now = this.diags.get(uri) ?? [];
        settle = setTimeout(() => { clearTimeout(end); this.waiting.delete(uri); resolve(this.diags.get(uri) ?? []); }, now.length ? 60 : settleMs);
      });
    });
    if (version === 1) {
      // At most 40 files open in the server: the oldest is closed first.
      if (this.versions.size > 40) {
        const oldest = this.versions.keys().next().value;
        if (oldest !== uri) { this.notify('textDocument/didClose', { textDocument: { uri: oldest } }); this.versions.delete(oldest); this.diags.delete(oldest); }
      }
      this.notify('textDocument/didOpen', { textDocument: { uri, languageId, version, text } });
    }
    else this.notify('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [{ text }] });
    return got;
  }

  close() {
    if (this.dead) return;
    this.dead = true;
    clearTimeout(this.idle);
    for (const p of this.pending.values()) p.reject(new Error('language server closed'));
    this.pending.clear();
    for (const w of [...this.waiting.values()]) w();
    try { this.p.kill(); } catch {}
    for (const [k, c] of clients) if (c === this) clients.delete(k);
  }
}

export function closeAllLsp() {
  for (const c of [...clients.values()]) c.close();
}
process.once('exit', closeAllLsp);

/** The errors in a file just written, as short lines for the model. '' when there is nothing to say. */
export async function diagnosticsFor(file, { cwd = process.cwd(), env = process.env, config = {}, startMs = 5000, timeoutMs = 3000, max = 10 } = {}) {
  if (!lspEnabled(env, config)) return '';
  const s = serverFor(file, { cwd, env });
  if (!s) return '';
  const abs = path.resolve(cwd, file);
  let text;
  try { text = fs.readFileSync(abs, 'utf8'); } catch { return ''; }
  if (text.length > 1_000_000) return '';
  const key = `${s.bin}\0${s.root}`;
  let c = clients.get(key);
  if (!c || c.dead) { c = new Client({ ...s, env }); clients.set(key, c); }
  let wait;
  const up = await Promise.race([c.ready, new Promise((r) => { wait = setTimeout(() => r('late'), startMs); })]);
  clearTimeout(wait);
  if (up !== true) return '';   // still starting (it keeps going for the next edit), or it failed
  const found = await c.check(abs, text, s.languageId, { timeoutMs });
  const errors = (found ?? []).filter((d) => (d.severity ?? 1) === 1);
  if (!errors.length) return '';
  const rel = path.relative(cwd, abs) || abs;
  const lines = errors.slice(0, max).map((d) => `${rel}:${(d.range?.start?.line ?? 0) + 1}:${(d.range?.start?.character ?? 0) + 1} ${String(d.message ?? '').split('\n')[0].slice(0, 200)}`);
  return `\n\nThe language server reports ${errors.length} error${errors.length === 1 ? '' : 's'} in this file now:\n${lines.join('\n')}${errors.length > max ? `\n… and ${errors.length - max} more` : ''}`;
}
