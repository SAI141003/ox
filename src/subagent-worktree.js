// Several subagents at once each get their own checkout. In a shared folder they overwrite
// each other's files and see each other's half-done work (documented in other agents too).
// A lone subagent stays where it is: one writer needs no copy.
//
// Each starts from the project as it is now, uncommitted edits and new files included
// (files git ignores are not). Its changes land back as a patch to your working folder. A
// patch that cannot apply is not thrown away: its folder stays, and the parent is told.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const git = (cwd, args, input) => spawnSync('git', args, { cwd, encoding: 'utf8', input, maxBuffer: 256 * 1024 * 1024 });
const home = () => process.env.OX_HOME || path.join(os.homedir(), '.ox');

/** The folder as it is right now, as a commit, without touching your index or branch. */
function snapshot(top) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-snap-'));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: path.join(scratch, 'index'), GIT_AUTHOR_NAME: 'ox', GIT_AUTHOR_EMAIL: 'ox@localhost', GIT_COMMITTER_NAME: 'ox', GIT_COMMITTER_EMAIL: 'ox@localhost' };
    const run = (args) => spawnSync('git', args, { cwd: top, encoding: 'utf8', env, maxBuffer: 16 * 1024 * 1024 });
    if (run(['add', '-A', '--', '.']).status !== 0) return null;
    const tree = run(['write-tree']).stdout?.trim();
    return tree ? run(['commit-tree', tree, '-m', 'ox: subagent starting point']).stdout?.trim() || null : null;
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}

/** A checkout for one subagent, or null when this is not a git project with a commit. */
export function prepareWorktree(cwd) {
  const top = git(cwd, ['rev-parse', '--show-toplevel']).stdout?.trim();
  if (!top) return null;
  const base = snapshot(top);
  if (!base) return null;
  const dir = path.join(home(), 'worktrees', crypto.randomBytes(6).toString('hex'));
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  if (git(top, ['worktree', 'add', '-q', '--detach', dir, base]).status !== 0) return null;
  // Dependencies are not in git, and without them no test can run.
  const deps = path.join(top, 'node_modules');
  if (fs.existsSync(deps) && !fs.existsSync(path.join(dir, 'node_modules'))) {
    try { fs.symlinkSync(deps, path.join(dir, 'node_modules'), 'dir'); } catch {}
  }
  return { top, base, dir, cwd: path.join(dir, path.relative(fs.realpathSync(top), fs.realpathSync(cwd))) };
}

function remove({ top, dir }) {
  git(top, ['worktree', 'remove', '--force', dir]);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  git(top, ['worktree', 'prune']);
}

/** Bring a subagent's changes home. Runs in one go, so two never interleave. → a line for the parent, or '' */
export function landWorktree(wt) {
  git(wt.dir, ['add', '-A', '--', '.', ':(exclude)node_modules', ':(exclude).agent/_sub']);
  const diff = git(wt.dir, ['diff', '--cached', '--binary', wt.base]);
  const files = git(wt.dir, ['diff', '--cached', '--name-only', wt.base]).stdout.split('\n').filter(Boolean);
  if (diff.status !== 0 || !files.length) { remove(wt); return ''; }
  const plain = git(wt.top, ['apply', '--whitespace=nowarn'], diff.stdout);
  const landed = plain.status === 0 || git(wt.top, ['apply', '--3way', '--whitespace=nowarn'], diff.stdout).status === 0;
  if (landed) { remove(wt); return `\nIts changes were applied to the project: ${files.slice(0, 20).join(', ')}`; }
  return `\nIts changes could NOT be applied: they conflict with other work. Nothing was lost: they are in ${wt.dir} (${files.slice(0, 20).join(', ')}). Bring them in by hand, or redo that part.`;
}

/** Wrap a subagent tool: its own checkout whenever it is one of several running at once. */
export function isolateParallel(run) {
  return async (args, ctx) => {
    const size = Number(ctx?._subagentBatch?.batchSize) || 1;
    const readsOnly = Array.isArray(args?.tools) && !args.tools.some((t) => /edit|write|patch|bash|exec|subagent/i.test(String(t)));
    const wt = size > 1 && !readsOnly && ctx?.cwd ? prepareWorktree(ctx.cwd) : null;
    if (!wt) return run(args, ctx);
    let result;
    try {
      result = await run(args, { ...ctx, _workCwd: wt.cwd });
    } catch (e) {
      const note = landWorktree(wt);
      if (note) e.message = `${e.message}${note}`;
      throw e;
    }
    const note = landWorktree(wt);
    return note && result && typeof result.content === 'string' ? { ...result, content: result.content + note } : result;
  };
}
