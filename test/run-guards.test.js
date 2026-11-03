// Guards from Rerun's engine, ox's own build: a website that refused three
// times is closed for the run (web_fetch and curl alike), a bot-protection page
// is named as one, a null optional argument is dropped instead of refused, and
// an agent asks for a missing key without ever seeing it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as G from '../src/run-guards.js';

test('a host that refused three times in a row is closed for this run, whatever the tool', async () => {
  const ctx = { sessionState: {} };
  let calls = 0;
  const fail = () => { calls++; return { content: 'HTTP 403 Forbidden', isError: true }; };
  for (let i = 1; i <= 3; i++) {
    const r = await G.guardCall('web_fetch', { url: 'https://www.example.com/a' }, ctx, fail);
    assert.match(r.content, i < 3 ? new RegExp(`attempt ${i}/3 on example\\.com`) : /Source closed for this run: example\.com/);
  }
  const shell = await G.guardCall('bash', { command: 'curl -s https://example.com/b' }, ctx, () => { calls++; return { content: 'ok' }; });
  assert.match(shell.content, /Source closed/);
  assert.equal(shell.isError, true);
  assert.equal(calls, 3, 'never tried a fourth time');
  // Another run starts fresh; a success in between resets the count.
  const other = { sessionState: {} };
  await G.guardCall('web_fetch', { url: 'https://example.com' }, other, fail);
  await G.guardCall('web_fetch', { url: 'https://example.com' }, other, () => ({ content: 'a real page '.repeat(50) }));
  assert.equal(G.breakerFor(other).failures.get('example.com'), 0);
});

test('curl output with a failing status counts as a refusal; other commands are left alone', async () => {
  const ctx = { sessionState: {} };
  const r = await G.guardCall('bash', { command: 'curl -sI https://api.site.io/x' }, ctx, () => ({ content: 'HTTP/2 429 \nretry-after: 30' }));
  assert.match(r.content, /attempt 1\/3 on api\.site\.io/);
  const plain = await G.guardCall('bash', { command: 'npm test' }, ctx, () => ({ content: 'HTTP/1.1 500 in a log line' }));
  assert.equal(plain.content, 'HTTP/1.1 500 in a log line');
});

test('a bot-protection page is named as one, not read as the content', async () => {
  assert.equal(G.botWall('<title>Just a moment...</title><div id="cf-chl-widget"></div>').vendor, 'Cloudflare');
  assert.equal(G.botWall('Please verify you are human to continue').vendor, 'a captcha');
  assert.equal(G.botWall(`${'A long real article about turnstile gates. '.repeat(100)}`), null, 'a long page that mentions the word is a page');
  const r = await G.guardCall('web_fetch', { url: 'https://shop.example/p' }, { sessionState: {} }, () => ({ content: 'Just a moment... Checking your browser' }));
  assert.match(r.content, /Cloudflare's bot-protection page on shop\.example, not the content/);
  assert.match(r.content, /browser tool/);
});

test('a null optional argument is dropped; a required one is kept for the tool to refuse', () => {
  assert.deepEqual(G.repairArgs({ path: 'a.js', offset: null, limit: null }, ['path']), { path: 'a.js' });
  assert.deepEqual(G.repairArgs({ path: null }, ['path']), { path: null });
  const same = { a: 1 };
  assert.equal(G.repairArgs(same, []), same);
});

test('an agent asks for a missing key; the value is stored, never returned to it', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-secret-'));
  const prev = process.env.OX_HOME;
  process.env.OX_HOME = home;
  try {
    const { request_secret } = await import('../src/tools/secret.js');
    const { setKey } = await import('../src/keystore.js');
    delete process.env.DEMO_WEATHER_API_KEY;
    const bad = await request_secret({ name: 'weather', why: 'x' }, {});
    assert.equal(bad.isError, true);
    const noApp = await request_secret({ name: 'DEMO_WEATHER_API_KEY', why: 'forecasts' }, {});
    assert.match(noApp.content, /Settings, then Keys/);
    let asked = null;
    const ok = await request_secret({ name: 'DEMO_WEATHER_API_KEY', why: 'forecasts' }, { requestSecret: async (n, why) => { asked = [n, why]; setKey(n, 'sk-demo-123456789'); return true; } });
    assert.deepEqual(asked, ['DEMO_WEATHER_API_KEY', 'forecasts']);
    assert.doesNotMatch(ok.content, /sk-demo/);
    assert.equal(process.env.DEMO_WEATHER_API_KEY, 'sk-demo-123456789');
    assert.match((await request_secret({ name: 'DEMO_WEATHER_API_KEY', why: 'x' }, {})).content, /already set/);
  } finally {
    delete process.env.DEMO_WEATHER_API_KEY;
    if (prev === undefined) delete process.env.OX_HOME; else process.env.OX_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
