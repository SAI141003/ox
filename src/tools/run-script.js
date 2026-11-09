// run_script: many read-only tool calls in one model call, so what each returns does not cross
// the model's context unless the script prints it. Reading 40 files to count something costs a
// few hundred tokens this way. It runs in its own Node with the permission system on: no file
// writes, no child processes. It asks first like a command, since a script can reach the network.
import { spawn } from 'node:child_process';
import os from 'node:os';

export const RUN_SCRIPT_TOOLS = Object.freeze(['run_script']);
export const RUN_SCRIPT_KEYWORDS = Object.freeze(['every', 'across', 'count', 'summarise', 'summarize', 'audit', 'inventory', 'bulk']);
const ALLOWED = new Set(['read_file', 'glob', 'grep', 'list_dir', 'code_graph']);
const MAX_CALLS = 300;
const MAX_OUT = 20_000;

export const RUN_SCRIPT_TOOL_SCHEMAS = [{
  name: 'run_script',
  description: 'Run a short JavaScript that calls read-only tools many times and prints only what you need: far fewer tokens than calling them one by one when going over many files. `await tools.read_file({path})`, `tools.glob({pattern})`, `tools.grep({pattern, path})`, `tools.list_dir({path})`, `tools.code_graph({...})` each return the tool\'s text. Use console.log for the result. No file writes or processes. Args: code (REQUIRED), timeoutSeconds (optional, default 60, at most 120).',
  input_schema: { type: 'object', properties: { code: { type: 'string' }, timeoutSeconds: { type: 'number' } }, required: ['code'] },
}];

const BOOT = String.raw`
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const log = (...a) => send({ log: a.map((x) => typeof x === 'string' ? x : JSON.stringify(x, null, 1)).join(' ') });
console.log = log; console.info = log; console.warn = log; console.error = log;
let seq = 0; const waiting = new Map();
let buf = '';
process.stdin.on('data', (d) => {
  buf += d; let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    const m = JSON.parse(line);
    if (m.code != null) { start(m.code); continue; }
    const w = waiting.get(m.id); waiting.delete(m.id);
    if (w) (m.error ? w.reject(new Error(m.error)) : w.resolve(m.content));
  }
});
const tools = new Proxy({}, { get: (_, name) => (args = {}) => new Promise((resolve, reject) => { const id = ++seq; waiting.set(id, { resolve, reject }); send({ id, tool: String(name), args }); }) });
delete globalThis.fetch; delete globalThis.WebSocket; delete globalThis.EventSource;
// The permission system stops writes and processes; this stops the network modules too.
{ const get = process.getBuiltinModule; const NO = /^(node:)?(net|http|https|http2|tls|dgram|dns|child_process|cluster|worker_threads|inspector|vm)(\/|$)/;
  process.getBuiltinModule = (id) => { if (NO.test(String(id))) throw new Error(String(id) + ' is not available in a script'); return get(id); };
  process.binding = () => { throw new Error('not available in a script'); }; process._linkedBinding = process.binding; }
const AsyncFunction = (async () => {}).constructor;
async function start(code) {
  try { const r = await new AsyncFunction('tools', code)(tools); if (r !== undefined) log(r); send({ done: true }); }
  catch (e) { send({ fail: String(e && e.message || e) }); }
  process.exit(0);
}
`;

const permissionFlag = () => (process.allowedNodeEnvironmentFlags.has('--permission') ? '--permission' : '--experimental-permission');

export async function runScriptTool(args = {}, ctx = {}) {
  const code = String(args.code ?? '');
  if (!code.trim()) return { content: 'run_script: code is required', isError: true };
  if (!ctx.yolo) {
    if (!ctx.requestApproval) return { content: 'run_script requires approval', isError: true };
    if (!(await ctx.requestApproval('run_script', { code: code.slice(0, 300) }, `Run this read-only script?\n${code.slice(0, 1000)}`))) return { content: 'declined: run_script', isError: true };
  }
  const dir = os.tmpdir();
  const { dispatchTool } = await import('./index.js');
  const timeoutMs = Math.max(1, Math.min(120, Number(args.timeoutSeconds) || 60)) * 1000;
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, [permissionFlag(), '-e', BOOT], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '' } });
    let out = '', calls = 0, buf = '', err = '', settled = false;
    const finish = (r) => { if (settled) return; settled = true; clearTimeout(timer); try { child.kill('SIGKILL'); } catch {} resolve(r); };
    const timer = setTimeout(() => finish({ content: `run_script stopped after ${timeoutMs / 1000} s. Printed so far:\n${out.slice(0, MAX_OUT)}`, isError: true }), timeoutMs);
    const say = (m) => { try { child.stdin.write(`${JSON.stringify(m)}\n`); } catch {} };
    child.on('error', (e) => finish({ content: `run_script: ${e.message}`, isError: true }));
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', () => finish(out || !err ? { content: `${out.slice(0, MAX_OUT) || '(printed nothing)'}${out.length > MAX_OUT ? '\n… cut' : ''}\n[${calls} tool call${calls === 1 ? '' : 's'}]` } : { content: `run_script: ${err.slice(0, 800)}`, isError: true }));
    child.stdout.on('data', async (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.log != null) out += `${m.log}\n`;
        else if (m.fail != null) finish({ content: `run_script failed: ${m.fail}${out ? `\nPrinted so far:\n${out.slice(0, MAX_OUT)}` : ''}`, isError: true });
        else if (m.tool) {
          if (!ALLOWED.has(m.tool)) { say({ id: m.id, error: `${m.tool} is not available in a script: only ${[...ALLOWED].join(', ')}` }); continue; }
          if (++calls > MAX_CALLS) { say({ id: m.id, error: `more than ${MAX_CALLS} tool calls` }); continue; }
          dispatchTool(m.tool, m.args ?? {}, ctx).then((r) => say(r?.isError ? { id: m.id, error: String(r.content ?? '').slice(0, 500) } : { id: m.id, content: String(r?.content ?? '') }), (e) => say({ id: m.id, error: String(e?.message ?? e) }));
        }
      }
    });
    say({ code });
  });
}
