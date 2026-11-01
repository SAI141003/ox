// Sign OX Island and OX with the Mac's own "OX Local Signing" identity when it
// exists. macOS keeps Screen Recording and Accessibility for an app by its
// signature: an ad-hoc signature changes with every build, so each update
// silently lost those permissions. A fixed local identity keeps them.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const LOCAL_IDENTITY = 'OX Local Signing';

export function hasLocalIdentity() {
  const r = spawnSync('security', ['find-identity', '-p', 'codesigning'], { encoding: 'utf8', timeout: 10_000 });
  return (r.stdout ?? '').includes(`"${LOCAL_IDENTITY}"`);
}

/** Sign an .app: the local identity when present (stable), else ad hoc. → 'local' | 'adhoc' */
export function signApp(app, identifier, run = spawnSync) {
  if (hasLocalIdentity()) {
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
export function createLocalIdentity({ run = spawnSync, log = console.log } = {}) {
  if (process.platform !== 'darwin') throw new Error('only on macOS');
  if (hasLocalIdentity()) { log(`"${LOCAL_IDENTITY}" is already in your keychain`); return true; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-sign-'));
  const pass = crypto.randomBytes(12).toString('hex');
  try {
    const conf = path.join(dir, 'c.cnf');
    fs.writeFileSync(conf, `[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=${LOCAL_IDENTITY}\n[ext]\nbasicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,codeSigning\n`, { mode: 0o600 });
    const step = (cmd, args, what) => { const r = run(cmd, args, { encoding: 'utf8', stdio: 'pipe' }); if (r.status !== 0) throw new Error(`${what}: ${String(r.stderr || r.stdout).trim().split('\n').pop()}`); };
    step('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '3650', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-config', conf], 'making the certificate');
    step('/usr/bin/openssl', ['pkcs12', '-export', '-inkey', path.join(dir, 'k.pem'), '-in', path.join(dir, 'c.pem'), '-out', path.join(dir, 'id.p12'), '-passout', `pass:${pass}`, '-name', LOCAL_IDENTITY], 'packing it');
    step('/usr/bin/security', ['import', path.join(dir, 'id.p12'), '-k', path.join(os.homedir(), 'Library/Keychains/login.keychain-db'), '-P', pass, '-T', '/usr/bin/codesign'], 'adding it to your login keychain');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const ok = hasLocalIdentity();
  log(ok ? `"${LOCAL_IDENTITY}" added. Rebuild once (ox island restart), then turn on Accessibility for OX Island and OX one last time: rebuilds keep it from now on.` : 'the identity did not appear in the keychain');
  return ok;
}
