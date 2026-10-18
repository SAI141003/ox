// From change to mergeable pull request (after Devin and Freebuff), and one
// worktree per task (after agent-orchestrator).
//
// - The environment recipe: `.ox/environment.yml` keeps how this repo is
//   installed, linted, built, tested and started. Detected once from the repo's
//   own files, then used by every later run, PR and `ox org` agent ("Save to
//   environment" in Devin).
// - `ox pr open`: a branch (when on the base), a commit, the recipe's checks,
//   a push and `gh pr create` with what was checked in the body.
// - `ox pr status` / `comments`: CI checks and review comments, read with gh.
// - `ox pr fix`: the review comments and failing checks become one ox task in
//   this repo; the result is committed and pushed to the same PR. Run again
//   until nothing is left: the PR can merge. Merging stays yours.
// - Worktrees: `ox task run <id> --worktree` works in `.ox/worktrees/<id>` on
//   its own branch, so tasks never step on each other or on your checkout.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const STEPS = ['install', 'lint', 'build', 'test', 'start'];
const OX_BIN = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'bin', 'ox.js');

const sh = (cmd, args, cwd, extra = {}) => {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: extra.timeout ?? 120_000, env: { ...process.env, ...(extra.env ?? {}) } });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() || (r.error?.message ?? ''), code: r.status };
};
const git = (cwd, ...args) => sh('git', args, cwd);
const fail = (m) => { throw new Error(m); };

export function repoRoot(cwd = process.cwd()) {
  const r = git(cwd, 'rev-parse', '--show-toplevel');
  if (!r.ok) fail(`${cwd} is not in a git repository`);
  return r.out;
}

// ---------------------------------------------------------------- the recipe

const recipeFile = (root) => path.join(root, '.ox', 'environment.yml');

/** What the repo's own files say about install / lint / build / test / start. */
export function detectRecipe(root) {
  const has = (f) => fs.existsSync(path.join(root, f));
  const r = {};
  if (has('package.json')) {
    let pkg = {};
    try { pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); } catch {}
    const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lockb') || has('bun.lock') ? 'bun' : 'npm';
    const run = (s) => (pm === 'npm' ? `npm run ${s}` : `${pm} ${s}`);
    r.install = pm === 'npm' ? (has('package-lock.json') ? 'npm ci' : 'npm install') : `${pm} install`;
    const s = pkg.scripts ?? {};
    if (s.lint) r.lint = run('lint');
    if (s.build) r.build = run('build');
    if (s.test && !/no test specified/.test(s.test)) r.test = pm === 'npm' ? 'npm test' : `${pm} test`;
    if (s.dev) r.start = run('dev'); else if (s.start) r.start = pm === 'npm' ? 'npm start' : `${pm} start`;
  } else if (has('pyproject.toml') || has('requirements.txt')) {
    r.install = has('uv.lock') ? 'uv sync' : has('requirements.txt') ? 'pip install -r requirements.txt' : 'pip install -e .';
    const py = fs.existsSync(path.join(root, 'pyproject.toml')) ? fs.readFileSync(path.join(root, 'pyproject.toml'), 'utf8') : '';
    if (/ruff/.test(py)) r.lint = 'ruff check .';
    if (has('tests') || has('test') || /pytest/.test(py)) r.test = has('uv.lock') ? 'uv run pytest -q' : 'pytest -q';
  } else if (has('Cargo.toml')) {
    Object.assign(r, { install: 'cargo fetch', lint: 'cargo clippy -q', build: 'cargo build', test: 'cargo test -q' });
  } else if (has('go.mod')) {
    Object.assign(r, { install: 'go mod download', lint: 'go vet ./...', build: 'go build ./...', test: 'go test ./...' });
  } else if (has('Package.swift')) {
    Object.assign(r, { build: 'swift build', test: 'swift test' });
  } else if (has('Makefile')) {
    r.build = 'make';
    if (/^test:/m.test(fs.readFileSync(path.join(root, 'Makefile'), 'utf8'))) r.test = 'make test';
  }
  return r;
}

/** The saved recipe; a small YAML subset (one `step: command` per line), written by ox. */
export function readRecipe(root) {
  try {
    const out = {};
    for (const line of fs.readFileSync(recipeFile(root), 'utf8').split('\n')) {
      const m = /^([a-z]+):\s*(.*)$/.exec(line.trim());
      if (m && STEPS.includes(m[1]) && m[2] && !m[2].startsWith('#')) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
    return out;
  } catch { return null; }
}

export function writeRecipe(root, recipe, { note = 'detected from the repo' } = {}) {
  const f = recipeFile(root);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const lines = [`# How ox sets up and checks this repo (${note}). Edit freely: every ox run, PR and org agent uses it.`];
  for (const s of STEPS) if (recipe[s]) lines.push(`${s}: ${recipe[s]}`);
  fs.writeFileSync(f, `${lines.join('\n')}\n`);
  return f;
}

/** The recipe, made and saved the first time. */
export function recipe(root) {
  const have = readRecipe(root);
  if (have && Object.keys(have).length) return { recipe: have, saved: false, file: recipeFile(root) };
  const r = detectRecipe(root);
  if (!Object.keys(r).length) return { recipe: {}, saved: false, file: null };
  return { recipe: r, saved: true, file: writeRecipe(root, r) };
}

/** Run recipe steps (default lint, build, test). Stops at the first failure. */
export function runChecks(root, steps = ['lint', 'build', 'test'], { timeout = 15 * 60_000, onStep } = {}) {
  const { recipe: r } = recipe(root);
  const results = [];
  for (const s of steps) {
    if (!r[s]) continue;
    onStep?.(s, r[s]);
    const t = Date.now();
    const x = sh('/bin/sh', ['-c', r[s]], root, { timeout, env: { CI: '1' } });
    results.push({ step: s, command: r[s], ok: x.ok, ms: Date.now() - t, tail: (x.ok ? x.out : `${x.out}\n${x.err}`).split('\n').slice(-15).join('\n').trim() });
    if (!x.ok) break;
  }
  return { ok: results.every((x) => x.ok), results };
}

// ---------------------------------------------------------------- pull requests

const slug = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'change';

function baseBranch(root) {
  const r = git(root, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD');
  if (r.ok) return r.out.replace(/^origin\//, '');
  for (const b of ['main', 'master']) if (git(root, 'rev-parse', '--verify', '--quiet', b).ok) return b;
  return 'main';
}

const gh = (root, args, extra) => {
  const r = sh(process.env.OX_GH_BIN || 'gh', args, root, extra);
  if (!r.ok && /not found|ENOENT/.test(r.err)) fail('the GitHub CLI (gh) is not installed: brew install gh, then gh auth login');
  return r;
};

/**
 * Commit what changed and open (or update) a pull request.
 * { title, body, base, draft, checks: true } → { url, branch, created, checks }
 */
export function openPr(cwd = process.cwd(), { title = null, body = '', base = null, draft = false, checks = true, onStep } = {}) {
  const root = repoRoot(cwd);
  const into = base ?? baseBranch(root);
  let branch = git(root, 'rev-parse', '--abbrev-ref', 'HEAD').out;
  // A recipe saved for the first time goes into this PR with the change.
  if (checks && git(root, 'status', '--porcelain').out) recipe(root);
  const dirty = git(root, 'status', '--porcelain').out;
  const ahead = git(root, 'rev-list', '--count', `${into}..HEAD`);
  if (!dirty && branch !== into && ahead.ok && ahead.out === '0') fail(`nothing to open: ${branch} has no changes against ${into}`);
  if (!dirty && branch === into) fail('nothing changed: make a change first (or ox pr open on a branch with commits)');
  const t = title ?? (dirty ? (git(root, 'diff', '--stat').out.split('\n').length > 2 ? 'Changes from ox' : `Update ${dirty.split('\n')[0].slice(3)}`) : git(root, 'log', '-1', '--format=%s').out);
  if (branch === into) {
    branch = `ox/${slug(t)}-${Date.now().toString(36).slice(-4)}`;
    const b = git(root, 'switch', '-c', branch);
    if (!b.ok) fail(`could not make branch ${branch}: ${b.err}`);
    onStep?.('branch', branch);
  }
  if (dirty) {
    git(root, 'add', '-A');
    const c = git(root, 'commit', '-m', t);
    if (!c.ok) fail(`commit failed: ${c.err || c.out}`);
    onStep?.('commit', t);
  }
  const checked = checks ? runChecks(root, ['lint', 'build', 'test'], { onStep: (s, cmd) => onStep?.('check', `${s}: ${cmd}`) }) : { ok: true, results: [] };
  const p = git(root, 'push', '-u', 'origin', branch);
  if (!p.ok) fail(`push failed: ${p.err}`);
  onStep?.('push', branch);
  const lines = [body.trim(), '', '### Checked by ox before opening'];
  if (!checked.results.length) lines.push('- no lint/build/test steps known for this repo (edit .ox/environment.yml)');
  for (const r of checked.results) lines.push(`- ${r.ok ? '✅' : '❌'} \`${r.command}\` (${Math.round(r.ms / 1000)} s)`);
  const fullBody = lines.join('\n').trim();
  const existing = gh(root, ['pr', 'view', branch, '--json', 'url,state']);
  if (existing.ok) {
    const j = JSON.parse(existing.out || '{}');
    if (j.state === 'OPEN') return { url: j.url, branch, created: false, checks: checked };
  }
  const args = ['pr', 'create', '--base', into, '--head', branch, '--title', t, '--body', fullBody];
  if (draft) args.push('--draft');
  const c = gh(root, args);
  if (!c.ok) fail(`gh pr create failed: ${c.err}`);
  const url = c.out.split('\n').find((l) => /^https?:\/\//.test(l)) ?? c.out;
  return { url, branch, created: true, checks: checked };
}

/** CI checks, reviews and comments of the current branch's PR (or a number). */
export function prStatus(cwd = process.cwd(), ref = null) {
  const root = repoRoot(cwd);
  const v = gh(root, ['pr', 'view', ...(ref ? [String(ref)] : []), '--json', 'number,url,title,state,mergeable,reviewDecision,statusCheckRollup,reviews,comments,headRefName']);
  if (!v.ok) fail(/no pull requests found/i.test(v.err) ? 'no pull request for this branch yet: ox pr open' : v.err);
  const j = JSON.parse(v.out);
  const checks = (j.statusCheckRollup ?? []).map((c) => ({ name: c.name ?? c.context, state: (c.conclusion || c.state || c.status || '').toUpperCase(), url: c.detailsUrl ?? c.targetUrl ?? null }));
  const failing = checks.filter((c) => ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED'].includes(c.state));
  const pending = checks.filter((c) => ['PENDING', 'QUEUED', 'IN_PROGRESS', 'EXPECTED', ''].includes(c.state));
  // Line comments are review threads: only the unresolved ones are still asks.
  let threads = [];
  const repo = gh(root, ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']);
  if (repo.ok && j.number && repo.out.includes('/')) {
    const [owner, name] = repo.out.split('/');
    const q = 'query($o:String!,$n:String!,$p:Int!){repository(owner:$o,name:$n){pullRequest(number:$p){reviewThreads(first:100){nodes{isResolved comments(first:1){nodes{author{login} body path line originalLine}}}}}}}';
    const r = gh(root, ['api', 'graphql', '-f', `query=${q}`, '-f', `o=${owner}`, '-f', `n=${name}`, '-F', `p=${j.number}`]);
    if (r.ok) {
      try {
        threads = (JSON.parse(r.out).data?.repository?.pullRequest?.reviewThreads?.nodes ?? []).filter((t) => !t.isResolved)
          .map((t) => t.comments.nodes[0]).filter(Boolean).map((c) => ({ author: c.author?.login, body: c.body, path: c.path, line: c.line ?? c.originalLine, thread: true }));
      } catch {}
    }
  }
  // Overview text from review bots (an HTML-commented summary) is not an ask.
  const ask = (b) => b?.trim() && !/^<!--/.test(b.trim());
  const comments = [
    ...(j.reviews ?? []).filter((r) => ask(r.body) && r.state !== 'APPROVED').map((r) => ({ author: r.author?.login, body: r.body, state: r.state })),
    ...(j.comments ?? []).filter((c) => ask(c.body)).map((c) => ({ author: c.author?.login, body: c.body })),
    ...threads,
  ];
  const changesRequested = j.reviewDecision === 'CHANGES_REQUESTED';
  const open = threads.length;
  const canMerge = j.state === 'OPEN' && !failing.length && !pending.length && !changesRequested && !open && j.mergeable !== 'CONFLICTING';
  return { number: j.number, url: j.url, title: j.title, state: j.state, mergeable: j.mergeable, review: j.reviewDecision || null, checks, failing, pending, comments, openThreads: open, canMerge, branch: j.headRefName };
}

/** The task `ox pr fix` hands to ox: what reviewers asked and what CI says. */
export function fixPrompt(st, failingLogs = '') {
  const parts = [`Pull request #${st.number} "${st.title}" needs work before it can merge. Make the changes in this repository; do not open a new PR.`];
  if (st.failing.length) parts.push(`Failing checks: ${st.failing.map((c) => c.name).join(', ')}.${failingLogs ? `\n\nEnd of the failing log:\n${failingLogs}` : ''}`);
  const asks = st.comments.filter((c) => c.body && !/^(lgtm|looks good|thanks)/i.test(c.body.trim()));
  if (asks.length) parts.push(`Review comments to address:\n${asks.map((c) => `- ${c.author ?? 'reviewer'}${c.path ? ` on ${c.path}${c.line ? `:${c.line}` : ''}` : ''}: ${c.body.trim().slice(0, 800)}`).join('\n')}`);
  if (st.mergeable === 'CONFLICTING') parts.push(`The branch conflicts with its base: merge the base in and resolve the conflicts.`);
  parts.push('When done, run the repo\'s checks (.ox/environment.yml) and say in one line what you changed for each point.');
  return parts.join('\n\n');
}

function failingLog(root, st) {
  const run = st.failing.map((c) => /\/runs\/(\d+)/.exec(c.url ?? '')?.[1]).find(Boolean);
  if (!run) return '';
  const r = gh(root, ['run', 'view', run, '--log-failed'], { timeout: 60_000 });
  return r.ok ? r.out.split('\n').slice(-60).join('\n') : '';
}

/**
 * One round of "keep going until it can merge": read the PR, hand what is left
 * to ox, commit and push. Returns { done, status, ran, pushed }.
 */
export async function fixPr(cwd = process.cwd(), { ref = null, approval = ['--yes-edits'], onStep, runOx = runOxTask } = {}) {
  const root = repoRoot(cwd);
  const st = prStatus(root, ref);
  if (st.state !== 'OPEN') return { done: true, status: st, ran: false, why: `the PR is ${st.state.toLowerCase()}` };
  if (st.pending.length && !st.failing.length && !st.comments.length) return { done: false, status: st, ran: false, why: `checks still running: ${st.pending.map((c) => c.name).join(', ')}` };
  if (st.canMerge) return { done: true, status: st, ran: false, why: 'checks green, no changes requested: it can merge (merging is yours)' };
  if (git(root, 'rev-parse', '--abbrev-ref', 'HEAD').out !== st.branch) {
    const sw = git(root, 'switch', st.branch);
    if (!sw.ok) fail(`could not switch to ${st.branch}: ${sw.err}`);
  }
  const prompt = fixPrompt(st, st.failing.length ? failingLog(root, st) : '');
  onStep?.('task', prompt);
  const r = await runOx(root, prompt, approval);
  if (!r.ok) return { done: false, status: st, ran: true, pushed: false, why: r.error };
  if (!git(root, 'status', '--porcelain').out) return { done: false, status: st, ran: true, pushed: false, why: 'ox changed nothing' };
  git(root, 'add', '-A');
  git(root, 'commit', '-m', `Address review on #${st.number}`);
  const p = git(root, 'push');
  onStep?.('push', st.branch);
  return { done: false, status: st, ran: true, pushed: p.ok, why: p.ok ? 'pushed; run again when CI finishes' : `push failed: ${p.err}` };
}

export function runOxTask(cwd, prompt, approval = ['--yes-edits'], { timeoutMs = 30 * 60_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [OX_BIN, '-p', prompt, ...approval], { cwd, env: { ...process.env, OX_SURFACE: 'pr' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const t = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => { clearTimeout(t); resolve({ ok: code === 0, output: out, error: code === 0 ? null : (err.trim().split('\n').pop() || `exit ${code}`) }); });
    child.on('error', (e) => { clearTimeout(t); resolve({ ok: false, output: out, error: e.message }); });
  });
}

// ---------------------------------------------------------------- worktrees

/** A worktree for one task: `.ox/worktrees/<id>` on branch ox/task-<id>, made once. */
export function taskWorktree(cwd, taskId) {
  const root = repoRoot(cwd);
  const id = slug(taskId);
  const dir = path.join(root, '.ox', 'worktrees', id);
  const branch = `ox/task-${id}`;
  if (fs.existsSync(path.join(dir, '.git'))) return { dir, branch, created: false };
  ignoreLocal(root, '.ox/worktrees/');
  const exists = git(root, 'rev-parse', '--verify', '--quiet', branch).ok;
  const r = exists ? git(root, 'worktree', 'add', dir, branch) : git(root, 'worktree', 'add', '-b', branch, dir);
  if (!r.ok) fail(`could not make the worktree: ${r.err}`);
  return { dir, branch, created: true };
}

export function removeWorktree(cwd, taskId) {
  const root = repoRoot(cwd);
  const dir = path.join(root, '.ox', 'worktrees', slug(taskId));
  const r = git(root, 'worktree', 'remove', '--force', dir);
  return r.ok;
}

// Worktrees stay out of `git status` without touching the repo's .gitignore.
function ignoreLocal(root, pattern) {
  const common = git(root, 'rev-parse', '--git-common-dir').out || '.git';
  const f = path.resolve(root, common, 'info', 'exclude');
  try {
    const have = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
    if (!have.split('\n').includes(pattern)) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.appendFileSync(f, `${have && !have.endsWith('\n') ? '\n' : ''}${pattern}\n`); }
  } catch {}
}

/** PR state for the task board: branch → { url, state, checks } (null when none). */
export function prForBranch(cwd, branch) {
  try {
    const r = gh(repoRoot(cwd), ['pr', 'view', branch, '--json', 'url,state,statusCheckRollup,reviewDecision'], { timeout: 15_000 });
    if (!r.ok) return null;
    const j = JSON.parse(r.out);
    const states = (j.statusCheckRollup ?? []).map((c) => (c.conclusion || c.state || c.status || '').toUpperCase());
    const ci = !states.length ? 'none' : states.some((s) => ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED'].includes(s)) ? 'failing' : states.every((s) => ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(s)) ? 'green' : 'running';
    return { url: j.url, state: j.state, ci, review: j.reviewDecision || null };
  } catch { return null; }
}

// ---------------------------------------------------------------- races (after Orca)

/**
 * One task, several agents side by side, each in its own worktree and branch
 * (ox, claude-plan, chatgpt-plan, any model). Every run is checked with the
 * repo's recipe; you compare and keep one. → [{ agent, branch, dir, ok, ms,
 * files, plus, minus, checks }]
 */
export async function race(cwd, prompt, agents, { approval = ['--yes-edits'], onStep, runOx = runOxTask, timeoutMs = 30 * 60_000 } = {}) {
  const root = repoRoot(cwd);
  if (!agents?.length) fail('name the agents to race, e.g. ox,claude-plan,chatgpt-plan');
  const id = `race-${Date.now().toString(36)}`;
  const lanes = agents.map((agent) => ({ agent, ...taskWorktree(root, `${id}-${slug(agent)}`) }));
  onStep?.('start', `${lanes.length} agents, each in its own worktree`);
  const results = await Promise.all(lanes.map(async (l) => {
    const t = Date.now();
    const model = l.agent === 'ox' ? [] : ['--model', l.agent];
    const r = await runOx(l.dir, prompt, [...approval, ...model], { timeoutMs });
    git(l.dir, 'add', '-A');
    const changed = git(l.dir, 'status', '--porcelain').out;
    if (changed) git(l.dir, 'commit', '-qm', `${l.agent}: ${prompt.slice(0, 60)}`);
    const stat = git(l.dir, 'diff', '--shortstat', 'HEAD~1', 'HEAD');
    const m = /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/.exec(changed ? stat.out : '');
    const checks = changed ? runChecks(l.dir, ['lint', 'build', 'test']) : { ok: false, results: [] };
    onStep?.('done', `${l.agent}: ${r.ok ? 'finished' : `stopped (${r.error})`}${m ? `, ${m[1]} files` : ', no changes'}${checks.results.length ? `, checks ${checks.ok ? 'pass' : 'fail'}` : ''}`);
    return { agent: l.agent, branch: l.branch, dir: l.dir, ok: r.ok, error: r.error, ms: Date.now() - t, files: Number(m?.[1] ?? 0), plus: Number(m?.[2] ?? 0), minus: Number(m?.[3] ?? 0), checks: checks.results.map((c) => ({ step: c.step, ok: c.ok })), checksOk: checks.ok, said: String(r.output ?? '').trim().split('\n').slice(-6).join('\n') };
  }));
  return { id, prompt, results };
}

/** Keep one lane: merge its branch into the current one; the other worktrees are removed. */
export function keep(cwd, raceId, agent) {
  const root = repoRoot(cwd);
  const lanes = git(root, 'worktree', 'list', '--porcelain').out.split('\n\n').map((b) => ({ dir: /^worktree (.+)$/m.exec(b)?.[1], branch: /^branch refs\/heads\/(.+)$/m.exec(b)?.[1] })).filter((l) => l.branch?.startsWith(`ox/task-${raceId}-`));
  const win = lanes.find((l) => l.branch === `ox/task-${raceId}-${slug(agent)}`);
  if (!win) fail(`no lane for ${agent} in ${raceId}`);
  const m = git(root, 'merge', '--no-ff', '-m', `Keep ${agent}'s take (${raceId})`, win.branch);
  if (!m.ok) fail(`merge failed: ${m.err || m.out}`);
  for (const l of lanes) git(root, 'worktree', 'remove', '--force', l.dir);
  return { merged: win.branch, removed: lanes.length };
}
