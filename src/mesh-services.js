// Read-only services a machine on the mesh answers (docs/MESH_DESIGN.md,
// version 2), each behind the grant the owner of THIS machine gave the asking
// machine. Nothing here runs a command or changes a file on this machine:
//
//   status   describe: its makeup (hardware, system, agent tools, models)
//   agents   agents: the sessions of any agent tool here; agent-read: one's messages
//   files    ls and pull, only inside the folders this machine shares
//
// Every request is written to ~/.ox/mesh/audit.jsonl on this machine.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const OP_GRANT = Object.freeze({ describe: 'status', agents: 'agents', 'agent-read': 'agents', ls: 'files', pull: 'files' });
const CHUNK = 48 * 1024;
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

/** One read-only request from a paired machine. Returns true when `msg.op` is one of these. */
export async function serveOp({ ch, peer, msg, grants, roots, home, ollamaUrl, meName }) {
  const op = msg.op;
  const need = OP_GRANT[op];
  if (!need) return false;
  const reply = (data) => ch.send({ t: 'res', rid: msg.rid, ok: true, data });
  const refuse = (why) => ch.send({ t: 'res', rid: msg.rid, ok: false, error: why });
  if (!grants[need]) { refuse(`${meName} does not allow ${need} for ${peer.name}: on ${meName}, run  ox mesh allow "${peer.name}" ${need}`); return true; }
  const a = msg.args ?? {};
  audit(home, { from: peer.name, peer: peer.id, op, detail: String(a.path ?? a.id ?? '').slice(0, 200) });

  if (op === 'describe') { reply(await describe({ ollamaUrl, home })); return true; }
  if (op === 'agents') {
    const A = await import('./agents-live.js');
    reply({ sessions: A.liveAgents({ fresh: true }).map((s) => ({ id: s.id, tool: s.tool, project: s.project, state: s.state, doing: s.doing, idleSec: s.idleSec, model: s.model })) });
    return true;
  }
  if (op === 'agent-read') { const A = await import('./agents-live.js'); reply(await A.sessionMessages(String(a.id ?? ''))); return true; }
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
  return false;
}
