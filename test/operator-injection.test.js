// Model-chosen text reaches the OS as data, never as script. The notify tool
// runs without an approval prompt, so a quote in its message must not be able
// to become `do shell script` on a Mac or a second command on Windows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { osCmd } from '../src/tools/operator.js';

const marker = path.join(os.tmpdir(), `ox-injected-${process.pid}`);
const payload = `" & (do shell script "touch ${marker}") & "`;

test('the payload is one argv element, outside the script text', { skip: os.platform() !== 'darwin' }, () => {
  for (const action of ['notify', 'type_text', 'open_window']) {
    const cmd = osCmd(action, payload);
    assert.equal(cmd[0], 'osascript');
    assert.equal(cmd.at(-1), payload, action);
    assert.ok(cmd.slice(0, -1).every((part) => !part.includes('do shell script')), action);
  }
  assert.deepEqual(osCmd('open_path', '-a Terminal'), ['open', './-a Terminal']);
});

test('osascript treats an argv payload as text: nothing runs', { skip: os.platform() !== 'darwin' }, () => {
  // Same shape as the real commands, with `return` in place of a visible action.
  const r = spawnSync('osascript', ['-e', 'on run argv', '-e', 'return item 1 of argv', '-e', 'end run', payload], { encoding: 'utf8' });
  assert.equal(r.stdout.trim(), payload);
  assert.equal(fs.existsSync(marker), false, 'the payload must not execute');
});
