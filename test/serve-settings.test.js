// The app's settings: read and change the default model, keep-awake and the
// island switch through the local server; the terminal sees the same config.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const OX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ox.js');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-settings-h-'));
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/_API_KEY$|^OX_/.test(k)));
Object.assign(env, { HOME: home, OX_ISLAND: '0', OX_NO_PLUGINS: '1', OX_LEARN: '0', ANTHROPIC_API_KEY: 'test' });
// Let the OS choose an unused ephemeral port. A random number in a high range
// can still belong to an unrelated WebSocket/dev server; the old test then
// silently queried that server and tried to parse its HTML as settings JSON.
const srv = spawn(process.execPath, [OX, 'serve', '--port', '0'], { cwd: home, env, stdio: ['ignore', 'pipe', 'ignore'] });
after(() => srv.kill());
const port = await new Promise((resolve, reject) => {
  let output = '';
  const timeout = setTimeout(() => reject(new Error(`ox serve did not announce its ephemeral port: ${output}`)), 10_000);
  srv.stdout.on('data', (chunk) => {
    output += chunk.toString();
    const match = /\[serve\] listening on http:\/\/(?:\[[^\]]+\]|[^:\s]+):(\d+)/.exec(output);
    if (match) { clearTimeout(timeout); resolve(Number(match[1])); }
  });
  srv.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`ox serve exited before listening (code ${code}): ${output}`)); });
});
const base = `http://127.0.0.1:${port}`;
const post = (body, headers = {}) => fetch(`${base}/ox/settings`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('settings show the model ox chose from your keys, and which bots are ready', async () => {
  const st = await (await fetch(`${base}/ox/settings`)).json();
  assert.equal(st.model.defaultBot, 'ox-claude', 'an Anthropic key means Claude, not xAI');
  assert.match(st.model.source, /^auto: ANTHROPIC_API_KEY is set/);
  assert.equal(st.model.bots.find((b) => b.id === 'ox-claude').ready, true);
  assert.equal(st.model.bots.find((b) => b.id === 'ox-grok').ready, false);
  assert.equal(st.island.enabled, true);
});

test('changing the default model and keep-awake writes the same config the terminal reads', async () => {
  const r = await post({ defaultBot: 'ox-opus', awake: false });
  assert.equal(r.status, 200);
  const st = await r.json();
  assert.equal(st.model.defaultBot, 'ox-opus');
  assert.equal(st.awake.on, false);
  const doc = JSON.parse(fs.readFileSync(path.join(home, '.ox', 'config.json'), 'utf8'));
  assert.equal(doc.defaultBot, 'ox-opus');
  assert.equal(doc.awake, false);
  assert.equal((await post({ defaultBot: 'nosuch:thing' })).status, 400, 'an unknown bot is refused');
});

test('the island can be switched off from the app, and the terminal agrees', async () => {
  const st = await (await post({ island: false })).json();
  assert.equal(st.island.enabled, false);
  const status = spawnSync(process.execPath, [OX, 'island', 'status'], { env, encoding: 'utf8' });
  assert.match(status.stdout, /turned off/);
});

test('another website cannot change settings', async () => {
  const r = await post({ defaultBot: 'ox-grok' }, { origin: 'https://evil.example' });
  assert.equal(r.status, 403);
});
