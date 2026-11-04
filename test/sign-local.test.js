// macOS keeps Screen Recording and Accessibility by an app's signature. These hold the rule that
// stopped updates losing them: a download is signed by this Mac; a real Developer ID build is left alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAdhoc, signDownload, ensureLocalIdentity } from '../src/sign-local.js';

const mac = (answers) => {
  const calls = [];
  const run = (cmd, args) => { calls.push([cmd, ...args]); return answers(cmd, args); };
  return { run, calls };
};
const withIdentity = (cmd, args) => (cmd === 'security' ? { status: 0, stdout: '1) ABC "OX Local Signing"' } : args[0] === '-dv' ? { status: 0, stderr: 'Signature=adhoc' } : { status: 0 });

test('an ad-hoc download is signed by this Mac, with the app\'s own identifier', () => {
  const { run, calls } = mac(withIdentity);
  assert.equal(signDownload('/x/OX.app', 'dev.ox.app', { run, env: {} }), 'local');
  const sign = calls.find((c) => c[0] === 'codesign' && c.includes('--sign'));
  assert.ok(sign.includes('OX Local Signing') && sign.includes('dev.ox.app') && sign.includes('/x/OX.app'));
});

test('a build someone signed is left exactly as it is', () => {
  const { run, calls } = mac((cmd, args) => (args[0] === '-dv' ? { status: 0, stderr: 'Authority=Developer ID Application: Someone' } : { status: 0 }));
  assert.equal(signDownload('/x/OX.app', 'dev.ox.app', { run, env: {} }), 'kept');
  assert.equal(calls.some((c) => c.includes('--sign')), false);
});

test('no identity on a build machine or in a test: none is made in anyone\'s keychain', () => {
  const { run, calls } = mac((cmd) => (cmd === 'security' ? { status: 0, stdout: '0 identities' } : { status: 0, stderr: 'Signature=adhoc' }));
  assert.equal(ensureLocalIdentity({ run, env: { CI: '1' } }), false);
  assert.equal(calls.some((c) => c.includes('import') || c[0].includes('openssl')), false);
  assert.equal(signDownload('/x/OX.app', 'dev.ox.app', { run, env: { CI: '1' } }), 'adhoc');
});

test('ad hoc is read from what codesign says', () => {
  assert.equal(isAdhoc('f', () => ({ stderr: 'Signature=adhoc' })), true);
  assert.equal(isAdhoc('f', () => ({ stderr: 'f: code object is not signed at all' })), true);
  assert.equal(isAdhoc('f', () => ({ stderr: 'Authority=OX Local Signing' })), false);
});
