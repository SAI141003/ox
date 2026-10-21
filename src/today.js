// Your morning brief (ShogunAI's "Today's schedule and priorities": every
// morning, see what changed, what needs you, and what is already prepared).
// Read-only and local: Calendar and Mail are read only when they are open
// (ox never launches them for this), the rest from ox's own records and git.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const DAY = 24 * 3600_000;
const running = (app) => process.platform === 'darwin' && spawnSync('pgrep', ['-x', app]).status === 0;
const osa = (script) => spawnSync('osascript', ['-e', script], { encoding: 'utf8', timeout: 10_000 });

/** Today's events from Calendar (only when it is open). → [{ title, at }] or null */
export function todaysEvents() {
  if (!running('Calendar')) return null;
  const script = 'set out to ""\ntell application "Calendar"\nset d0 to current date\nset hours of d0 to 0\nset minutes of d0 to 0\nset seconds of d0 to 0\nset d1 to d0 + 1 * days\nrepeat with c in calendars\ntry\nrepeat with e in (every event of c whose start date >= d0 and start date < d1)\nset out to out & (summary of e) & "\t" & ((start date of e) as «class isot» as string) & "\n"\nend repeat\nend try\nend repeat\nend tell\nreturn out';
  const r = osa(script);
  if (r.status !== 0) return null;
  return String(r.stdout).trim().split('\n').filter(Boolean).map((l) => { const [title, at] = l.split('\t'); return { title: title.slice(0, 80), at }; }).sort((a, b) => a.at.localeCompare(b.at));
}

/** Unread email in Mail (only when it is open). */
export function unreadMail() {
  if (!running('Mail')) return null;
  const n = Number(String(osa('tell application "Mail" to get unread count of inbox').stdout).trim());
  return Number.isFinite(n) ? n : null;
}

/** Commits in the last day in your recent projects. → [{ project, commits, last }] */
export function recentCommits(projects, { now = Date.now() } = {}) {
  const out = [];
  for (const p of projects.slice(0, 12)) {
    const r = spawnSync('git', ['log', `--since=${new Date(now - DAY).toISOString()}`, '--format=%s'], { cwd: p.path, encoding: 'utf8', timeout: 5000 });
    if (r.status !== 0) continue;
    const lines = r.stdout.trim().split('\n').filter(Boolean);
    if (lines.length) out.push({ project: p.name ?? path.basename(p.path), commits: lines.length, last: lines[0].slice(0, 90) });
  }
  return out;
}

/** Notes added or changed in ox brain in the last day. */
export function brainChanges(dir, { now = Date.now() } = {}) {
  const out = [];
  const walk = (d) => { let e = []; try { e = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const x of e) { if (x.name.startsWith('.')) continue; const p = path.join(d, x.name); if (x.isDirectory()) walk(p); else if (x.name.endsWith('.md') && x.name !== 'INDEX.md') { const m = fs.statSync(p).mtimeMs; if (now - m < DAY) out.push({ title: x.name.replace(/\.md$/, ''), research: p.includes(`${path.sep}research${path.sep}`), at: m }); } } };
  walk(dir);
  return out.sort((a, b) => b.at - a.at);
}

/**
 * The brief from its parts (every part optional). → { needsYou, changed, schedule, ready, text }
 */
export function compose({ events = null, unread = null, tasks = [], agents = [], prs = null, commits = [], notes = [], name = '', now = new Date() } = {}) {
  const needsYou = [];
  for (const t of tasks.filter((x) => x.status === 'in_review')) needsYou.push(`Review "${t.title}" (task board)`);
  for (const t of tasks.filter((x) => x.status === 'blocked' || x.status === 'failed')) needsYou.push(`"${t.title}" is ${t.status}`);
  for (const a of agents.filter((x) => x.state === 'idle' && (x.idleSec ?? 0) < 3 * 3600)) needsYou.push(`${a.tool} in ${a.project} finished and waits for your reply`);
  if (prs?.failing) needsYou.push(`${prs.failing} pull request${prs.failing === 1 ? ' has' : 's have'} failing checks`);
  if (unread) needsYou.push(`${unread} unread email${unread === 1 ? '' : 's'}`);
  const changed = [
    ...commits.map((c) => `${c.project}: ${c.commits} commit${c.commits === 1 ? '' : 's'} (latest: ${c.last})`),
    ...tasks.filter((t) => t.status === 'done' && now - new Date(t.updatedAt ?? t.completedAt ?? 0) < DAY).map((t) => `Done: ${t.title}`),
    ...notes.filter((n) => !n.research).slice(0, 5).map((n) => `Note: ${n.title}`),
  ];
  const ready = [
    ...notes.filter((n) => n.research).map((n) => `Research ready: ${n.title.replace(/^research-/, '').replace(/-/g, ' ')}`),
    ...(prs?.open ? [`${prs.open} open pull request${prs.open === 1 ? '' : 's'}${prs.failing ? '' : ', checks passing'}`] : []),
  ];
  const time = (iso) => { const d = new Date(iso); return Number.isNaN(+d) ? iso : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); };
  const schedule = events ? events.map((e) => `${time(e.at)} ${e.title}`) : null;
  const hour = now.getHours();
  const hello = `${hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'}${name ? `, ${name}` : ''}.`;
  const sec = (h, l, none) => `## ${h}\n${l.length ? l.map((x) => `- ${x}`).join('\n') : `- ${none}`}`;
  const text = [
    hello,
    sec('Today', schedule ?? [], schedule ? 'Nothing on your calendar today' : 'Calendar is not open, so ox did not read it'),
    sec('Needs you', needsYou, 'Nothing is waiting for you'),
    sec('Since yesterday', changed, 'Nothing changed in your projects'),
    sec('Ready', ready, 'Nothing new prepared'),
  ].join('\n\n');
  return { needsYou, changed, schedule, ready, text };
}

/** The brief as a few sentences to say out loud. */
export function spoken(b) {
  const parts = [];
  if (b.schedule?.length) parts.push(`Today: ${b.schedule.slice(0, 3).join('; ')}${b.schedule.length > 3 ? `, and ${b.schedule.length - 3} more` : ''}.`);
  parts.push(b.needsYou.length ? `Needs you: ${b.needsYou.slice(0, 3).join('; ')}.` : 'Nothing is waiting for you.');
  if (b.changed.length) parts.push(`Since yesterday: ${b.changed.slice(0, 2).join('; ')}.`);
  if (b.ready.length) parts.push(`Ready: ${b.ready.slice(0, 2).join('; ')}.`);
  return parts.join(' ');
}

/** Everything, from this Mac. */
export async function brief({ home = os.homedir() } = {}) {
  const [{ listTasks }, A, AP, B] = await Promise.all([import('./tasks.js'), import('./agents-live.js'), import('./app-api.js'), import('./brain.js')]);
  let tasks = []; try { tasks = listTasks(); } catch {}
  let agents = []; try { agents = A.liveAgents(); } catch {}
  let projects = []; try { projects = AP.projectsView({ limit: 200 }); } catch {}
  let prs = null;
  const gh = spawnSync('gh', ['api', 'graphql', '-f', 'query=query{viewer{pullRequests(states:OPEN,first:20){nodes{commits(last:1){nodes{commit{statusCheckRollup{state}}}}}}}}'], { encoding: 'utf8', timeout: 15_000 });
  if (gh.status === 0) { try { const n = JSON.parse(gh.stdout).data.viewer.pullRequests.nodes; prs = { open: n.length, failing: n.filter((x) => ['FAILURE', 'ERROR'].includes(x.commits.nodes[0]?.commit?.statusCheckRollup?.state)).length }; } catch {} }
  return compose({ events: todaysEvents(), unread: unreadMail(), tasks, agents, prs, commits: recentCommits(projects), notes: brainChanges(B.brainDir()) });
}
