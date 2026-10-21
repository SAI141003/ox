// Keep the agent out of secrets (src/oxignore.js): defaults, the project's
// .oxignore, exceptions, and the file tools refusing them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const O = await import('../src/oxignore.js');
const T = await import('../src/tools/fs.js');

const proj = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ox-oxignore-')));

test('defaults: .env, keys and credential files are secrets; examples and public keys are not', () => {
  const root = proj();
  const is = (rel) => O.secretMatch(path.join(root, rel), root, {});
  for (const f of ['.env', '.env.local', 'apps/web/.env.production', 'certs/server.pem', 'id_rsa', 'deploy.key', '.npmrc', 'credentials.json', 'service-account-prod.json', 'config/secrets.yml']) assert.ok(is(f), f);
  for (const f of ['.env.example', '.env.sample', 'id_rsa.pub', 'src/app.js', 'README.md', 'keys.md', 'environment.ts']) assert.equal(is(f), null, f);
});

test('a project .oxignore adds paths, names and folders, and "!" re-allows', () => {
  const root = proj();
  fs.writeFileSync(path.join(root, '.oxignore'), '# mine\nconfig/prod.yml\n*.sqlite\nprivate/\n!.env.test\n');
  const is = (rel) => O.secretMatch(path.join(root, rel), root, {});
  assert.ok(is('config/prod.yml'));
  assert.equal(is('other/config/prod.yml'), null, 'a path with a slash is from the root');
  assert.ok(is('data/app.sqlite'));
  assert.ok(is('private/notes.txt'));
  assert.equal(is('.env.test'), null);
  assert.ok(is('.env'));
  assert.equal(O.secretMatch(path.join(root, '.env'), root, { OX_ALLOW_SECRET_READS: '1' }), null, 'the switch for one run');
});

test('the file tools refuse secrets: read, write, edit; grep skips them', async () => {
  const root = proj();
  fs.writeFileSync(path.join(root, '.env'), 'API_KEY=sk-live-123\n');
  fs.writeFileSync(path.join(root, 'app.js'), 'const key = process.env.API_KEY;\n');
  const ctx = { cwd: root };
  const r = await T.readFileTool({ path: '.env' }, ctx);
  assert.equal(r.isError, true);
  assert.match(r.content, /looks like a secret.*\.oxignore/);
  assert.doesNotMatch(r.content, /sk-live/);
  assert.equal((await T.writeFileTool({ path: '.env', content: 'x' }, ctx)).isError, true);
  assert.equal(fs.readFileSync(path.join(root, '.env'), 'utf8'), 'API_KEY=sk-live-123\n', 'not overwritten');
  assert.equal((await T.editFileTool({ path: '.env', old_string: 'API_KEY', new_string: 'X' }, ctx)).isError, true);
  const g = await T.grepTool({ pattern: 'API_KEY' }, ctx);
  assert.match(g.content, /app\.js/);
  assert.doesNotMatch(g.content, /sk-live|\.env:/);
  assert.equal((await T.readFileTool({ path: 'app.js' }, ctx)).isError, undefined, 'ordinary files are fine');
});
