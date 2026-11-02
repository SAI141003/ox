// Routines that look before they run (Agently's self-managing routines): a
// schedule may name the sources its work depends on, and a run whose sources
// have not changed since the last run is skipped, costing nothing. And a plain
// description of a routine gets a suggested schedule, model, cost cap and
// sources, each with its reason.
//
// A source is one of:
//   https://…          the page (its text, so a changing timestamp in a header does not count)
//   /path or ~/path    a file, or a folder (names, sizes and times of what is in it)
//   git                the schedule's own folder: HEAD and uncommitted changes
//   git:/path          another repository
//   gh:<search>        GitHub issues or pull requests matching a search, e.g. gh:review-requested:@me is:open
//
// The fingerprints live in ~/.ox/schedule-watch.json: { <schedule id>: { fp, at } }.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const FILE = (env = process.env) => path.join(env.OX_HOME || path.join(os.homedir(), '.ox'), 'schedule-watch.json');
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const home = (p) => p.replace(/^~(?=[\\/]|$)/, os.homedir());

export function validSource(s) {
  const t = String(s ?? '').trim();
  // A path: /x or ~/x, or on Windows C:\x, C:/x or ~\x.
  const isPath = (p) => /^(\/|~[\\/])/.test(p) || /^[A-Za-z]:[\\/]/.test(p);
  return /^https?:\/\/\S+$/.test(t) || isPath(t) || t === 'git' || (t.startsWith('git:') && isPath(t.slice(4))) || /^gh:\S/.test(t);
}

/** What one source looks like now, as a hash; null when it cannot be read (counts as changed). */
export function sourceState(src, { cwd = process.cwd(), run = spawnSync } = {}) {
  const s = String(src).trim();
  if (/^https?:\/\//.test(s)) {
    const r = run('curl', ['-sL', '-m', '8', '-A', 'ox-routine/1', s], { encoding: 'utf8', maxBuffer: 8 * 2 ** 20 });
    if (r.status !== 0 || !r.stdout) return null;
    // The text, not the markup: build ids, nonces and inline timestamps change on every load.
    const text = r.stdout.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    return sha(text);
  }
  if (s === 'git' || s.startsWith('git:')) {
    const dir = s === 'git' ? cwd : home(s.slice(4));
    const head = run('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    if (head.status !== 0) return null;
    const dirty = run('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' });
    return sha(`${head.stdout}\n${dirty.stdout ?? ''}`);
  }
  if (s.startsWith('gh:')) {
    const r = run('gh', ['search', 'prs', ...s.slice(3).trim().split(/\s+/), '--json', 'url,updatedAt', '--limit', '50'], { encoding: 'utf8', timeout: 20_000 });
    if (r.status !== 0) return null;
    return sha(r.stdout);
  }
  const p = home(s);
  let st;
  try { st = fs.statSync(p); } catch { return sha('missing'); }
  if (st.isFile()) return sha(`${st.size}:${st.mtimeMs}`);
  const rows = [];
  const walk = (d, depth) => {
    let es = [];
    try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      if (e.name.startsWith('.') || rows.length > 5000) continue;
      const f = path.join(d, e.name);
      if (e.isDirectory()) { if (depth < 4) walk(f, depth + 1); continue; }
      try { const x = fs.statSync(f); rows.push(`${f}:${x.size}:${x.mtimeMs}`); } catch {}
    }
  };
  walk(p, 0);
  return sha(rows.sort().join('\n'));
}

export function fingerprint(sources = [], opts = {}) {
  const parts = sources.map((s) => sourceState(s, opts));
  return parts.some((x) => x === null) ? null : sha(parts.join('|'));
}

const read = (env) => { try { return JSON.parse(fs.readFileSync(FILE(env), 'utf8')) ?? {}; } catch { return {}; } };

/**
 * Before a run: has anything it watches changed since the last run?
 * → { run: true, fp } or { run: false, why }. No sources: always run.
 */
export function shouldRun(schedule, { env = process.env, run } = {}) {
  const sources = Array.isArray(schedule?.watch) ? schedule.watch.filter(validSource) : [];
  if (!sources.length) return { run: true, fp: null };
  const fp = fingerprint(sources, { cwd: schedule.cwd, run });
  const last = read(env)[schedule.id];
  if (fp && last?.fp === fp) return { run: false, why: `nothing new in ${sources.length === 1 ? sources[0] : `its ${sources.length} sources`} since ${new Date(last.at).toLocaleString()}` };
  return { run: true, fp };
}

/** After a run was started: what its sources looked like. */
export function noteRun(id, fp, { env = process.env, now = Date.now() } = {}) {
  if (!fp) return;
  const all = read(env);
  all[id] = { fp, at: now };
  fs.mkdirSync(path.dirname(FILE(env)), { recursive: true });
  fs.writeFileSync(FILE(env), JSON.stringify(all));
}

/**
 * A routine from a description: when to run, which model, a cost cap and the
 * sources to watch, each with why. Rules, not a model call, so it is instant,
 * free and the same every time; the user can change any of it.
 */
export function suggestRoutine(text, { defaultModel = null } = {}) {
  const t = String(text ?? '');
  const low = t.toLowerCase();
  const reasons = [];
  let cadence;
  const time = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(t) ?? /\bat (\d{1,2}):(\d{2})\b/.exec(t);
  const hhmm = time ? `${String((Number(time[1]) % 12) + (/pm/i.test(time[3] ?? '') ? 12 : 0) + (!time[3] && Number(time[1]) === 12 ? 12 : 0)).padStart(2, '0')}:${time[2] ?? '00'}` : null;
  if (/\bevery (\d+)\s*(min|minute)/.test(low)) { const n = Number(/\bevery (\d+)/.exec(low)[1]); cadence = { every: `${n}m` }; reasons.push(`every ${n} minutes, as asked`); }
  else if (/\bhourly|every hour\b/.test(low)) { cadence = { every: '1h' }; reasons.push('hourly, as asked'); }
  else if (/\b(monday|tuesday|wednesday|thursday|friday|weekly|every week|each week)\b/.test(low)) { cadence = { every: '7d' }; reasons.push('every 7 days from when it is turned on: a week\'s worth is the unit of the work'); }
  else if (/\b(month|monthly|1st of)\b/.test(low)) { cadence = { every: '30d' }; reasons.push('every 30 days'); }
  else if (/\b(morning|daily|every day|each day|tonight|evening|nightly)\b/.test(low) || hhmm) { const at = hhmm ?? (/\b(evening|tonight|nightly)\b/.test(low) ? '18:00' : '08:00'); cadence = { at }; reasons.push(`daily at ${at}${hhmm ? ', as asked' : ': before the day starts'}`); }
  else if (/\b(stale|quiet|failed|failing|alert|watch|monitor|whenever|as soon as)\b/.test(low)) { cadence = { every: '30m' }; reasons.push('every 30 minutes: it reacts to changes, and runs are skipped when nothing changed'); }
  else { cadence = { at: '09:00' }; reasons.push('daily at 09:00: nothing in the description says how often'); }

  const watch = [];
  for (const u of t.match(/https?:\/\/[^\s)"']+/g) ?? []) watch.push(u);
  if (/\b(pull requests?|prs?|reviews?)\b/.test(low)) watch.push('gh:review-requested:@me is:open');
  if (/\b(commits?|repo|repository|branch|code|tests?)\b/.test(low)) watch.push('git');
  for (const p of t.match(/(?:^|\s)(~\/[^\s]+|\/(?:Users|Volumes|tmp)\/[^\s]+)/g) ?? []) watch.push(p.trim());
  if (watch.length) reasons.push(`watches ${watch.join(', ')}: a run with nothing new there is skipped, free`);

  const heavy = /\b(research|report|analy[sz]|write|draft|summar|investor|review the code|refactor)/.test(low);
  const maxCostUsd = heavy ? 0.5 : 0.1;
  reasons.push(heavy ? '$0.50 a run: it reads and writes a page of work' : '$0.10 a run: a short check');
  const model = defaultModel;
  if (model) reasons.push(`your default model (${model})`);
  const ev = cadence.every ?? '1d';
  const runsPerDay = ev.endsWith('m') ? 1440 / Number(ev.slice(0, -1)) : ev.endsWith('h') ? 24 / Number(ev.slice(0, -1)) : 1 / Number(ev.slice(0, -1));
  const dailyMax = Math.round(runsPerDay * maxCostUsd * 100) / 100;
  reasons.push(`at most $${dailyMax} a day if every run happens${watch.length ? ' (less: unchanged runs are skipped)' : ''}`);
  return { cadence, model, maxCostUsd, watch: [...new Set(watch)], dailyMaxUsd: dailyMax, reasons };
}
