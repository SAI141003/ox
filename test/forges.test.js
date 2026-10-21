// ox pr on GitLab and Bitbucket (src/dev-flow.js): forge detection, GitLab's
// push options (delivered for real to a bare repo), Bitbucket's API or link.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const D = await import('../src/dev-flow.js');
const git = (cwd, ...a) => spawnSync('git', ['-C', cwd, ...a], { encoding: 'utf8' });

test('the forge is read from origin: GitHub, GitLab (self-hosted too), Bitbucket', () => {
  assert.deepEqual(D.forgeOf('git@gitlab.com:me/app.git'), { forge: 'gitlab', host: 'gitlab.com', path: 'me/app' });
  assert.equal(D.forgeOf('https://gitlab.acme.dev/team/sub/app.git').path, 'team/sub/app');
  assert.equal(D.forgeOf('git@bitbucket.org:ws/repo.git').forge, 'bitbucket');
  assert.equal(D.forgeOf('https://github.com/SAI141003/ox.git').forge, 'github');
  assert.equal(D.forgeOf('/some/local/path').forge, 'other');
});

test('GitLab push options reach the server: create, target, title, description', { skip: process.platform === 'win32' && 'shell hook' }, () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-forge-'));
  const bare = path.join(d, 'remote.git'), work = path.join(d, 'work'), seen = path.join(d, 'options.txt');
  spawnSync('git', ['init', '-q', '--bare', bare]);
  git(bare, 'config', 'receive.advertisePushOptions', 'true');
  fs.writeFileSync(path.join(bare, 'hooks', 'pre-receive'), `#!/bin/sh\ni=0\nwhile [ $i -lt "$GIT_PUSH_OPTION_COUNT" ]; do eval "echo \\"\\$GIT_PUSH_OPTION_$i\\"" >> '${seen}'; i=$((i+1)); done\necho "remote:   https://gitlab.com/me/app/-/merge_requests/7" >&2\n`, { mode: 0o755 });
  spawnSync('git', ['init', '-q', '-b', 'main', work]);
  git(work, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'one');
  git(work, 'remote', 'add', 'origin', bare);
  git(work, 'switch', '-q', '-c', 'ox/fix-cart');
  const r = spawnSync('git', ['-C', work, ...D.gitlabPushArgs('ox/fix-cart', { into: 'main', title: 'Fix the cart total', body: 'Checked by ox\n- npm test' })], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(fs.readFileSync(seen, 'utf8').trim().split('\n'), ['merge_request.create', 'merge_request.target=main', 'merge_request.title=Fix the cart total', 'merge_request.description=Checked by ox - npm test', 'merge_request.remove_source_branch']);
  assert.equal(D.gitlabUrlFrom(r.stderr), 'https://gitlab.com/me/app/-/merge_requests/7');
});

test('Bitbucket: a pull request through the API with an app password, else the create link', async () => {
  const pr = { path: 'ws/repo', branch: 'ox/fix', into: 'main', title: 'Fix', body: 'checked' };
  const link = await D.bitbucketPr(pr, { env: {} });
  assert.equal(link.created, false);
  assert.equal(link.url, 'https://bitbucket.org/ws/repo/pull-requests/new?source=ox%2Ffix&dest=main&t=1');
  let sent;
  const made = await D.bitbucketPr(pr, { env: { BITBUCKET_USERNAME: 'me', BITBUCKET_APP_PASSWORD: 'pw' }, fetchImpl: async (url, init) => { sent = { url, init }; return new Response(JSON.stringify({ links: { html: { href: 'https://bitbucket.org/ws/repo/pull-requests/3' } } }), { status: 201 }); } });
  assert.equal(made.url, 'https://bitbucket.org/ws/repo/pull-requests/3');
  assert.equal(sent.url, 'https://api.bitbucket.org/2.0/repositories/ws/repo/pullrequests');
  assert.deepEqual(JSON.parse(sent.init.body).destination, { branch: { name: 'main' } });
  assert.match(sent.init.headers.Authorization, /^Basic /);
});
