// Sessions ox itself started inside another tool (a Claude plan run is Claude
// Code underneath, a ChatGPT plan run is Codex). They write their own session
// files, so without this the island and the office showed one ox run twice:
// once as ox, and again as "Claude Code" or "Codex". ox remembers the ids it
// started and the session lists leave them out. Kept two days, at most 500.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const file = () => path.join(process.env.OX_HOME || path.join(os.homedir(), '.ox'), 'own-sessions.json');
let cache = { at: 0, map: null };

function read() {
  if (cache.map && Date.now() - cache.at < 2000) return cache.map;
  let map = {};
  try { map = JSON.parse(fs.readFileSync(file(), 'utf8')); } catch {}
  cache = { at: Date.now(), map };
  return map;
}

/** Remember that ox started session `id` of `tool` ('claude', 'codex'). */
export function markOwn(tool, id) {
  if (!id) return;
  const map = { ...read() };
  map[`${tool}:${id}`] = Date.now();
  const keep = Object.entries(map).filter(([, t]) => Date.now() - t < 2 * 86_400_000).sort((a, b) => b[1] - a[1]).slice(0, 500);
  try { fs.mkdirSync(path.dirname(file()), { recursive: true }); fs.writeFileSync(file(), JSON.stringify(Object.fromEntries(keep))); } catch {}
  cache = { at: Date.now(), map: Object.fromEntries(keep) };
}

/** Whether a session id (as the lists show it, "claude:<id>") was started by ox. */
export function isOwn(listId) {
  return Object.prototype.hasOwnProperty.call(read(), String(listId));
}

/** The environment marker on every tool process ox starts: its hooks stay quiet (the run is ox's, shown as ox). */
export const OWN_RUN_ENV = 'OX_OWN_RUN';
