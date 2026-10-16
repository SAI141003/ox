// SearchImage: ox picks the top Wikipedia match, fetches only from Wikimedia,
// and caches it so a second ask costs nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('the best match is fetched once, cached, and only from Wikimedia', async () => {
  process.env.OX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-img-'));
  const { findImage } = await import('../src/image-search.js');
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('w/api.php')) return { ok: true, json: async () => ({ query: { pages: {
      a: { pageid: 1, index: 2, title: 'Sintra', thumbnail: { source: 'https://upload.wikimedia.org/s.jpg' } },
      b: { pageid: 2, index: 1, title: 'Pena Palace', thumbnail: { source: 'https://upload.wikimedia.org/p.jpg' } },
    } } }) };
    return { ok: true, headers: new Map([['content-type', 'image/jpeg']]), arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
  };
  const r = await findImage('Pena Palace', { fetchImpl });
  assert.equal(r.title, 'Pena Palace');
  assert.equal(calls[1], 'https://upload.wikimedia.org/p.jpg');
  assert.equal(fs.readFileSync(r.file).length, 3);
  await findImage('pena palace', { fetchImpl });
  assert.equal(calls.length, 2);
  const evil = async (url) => url.includes('w/api.php')
    ? { ok: true, json: async () => ({ query: { pages: { a: { pageid: 3, index: 1, title: 'X', thumbnail: { source: 'https://evil.example/x.jpg' } } } } }) }
    : assert.fail('fetched a non-Wikimedia host');
  assert.equal(await findImage('something else', { fetchImpl: evil }), null);
  assert.equal(await findImage('   '), null);
});
