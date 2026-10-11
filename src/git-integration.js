// src/git-integration.js — Visual git with agent awareness.
// ESM, node built-ins only.

import { execFileSync } from 'node:child_process';

export const GIT_SCHEMA_VERSION = '1.0.0';

function validateBranchName(name) {
  if (typeof name !== 'string' || !name || name.startsWith('-') || name.includes('\0')) {
    throw new TypeError('Invalid branch name');
  }
}

export class GitIntegration {
  constructor(cwd, { execFile = execFileSync } = {}) {
    this.cwd = cwd || process.cwd();
    this.execFile = execFile;
  }

  git(args) {
    return this.execFile('git', args, { cwd: this.cwd, maxBuffer: 50 * 1024 * 1024, shell: false });
  }

  status() {
    const out = this.git(['status', '--porcelain=v1', '-b', '-z']);
    const lines = out.toString().split('\0');
    let branch = '';
    const staged = [];
    const unstaged = [];
    const untracked = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      if (line.startsWith('##')) {
        branch = line.replace('## ', '').split('...')[0];
        continue;
      }
      const x = line[0];
      const y = line[1];
      const file = line.slice(3);
      if (x === 'R' || x === 'C' || y === 'R' || y === 'C') i++;
      if (x === '?' && y === '?') untracked.push(file);
      else {
        if (x !== ' ') staged.push({ status: x, file });
        if (y !== ' ') unstaged.push({ status: y, file });
      }
    }
    return { branch, staged, unstaged, untracked, clean: staged.length === 0 && unstaged.length === 0 && untracked.length === 0 };
  }

  diff(file) {
    if (file) return this.git(['diff', '--', file]).toString();
    return this.git(['diff']).toString();
  }

  diffAll() {
    return this.git(['diff', '--cached']).toString();
  }

  stage(file) {
    this.git(['add', '--', file]);
    return { staged: true, file };
  }

  unstage(file) {
    this.git(['reset', 'HEAD', '--', file]);
    return { unstaged: true, file };
  }

  commit(message) {
    this.git(['commit', '-m', message]);
    return { committed: true, message };
  }

  push() {
    const out = this.git(['push']).toString();
    return { pushed: true, output: out.trim() };
  }

  pull() {
    const out = this.git(['pull']).toString();
    return { pulled: true, output: out.trim() };
  }

  branch(name) {
    validateBranchName(name);
    this.git(['branch', name]);
    return { created: true, name };
  }

  switchBranch(name) {
    validateBranchName(name);
    this.git(['switch', name]);
    return { switched: true, name };
  }

  listBranches() {
    const out = this.git(['branch', '-a']).toString();
    return out.split('\n').map(b => b.replace(/^\* /, '').replace(/^  /, '').trim()).filter(Boolean);
  }

  createPR(title, body) {
    // An honest contract: this pushes the branch; it does NOT create a PR.
    // PR creation requires a hosting API (gh/GraphQL) that is not wired here.
    const out = this.git(['push', '-u', 'origin', 'HEAD']).toString();
    return { pushed: true, created: false, title, body, output: out.trim() };
  }

  getLog(limit = 10) {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new TypeError('Invalid log limit');
    const out = this.git(['log', `--oneline`, '-n', String(limit)]).toString();
    return out.split('\n').filter(Boolean).map(line => {
      const m = line.match(/^([a-f0-9]+)\s+(.*)$/);
      return m ? { hash: m[1], message: m[2] } : { hash: '', message: line };
    });
  }

  getRemotes() {
    const out = this.git(['remote', '-v']).toString();
    const remotes = {};
    for (const line of out.split('\n').filter(Boolean)) {
      const m = line.match(/^(\S+)\s+(\S+)\s+\((\w+)\)$/);
      if (!m) continue;
      if (Object.hasOwn(remotes, m[1])) remotes[m[1]].push(m[2]);
      else remotes[m[1]] = [m[2]];
    }
    return remotes;
  }

  stash() {
    const out = this.git(['stash']).toString();
    return { stashed: true, output: out.trim() };
  }

  restoreStash() {
    const out = this.git(['stash', 'pop']).toString();
    return { restored: true, output: out.trim() };
  }
}

export function createGitIntegration(cwd) {
  return new GitIntegration(cwd);
}

export function formatGitStatus(status) {
  if (!status) return '';
  const lines = [];
  lines.push(`Branch: ${status.branch || 'unknown'}`);
  lines.push(`Clean: ${status.clean ? 'yes' : 'no'}`);
  if (status.staged.length) { lines.push('Staged:'); status.staged.forEach(s => lines.push(`  + ${s.file}`)); }
  if (status.unstaged.length) { lines.push('Modified:'); status.unstaged.forEach(s => lines.push(`  ~ ${s.file}`)); }
  if (status.untracked.length) { lines.push('Untracked:'); status.untracked.forEach(f => lines.push(`  ? ${f}`)); }
  return lines.join('\n');
}

export function formatDiff(diff) {
  if (!diff) return '';
  return diff.split('\n').map(line => {
    if (line.startsWith('+++') || line.startsWith('---')) return `\x1b[1m${line}\x1b[0m`;
    if (line.startsWith('+')) return `\x1b[32m${line}\x1b[0m`;
    if (line.startsWith('-')) return `\x1b[31m${line}\x1b[0m`;
    if (line.startsWith('@@')) return `\x1b[36m${line}\x1b[0m`;
    return line;
  }).join('\n');
}
