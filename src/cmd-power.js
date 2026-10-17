// Power-user slash commands from the playbook (Differentiator 7).
// Each command produces either:
//   { type: 'injected', payload } — inject payload as a user message to the model
//   { type: 'output',    payload } — print payload to the console
//   { type: 'error',     payload } — print payload in red
//
// Commands: /init /commit /review /test /explain /fix /refactor /doc /migrate

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const SAFE_GIT_TIMEOUT = 5_000;

function safeExec(cmd, cwd) {
  try {
    // ox-secure-ignore: every caller passes a fixed command or the project's own lint script.
    return execSync(cmd, {
      cwd,
      timeout: SAFE_GIT_TIMEOUT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return '';
  }
}

function readIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function inGitRepo(cwd) {
  try {
    execSync('git rev-parse --git-dir', { cwd, timeout: 1000, stdio: ['ignore', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

function detectLinter(cwd) {
  const markers = [
    { file: 'package.json', cmd: 'npx --no-install eslint --ext .js,.jsx,.ts,.tsx . 2>&1 | head -100' },
    { file: 'pyproject.toml', cmd: 'ruff check . 2>&1 | head -100 || flake8 . 2>&1 | head -100' },
    { file: '.golangci.yml', cmd: 'golangci-lint run ./... 2>&1 | head -100' },
    { file: 'Cargo.toml', cmd: 'cargo clippy 2>&1 | head -100' },
  ];
  for (const m of markers) {
    if (fs.existsSync(path.join(cwd, m.file))) return m.cmd;
  }
  return null;
}

// ---- Command implementations ----

function cmdInit({ cwd }) {
  const repoRoot = safeExec('git rev-parse --show-toplevel', cwd) || cwd;
  const pkg = readIfExists(path.join(repoRoot, 'package.json'));
  const pyproject = readIfExists(path.join(repoRoot, 'pyproject.toml'));
  const claude = readIfExists(path.join(repoRoot, 'CLAUDE.md'));
  const agents = readIfExists(path.join(repoRoot, 'AGENTS.md'));
  const ox = readIfExists(path.join(cwd, '.ox'));
  const readme = readIfExists(path.join(repoRoot, 'README.md')).slice(0, 2000);

  const prompt = `Analyze this project and create initial memory entries describing its purpose, language, build system, and conventions. Use memory_add to save the findings.

Repo root: ${repoRoot}
${pkg ? `\npackage.json (first 500 chars):\n${pkg.slice(0, 500)}` : ''}
${pyproject ? `\npyproject.toml (first 500 chars):\n${pyproject.slice(0, 500)}` : ''}
${claude ? `\nCLAUDE.md (first 1000 chars):\n${claude.slice(0, 1000)}` : ''}
${agents ? `\nAGENTS.md (first 1000 chars):\n${agents.slice(0, 1000)}` : ''}
${ox ? `\n.ox config (first 500 chars):\n${ox.slice(0, 500)}` : ''}
${readme ? `\nREADME.md (first 2000 chars):\n${readme}` : ''}

Steps:
1. Identify the project language, build system, and main entry points
2. Use memory_add to save 3-5 typed [project] entries: purpose, language, build, conventions
3. Do NOT save secrets, API keys, or anything from .env files`;
  return { type: 'injected', payload: prompt };
}

function cmdCommit({ cwd }) {
  if (!inGitRepo(cwd)) {
    return { type: 'error', payload: 'not in a git repository' };
  }
  const stagedStat = safeExec('git diff --staged --stat', cwd);
  const unstagedStat = safeExec('git diff --stat', cwd);
  if (!stagedStat.trim() && !unstagedStat.trim()) {
    return { type: 'error', payload: 'no staged or unstaged changes to commit' };
  }
  const diff = stagedStat.trim()
    ? safeExec('git diff --staged', cwd)
    : safeExec('git diff', cwd);
  return {
    type: 'injected',
    payload: `Draft a conventional commit message (type: subject, blank line, body) for these changes, then run \`git commit -m "<message>"\`. Show me the message before committing and ask for approval.\n\nChanges:\n\`\`\`\n${diff.slice(0, 8000)}\n\`\`\``,
  };
}

function cmdReview({ cwd }) {
  if (!inGitRepo(cwd)) {
    return { type: 'error', payload: 'not in a git repository' };
  }
  const stagedStat = safeExec('git diff --staged --stat', cwd);
  const diff = stagedStat.trim()
    ? safeExec('git diff --staged', cwd)
    : safeExec('git diff', cwd);
  if (!diff.trim()) {
    return { type: 'error', payload: 'no changes to review (try making changes or staging them)' };
  }
  return {
    type: 'injected',
    payload: `Review these changes for bugs, style issues, and potential improvements. Be specific and actionable. Use file:line references. Do NOT modify any files — just produce a review.\n\nChanges:\n\`\`\`\n${diff.slice(0, 12000)}\n\`\`\``,
  };
}

function cmdTest({ cwd, rest }) {
  if (!rest.trim()) {
    return { type: 'injected', payload: 'Ask me which file to generate tests for, then read it and write tests using the existing test framework detected in the project.' };
  }
  const filePath = path.isAbsolute(rest) ? rest : path.join(cwd, rest);
  const content = readIfExists(filePath);
  if (!content) {
    return { type: 'error', payload: `file not found: ${filePath}` };
  }
  return {
    type: 'injected',
    payload: `Generate tests for this file using the project's existing test framework. If you're unsure of the framework, check package.json/pyproject.toml first. Write the tests to a sensible location (e.g. __tests__/, tests/, or alongside as *.test.*).\n\nFile: ${filePath}\n\`\`\`\n${content.slice(0, 12000)}\n\`\`\``,
  };
}

function cmdExplain({ cwd, rest }) {
  if (!rest.trim()) {
    return { type: 'injected', payload: 'Ask me which file or code snippet to explain.' };
  }
  const filePath = path.isAbsolute(rest) ? rest : path.join(cwd, rest);
  const content = readIfExists(filePath);
  if (!content) {
    return { type: 'error', payload: `file not found: ${filePath}` };
  }
  return {
    type: 'injected',
    payload: `Explain this code in detail: what it does, how it works, key design decisions, and any potential issues. Use code citations with file:line numbers.\n\nFile: ${filePath}\n\`\`\`\n${content.slice(0, 12000)}\n\`\`\``,
  };
}

function cmdFix({ cwd }) {
  const linter = detectLinter(cwd);
  if (!linter) {
    return { type: 'error', payload: 'no supported linter detected (looking for eslint, ruff/flake8, golangci-lint, cargo clippy)' };
  }
  const output = safeExec(linter, cwd);
  if (!output.trim()) {
    return { type: 'output', payload: '✓ linter reports no issues' };
  }
  return {
    type: 'injected',
    payload: `Fix the issues reported by the linter below. Read each reported file, understand the issue, and apply the minimal correct fix. After fixing, re-run the linter to confirm.\n\nLinter command: \`${linter}\`\n\nOutput:\n\`\`\`\n${output.slice(0, 8000)}\n\`\`\``,
  };
}

function cmdRefactor({ cwd, rest }) {
  if (!rest.trim()) {
    return { type: 'injected', payload: 'Ask me which file to suggest refactorings for.' };
  }
  const filePath = path.isAbsolute(rest) ? rest : path.join(cwd, rest);
  const content = readIfExists(filePath);
  if (!content) {
    return { type: 'error', payload: `file not found: ${filePath}` };
  }
  return {
    type: 'injected',
    payload: `Suggest refactorings for this file. Focus on: reducing duplication, improving naming, extracting reusable functions, and simplifying complex conditionals. Do NOT modify any files — just produce a list of refactoring suggestions with file:line citations and proposed code.\n\nFile: ${filePath}\n\`\`\`\n${content.slice(0, 12000)}\n\`\`\``,
  };
}

function cmdDoc({ cwd, rest }) {
  if (!rest.trim()) {
    return { type: 'injected', payload: 'Ask me which file to generate documentation for.' };
  }
  const filePath = path.isAbsolute(rest) ? rest : path.join(cwd, rest);
  const content = readIfExists(filePath);
  if (!content) {
    return { type: 'error', payload: `file not found: ${filePath}` };
  }
  return {
    type: 'injected',
    payload: `Add JSDoc/docstrings to all functions, classes, and exported constants in this file. Match the existing documentation style. After adding docs, run any linter to verify the file is still valid.\n\nFile: ${filePath}\n\`\`\`\n${content.slice(0, 12000)}\n\`\`\``,
  };
}

function cmdMigrate({ rest }) {
  if (!rest.trim()) {
    return { type: 'injected', payload: 'Describe the migration you want to perform (e.g. "convert require() to import", "upgrade to TypeScript 5.5", "migrate from Mocha to Vitest").' };
  }
  return {
    type: 'injected',
    payload: `Plan and execute this migration: ${rest}

Steps:
1. First, show me the planned steps (files to change, approach)
2. Wait for my approval before making changes
3. Then execute the migration
4. Run tests/linter to verify nothing is broken
5. Report the result`,
  };
}

// ---- Dispatch ----

const COMMANDS = {
  init: cmdInit,
  commit: cmdCommit,
  review: cmdReview,
  test: cmdTest,
  explain: cmdExplain,
  fix: cmdFix,
  refactor: cmdRefactor,
  doc: cmdDoc,
  migrate: cmdMigrate,
};

export function listPowerCommands() {
  return Object.keys(COMMANDS);
}

export async function handlePowerCommand(cmd, rest, ctx) {
  const impl = COMMANDS[String(cmd || '').toLowerCase()];
  if (!impl) {
    return { type: 'error', payload: `unknown power command: ${cmd}` };
  }
  try {
    return impl({ cwd: ctx?.cwd || process.cwd(), rest: String(rest || ''), ctx });
  } catch (err) {
    return { type: 'error', payload: String(err?.message ?? err) };
  }
}
