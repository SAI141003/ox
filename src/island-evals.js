// OX Island checks itself and gets better from how it is really used.
//
//   evals/island/offline.jsonl   requests the no-AI router must do (or must
//                                leave to an agent), with where each came from
//   evals/island/commands.json   phrases the island must handle itself, and
//                                ones it must leave for ox (checked by the
//                                island binary: OxIsland --check-commands)
//
// `ox island evals` scores both and keeps the score in ~/.ox/island/evals.jsonl,
// so the trend shows. `ox island learn` reads ~/.ox/island.log (what the island
// heard and where it went) and proposes the misses as new cases. `ox island
// evolve` hands the failing cases to `ox evolve`, which keeps a change only when
// the unit suite (test/island-evals.test.js runs these files) measures better.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { doOffline } from './offline.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const EVAL_DIR = path.join(ROOT, 'evals', 'island');
const HOME = () => process.env.OX_HOME || path.join(os.homedir(), '.ox');
export const HISTORY = () => path.join(HOME(), 'island', 'evals.jsonl');
export const CANDIDATES = () => path.join(HOME(), 'island', 'eval-candidates.jsonl');

export function readCases(file = path.join(EVAL_DIR, 'offline.jsonl')) {
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

/** Each offline case through the real router (dry run: nothing is done). */
export function offlineEvals(cases = readCases()) {
  const rows = cases.map((c) => {
    const r = doOffline(c.text, { dryRun: true });
    const got = r.handled ? r.intent?.intent ?? 'handled' : null;
    return { text: c.text, want: c.intent ?? null, got, pass: (c.intent ?? null) === got };
  });
  return { pass: rows.filter((r) => r.pass).length, total: rows.length, failing: rows.filter((r) => !r.pass) };
}

/** The island's own command matching, through its binary (macOS, built). */
export function commandEvals({ bin = path.join(ROOT, 'desktop', 'island', '.build', 'release', 'OxIsland'), file = path.join(EVAL_DIR, 'commands.json') } = {}) {
  if (!fs.existsSync(bin)) return { skipped: 'the island is not built here (swift build -c release in desktop/island)' };
  const r = spawnSync(bin, ['--check-commands', file], { encoding: 'utf8', timeout: 30_000 });
  const lines = String(r.stdout ?? '').split('\n');
  const pass = lines.filter((l) => l.startsWith('ok ')).length;
  const failing = lines.filter((l) => l.startsWith('FAIL')).map((l) => l.replace(/^FAIL\s+/, ''));
  return { pass, total: pass + failing.length, failing };
}

export function runEvals({ record = true, now = Date.now() } = {}) {
  const offline = offlineEvals();
  const commands = commandEvals();
  const score = { at: now, offline: { pass: offline.pass, total: offline.total }, commands: commands.skipped ? null : { pass: commands.pass, total: commands.total } };
  if (record) {
    fs.mkdirSync(path.dirname(HISTORY()), { recursive: true });
    fs.appendFileSync(HISTORY(), `${JSON.stringify(score)}\n`);
  }
  return { offline, commands, score };
}

export function history() {
  try { return fs.readFileSync(HISTORY(), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
}

/**
 * What went wrong in real use, from ~/.ox/island.log lines written by the island
 * (Tray.swift IslandLog): "heard: X" followed by where it went. A miss is
 *   - a short everyday request that became an agent run (should it be offline?)
 *   - a run that stopped, or the island not finding ox
 * Returns candidate cases, not yet trusted: you confirm what each should do.
 */
export function learnFromLog(text) {
  const lines = String(text ?? '').split('\n');
  const out = [];
  let heard = null;
  for (const line of lines) {
    const msg = line.replace(/^\S+\s/, '');
    let m;
    if ((m = /^heard: (.+)$/.exec(msg))) { heard = m[1].trim(); continue; }
    if (!heard) continue;
    if (/^agent run /.test(msg) && heard.split(/\s+/).length <= 8) out.push({ text: heard, saw: 'became an agent run', ask: 'should this be done offline (no AI)?' });
    else if (/^replied: stopped/.test(msg)) out.push({ text: heard, saw: msg.slice(9, 160), ask: 'the run stopped: what should have happened?' });
    else if (/^no running ox answered/.test(msg)) out.push({ text: heard, saw: 'the OX app was not running', ask: 'start the app server with the island?' });
    else continue;
    heard = null;
  }
  const seen = new Set();
  return out.filter((c) => (seen.has(c.text.toLowerCase()) ? false : seen.add(c.text.toLowerCase())));
}

export function learn({ log = path.join(HOME(), 'island.log') } = {}) {
  let text = '';
  try { text = fs.readFileSync(log, 'utf8'); } catch { return { candidates: [], note: `no island log yet (${log}): it fills as you use the island` }; }
  const known = new Set(readCases().map((c) => c.text.toLowerCase()));
  const candidates = learnFromLog(text).filter((c) => !known.has(c.text.toLowerCase()));
  if (candidates.length) {
    fs.mkdirSync(path.dirname(CANDIDATES()), { recursive: true });
    fs.writeFileSync(CANDIDATES(), candidates.map((c) => JSON.stringify(c)).join('\n') + '\n');
  }
  return { candidates };
}

/** The goal handed to `ox evolve` when island evals fail. */
export function evolveGoal(r = runEvals({ record: false })) {
  const bad = [
    ...r.offline.failing.map((f) => `the offline router should give "${f.text}" ${f.want ? `the ${f.want} intent` : 'to an agent'} but gives ${f.got ?? 'nothing'}`),
    ...(r.commands.failing ?? []).map((f) => `island command check: ${f}`),
  ];
  if (!bad.length) return null;
  return `Make these OX Island evals pass (evals/island/, test/island-evals.test.js) without breaking others:\n- ${bad.slice(0, 12).join('\n- ')}`;
}
