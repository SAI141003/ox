// Tests stand up a throwaway home by setting process.env.HOME. Node on
// Windows reads USERPROFILE instead, so without this those tests would write
// to (and read from) the runner's real profile. Loaded only by verify on Windows.
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';

if (process.platform === 'win32') {
  const real = os.homedir;
  os.homedir = () => process.env.HOME || real();
  syncBuiltinESMExports();
}
