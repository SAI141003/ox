// Needs you (Agently's inbox of what waits on you, across tools): one list of
// the things only you can move, each with where to go to do it.
//
//   GitHub    pull requests waiting for your review; your own with failing
//             checks or changes requested; issues assigned to you
//   ox        tasks waiting for your review, blocked or failed; agents that
//             finished and wait for your reply; scheduled runs that failed
//   Mail      unread email (only when Mail is open; ox never launches it)
//
// Read-only. Every source is optional: one that cannot be read is left out
// and named in `skipped`, never guessed.
import { execFile, spawnSync } from 'node:child_process';

const HOUR = 3600_000;

// The same three gh questions at once, not one after another (about 1.5 s each), and kept a
// minute: the Today page reads this too, and both opened together asked GitHub six times.
const GH_KEEP_MS = 60_000;
let ghCache = null;
const ghAsync = (args) => new Promise((resolve) => execFile('gh', args, { encoding: 'utf8', timeout: 20_000 }, (err, stdout) => resolve(err ? { status: 1, stdout: '' } : { status: 0, stdout })));
async function githubNeedsNow() {
  if (ghCache && Date.now() - ghCache.at < GH_KEEP_MS) return ghCache.value;
  const answers = new Map();
  const calls = [];
  // The questions githubNeeds asks, answered together; it then reads them in its own order.
  githubNeeds({ run: (_, args) => { calls.push(args); return { status: 0, stdout: '[]' }; } });
  await Promise.all(calls.map(async (args) => answers.set(args.join('\0'), await ghAsync(args))));
  const value = githubNeeds({ run: (_, args) => answers.get(args.join('\0')) ?? { status: 1, stdout: '' } });
  ghCache = { at: Date.now(), value };
  return value;
}

function ghJson(args, run) {
  const r = run('gh', args, { encoding: 'utf8', timeout: 20_000 });
  if (r.status !== 0) return null;
  try { return JSON.parse(r.stdout); } catch { return null; }
}

/** From GitHub, through the gh CLI you are signed in to. → { items, skipped } */
export function githubNeeds({ run = spawnSync } = {}) {
  const items = [];
  const reviews = ghJson(['search', 'prs', '--review-requested=@me', '--state=open', '--json', 'title,url,repository,updatedAt', '--limit', '30'], run);
  if (!reviews) return { items, skipped: ['GitHub (gh is not signed in, or offline)'] };
  for (const p of reviews) items.push({ kind: 'review', source: 'GitHub', title: `Review "${p.title}"`, where: p.repository?.nameWithOwner ?? '', url: p.url, at: p.updatedAt });
  const mine = ghJson(['api', 'graphql', '-f', 'query=query{viewer{pullRequests(states:OPEN,first:30,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{title url updatedAt reviewDecision repository{nameWithOwner} commits(last:1){nodes{commit{statusCheckRollup{state}}}}}}}}'], run);
  for (const p of mine?.data?.viewer?.pullRequests?.nodes ?? []) {
    const rollup = p.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state;
    if (['FAILURE', 'ERROR'].includes(rollup)) items.push({ kind: 'failing', source: 'GitHub', title: `Checks failing on "${p.title}"`, where: p.repository?.nameWithOwner ?? '', url: p.url, at: p.updatedAt });
    if (p.reviewDecision === 'CHANGES_REQUESTED') items.push({ kind: 'changes', source: 'GitHub', title: `Changes requested on "${p.title}"`, where: p.repository?.nameWithOwner ?? '', url: p.url, at: p.updatedAt });
  }
  const issues = ghJson(['search', 'issues', '--assignee=@me', '--state=open', '--json', 'title,url,repository,updatedAt', '--limit', '20'], run);
  for (const i of issues ?? []) items.push({ kind: 'issue', source: 'GitHub', title: `Assigned: "${i.title}"`, where: i.repository?.nameWithOwner ?? '', url: i.url, at: i.updatedAt });
  return { items, skipped: [] };
}

/** From ox's own records: tasks, live agents, scheduled runs. */
export function oxNeeds({ tasks = [], agents = [], schedules = [], now = Date.now() } = {}) {
  const items = [];
  for (const t of tasks.filter((x) => x.status === 'in_review')) items.push({ kind: 'review', source: 'ox', title: `Review "${t.title}"`, where: 'Task board', at: t.updatedAt ?? null });
  for (const t of tasks.filter((x) => x.status === 'blocked' || x.status === 'failed')) items.push({ kind: t.status, source: 'ox', title: `"${t.title}" is ${t.status}`, where: 'Task board', at: t.updatedAt ?? null });
  for (const a of agents.filter((x) => x.state === 'idle' && (x.idleSec ?? 0) < 3 * 3600)) items.push({ kind: 'reply', source: a.tool ?? 'agent', title: `${a.tool} finished in ${a.project} and waits for your reply`, where: a.project, at: null });
  for (const s of schedules) {
    const last = s.lastRun;
    if (!s.enabled || !last || now - Number(last.at ?? 0) > 48 * HOUR) continue;
    if (/fail|error|refused|missed/.test(String(last.state))) items.push({ kind: 'routine', source: 'ox', title: `Scheduled "${String(s.prompt).slice(0, 60)}" ${String(last.state).replace(/:.*/, '')}${last.note ? `: ${String(last.note).slice(0, 80)}` : ''}`, where: 'Scheduled', at: new Date(Number(last.at)).toISOString() });
  }
  return items;
}

/** Everything, newest first. → { items, skipped, at } */
export async function needsYou({ run = spawnSync, now = Date.now() } = {}) {
  const skipped = [];
  let tasks = [], agents = [], schedules = [];
  try { tasks = (await import('./tasks.js')).listTasks(); } catch { skipped.push('the task board'); }
  try { agents = (await import('./agents-live.js')).liveAgents(); } catch {}
  try { schedules = (await import('./schedule.js')).listSchedules(); } catch {}
  const gh = run === spawnSync ? await githubNeedsNow() : githubNeeds({ run });
  skipped.push(...gh.skipped);
  const items = [...gh.items, ...oxNeeds({ tasks, agents, schedules, now })];
  try {
    const n = (await import('./today.js')).unreadMail();
    if (n) items.push({ kind: 'mail', source: 'Mail', title: `${n} unread email${n === 1 ? '' : 's'}`, where: 'Mail', at: null });
    else if (n == null) skipped.push('Mail (not open)');
  } catch {}
  items.sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')));
  return { items, skipped, at: new Date(now).toISOString() };
}

export function formatNeeds({ items, skipped }) {
  const lines = items.length ? items.map((i) => `- ${i.title}${i.where ? ` (${i.where})` : ''}${i.url ? `\n  ${i.url}` : ''}`) : ['Nothing is waiting for you.'];
  if (skipped.length) lines.push('', `Not read: ${skipped.join(', ')}`);
  return lines.join('\n');
}
