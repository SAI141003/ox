import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitIntegration } from '../src/git-integration.js';

function fixture(output = '') {
  const calls = [];
  const git = new GitIntegration('/not-a-real-repository', {
    execFile(command, args, options) {
      calls.push({ command, args, options });
      if (output instanceof Error) throw output;
      return Buffer.from(output);
    },
  });
  return { git, calls };
}

test('status propagates a failed git invocation instead of claiming clean', () => {
  const error = new Error('repository unavailable');
  const { git } = fixture(error);
  assert.throws(() => git.status(), /repository unavailable/);
});

test('status parses NUL-delimited paths and both status columns', () => {
  const { git, calls } = fixture('## main...origin/main\0 M leading.txt\0MM both.txt\0?? odd\nname.txt\0R  new -> name.txt\0old name.txt\0');
  assert.deepEqual(git.status(), {
    branch: 'main',
    staged: [{ status: 'M', file: 'both.txt' }, { status: 'R', file: 'new -> name.txt' }],
    unstaged: [{ status: 'M', file: 'leading.txt' }, { status: 'M', file: 'both.txt' }],
    untracked: ['odd\nname.txt'],
    clean: false,
  });
  assert.deepEqual(calls[0].args, ['status', '--porcelain=v1', '-b', '-z']);
});

test('git arguments are passed literally without a shell', () => {
  const { git, calls } = fixture();
  const file = 'space name; literal.txt';
  const message = 'fix: keep spaces and $symbols literal';
  git.stage(file);
  git.unstage(file);
  git.diff(file);
  git.commit(message);
  assert.deepEqual(calls.map(call => call.args), [
    ['add', '--', file],
    ['reset', 'HEAD', '--', file],
    ['diff', '--', file],
    ['commit', '-m', message],
  ]);
  for (const call of calls) {
    assert.equal(call.command, 'git');
    assert.equal(call.options.cwd, '/not-a-real-repository');
    assert.equal(call.options.shell, false);
  }
});

test('read operations preserve errors', () => {
  const { git } = fixture(new Error('git failed'));
  for (const invoke of [() => git.diff(), () => git.diffAll(), () => git.listBranches(), () => git.getLog(), () => git.getRemotes()]) {
    assert.throws(invoke, /git failed/);
  }
});

test('status consumes copy origins without treating them as files', () => {
  const { git } = fixture('## main\0C  copy.txt\0source.txt\0');
  assert.deepEqual(git.status().staged, [{ status: 'C', file: 'copy.txt' }]);
});

test('branch option-like names are rejected before git executes', () => {
  const { git, calls } = fixture();
  assert.throws(() => git.branch('--delete'), /branch name/);
  assert.throws(() => git.switchBranch('-b'), /branch name/);
  assert.equal(calls.length, 0);
});

test('getLog validates limits and remotes ignore malformed lines', () => {
  const { git, calls } = fixture('origin https://example.invalid/repo (fetch)\nmalformed\norigin https://example.invalid/repo (push)\n');
  assert.throws(() => git.getLog(-1), /limit/);
  assert.equal(calls.length, 0);
  assert.deepEqual(git.getRemotes(), { origin: ['https://example.invalid/repo', 'https://example.invalid/repo'] });
});

test('createPR reports push only and preserves failure', () => {
  const { git, calls } = fixture('pushed\n');
  assert.deepEqual(git.createPR('title', 'body'), { pushed: true, created: false, title: 'title', body: 'body', output: 'pushed' });
  assert.deepEqual(calls[0].args, ['push', '-u', 'origin', 'HEAD']);
  assert.throws(() => fixture(new Error('push failed')).git.createPR('title', 'body'), /push failed/);
});
