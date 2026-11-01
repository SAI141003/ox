// OX Island fixes itself (the way `ox evolve` does for ox): it reads its own
// log (~/.ox/island.log), finds what went wrong, fixes what is not code on the
// spot, and hands what is code to ox's own model as a goal for `ox evolve`
// (a worktree, the full suite before and after, kept only if it measured
// better). A change that measured better is offered on the island; with
// "island.selfHeal": "auto" in ~/.ox/config.json it goes in by itself.
//
//   ox island heal            look now, fix, and try a code change if needed
//   ox island heal status     what it found and what it did last
//   ox island heal apply      take the change it offered, rebuild, restart
//   GET/POST /ox/island/heal  the same for the island's card
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const HOME = () => process.env.OX_HOME || path.join(os.homedir(), '.ox');
const STATE = () => path.join(HOME(), 'island-heal.json');
const LOG = () => path.join(HOME(), 'island.log');
const DAY = 24 * 3600_000;

export function readState() { try { return JSON.parse(fs.readFileSync(STATE(), 'utf8')); } catch { return {}; } }
function writeState(s) { fs.mkdirSync(HOME(), { recursive: true }); fs.writeFileSync(STATE(), JSON.stringify(s, null, 2)); return s; }

/** One log line → { at (ms), msg }. */
function parse(line) {
  const m = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z) (.*)$/.exec(line);
  return m ? { at: Date.parse(m[1]), msg: m[2] } : null;
}

const SHORT_COMMAND = /^(open|close|quit|play|pause|search|send|type|click|go to|show|turn|start|stop|mute|call|text|message)\b/i;
const CLARIFY = /\b(which (one|specific|file|document)|could you clarify|what would you like|do you want (me )?to|can you tell me more|not sure what you)/i;

/**
 * What went wrong, from the log since `since`.
 * → { env: [{ id, why, fix }], code: [{ id, why, evidence: [line] }] }
 */
export function diagnose(text, { since = 0 } = {}) {
  const rows = String(text ?? '').split('\n').map(parse).filter((r) => r && r.at >= since);
  const env = [], code = [];
  const add = (list, id, why, more = {}) => { const have = list.find((x) => x.id === id); if (have) { have.count += 1; if (more.evidence) have.evidence.push(...more.evidence); } else list.push({ id, why, count: 1, evidence: [], ...more }); };

  for (let i = 0; i < rows.length; i++) {
    const { msg, at } = rows[i];
    if (/^voice heard: .*recording: true, peak: 0\.0000\)/.test(msg)) add(env, 'mic-silence', 'macOS gave the island exact silence: its microphone permission belongs to an older build', { fix: 'reset-mic' });
    if (/^errand: macOS has not given ox Accessibility/.test(msg)) add(env, 'accessibility', 'typing and clicking for you need Accessibility, which every rebuild loses until `ox island sign-setup` is run once', { fix: 'advice' });
    if (/^voice: nobody took it|^no running ox answered/.test(msg)) add(env, 'no-server', 'a request found no ox to take it', { fix: 'advice' });
    // The same request three times in the same second: more than one island was running.
    const req = /^request: "(.+?)" →/.exec(msg);
    if (req && rows.slice(i + 1, i + 4).filter((r) => r.at - at < 1500 && r.msg.startsWith(`request: "${req[1]}"`)).length >= 1) add(env, 'duplicate-islands', 'one request was taken more than once (two islands were running)', { fix: 'restart' });
    // A short command answered with a question: the router should have done it offline.
    const heard = /^heard: (.+)$/.exec(msg);
    if (heard && SHORT_COMMAND.test(heard[1]) && heard[1].split(/\s+/).length <= 7) {
      const reply = rows.slice(i + 1, i + 8).find((r) => r.msg.startsWith('replied: '));
      if (reply && CLARIFY.test(reply.msg)) add(code, `clarify:${heard[1].toLowerCase()}`, `"${heard[1]}" was answered with a question instead of being done`, { evidence: [`heard: ${heard[1]}`, reply.msg.slice(0, 200)] });
    }
    const failed = /^errand: (could not .+|.*(failed|error).*)$/i.exec(msg);
    if (failed && !/Accessibility/.test(msg)) add(code, `errand:${failed[1].slice(0, 60).toLowerCase()}`, `an errand failed: ${failed[1].slice(0, 160)}`, { evidence: [msg.slice(0, 200)] });
    if (/^voice: recognizer error: (?!No speech detected|Recognition request was canceled)/.test(msg)) add(code, `recognizer:${msg.slice(25, 80)}`, `the speech recognizer failed: ${msg.slice(25, 160)}`, { evidence: [msg.slice(0, 200)] });
  }
  return { env, code };
}

/** The goal handed to `ox evolve` for the code problems found. */
export function goalFor(code) {
  if (!code.length) return null;
  const lines = code.slice(0, 8).map((c) => `- ${c.why}${c.count > 1 ? ` (${c.count} times)` : ''}${c.evidence.length ? `\n  log: ${c.evidence.slice(0, 2).join(' | ')}` : ''}`);
  return `OX Island's own log shows these problems in real use. Fix them in ox's code (the offline router in src/offline.js and src/voice-control.js for commands, desktop/island/Sources/OxIsland for the island), add a case to evals/island/offline.jsonl or a test for each, and keep every other test passing:\n${lines.join('\n')}`;
}

/** Fix what is not code, now. → [what was done] */
export function fixEnvironment(env, { run = spawnSync, bundleId = 'dev.ox.island' } = {}) {
  const done = [];
  for (const e of env) {
    if (e.fix === 'reset-mic') {
      for (const service of ['Microphone', 'SpeechRecognition']) run('tccutil', ['reset', service, bundleId], { stdio: 'ignore' });
      done.push('reset the island\'s Microphone and Speech permissions: the next time you talk, choose Allow');
    } else if (e.fix === 'restart') {
      done.push('two islands had been running: a new island now stops older ones');
    } else done.push(`${e.why}`);
  }
  return done;
}

function selfHealMode() {
  try { const doc = JSON.parse(fs.readFileSync(path.join(HOME(), 'config.json'), 'utf8')); return doc.island?.selfHeal === 'auto' ? 'auto' : doc.island?.selfHeal === 'off' ? 'off' : 'ask'; } catch { return 'ask'; }
}

/**
 * Look, fix, and (when code is at fault) try a change with ox's own model.
 * → the new state: { at, env, code, done, attempt?: { id, accepted, why, files }, offer? }
 */
export async function heal({ evolve = null, now = Date.now(), log = () => {}, since = null } = {}) {
  const prev = readState();
  let text = '';
  try { text = fs.readFileSync(LOG(), 'utf8'); } catch {}
  const from = since ?? Math.max(prev.lookedAt ?? 0, now - DAY);
  const found = diagnose(text, { since: from });
  const done = fixEnvironment(found.env);
  const state = { lookedAt: now, env: found.env, code: found.code.map(({ id, why, count }) => ({ id, why, count })), done, offer: prev.offer ?? null };
  const goal = goalFor(found.code);
  if (goal && selfHealMode() !== 'off') {
    writeState({ ...state, running: true });
    log(`trying a fix with ox's own model:\n${goal}`);
    const E = evolve ?? (await import('./evolve.js'));
    try {
      const r = await (E.evolve ?? E)({ goal, maxCost: 1, log });
      state.attempt = { id: r.id, accepted: r.accepted, why: r.why, files: r.files ?? [] };
      if (r.accepted) {
        state.offer = { id: r.id, why: found.code.map((c) => c.why).slice(0, 3).join('; '), files: r.files ?? [], measured: r.why };
        if (selfHealMode() === 'auto') return applyOffer({ state });
      }
    } catch (e) { state.attempt = { id: null, accepted: false, why: e.message }; }
  }
  return writeState({ ...state, running: false });
}

/** Take the change it offered: fast-forward onto it, rebuild and restart the island. */
export async function applyOffer({ state = readState(), accept = null, restart = null } = {}) {
  const offer = state.offer;
  if (!offer?.id) return writeState({ ...state, applied: null, note: 'nothing to apply' });
  const E = await import('./evolve.js');
  try { (accept ?? E.accept)(offer.id); } catch (e) { return writeState({ ...state, applied: { id: offer.id, ok: false, why: e.message } }); }
  const restartIsland = restart ?? (async () => (await import('./island.js')).cmdIsland(['restart'], { log: () => {}, err: () => {} }));
  await restartIsland();
  return writeState({ ...state, offer: null, applied: { id: offer.id, ok: true, at: Date.now(), why: offer.why } });
}

export async function dismissOffer({ state = readState() } = {}) {
  if (state.offer?.id) { try { (await import('./evolve.js')).reject(state.offer.id); } catch {} }
  return writeState({ ...state, offer: null });
}

/** For the island's poll: start a look when the last was over 6 h ago and nothing is running. */
export function maybeHealInBackground({ now = Date.now(), everyMs = 6 * 3600_000 } = {}) {
  const s = readState();
  if (s.running || now - (s.lookedAt ?? 0) < everyMs || process.env.NODE_TEST_CONTEXT) return false;
  writeState({ ...s, running: true });
  heal({ now }).catch((e) => writeState({ ...readState(), running: false, error: e.message }));
  return true;
}
