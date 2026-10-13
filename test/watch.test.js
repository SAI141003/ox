// ox watch: page checks with no model. One alert per transition, backoff on
// failure, prices read off real-looking markup.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { addWatch, checkWatches, loadWatches, lowestPrice, pageText } from '../src/watch.js';

let page = '<html><body><h1>Shoe</h1><span class="price">$129.99</span><p>Out of stock</p><script>var x="$1"</script></body></html>';
let status = 200;
const server = http.createServer((req, res) => { res.writeHead(status, { 'content-type': 'text/html' }); res.end(page); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
after(() => server.close());
const url = `http://127.0.0.1:${server.address().port}/item`;

test('page text and prices', () => {
  assert.equal(pageText('<p>a&nbsp;b</p><script>evil()</script>'), 'a b');
  assert.equal(lowestPrice('was $1,299.00 now $999.50'), 999.5);
  assert.equal(lowestPrice('Prix 45,00 € ou 49 EUR'), 45);
  assert.equal(lowestPrice('no numbers with currency here 42'), null);
});

test('alerts fire once per transition, and a broken page backs off', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ox-watch-')), 'w.json');
  addWatch({ url, contains: 'In stock', every: '5m', file });
  addWatch({ url, priceBelow: 100, every: '5m', file });
  addWatch({ url, every: '5m', file, label: 'any change' });
  let t = 1_000_000;
  assert.deepEqual(await checkWatches({ file, now: t, notify: false }), [], 'nothing yet: out of stock, $129.99, first look');

  page = page.replace('Out of stock', 'In stock').replace('$129.99', '$89.00');
  t += 6 * 60_000;
  const alerts = (await checkWatches({ file, now: t, notify: false })).map((a) => a.message.split('\n')[0]);
  assert.deepEqual(alerts.sort(), ['127.0.0.1: "In stock" is on the page', '127.0.0.1: lowest price 89 (alert below 100)', 'any change: the page changed'].sort());

  t += 6 * 60_000;
  assert.deepEqual(await checkWatches({ file, now: t, notify: false }), [], 'no repeat while nothing changes');

  status = 500;
  t += 6 * 60_000;
  await checkWatches({ file, now: t, notify: false });
  const w = loadWatches(file)[0];
  assert.equal(w.failures, 1);
  assert.match(w.lastError, /HTTP 500/);
  assert.equal(w.nextAt - t, 10 * 60_000, 'the next try waits twice as long');
  status = 200;
});

test('bad input is refused', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ox-watch-')), 'w.json');
  assert.throws(() => addWatch({ url: 'file:///etc/passwd', file }), /only http/);
  assert.throws(() => addWatch({ url, every: '10s', file }), /at least 1m/);
  assert.throws(() => addWatch({ url, priceBelow: 'cheap', file }), /positive number/);
});
