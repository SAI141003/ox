// Read-only services a machine on the mesh answers (docs/MESH_DESIGN.md,
// version 2), each behind the grant the owner of THIS machine gave the asking
// machine. Nothing here runs a command or changes a file on this machine:
//
//   status   describe: its makeup (hardware, system, agent tools, models)
//   agents      sessions, transcript reads, and supported session sends
//   files       ls and pull, only inside the folders this machine shares
//   files-write safe, separately granted small-file pushes
//
// Every request is written to ~/.ox/mesh/audit.jsonl on this machine.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const OP_GRANT = Object.freeze({ describe: 'status', agents: 'agents', 'agent-read': 'agents', 'agent-send': 'agents', 'agent-delivery': 'agents', ls: 'files', pull: 'files', push: 'files-write', 'dev-start': 'dev', 'dev-stop': 'dev', 'dev-list': 'dev', http: 'dev', screen: 'screen', 'control-list': 'control', 'control-click': 'control', 'control-type': 'control', 'control-key': 'control' });
const CHUNK = 48 * 1024;
const MAX_PUSH_BYTES = 8 * 1024 * 1024;
const b64 = (b) => Buffer.from(b).toString('base64');
const expand = (p) => String(p ?? '').replace(/^~(?=$|\/)/, os.homedir());

export const auditFile = (home) => path.join(home, 'mesh', 'audit.jsonl');
export function audit(home, row) {
  try {
    const f = auditFile(home);
    fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
    fs.appendFileSync(f, `${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`, { mode: 0o600 });
  } catch {}
}
export function readAudit(home, { limit = 50 } = {}) {
  try { return fs.readFileSync(auditFile(home), 'utf8').trim().split('\n').slice(-limit).map((l) => JSON.parse(l)).reverse(); } catch { return []; }
}

const has = (bin) => spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { encoding: 'utf8', timeout: 3000 }).status === 0;

/** The machine's makeup: hardware, system, agent tools, models, providers (names only, never keys). */
export async function describe({ ollamaUrl = 'http://127.0.0.1:11434', home = path.join(os.homedir(), '.ox') } = {}) {
  const out = {
    name: os.hostname().replace(/\.local$/, ''), os: `${os.type()} ${os.release()}`, platform: process.platform, arch: os.arch(),
    cpu: os.cpus()[0]?.model ?? null, cores: os.cpus().length, memGb: Math.round(os.totalmem() / 1e9), uptimeH: Math.round(os.uptime() / 3600),
    model: null, gpu: null, disks: [], tools: [], models: [], providers: [], ox: null, sessions: 0,
  };
  if (process.platform === 'darwin') {
    out.model = spawnSync('sysctl', ['-n', 'hw.model'], { encoding: 'utf8', timeout: 2000 }).stdout?.trim() || null;
    const g = spawnSync('system_profiler', ['SPDisplaysDataType', '-json'], { encoding: 'utf8', timeout: 8000 });
    try { const d = JSON.parse(g.stdout).SPDisplaysDataType?.[0]; out.gpu = d ? `${d.sppci_model ?? d._name}${d.sppci_cores ? `, ${d.sppci_cores} cores` : ''}` : null; } catch {}
    const v = spawnSync('sw_vers', ['-productVersion'], { encoding: 'utf8', timeout: 2000 }).stdout?.trim();
    if (v) out.os = `macOS ${v}`;
  }
  try { const s = fs.statfsSync(os.homedir()); out.disks.push({ path: os.homedir(), freeGb: Math.round((s.bavail * s.bsize) / 1e9), totalGb: Math.round((s.blocks * s.bsize) / 1e9) }); } catch {}
  for (const [bin, label] of [['claude', 'Claude Code'], ['codex', 'Codex'], ['gemini', 'Gemini CLI'], ['cursor-agent', 'Cursor'], ['copilot', 'Copilot CLI'], ['hermes', 'Hermes'], ['opencode', 'OpenCode'], ['ollama', 'Ollama'], ['gh', 'GitHub CLI'], ['docker', 'Docker'], ['git', 'git'], ['python3', 'Python'], ['ffmpeg', 'ffmpeg']]) if (has(bin)) out.tools.push(label);
  try { const r = await fetch(`${ollamaUrl.replace(/\/+$/, '')}/api/tags`, { signal: AbortSignal.timeout(1500) }); if (r.ok) out.models = ((await r.json()).models ?? []).map((m) => m.name); } catch {}
  try { out.providers = Object.keys(JSON.parse(fs.readFileSync(path.join(home, 'keys.json'), 'utf8'))).map((k) => k.replace(/_API_KEY$|_TOKEN$/, '').toLowerCase()); } catch {}
  try { out.ox = JSON.parse(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'package.json'), 'utf8')).version; } catch {}
  try { out.sessions = (await import('./agents-live.js')).liveAgents().length; } catch {}
  return out;
}

/** The real path when it is inside one of the shared folders; null when it is not. */
export function inside(target, roots) {
  const want = path.resolve(expand(target));
  let real;
  try { real = fs.realpathSync(want); } catch { return null; }
  for (const r of roots) {
    let rr; try { rr = fs.realpathSync(expand(r)); } catch { continue; }
    if (real === rr || real.startsWith(rr + path.sep)) return real;
  }
  return null;
}

// Resolve an upload destination through its existing parent so a symlink cannot
// turn a permitted root into a write outside it. New directory trees are not
// created remotely; the receiving machine owner chooses its shared folders.
function writeInside(target, roots) {
  const requested = path.resolve(expand(target));
  const parent = inside(path.dirname(requested), roots);
  if (!parent) return null;
  const name = path.basename(requested);
  if (!name || name === '.' || name === path.sep) return null;
  const destination = path.join(parent, name);
  try {
    const st = fs.lstatSync(destination);
    if (!st.isFile() || !inside(destination, roots)) return null;
  } catch (e) {
    if (e?.code !== 'ENOENT') return null;
  }
  return destination;
}

/** One read-only request from a paired machine. Returns true when `msg.op` is one of these. */
export async function serveOp({ ch, peer, msg, grants, roots, home, ollamaUrl, meName, remoteControl = null, agentRun = null }) {
  const op = msg.op;
  const need = OP_GRANT[op];
  if (!need) return false;
  const reply = (data) => ch.send({ t: 'res', rid: msg.rid, ok: true, data });
  const refuse = (why) => ch.send({ t: 'res', rid: msg.rid, ok: false, error: why });
  if (!grants[need]) { refuse(`${meName} does not allow ${need} for ${peer.name}: on ${meName}, run  ox mesh allow "${peer.name}" ${need}`); return true; }
  const a = msg.args ?? {};
  let detail = String(a.path ?? a.id ?? '').slice(0, 200);
  if (need === 'screen' || need === 'control') {
    const C = await import('./mesh-control.js');
    detail = C.controlAuditDetail(op, a);
  }
  audit(home, { from: peer.name, peer: peer.id, op, detail });

  if (need === 'screen' || need === 'control') {
    const C = await import('./mesh-control.js');
    const r = await (remoteControl ?? C.remoteControl)(op, a);
    if (r?.error) { refuse(r.error); return true; }
    if (op === 'screen') {
      const data = Buffer.from(r.data ?? []);
      for (let at = 0; at < data.length; at += CHUNK) ch.send({ t: 'chunk', rid: msg.rid, data: b64(data.subarray(at, at + CHUNK)) });
      reply({ mime: r.mime ?? 'image/png', size: data.length });
    } else reply(r);
    return true;
  }

  if (op === 'describe') { reply(await describe({ ollamaUrl, home })); return true; }
  if (op === 'agents') {
    const A = await import('./agents-live.js');
    reply({ sessions: A.liveAgents({ fresh: true }).map((s) => ({ id: s.id, tool: s.tool, project: s.project, state: s.state, doing: s.doing, idleSec: s.idleSec, model: s.model })) });
    return true;
  }
  if (op === 'agent-read') { const A = await import('./agents-live.js'); reply(await A.sessionMessages(String(a.id ?? ''), { home })); return true; }
  if (op === 'agent-send') {
    // A transcript being readable is not enough: sendToSession independently
    // verifies the target CLI's safe resume capability before starting a turn.
    const A = await import('./agents-live.js');
    reply(await A.sendToSession(String(a.id ?? ''), String(a.text ?? ''), { home, run: agentRun, model: String(a.model ?? '') }));
    return true;
  }
  if (op === 'agent-delivery') { const A = await import('./agents-live.js'); reply(A.deliveryStatus(String(a.ticket ?? ''), { home })); return true; }
  if (op === 'ls') {
    const d = inside(a.path ?? '~', roots);
    if (!d) { refuse(`${a.path ?? '~'} is outside the folders ${meName} shares, or does not exist`); return true; }
    const st = fs.statSync(d);
    if (!st.isDirectory()) { reply({ path: d, entries: [{ name: path.basename(d), dir: false, size: st.size, mtime: st.mtimeMs }] }); return true; }
    const entries = fs.readdirSync(d, { withFileTypes: true }).filter((e) => a.all || !e.name.startsWith('.')).slice(0, 2000).map((e) => {
      let size = null, mtime = null; try { const s = fs.statSync(path.join(d, e.name)); size = s.size; mtime = s.mtimeMs; } catch {}
      return { name: e.name, dir: e.isDirectory(), size, mtime };
    }).sort((x, y) => (y.dir - x.dir) || x.name.localeCompare(y.name));
    reply({ path: d, entries });
    return true;
  }
  // Dev servers (src/mesh-dev.js): the project's own start command, in a shared
  // folder; pages are read only from ports started this way.
  if (op === 'dev-start') {
    const d = inside(a.path ?? '', roots);
    if (!d || !fs.statSync(d).isDirectory()) { refuse(`${a.path} is not a folder ${meName} shares`); return true; }
    try { reply(await (await import('./mesh-dev.js')).startDev(d)); } catch (e) { refuse(`${meName}: ${e.message}`); }
    return true;
  }
  if (op === 'dev-stop') { reply({ stopped: (await import('./mesh-dev.js')).stopDev(a.port) }); return true; }
  if (op === 'dev-list') { reply({ servers: (await import('./mesh-dev.js')).listDev() }); return true; }
  if (op === 'http') {
    const D = await import('./mesh-dev.js');
    try {
      await D.forward(a, { onHead: (h) => ch.send({ t: 'head', rid: msg.rid, status: h.status, type: JSON.stringify(h.headers) }), onChunk: (c) => ch.send({ t: 'chunk', rid: msg.rid, data: b64(c) }) });
      reply({ done: true });
    } catch (e) { refuse(e.message); }
    return true;
  }
  if (op === 'pull') {
    const f = inside(a.path, roots);
    if (!f) { refuse(`${a.path} is outside the folders ${meName} shares, or does not exist`); return true; }
    const st = fs.statSync(f);
    if (st.isDirectory()) { refuse('copy one file at a time (a folder: copy its files)'); return true; }
    const rs = fs.createReadStream(f, { highWaterMark: CHUNK });
    rs.on('data', (d) => ch.send({ t: 'chunk', rid: msg.rid, data: b64(d) }));
    rs.on('end', () => reply({ size: st.size, name: path.basename(f) }));
    rs.on('error', (e) => refuse(e.message));
    return true;
  }
  if (op === 'push') {
    const encoded = String(a.data ?? '');
    if (!encoded || encoded.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) { refuse('upload data is not valid base64'); return true; }
    const data = Buffer.from(encoded, 'base64');
    if (!data.length || data.length > MAX_PUSH_BYTES) { refuse(`uploads must be between 1 byte and ${MAX_PUSH_BYTES / 1024 / 1024} MB`); return true; }
    const destination = writeInside(a.path, roots);
    if (!destination) { refuse(`${a.path ?? '(no destination)'} is not a regular file location inside folders ${meName} shares`); return true; }
    if (fs.existsSync(destination) && !a.overwrite) { refuse(`${destination} already exists; explicit overwrite is required`); return true; }
    const temp = path.join(path.dirname(destination), `.${path.basename(destination)}.ox-upload-${process.pid}-${Date.now()}`);
    try {
      fs.writeFileSync(temp, data, { mode: 0o600, flag: 'wx' });
      fs.renameSync(temp, destination);
      reply({ ok: true, path: destination, size: data.length, overwritten: !!a.overwrite });
    } catch (e) {
      try { fs.rmSync(temp, { force: true }); } catch {}
      refuse(`upload failed: ${e.message}`);
    }
    return true;
  }
  return false;
}
