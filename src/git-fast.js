// Git facts ox needs at startup, read from the .git directory instead of
// spawning `git`. Each subprocess costs tens of milliseconds on an idle
// machine and seconds on a loaded one, and startup used to spend three.
//
//   gitToplevel(cwd)  the working tree root (like `git rev-parse --show-toplevel`)
//   gitBranch(cwd)    the branch name, "HEAD" when detached (like `--abbrev-ref HEAD`)
//
// Both handle linked worktrees and submodules, where .git is a file holding
// "gitdir: <path>". They return null outside a repository.

import fs from 'node:fs';
import path from 'node:path';

/** The directory holding `.git` (file or directory) at or above `cwd`, or null. */
export function gitToplevel(cwd = process.cwd()) {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    try {
      fs.statSync(path.join(dir, '.git'));
      return dir;
    } catch {}
    if (path.dirname(dir) === dir) return null;
  }
}

/** The git directory for a working tree root (follows a `gitdir:` file). */
export function gitDir(root) {
  const dotgit = path.join(root, '.git');
  try {
    if (fs.statSync(dotgit).isDirectory()) return dotgit;
    const m = /^gitdir:\s*(.+)\s*$/m.exec(fs.readFileSync(dotgit, 'utf8'));
    return m ? path.resolve(root, m[1]) : null;
  } catch {
    return null;
  }
}

export function gitBranch(cwd = process.cwd()) {
  const root = gitToplevel(cwd);
  const dir = root && gitDir(root);
  if (!dir) return null;
  try {
    const head = fs.readFileSync(path.join(dir, 'HEAD'), 'utf8').trim();
    const m = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    return m ? m[1] : 'HEAD';
  } catch {
    return null;
  }
}
