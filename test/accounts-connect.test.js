import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { accountCanConnect, accountInstallPage, launchSubscriptionLogin } from '../src/subscriptions.js';

test('account sign-in is allow-listed and refuses browser-supplied commands', async () => {
  assert.throws(() => launchSubscriptionLogin('echo hacked', { platform: 'darwin' }), /does not support a built-in sign-in flow/);
  assert.throws(() => launchSubscriptionLogin('mine', { platform: 'darwin' }), /does not support a built-in sign-in flow/);
  assert.deepEqual(await launchSubscriptionLogin('chatgpt', { platform: 'linux' }), {
    opened: false,
    reason: 'The one-click Terminal sign-in is currently available in the macOS app.',
  });
});

test('account setup links point to provider-owned installation and sign-in docs', () => {
  assert.match(accountInstallPage('claude'), /^https:\/\/docs\.anthropic\.com\//);
  assert.match(accountInstallPage('chatgpt'), /^https:\/\/developers\.openai\.com\//);
  assert.match(accountInstallPage('gemini'), /^https:\/\/github\.com\/google-gemini\//);
  assert.equal(accountInstallPage('custom'), null);
  assert.equal(accountCanConnect('chatgpt'), true);
  assert.equal(accountCanConnect('aider'), false, 'API-key tools are not falsely presented as OAuth accounts');
});

test('Connect Account opens real sign-in and verifies state instead of copying terminal text', () => {
  const html = fs.readFileSync(new URL('../src/web/chat.html', import.meta.url), 'utf8');
  assert.match(html, /postJson\('\/ox\/accounts\/connect', \{ id \}\)/);
  assert.match(html, /getJson\(`\/ox\/accounts\?id=/);
  assert.match(html, /current\?\.works/);
  assert.match(html, /data-account-connect/);
  assert.match(html, /Install guide/);
  assert.doesNotMatch(html, /Copy install/);
});
