// What the memory layer did, for the Memory page and the sleep pass: one JSON
// line per read (what was put in front of a run), write (remember / forget) or
// sleep (consolidation). Rows hold ids, counts and token estimates, never the
// text of a memory, so this log cannot leak what it describes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const KEEP = 400;
const MAX_BYTES = 256 * 1024;

export function memoryHome({ home = os.homedir() } = {}) {
  return process.env.OX_MEMORY_HOME || path.join(home, '.ox', 'memory');
}

export function eventsFile(opts = {}) {
  return path.join(memoryHome(opts), 'layer-events.jsonl');
}

const short = (v) => String(v ?? '').replace(/[^\w.:-]/g, '').slice(0, 40);

export function noteMemoryEvent(type, data = {}, { home, at = Date.now() } = {}) {
  if (!['read', 'write', 'sleep'].includes(type)) return null;
  const row = { at, type };
  for (const [k, v] of Object.entries(data)) {
    if (typeof v === 'number' && Number.isFinite(v)) row[k] = v;
    else if (typeof v === 'boolean') row[k] = v;
    else if (Array.isArray(v)) row[k] = v.slice(0, 24).map(short);
    else if (typeof v === 'string') row[k] = short(v);
  }
  try {
    const file = eventsFile({ home });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(row)}\n`, { mode: 0o600 });
    if (fs.statSync(file).size > MAX_BYTES) {
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-KEEP);
      fs.writeFileSync(`${file}.tmp`, `${lines.join('\n')}\n`, { mode: 0o600 });
      fs.renameSync(`${file}.tmp`, file);
    }
  } catch {}
  return row;
}

export function readMemoryEvents({ home, since = 0, limit = KEEP } = {}) {
  let text = '';
  try { text = fs.readFileSync(eventsFile({ home }), 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { const r = JSON.parse(line); if (r.at >= since) out.push(r); } catch {}
  }
  return out.slice(-limit);
}
