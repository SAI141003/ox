import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { discoverSkills } from './skills.js';

const ignored = new Set(['node_modules', '.git', '.agent', '.agents', '.claude', 'dist', 'build', 'coverage', 'target', '.next', '.yarn', '.venv']);
const languageExtensions = {
  '.js': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript', '.jsx': 'JavaScript',
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.mts': 'TypeScript', '.cts': 'TypeScript',
  '.py': 'Python', '.rs': 'Rust', '.go': 'Go', '.java': 'Java', '.rb': 'Ruby',
  '.c': 'C', '.h': 'C', '.cpp': 'C++', '.cs': 'C#', '.swift': 'Swift',
  '.html': 'HTML', '.css': 'CSS', '.scss': 'SCSS', '.vue': 'Vue', '.svelte': 'Svelte', '.sh': 'Shell',
};

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function entries(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); } catch { return []; }
}

function gitState(cwd) {
  const run = (...args) => execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000,
  });
  try {
    if (run('rev-parse', '--is-inside-work-tree').trim() !== 'true') throw new Error('Not a worktree');
    let branch;
    try { branch = run('symbolic-ref', '--short', 'HEAD').trim(); } catch { branch = 'HEAD (detached)'; }
    const records = run('status', '--porcelain=v1', '-z', '--untracked-files=all').split('\0');
    let dirtyFileCount = 0;
    for (let i = 0; i < records.length; i++) {
      if (!records[i]) continue;
      dirtyFileCount++;
      if (/[RC]/.test(records[i].slice(0, 2))) i++;
    }
    return { isRepo: true, branch, dirtyFileCount };
  } catch { return { isRepo: false, branch: null, dirtyFileCount: null }; }
}

export function detectRepoState(cwd = process.cwd()) {
  cwd = path.resolve(cwd);
  const pkg = readJson(path.join(cwd, 'package.json'));
  const exists = (file) => fs.existsSync(path.join(cwd, file));
  const locks = [['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lock', 'bun'], ['bun.lockb', 'bun'], ['package-lock.json', 'npm']];
  const lock = locks.find(([file]) => exists(file));
  const declared = typeof pkg?.packageManager === 'string' ? pkg.packageManager.split('@')[0] : null;
  const packageManager = lock?.[1] || (['npm', 'pnpm', 'yarn', 'bun'].includes(declared) ? declared : pkg ? 'npm' : null);
  const scripts = Object.fromEntries(Object.entries(pkg?.scripts || {}).filter(([, value]) => typeof value === 'string' && value.trim()));
  const rootEntries = entries(cwd);
  const testDir = ['test', 'tests', '__tests__'].find(name => rootEntries.some(e => e.name === name && e.isDirectory()));
  const testCommand = scripts.test ? `${packageManager}${packageManager === 'bun' ? ' run' : ''} test` : null;
  const bin = typeof pkg?.bin === 'string' ? [pkg.bin] : Object.values(pkg?.bin || {});
  let entrypoints = [...new Set([pkg?.main, ...bin, pkg?.module].filter(v => typeof v === 'string' && v))];
  if (!entrypoints.length) entrypoints = ['src/index.js', 'index.js'].filter(exists);
  const extensions = {};
  const scan = (dir) => {
    for (const entry of entries(dir)) {
      if (entry.isDirectory() && !ignored.has(entry.name)) scan(path.join(dir, entry.name));
      else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (ext) extensions[ext] = (extensions[ext] || 0) + 1;
      }
    }
  };
  scan(cwd);
  const languageCounts = {};
  for (const [ext, count] of Object.entries(extensions)) {
    const language = languageExtensions[ext];
    if (language) languageCounts[language] = (languageCounts[language] || 0) + count;
  }
  const languages = Object.keys(languageCounts).sort((a, b) => languageCounts[b] - languageCounts[a] || a.localeCompare(b));
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies, ...pkg?.peerDependencies, ...pkg?.optionalDependencies };
  const config = name => rootEntries.some(e => e.isFile() && e.name.startsWith(`${name}.config.`));
  const frameworks = [
    ['react', 'react' in deps], ['next', 'next' in deps || config('next')],
    ['vite', 'vite' in deps || config('vite')],
    ['tauri', '@tauri-apps/api' in deps || '@tauri-apps/cli' in deps || exists('src-tauri/tauri.conf.json') || exists('src-tauri/Cargo.toml')],
    ['express', 'express' in deps],
  ].filter(([, found]) => found).map(([name]) => name);
  return {
    cwd, packageManager, lockfile: lock?.[0] || null, testCommand, testDir: testDir ? `${testDir}/` : null,
    entrypoints, languages, languageCounts, extensions, scripts,
    hasBuild: !!scripts.build, hasLint: !!scripts.lint, hasDev: !!scripts.dev,
    git: gitState(cwd), frameworks,
  };
}

export function generateOnboarding(cwd, state = detectRepoState(cwd)) {
  const steps = [];
  const add = (id, title, body, action, highlight) => steps.push({ id, title, body, ...(action && { action }), ...(highlight && { highlight }) });
  if (state.packageManager) {
    const command = `${state.packageManager} install`;
    add('install', 'Install dependencies', `This project uses ${state.packageManager} — install with \`${command}\`.`, `run \`${command}\``, state.lockfile || 'package.json');
  }
  add('tests', 'Where tests live', state.testDir
    ? `Tests live in ${state.testDir}${state.testCommand ? ` — run with \`${state.testCommand}\`.` : ' — no test script is configured.'}`
    : state.testCommand ? `Tests are configured in package.json scripts.test — run with \`${state.testCommand}\`.` : 'No test directory or test script was detected.',
  state.testCommand && `run \`${state.testCommand}\``, state.testDir || (state.testCommand && 'package.json'));
  add('entrypoints', 'Start reading here', state.entrypoints.length ? `Your entrypoint${state.entrypoints.length > 1 ? 's are' : ' is'} ${state.entrypoints.join(', ')}.` : 'No package entrypoint or index.js was detected.', undefined, state.entrypoints[0]);
  add('languages', 'Project languages', state.languages.length ? `Source files use ${state.languages.map(name => `${name} (${state.languageCounts[name]} files)`).join(', ')}.` : 'No recognized source language extensions were found.');
  add('git', 'Working tree', state.git.isRepo ? `Branch: ${state.git.branch} — ${state.git.dirtyFileCount} dirty files.` : 'This directory is not a Git working tree, or Git is unavailable.');
  const skills = discoverSkills({ cwd });
  const terms = [...state.frameworks, ...state.languages].map(value => value.toLowerCase());
  const relevant = skills.map(skill => ({ skill, score: terms.filter(term => `${skill.name} ${skill.description}`.toLowerCase().includes(term)).length }))
    .filter(item => item.score).sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name)).slice(0, 3);
  if (skills.length) add('skills', 'Skills for this repo', `Ox knows ${skills.length} skills${relevant.length ? ` — ${relevant.length} relevant to this repo: ${relevant.map(item => item.skill.name).join(', ')}.` : ' — no repo-specific matches were detected.'}`);
  for (const framework of state.frameworks) {
    const advice = { react: 'Start with the UI components.', next: 'Check app/ or pages/ for routes.', vite: 'Check the Vite configuration and index.html.', tauri: 'Check src-tauri/ for the desktop backend.', express: 'Start with the server entrypoint and route handlers.' };
    add(`framework-${framework}`, `${framework} project`, `Detected ${framework}. ${advice[framework]}`);
  }
  for (const name of ['dev', 'build', 'lint']) {
    if (!state.scripts[name]) continue;
    const command = `${state.packageManager} run ${name}`;
    add(name, { dev: 'Start the dev server', build: 'Build the project', lint: 'Check code style' }[name], `The ${name} script is configured — run \`${command}\`.`, `run \`${command}\``, 'package.json');
  }
  add('help', 'Keep exploring', 'Ask me anything — try `/help` for the command list.', 'type `/help`');
  return steps;
}

function makeWalk(cwd, steps) {
  const file = path.join(cwd, '.agent', 'clicky-progress.json');
  const saved = readJson(file);
  const ids = steps.map(step => step.id);
  const sameGuide = JSON.stringify(saved?.steps) === JSON.stringify(ids);
  let index = sameGuide && Number.isInteger(saved.nextIndex) ? Math.max(0, Math.min(saved.nextIndex, steps.length)) : Math.max(0, ids.indexOf(saved?.nextId));
  let displayed = Math.min(index + 1, steps.length);
  const persist = (nextIndex) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, steps: ids, nextIndex, nextId: ids[nextIndex] ?? null }, null, 2));
    index = nextIndex;
  };
  const walk = {
    next() {
      if (this.done) return null;
      const current = steps[index];
      persist(index + 1);
      displayed = index;
      return current;
    },
    remaining() { return steps.length - index; },
    get done() { return index >= steps.length; },
    jumpTo(id) {
      const target = ids.indexOf(id);
      if (target < 0) return false;
      persist(target);
      displayed = target + 1;
      return true;
    },
  };
  return { walk, format: (options = {}) => formatOnboarding(steps, { step: displayed, ...options }) };
}

export function createOnboardingWalk(cwd = process.cwd()) {
  return makeWalk(cwd, generateOnboarding(cwd)).walk;
}

export function formatOnboarding(steps, { step = 1 } = {}) {
  if (!steps.length) return '  CLICKY ONBOARDING · no steps';
  if (!Number.isInteger(step) || step < 1 || step > steps.length) throw new RangeError('step must be a 1-based guide index');
  const current = steps[step - 1];
  const filled = Math.round(step / steps.length * 20);
  return [`  CLICKY ONBOARDING · step ${step}/${steps.length}`, `  ${'▓'.repeat(filled)}${'░'.repeat(20 - filled)}`,
    `  ${current.title}`, `  ${current.body}`, ...(current.action ? [`  → action: ${current.action}`] : [])].join('\n');
}

export function clickyOnboard(cwd = process.cwd()) {
  const state = detectRepoState(cwd);
  const steps = generateOnboarding(cwd, state);
  return { state, steps, ...makeWalk(cwd, steps) };
}
