// Your own SearXNG: your URL wins, a half-finished setup is not used, and
// tests never start a real search server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-searxng-'));
process.env.OX_HOME = home;
const S = await import('../src/searxng.js');

test('OX_SEARXNG_URL wins; otherwise nothing until setup has finished', () => {
  assert.equal(S.searxngUrl({ OX_SEARXNG_URL: 'http://box:8080/' }), 'http://box:8080');
  assert.equal(S.searxngUrl({}), null, 'not installed');
  fs.mkdirSync(path.join(home, 'searxng', 'venv', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(home, 'searxng', 'venv', 'bin', 'python'), '');
  assert.equal(S.installed(), false, 'a venv alone is a half-finished setup');
  fs.writeFileSync(path.join(home, 'searxng', 'ready'), 'x');
  if (process.platform !== 'win32') assert.equal(S.installed(), true);
  assert.equal(S.searxngUrl({ NODE_TEST_CONTEXT: 'child' }), null, 'tests never use a real local server');
  assert.equal(S.searxngUrl({ OX_NO_LOCAL_SEARXNG: '1' }), null);
});

test('web_search tries your own SearXNG first and it needs no key', async () => {
  const { SEARCH_CHAIN_ORDER, listSearchBackends } = await import('../src/tools/web.js');
  assert.equal(SEARCH_CHAIN_ORDER[0], 'searxng');
  const b = listSearchBackends().find((x) => x.name === 'searxng');
  assert.equal(b.keyless, true);
});
