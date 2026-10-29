// Optional integration point for the CUA command-line tools.  Ox never
// downloads or invokes a remote installer for the owner: a locally installed
// CUA binary is discovered and its own version command is used as evidence.
// This keeps CUA's VM/desktop automation boundary explicit in the UI.
import { spawnSync } from 'node:child_process';

function executable(name, platform = process.platform) {
  const lookup = platform === 'win32' ? 'where' : 'which';
  const r = spawnSync(lookup, [name], { encoding: 'utf8', timeout: 3_000, windowsHide: true });
  if (r.status !== 0) return null;
  return String(r.stdout ?? '').split(/\r?\n/).map((x) => x.trim()).find(Boolean) ?? null;
}

function version(command) {
  if (!command) return null;
  const r = spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 8_000, windowsHide: true });
  if (r.error || r.status !== 0) return { available: false, error: String(r.error?.message ?? r.stderr ?? `exit ${r.status}`).trim() };
  return { available: true, version: String(r.stdout ?? r.stderr ?? '').trim().split(/\r?\n/)[0] || 'installed' };
}

/**
 * Report the installed CUA surface without conflating it with an active VM or
 * browser session.  A caller must still create/select a CUA Space explicitly.
 */
export function cuaStatus({ platform = process.platform } = {}) {
  const cua = executable('cua', platform);
  const driver = executable('cua-driver', platform);
  return {
    cua: { command: cua, ...version(cua) },
    driver: { command: driver, ...version(driver) },
    capabilities: {
      spaces: 'available only when the CUA CLI is installed and the owner has created or joined a Space',
      driver: 'available only when Cua Driver is installed and attached to an owner-authorized desktop/browser',
      isolation: 'CUA Spaces provide the isolated runtime; Ox does not label a workspace or profile as a separate computer',
    },
    setup: 'Install CUA using its verified upstream instructions, then create or join a Space from CUA. Ox will discover the local CLI on refresh.',
  };
}
