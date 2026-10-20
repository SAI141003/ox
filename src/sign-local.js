// Sign OX Island and OX with the Mac's own "OX Local Signing" identity when it
// exists. macOS keeps Screen Recording and Accessibility for an app by its
// signature: an ad-hoc signature changes with every build, so each update
// silently lost those permissions. A fixed local identity keeps them.
import { spawnSync } from 'node:child_process';

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
