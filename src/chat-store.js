// Your chats and settings, in a file: ~/.ox/chats.json.
//
// They used to live only in the page's browser storage, which belongs to one
// exact address. The app's server moved to a new port now and then (an update, a
// restart), and each new port opened with an empty chat list and default settings.
// Nothing was deleted: the old ones sat in that port's storage. The file does not
// care about ports, and `recoverStranded` brings the old ones back, once.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const MAX_CHATS = 500;
const homeDir = (home) => home ?? process.env.OX_HOME ?? path.join(os.homedir(), '.ox');
export const chatsFile = (home) => path.join(homeDir(home), 'chats.json');

function read(home) {
  try { const j = JSON.parse(fs.readFileSync(chatsFile(home), 'utf8')); return j && typeof j === 'object' ? j : {}; } catch { return {}; }
}
function write(doc, home) {
  const f = chatsFile(home);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc), { mode: 0o600 });
  fs.renameSync(tmp, f);
}

const stamp = (c) => Number(c?.updated ?? c?.at ?? (String(c?.id ?? '').slice(1) || 0)) || 0;
/** One list from several, by chat id: the longer copy of a chat wins, then the newer. */
export function mergeChats(...lists) {
  const best = new Map();
  for (const list of lists) {
    for (const c of Array.isArray(list) ? list : []) {
      if (!c?.id || c.incognito) continue;
      const had = best.get(c.id);
      const more = (c.messages?.length ?? 0) - (had?.messages?.length ?? 0);
      if (!had || more > 0 || (more === 0 && stamp(c) > stamp(had))) best.set(c.id, c);
    }
  }
  return [...best.values()].sort((a, b) => stamp(b) - stamp(a)).slice(0, MAX_CHATS);
}

export function readStore({ home } = {}) {
  const d = read(home);
  return { chats: Array.isArray(d.chats) ? d.chats : [], prefs: d.prefs ?? null, recovered: d.recovered ?? false };
}

/** Save the list as the page has it (a deleted chat stays deleted), or the settings. */
export function saveStore({ chats, prefs } = {}, { home } = {}) {
  const d = read(home);
  if (Array.isArray(chats)) d.chats = chats.filter((c) => c?.id && !c.incognito).slice(0, MAX_CHATS);
  if (prefs && typeof prefs === 'object') d.prefs = prefs;
  write(d, home);
  return { saved: d.chats?.length ?? 0 };
}

/** Browser storage files of the OX window (macOS keeps one per address). */
export function strandedFiles({ userHome = os.homedir() } = {}) {
  const out = [];
  const walk = (dir, depth) => {
    let rows = [];
    try { rows = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of rows) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 8) walk(p, depth + 1);
      else if (e.name === 'localstorage.sqlite3') out.push(p);
    }
  };
  for (const app of ['dev.ox.app', 'dev.ox.app.runtime']) walk(path.join(userHome, 'Library', 'WebKit', app), 0);
  return out;
}

/** Read one key from a browser storage file, read-only. → the parsed value, or null. */
export function readStranded(file, key, { run = spawnSync } = {}) {
  const r = run('/usr/bin/sqlite3', ['-readonly', file, `select hex(value) from ItemTable where key='${key}'`], { encoding: 'utf8', timeout: 10_000 });
  const hex = String(r.stdout ?? '').trim();
  if (r.status !== 0 || !hex) return null;
  try { return JSON.parse(Buffer.from(hex, 'hex').toString('utf16le')); } catch { return null; }
}

/** Once: gather the chats left behind at old addresses. Reads them, changes nothing there. → added */
export function recoverStranded({ home, userHome, files = null, reader = readStranded } = {}) {
  const d = read(home);
  if (d.recovered) return 0;
  const lists = [];
  let prefs = null;
  if (files || process.platform === 'darwin') {
    for (const f of files ?? strandedFiles({ userHome })) {
      const rows = reader(f, 'ox.convos');
      if (Array.isArray(rows)) lists.push(rows);
      prefs ??= reader(f, 'ox.prefs');
    }
  }
  const before = new Set((d.chats ?? []).map((c) => c.id));
  d.chats = mergeChats(d.chats ?? [], ...lists);
  if (prefs && !d.prefs) d.prefs = prefs;
  d.recovered = true;
  write(d, home);
  return d.chats.filter((c) => !before.has(c.id)).length;
}
