// OX Island presence. The notch app (desktop/island) writes ~/.ox/island.json
// with its pid while it runs; an ox run that sees a live island binds a
// per-run IPC socket so the island can show it and answer approvals, with no
// --ipc flag needed. OX_ISLAND=0 opts a run out.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const islandFile = (home = os.homedir()) => path.join(home, '.ox', 'island.json');

export function islandRunning({ home = os.homedir(), env = process.env } = {}) {
  if (env.OX_ISLAND === '0') return false;
  let rec;
  try {
    rec = JSON.parse(fs.readFileSync(islandFile(home), 'utf8'));
  } catch {
    return false;
  }
  const pid = Number(rec?.pid);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0); // signal 0: existence check only
    return true;
  } catch (err) {
    return err?.code === 'EPERM'; // alive but owned by someone else
  }
}
