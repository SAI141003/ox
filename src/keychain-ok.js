// Whether this process may use the macOS Keychain: only a Mac, only your real home,
// and only when your login keychain is there. A process with another HOME (tests,
// sandboxes, scripts) asking the Keychain makes macOS pop up "Keychain Not Found".
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function keychainUsable(env = process.env) {
  if (process.platform !== 'darwin' || env.NODE_TEST_CONTEXT || env.OX_NO_KEYCHAIN === '1') return false;
  let real;
  try { real = os.userInfo().homedir; } catch { return false; }
  const home = env.HOME || os.homedir();
  if (path.resolve(home) !== path.resolve(real)) return false;
  return fs.existsSync(path.join(real, 'Library', 'Keychains', 'login.keychain-db'));
}
