// Models that just stalled (a minute with no reply). An automatic fallback that stalled in the
// last half hour is passed over: a debug run sat four minutes on retries of one that stalled
// twice that morning. A model you chose yourself is never skipped; this only steers ox's own picks.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FILE = () => path.join(process.env.OX_HOME || path.join(os.homedir(), '.ox'), 'cache', 'stalls.json');
export const STALL_QUIET_MS = 30 * 60_000;

function read() {
  try { return JSON.parse(fs.readFileSync(FILE(), 'utf8')) ?? {}; } catch { return {}; }
}

export function noteStall(provider, model, now = Date.now()) {
  if (!provider || !model) return;
  const all = read();
  for (const [k, at] of Object.entries(all)) if (now - at > STALL_QUIET_MS) delete all[k];
  all[`${provider}:${model}`] = now;
  try { fs.mkdirSync(path.dirname(FILE()), { recursive: true }); fs.writeFileSync(FILE(), JSON.stringify(all)); } catch {}
}

export function stalledRecently(provider, model, now = Date.now()) {
  const at = read()[`${provider}:${model}`];
  return typeof at === 'number' && now - at < STALL_QUIET_MS;
}
