import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { detectRepoState, generateOnboarding, createOnboardingWalk, formatOnboarding, clickyOnboard } from '../src/clicky-onboard.js';

function fixture(t, files = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'clicky-onboard-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(cwd, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  }
  return cwd;
}

for (const [lock, pm] of [['package-lock.json', 'npm'], ['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lock', 'bun'], ['bun.lockb', 'bun']]) {
  test(`detects ${pm} from ${lock}`, t => {
    const state = detectRepoState(fixture(t, { 'package.json': { scripts: { test: 'node --test' } }, [lock]: '' }));
    assert.equal(state.packageManager, pm);
    assert.equal(state.testCommand, `${pm}${pm === 'bun' ? ' run' : ''} test`);
  });
}

test('finds main, bin and module entrypoints and index fallback', t => {
  const cwd = fixture(t, { 'package.json': { main: 'lib/main.js', bin: { cli: './bin/cli.js' }, module: 'lib/module.mjs' } });
  assert.deepEqual(detectRepoState(cwd).entrypoints, ['lib/main.js', './bin/cli.js', 'lib/module.mjs']);
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ bin: 'cli.js' }));
  assert.deepEqual(detectRepoState(cwd).entrypoints, ['cli.js']);
  fs.writeFileSync(path.join(cwd, 'package.json'), '{}');
  fs.writeFileSync(path.join(cwd, 'index.js'), '');
  assert.deepEqual(detectRepoState(cwd).entrypoints, ['index.js']);
});

test('generates factual guide, script actions, languages and framework hints', t => {
  const cwd = fixture(t, {
    'package.json': { main: 'src/index.js', scripts: { test: 'node --test', dev: 'vite', build: 'vite build', lint: 'eslint .' }, dependencies: { react: '*', express: '*' } },
    'package-lock.json': '', 'test/example.test.js': '', 'src/index.js': '', 'src/view.tsx': '',
    'vite.config.js': '', 'src-tauri/tauri.conf.json': '{}', 'next.config.mjs': '', 'node_modules/ignored.py': '',
  });
  const state = detectRepoState(cwd);
  assert.equal(state.testDir, 'test/');
  assert.deepEqual(state.frameworks, ['react', 'next', 'vite', 'tauri', 'express']);
  assert.equal(state.languageCounts.JavaScript, 4);
  assert.equal(state.languageCounts.TypeScript, 1);
  assert.ok(!state.languages.includes('Python'));
  assert.ok(state.hasBuild && state.hasLint && state.hasDev);
  const steps = generateOnboarding(cwd, state);
  assert.ok(steps.length >= 5);
  assert.match(steps.find(s => s.id === 'install').body, /npm.*`npm install`/);
  assert.match(steps.find(s => s.id === 'tests').body, /test\/.*`npm test`/);
  assert.match(steps.find(s => s.id === 'entrypoints').body, /src\/index.js/);
  assert.equal(steps.find(s => s.id === 'dev').action, 'run `npm run dev`');
  assert.match(steps.at(-1).body, /Ask me anything.*`\/help`/);
  assert.match(formatOnboarding(steps, { step: 2 }), /step 2\/\d+\n  [▓░]{20}\n  Where tests live/);
  assert.throws(() => formatOnboarding(steps, { step: 0 }), RangeError);
  assert.match(formatOnboarding([]), /no steps/);
});

test('walk resumes, jumps, finishes and convenience format tracks displayed step', t => {
  const cwd = fixture(t, { 'package.json': {} });
  const onboard = clickyOnboard(cwd);
  assert.match(onboard.format(), /step 1\//);
  assert.equal(onboard.walk.next().id, onboard.steps[0].id);
  const progress = path.join(cwd, '.agent/clicky-progress.json');
  assert.equal(JSON.parse(fs.readFileSync(progress, 'utf8')).nextIndex, 1);
  const resumed = createOnboardingWalk(cwd);
  assert.equal(resumed.next().id, onboard.steps[1].id);
  assert.equal(resumed.jumpTo('missing'), false);
  assert.equal(resumed.jumpTo('entrypoints'), true);
  assert.equal(createOnboardingWalk(cwd).next().id, 'entrypoints');
  while (!resumed.done) assert.ok(resumed.next());
  assert.equal(resumed.remaining(), 0);
  assert.equal(resumed.next(), null);
  assert.equal(createOnboardingWalk(cwd).done, true);
  assert.equal(onboard.walk.jumpTo('tests'), true);
  onboard.walk.next();
  assert.match(onboard.format(), /Where tests live/);
  fs.writeFileSync(progress, '{broken');
  assert.equal(createOnboardingWalk(cwd).next().id, onboard.steps[0].id);
});

test('missing metadata does not invent commands; directory-only tests are reported', t => {
  const cwd = fixture(t, { 'tests/sample.py': '', 'package.json': '{broken' });
  const state = detectRepoState(cwd);
  assert.equal(state.packageManager, null);
  assert.equal(state.testCommand, null);
  assert.equal(state.testDir, 'tests/');
  assert.equal(generateOnboarding(cwd, state).find(s => s.id === 'tests').action, undefined);
});

test('reports real git branch and dirty file count', t => {
  const cwd = fixture(t, { 'one.js': '', 'two\nlines.js': '' });
  const git = (...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' });
  git('init', '--initial-branch=onboarding');
  assert.deepEqual(detectRepoState(cwd).git, { isRepo: true, branch: 'onboarding', dirtyFileCount: 2 });
});
