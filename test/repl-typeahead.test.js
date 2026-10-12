// Lines typed while a turn runs are queued and run in order, never dropped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const OX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ox.js');

test('everything piped in at once runs, in order', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-typeahead-'));
  const r = spawnSync(process.execPath, [OX], {
    cwd: home, // /exit saves an episode under the cwd: keep it out of the repo
    input: '/help goal\n/cost\n/session\n/exit\n',
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, HOME: home, OX_ISLAND: '0', NO_COLOR: '1', OX_NO_PLUGINS: '1', OX_BOT: 'custom', OX_MODEL: 'm', OX_BASE_URL: 'http://127.0.0.1:9/v1', OX_API_KEY: 'x' },
  });
  const out = r.stdout;
  assert.doesNotMatch(out, /\(busy —/, 'nothing is dropped');
  const at = (re) => out.search(re);
  const goal = at(/\/goal <text>/);
  const cost = at(/est context tokens/);
  const session = at(/messages in context/);
  assert.ok(goal >= 0 && cost > goal, `the /help goal answer, then /cost:\n${out}`);
  assert.ok(session > cost, 'then /session');
  assert.match(out, /bye/, '/exit ran last');
});
