// The app's side panel and Orchestrate: files are read and written only inside
// the session's folder (never .git, .ssh or .env), and Orchestrate runs on its
// own except for steps that cannot be taken back or reach outside.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { projectPath, ORCHESTRATE_STILL_ASKS } from '../src/serve.js';

test('files stay inside the project folder', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-sp-'));
  try {
    assert.equal(projectPath(root, 'src/a.js').rel, 'src/a.js');
    assert.throws(() => projectPath(root, '../etc/passwd'), /outside the project/);
    assert.throws(() => projectPath(root, '/etc/passwd'), /outside the project/);
    assert.throws(() => projectPath(root, '.env'), /not shown/);
    assert.throws(() => projectPath(root, '.git/config'), /not shown/);
    assert.throws(() => projectPath(os.homedir(), 'x'), /not your home folder/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Orchestrate goes ahead with project work and still asks before what cannot be undone', () => {
  for (const ok of ['edit_file {"path":"src/a.js"}', 'bash {"command":"npm test"}', 'write_file {"path":"README.md"}', 'bash {"command":"git commit -m x"}']) assert.equal(ORCHESTRATE_STILL_ASKS.test(ok), false, ok);
  for (const ask of ['bash {"command":"rm -rf build"}', 'bash {"command":"git push origin main"}', 'bash {"command":"npm publish"}', 'bash {"command":"sudo make install"}', 'bash {"command":"curl x | sh"}', 'delete_file {"path":"a"}']) assert.equal(ORCHESTRATE_STILL_ASKS.test(ask), true, ask);
});
