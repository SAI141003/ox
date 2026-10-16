// The app's data: pasted keys stay on this machine and are never shown back,
// a key from the shell always wins, and session ids cannot walk out of
// ~/.ox/sessions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setKey, readKeys, loadKeysIntoEnv, keyStatus } from '../src/keystore.js';
import { providersView, sessionView } from '../src/app-api.js';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ox-keys-')), 'keys.json');

test('a pasted key is saved 0600, applied, and shown only as its last four characters', () => {
  const file = tmp();
  const env = {};
  setKey('ANTHROPIC_API_KEY', 'sk-ant-secret-1234', { env, file });
  assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant-secret-1234');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const st = keyStatus('ANTHROPIC_API_KEY', env, file);
  assert.deepEqual(st, { set: true, source: 'app', hint: '…1234' });
  // Removing it clears the environment only because the value came from the file.
  setKey('ANTHROPIC_API_KEY', null, { env, file });
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.deepEqual(readKeys(file), {});
});

test('a key set in the shell wins over the file and is never cleared by it', () => {
  const file = tmp();
  setKey('OPENAI_API_KEY', 'from-file-9999', { env: {}, file });
  const env = { OPENAI_API_KEY: 'from-shell-0000' };
  assert.deepEqual(loadKeysIntoEnv(env, file), []);
  assert.equal(env.OPENAI_API_KEY, 'from-shell-0000');
  assert.equal(keyStatus('OPENAI_API_KEY', env, file).source, 'environment');
  setKey('OPENAI_API_KEY', null, { env, file });
  assert.equal(env.OPENAI_API_KEY, 'from-shell-0000');
  // OX_NO_KEYSTORE=1 (tests, CI) loads nothing.
  setKey('XAI_API_KEY', 'xai-abcdefgh', { env: {}, file });
  assert.deepEqual(loadKeysIntoEnv({ OX_NO_KEYSTORE: '1' }, file), []);
});

test('only credential-shaped names and key-shaped values are accepted', () => {
  const file = tmp();
  for (const name of ['PATH', 'NODE_OPTIONS', 'bad name', 'HOME']) assert.throws(() => setKey(name, 'x', { env: {}, file }), /not a key name/);
  fs.writeFileSync(file, JSON.stringify({ NODE_OPTIONS: '--require evil', GROQ_API_KEY: 'gsk-1234567890' }));
  const env = {};
  assert.deepEqual(loadKeysIntoEnv(env, file), ['GROQ_API_KEY']);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.throws(() => setKey('GROQ_API_KEY', 'has a space', { env: {}, file }), /does not look like/);
});

test('the providers view never carries a key', () => {
  const env = { ANTHROPIC_API_KEY: 'sk-ant-supersecretvalue-7777' };
  const view = providersView(env);
  const a = view.find((p) => p.id === 'anthropic');
  assert.equal(a.set, true);
  assert.equal(a.hint, '…7777');
  assert.ok(!JSON.stringify(view).includes('supersecret'));
});

test('session ids cannot reach outside the sessions folder', () => {
  assert.equal(sessionView('../config'), null);
  assert.equal(sessionView('../../etc/passwd'), null);
  assert.equal(sessionView('no-such-session-123'), null);
});
