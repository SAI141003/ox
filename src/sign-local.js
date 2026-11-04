// Sign OX Island and OX with the Mac's own "OX Local Signing" identity when it
// exists. macOS keeps Screen Recording and Accessibility for an app by its
// signature: an ad-hoc signature changes with every build, so each update
// silently lost those permissions. A fixed local identity keeps them. A release
// has no Apple certificate behind it, so this Mac's identity is made when it is
// first needed, and a download is signed with it before it takes the app's place.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const LOCAL_IDENTITY = 'OX Local Signing';

const LOGIN_KEYCHAIN = () => path.join(os.homedir(), 'Library/Keychains/login.keychain-db');

export function hasLocalIdentity({ run = spawnSync, keychain = null } = {}) {
  const r = run('security', ['find-identity', '-p', 'codesigning', ...(keychain ? [keychain] : [])], { encoding: 'utf8', timeout: 10_000 });
  return (r.stdout ?? '').includes(`"${LOCAL_IDENTITY}"`);
}

// Never made on a build machine or in a test: there is no one's Mac there to keep a grant on.
const mayMakeIdentity = (env = process.env) => process.platform === 'darwin' && !env.CI && !env.NODE_TEST_CONTEXT && env.OX_NO_KEYSTORE !== '1';

/** The identity exists after this, if it can. Quiet: failing leaves the old ad-hoc behaviour. */
export function ensureLocalIdentity({ run = spawnSync, env = process.env } = {}) {
  if (hasLocalIdentity({ run })) return true;
  if (!mayMakeIdentity(env)) return false;
  try { return createLocalIdentity({ run, log: () => {} }); } catch { return false; }
}

/** An app or helper whose signature macOS would forget on the next build. */
export function isAdhoc(file, run = spawnSync) {
  const r = run('codesign', ['-dv', file], { encoding: 'utf8', timeout: 20_000 });
  return /Signature=adhoc|code object is not signed/.test(`${r.stderr ?? ''}${r.stdout ?? ''}`);
}

/**
 * A download, before it replaces the app: signed by this Mac, so Screen Recording and Accessibility
 * carry over. A build signed by someone (Developer ID) is left exactly as it is.
 * → 'local' | 'kept' | 'adhoc'
 */
export function signDownload(app, identifier, { run = spawnSync, env = process.env } = {}) {
  if (!isAdhoc(app, run)) return 'kept';
  if (!ensureLocalIdentity({ run, env })) return 'adhoc';
  const r = run('codesign', ['--force', '--deep', '--sign', LOCAL_IDENTITY, ...(identifier ? ['--identifier', identifier] : []), app], { stdio: 'ignore', timeout: 120_000 });
  return r.status === 0 ? 'local' : 'adhoc';
}

/** Sign an .app: the local identity when present (stable), else ad hoc. → 'local' | 'adhoc' */
export function signApp(app, identifier, run = spawnSync) {
  if (ensureLocalIdentity({ run })) {
    const r = run('codesign', ['--force', '--deep', '--sign', LOCAL_IDENTITY, ...(identifier ? ['--identifier', identifier] : []), app], { stdio: 'ignore', timeout: 120_000 });
    if (r.status === 0) return 'local';
  }
  run('codesign', ['--force', '--deep', '-s', '-', app], { stdio: 'ignore' });
  return 'adhoc';
}

/**
 * Make the "OX Local Signing" identity in your login keychain: a self-signed
 * code-signing certificate that never leaves this Mac. From then on every
 * rebuild of OX Island and OX keeps the same signature, so Accessibility
 * (typing, clicking) and Screen Recording stay granted. Run by you, once:
 * `ox island sign-setup`. macOS may ask to allow codesign to use the key.
 */
export function createLocalIdentity({ run = spawnSync, log = console.log, keychain = LOGIN_KEYCHAIN() } = {}) {
  if (process.platform !== 'darwin') throw new Error('only on macOS');
  if (hasLocalIdentity({ run, keychain })) { log(`"${LOCAL_IDENTITY}" is already in your keychain`); return true; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-sign-'));
  const pass = crypto.randomBytes(12).toString('hex');
  try {
    const conf = path.join(dir, 'c.cnf');
    fs.writeFileSync(conf, `[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=${LOCAL_IDENTITY}\n[ext]\nbasicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,codeSigning\n`, { mode: 0o600 });
    const step = (cmd, args, what) => { const r = run(cmd, args, { encoding: 'utf8', stdio: 'pipe' }); if (r.status !== 0) throw new Error(`${what}: ${String(r.stderr || r.stdout).trim().split('\n').pop()}`); };
    step('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '3650', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-config', conf], 'making the certificate');
    step('/usr/bin/openssl', ['pkcs12', '-export', '-inkey', path.join(dir, 'k.pem'), '-in', path.join(dir, 'c.pem'), '-out', path.join(dir, 'id.p12'), '-passout', `pass:${pass}`, '-name', LOCAL_IDENTITY], 'packing it');
    step('/usr/bin/security', ['import', path.join(dir, 'id.p12'), '-k', keychain, '-P', pass, '-T', '/usr/bin/codesign'], 'adding it to your login keychain');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const ok = hasLocalIdentity({ run, keychain });
  log(ok ? `"${LOCAL_IDENTITY}" added. Rebuild once (ox island restart), then turn on Accessibility for OX Island and OX one last time: rebuilds keep it from now on.` : 'the identity did not appear in the keychain');
  return ok;
}
