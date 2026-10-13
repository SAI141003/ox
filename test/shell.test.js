// The shell ox runs commands in, per OS: never a hard-coded /bin/zsh that a
// Windows machine does not have.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectShell, shellArgv, shellNote } from '../src/shell.js';

test('macOS/Linux: $SHELL, with a login shell', () => {
  assert.deepEqual(shellArgv('ls', { platform: 'linux', env: { SHELL: '/usr/bin/fish' }, fresh: true }), ['/usr/bin/fish', '-lc', 'ls']);
  assert.deepEqual(shellArgv('ls', { platform: 'linux', env: { SHELL: '/bin/bash' }, login: false, fresh: true }), ['/bin/bash', '-c', 'ls']);
  const none = detectShell({ platform: 'linux', env: {}, fresh: true });
  assert.ok(['/bin/zsh', '/bin/bash', '/bin/sh'].includes(none.path));
});

test('Windows: Git Bash when it is there, else PowerShell, and the model is told', () => {
  const pf = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-pf-'));
  const ps = detectShell({ platform: 'win32', env: { ProgramFiles: pf, PATH: '' }, fresh: true });
  assert.equal(ps.kind, 'powershell');
  assert.deepEqual(shellArgv('dir', { platform: 'win32', env: { ProgramFiles: pf, PATH: '' }, fresh: true }), ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', 'dir']);
  assert.match(shellNote({ platform: 'win32', env: { ProgramFiles: pf, PATH: '' }, fresh: true }), /PowerShell/);
  fs.mkdirSync(path.join(pf, 'Git', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(pf, 'Git', 'bin', 'bash.exe'), '');
  const gb = detectShell({ platform: 'win32', env: { ProgramFiles: pf }, fresh: true });
  assert.equal(gb.kind, 'posix');
  assert.equal(gb.path, path.join(pf, 'Git', 'bin', 'bash.exe'));
  assert.match(shellNote({ platform: 'win32', env: { ProgramFiles: pf }, fresh: true }), /Git Bash/);
  assert.equal(shellNote({ platform: 'darwin', env: { SHELL: '/bin/zsh' }, fresh: true }), '');
});
