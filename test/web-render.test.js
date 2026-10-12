// Local rendering of JavaScript-only pages (src/web-render.js). The detection
// and browser lookup are tested everywhere; the real render runs only where a
// Chrome-family browser is installed.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { findBrowser, looksClientRendered, renderPage } from '../src/web-render.js';
import { htmlToText } from '../src/tools/web.js';

const SHELL = `<!doctype html><html><head><title>App</title></head><body><div id="root"></div>
<script>document.getElementById('root').innerHTML = '<h1>Pricing</h1><p>' + ['Starter $9', 'Team $29', 'Scale $99'].join('</p><p>') + '</p>';</script></body></html>`;

test('a client-rendered shell is detected; a real article is not', () => {
  assert.equal(looksClientRendered(SHELL, htmlToText(SHELL).text), true);
  const article = `<html><body><article>${'<p>Real server-rendered prose. </p>'.repeat(60)}</article><script>track()</script></body></html>`;
  assert.equal(looksClientRendered(article, htmlToText(article).text), false);
  const noScript = '<html><body><p>tiny</p></body></html>';
  assert.equal(looksClientRendered(noScript, 'tiny'), false, 'no scripts: nothing to render');
  assert.equal(looksClientRendered('<div id="__next"></div><script src="/a.js"></script><p>Loading the dashboard, one moment please while it starts up</p>', 'Loading the dashboard, one moment please while it starts up'), true);
});

test('OX_BROWSER pins a browser, "off" disables rendering, a bad path is null', () => {
  const fake = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ox-br-')), 'chrome');
  fs.writeFileSync(fake, '#!/bin/sh\n', { mode: 0o755 });
  assert.equal(findBrowser({ OX_BROWSER: fake }), fake);
  assert.equal(findBrowser({ OX_BROWSER: 'off' }), null);
  assert.equal(findBrowser({ OX_BROWSER: '/nope/chrome' }), null);
  assert.equal(findBrowser({ PATH: path.dirname(fake) }, 'linux'), null, 'only known browser names are taken from PATH');
});

test('no browser: a clear refusal, not a crash', async () => {
  const r = await renderPage('http://127.0.0.1:9/', { browser: null });
  assert.equal(r.ok, false);
  assert.match(r.message, /OX_BROWSER/);
});

const browser = findBrowser();
let server;
after(() => server?.close());

test('a real headless render turns the shell into its content', { skip: !browser && 'no Chrome-family browser installed' }, async () => {
  server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(SHELL); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  assert.doesNotMatch(htmlToText(SHELL).text, /Team \$29/, 'a plain GET sees nothing');
  const doc = await renderPage(url, { browser, timeoutMs: 60_000 });
  assert.equal(doc.ok, true, doc.message);
  assert.match(doc.via, /rendered locally/);
  const text = htmlToText(doc.body).text;
  assert.match(text, /Pricing/);
  assert.match(text, /Team \$29/);
});

test('web_fetch renders a JavaScript shell locally and says so', { skip: !browser && 'no Chrome-family browser installed' }, async (t) => {
  const { webFetchTool } = await import('../src/tools/web.js');
  const srv = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(SHELL); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const url = `http://127.0.0.1:${srv.address().port}/`;

  const rendered = await webFetchTool({ url }, { yolo: true });
  assert.equal(rendered.isError, undefined, rendered.content);
  assert.match(rendered.content, /Team \$29/);
  assert.match(rendered.content, /rendered locally/);

  const raw = await webFetchTool({ url, render: false }, { yolo: true });
  assert.doesNotMatch(String(raw.content), /Team \$29/, 'render:false keeps the plain GET');

  // A sandbox that restricts the network (here: allow-listing this host) never
  // renders: the page's own scripts could reach hosts the list never named.
  const sandbox = { restrict_network: true, network_allow: ['127.0.0.1'], blocksTool: () => false };
  const fenced = await webFetchTool({ url }, { yolo: true, sandbox });
  assert.doesNotMatch(String(fenced.content), /rendered locally|Team \$29/);
});
