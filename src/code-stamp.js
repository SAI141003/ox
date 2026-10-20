// When ox's own code last changed (a commit, a pull, an edit): the newest
// modification time among bin/ and src/ (two levels) and the app page. The
// app's server compares it with its start time, so a running app never keeps
// serving yesterday's code.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Call `fn` when a file under bin/ or src/ changes, through the file system's own
 * notices (FSEvents on macOS), so nothing runs while nothing changes. false when
 * this platform cannot watch a folder tree (the caller then checks on a timer).
 */
export function onCodeChange(fn, root = ROOT) {
  const watchers = [];
  try {
    for (const d of ['bin', 'src']) {
      const w = fs.watch(path.join(root, d), { recursive: true, persistent: false }, (_e, name) => { if (!name || /\.(js|mjs|html|css|json)$/.test(String(name))) fn(); });
      w.on('error', () => {});
      watchers.push(w);
    }
    return true;
  } catch {
    for (const w of watchers) try { w.close(); } catch {}
    return false;
  }
}

export function codeStamp(root = ROOT) {
  let newest = 0;
  const look = (dir, depth) => {
    let names = [];
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of names) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) { if (depth > 0 && d.name !== 'node_modules') look(p, depth - 1); continue; }
      if (!/\.(js|mjs|html|css|json)$/.test(d.name)) continue;
      try { const m = fs.statSync(p).mtimeMs; if (m > newest) newest = m; } catch {}
    }
  };
  look(path.join(root, 'bin'), 0);
  look(path.join(root, 'src'), 2);
  return newest;
}
