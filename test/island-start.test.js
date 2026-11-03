// OX Island comes with ox on every way OX opens: the app's window (from
// Applications or from the `ox` command) and `ox app`. `ox island start` does
// nothing while the island is off in Settings, and is never started behind the
// person's back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cmdIsland, setIslandEnabled, islandEnabled } from '../src/island.js';

const app = fs.readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const oxApp = fs.readFileSync(new URL('../desktop/island/Sources/OxApp/main.swift', import.meta.url), 'utf8');

test('start does nothing while the island is off, and says how to turn it on', async () => {
  // cmdIsland reads the switch from the home folder, so point HOME at a temp one.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-island-off-'));
  const realHome = process.env.HOME;
  process.env.HOME = home;
  try {
    setIslandEnabled(false, { home });
    assert.equal(islandEnabled({ home }), false);
    const lines = [];
    const code = await cmdIsland(['start'], { log: (s) => lines.push(s), err: () => {} });
    assert.equal(code, 0);
    assert.match(lines.join('\n'), /OX Island is off: turn it on with: ox island on/);
    assert.equal(fs.existsSync(path.join(home, '.ox', 'island.json')), false);
  } finally {
    process.env.HOME = realHome;
  }
});

test('the island is on by default, so start is not blocked on a fresh machine', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-island-default-'));
  assert.equal(islandEnabled({ home }), true);
});

test('ox app starts the island with the window, and the OX app starts it on every path', () => {
  assert.match(app, /spawn\(process\.execPath, \[OX_CLI, 'island', 'start'\]/);
  // The island is started at the top of load(), before the OX_APP_URL branch that skipped it.
  const loadStart = oxApp.indexOf('func load() {');
  const island = oxApp.indexOf('Self.startIslandInBackground()', loadStart);
  const envBranch = oxApp.indexOf('if !usedEnvURL', loadStart);
  assert.ok(loadStart > 0 && island > loadStart && island < envBranch, 'island start must come before the OX_APP_URL branch');
  assert.equal((oxApp.match(/startIslandInBackground\(\)/g) || []).length, 2, 'one call site in load(), one definition');
});
