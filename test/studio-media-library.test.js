// Studio, its gallery and the Library as a user meets them: the routes on a real server with a
// throwaway home, and the runs that go wrong (a provider that leaves nothing, a link that is a PDF).
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ox.js');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-studio-lib-'));
const oxHome = path.join(home, '.ox');
const CHAT = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'web', 'chat.html'), 'utf8');
process.env.OX_HOME = oxHome;
process.env.OX_STUDIO_LOCAL = '0';

// A real one-page PDF, so pdftotext has something to read.
function tinyPdf() {
  const body = 'BT /F1 12 Tf 20 100 Td (The quick brown fox jumps over the lazy dog again today) Tj ET';
  const objs = ['<</Type/Catalog/Pages 2 0 R>>', '<</Type/Pages/Kids[3 0 R]/Count 1>>', '<</Type/Page/Parent 2 0 R/MediaBox[0 0 500 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>', `<</Length ${body.length}>>stream\n${body}\nendstream`, '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>'];
  let out = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = out.length;
  out += `xref\n0 6\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer<</Size 6/Root 1 0 R>>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(out);
}
const hasPdftotext = spawnSync('pdftotext', ['-v']).error == null;
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).error == null;

// The web and the providers, on loopback.
let web, webBase, srv, base;
const seen = [];
before(async () => {
  web = http.createServer((q, r) => {
    let body = '';
    q.on('data', (d) => { body += d; });
    q.on('end', () => {
      seen.push({ url: q.url, body });
      const J = (o, c = 200) => { r.writeHead(c, { 'content-type': 'application/json' }); r.end(JSON.stringify(o)); };
      const html = (s) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end(s); };
      if (q.url.startsWith('/arxiv/')) { r.writeHead(200, { 'content-type': 'application/pdf' }); return r.end(tinyPdf()); }
      if (q.url === '/hop.pdf') { r.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data.pdf' }); return r.end(); }
      if (q.url === '/teaser') return html(`<title>Story</title><article>Related: a short teaser card here</article><article><h1>The real story</h1><p>${'The herd walked to the river every morning. '.repeat(30)}</p></article>`);
      if (q.url === '/cards') return html(`<title>Index</title><article>${'one card of words here '.repeat(4)}</article><article>${'two card of words here '.repeat(4)}</article><article>${'six card of words here '.repeat(4)}</article><article>${'ten card of words here '.repeat(4)}</article><article>${'big card of words here '.repeat(4)}</article><article>${'old card of words here '.repeat(4)}</article>`);
      if (q.url === '/img') { r.writeHead(200, { 'content-type': 'image/png' }); return r.end(Buffer.from([1, 2, 3])); }
      if (q.url.startsWith('/sdapi')) return J({ images: [] });
      if (q.url === '/images/generations') return J({ data: [] });
      if (q.url === '/gone.png') return J({}, 404);
      if (q.url.endsWith('/status')) return J({ status: 'COMPLETED' });
      if (q.url.includes('/requests/')) return J({ images: [{ url: `${webBase}/gone.png` }] });
      if (q.url.startsWith('/fal/')) return J({ request_id: 'r1' });
      return J({}, 404);
    });
  });
  await new Promise((r) => web.listen(0, '127.0.0.1', r));
  webBase = `http://127.0.0.1:${web.address().port}`;
  const env = { ...process.env, HOME: home, OX_HOME: oxHome, OX_NO_KEYSTORE: '1', OX_ISLAND: '0', OX_MESH: '0', OX_PHONE: '0', OX_USAGE_LOG: '0', OX_LEARN: '0', OX_NO_PLUGINS: '1', OX_LIBRARY_LOCAL_LINKS: '1' };
  srv = spawn(process.execPath, [OX, 'serve', '--port', '0'], { cwd: home, env, stdio: ['ignore', 'pipe', 'ignore'] });
  base = await new Promise((resolve, reject) => {
    let out = '';
    const t = setTimeout(() => reject(new Error(`no listen line: ${out}`)), 30_000);
    srv.stdout.on('data', (d) => {
      out += d;
      const m = /listening on (http:\/\/[\d.:]+)/.exec(out);
      if (m) { clearTimeout(t); resolve(m[1]); }
    });
  });
});
after(() => {
  srv?.kill();
  web?.closeAllConnections?.();
  web?.close();
  fs.rmSync(home, { recursive: true, force: true });
});

const post = (p, b) => fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });

test('a folder in a run is a 404, and the server is still there after it', async () => {
  fs.mkdirSync(path.join(oxHome, 'media', 'abcdef1234', 'scenes'), { recursive: true });
  assert.equal((await fetch(`${base}/ox/media/abcdef1234/scenes`)).status, 404);
  assert.equal((await fetch(`${base}/ox/library`)).status, 200);
});

test('/ox/media answers ranges, names sound, and a malformed escape is a 404', async () => {
  const dir = path.join(oxHome, 'media', 'abcdef5678');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '1.mp4'), Buffer.alloc(1000, 7));
  fs.writeFileSync(path.join(dir, '1.wav'), Buffer.alloc(10, 7));
  const part = await fetch(`${base}/ox/media/abcdef5678/1.mp4`, { headers: { range: 'bytes=0-99' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), 'bytes 0-99/1000');
  assert.equal((await part.arrayBuffer()).byteLength, 100);
  assert.equal((await fetch(`${base}/ox/media/abcdef5678/1.mp4`, { headers: { range: 'bytes=5000-' } })).status, 416);
  assert.equal((await fetch(`${base}/ox/media/abcdef5678/1.wav`)).headers.get('content-type'), 'audio/wav');
  assert.equal((await fetch(`${base}/ox/media/%ZZ/1.png`)).status, 404);
});

test('a long video opens from the gallery, and nothing is left beside your clips', { skip: !hasFfmpeg }, async () => {
  const a = path.join(home, 'a.mp4'), b = path.join(home, 'b.mp4');
  for (const f of [a, b]) spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=d=1:s=160x120:r=10', f]);
  for (const files of [[a], [a, b]]) {
    const r = await post('/ox/studio/open', { tool: 'compose_video', args: { files } });
    assert.equal(r.status, 200);
    const row = (await (await fetch(`${base}/ox/studio`)).json()).history.find((x) => x.model === 'ox timeline');
    assert.equal((await fetch(`${base}${row.files[0]}`)).status, 200, 'the tile plays');
  }
  assert.deepEqual(fs.readdirSync(home).filter((f) => f.endsWith('.mp4')).sort(), ['a.mp4', 'b.mp4']);
  assert.equal((await post('/ox/studio/open', { tool: 'compose_video', args: { files: ['/nope.mp4'] } })).status, 400);
});

test('a favorite for an id never made is not a tile', async () => {
  const before = (await (await fetch(`${base}/ox/studio`)).json()).history.length;
  const d = await (await post('/ox/studio', { id: 'abcdefabcc', action: 'favorite' })).json();
  assert.equal(d.history.length, before);
});

test('the Library explains a bad reference in words', async () => {
  const msg = async (ref) => (await (await post('/ox/library/add', { ref })).json()).error.message;
  assert.match(await msg(''), /paste a link or a file path/);
  assert.match(await msg(home), /is a folder/);
  assert.match(await msg('example.com/article'), /does not exist \(a link starts with https:/);
  const bin = path.join(home, 'photo.png');
  fs.writeFileSync(bin, Buffer.from([0x89, 0x50, 0, 0, 0x20, 0x61, 0x20, 0x62, 0x20, 0x63, 0x20, 0x64, 0x20, 0x65]));
  assert.match(await msg(bin), /not text/);
  assert.match(await msg(`${webBase}/img`), /not a page or a PDF/);
});

test('a PDF link is checked like a page, and saved even with no .pdf in it', async (t) => {
  const msg = async (ref) => (await (await post('/ox/library/add', { ref })).json()).error?.message;
  assert.match(await msg('http://169.254.169.254/latest/a.pdf'), /metadata/);
  assert.match(await msg('http://me:pw@127.0.0.1:1/a.pdf'), /credentials/);
  assert.match(await msg(`${webBase}/hop.pdf`), /metadata/, 'a redirect is checked too');
  if (!hasPdftotext) { t.diagnostic('no pdftotext here: the saved half is not run'); return; }
  const { item } = await (await post('/ox/library/add', { ref: `${webBase}/arxiv/2301.00001` })).json();
  assert.equal(item.kind, 'pdf');
  assert.match(item.text, /quick brown fox/);
  const again = await (await post('/ox/library/add', { ref: `${webBase}/arxiv/my%ZZpaper.pdf#page=2` })).json();
  assert.equal(again.item.title, 'my%ZZpaper', 'a stray % and a fragment');
});

test('the Library keeps the story, not the teaser card before it', async () => {
  const { item } = await (await post('/ox/library/add', { ref: `${webBase}/teaser` })).json();
  assert.match(item.text, /The real story/);
  const cards = await (await post('/ox/library/add', { ref: `${webBase}/cards` })).json();
  assert.match(cards.item.text, /one card/, 'a page of cards keeps them all');
  assert.match(cards.item.text, /old card/);
});

test('a run that leaves nothing is a failure, not "Done. Saved"', async () => {
  const ms = await import('../src/media-studio.js');
  const env = { OX_HOME: oxHome };
  process.env.OX_SD_URL = webBase;
  await assert.rejects(ms.generate({ provider: 'local', model: 'local', prompt: 'x', env }), /finished without a file/);
  delete process.env.OX_SD_URL;
  await assert.rejects(ms.generate({ provider: 'openai', model: 'gpt-image-2', prompt: 'x', env: { ...env, OPENAI_API_KEY: 'k', OPENAI_BASE_URL: webBase } }), /finished without a file/);
  await assert.rejects(ms.generate({ provider: 'fal', model: 'fal-ai/flux/schnell', prompt: 'x', env: { ...env, FAL_KEY: 'k', FAL_QUEUE_BASE: `${webBase}/fal` }, wait: { interval: 1 } }), /could not be downloaded.*gone\.png/);
  await assert.rejects(ms.generate({ provider: 'constructor', model: 'x', prompt: 'x', env }), /unknown provider/);
  const client = { submit: async () => ({ requestId: 'r', status: 'queued' }), status: async () => ({ status: 'completed', images: [`${webBase}/gone.png`], video: null, error: null }) };
  const r = await ms.create({ model: 'soul-2', prompt: 'x', client, wait: { interval: 1 } });
  assert.equal(r.status, 'failed');
  assert.match(r.error, /could not be downloaded/);
});

test('a fal edit sends the picture as image_url, on a model that edits, in one gallery row', async () => {
  const ms = await import('../src/media-studio.js');
  const { pick } = await import('../src/tools/media.js');
  assert.equal(pick({ kind: 'image', edit: true }, { FAL_KEY: 'k', OX_STUDIO_LOCAL: '0' }).model, 'fal-ai/flux-pro/kontext');
  const src = path.join(home, 'src.png');
  fs.writeFileSync(src, 'PNG');
  const fal = (edit) => ms.generate({ provider: 'fal', model: 'fal-ai/flux-pro/kontext', prompt: 'night', media: { edit: [edit] }, run: 'run-edit', env: { OX_HOME: oxHome, FAL_KEY: 'k', FAL_QUEUE_BASE: `${webBase}/fal` }, wait: { interval: 1 } }).catch((e) => e);
  for (const edit of [src, 'https://example.invalid/a.png']) {
    const count = ms.history().length;
    seen.length = 0;
    await fal(edit);
    const input = JSON.parse(seen.find((s) => s.url === '/fal/fal-ai/flux-pro/kontext').body);
    assert.ok(input.image_url, 'the source goes as image_url');
    assert.equal(input.edit_url, undefined);
    assert.equal(ms.history().length, count + 1, 'one run is one row');
    assert.equal(ms.history()[0].run, 'run-edit');
  }
});

test('with no key and nothing set up, the answer names what to do', async () => {
  const ms = await import('../src/media-studio.js');
  process.env.OX_SD_URL = 'http://127.0.0.1:9';
  await assert.rejects(ms.generate({ provider: 'local', model: 'local', prompt: 'x', env: { OX_HOME: oxHome } }), /ox studio local install.*Settings › API keys/);
  delete process.env.OX_SD_URL;
  // Upscale and cut-out need no setup on a Mac, so a mistyped path reaches them.
  const L = await import('../src/studio-local.js');
  if (L.status({ OX_HOME: oxHome }).can.cutout) await assert.rejects(ms.generate({ provider: 'device', model: 'mac-cutout', media: { start: ['/nope.png'] }, env: { OX_HOME: oxHome } }), /no image at \/nope\.png/);
});

// The pieces of the page that have no route of their own.
test('the page: Library can remove, sound is a player, Reuse restores what it can', () => {
  assert.match(CHAT, /id="lib-rm"/);
  assert.match(CHAT, /postJson\('\/ox\/library\/remove', \{ id: libOpen \}\)/);
  assert.match(CHAT, /body\.replace\(q, \(\) => /, 'a quote with $& stays as written');
  assert.match(CHAT, /<audio src="\$\{esc\(f\)\}"/);
  assert.match(CHAT, /\/\^ox \/\.test\(r\.model\) \? ''/, 'a timeline or animation has no recipe the form can rerun');
  assert.match(CHAT, /stProvider\(\)\?\.anyModel\) \$\('st-model-custom'\)\.value = r\.model/);
  assert.match(CHAT, /\$\('st-model-custom'\)\.value = '';/);
});

test('a Library PDF link refuses addresses on this machine or its network', async () => {
  const { privateAddress } = await import('../src/library.js');
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.20.0.1', '169.254.169.254', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '0.0.0.0', '100.64.0.1']) assert.equal(privateAddress(ip), true, ip);
  for (const ip of ['8.8.8.8', '151.101.1.69', '172.32.0.1', '2606:4700::1111']) assert.equal(privateAddress(ip), false, ip);
});

test('a fal edit with no model named uses the model that reads the picture', async () => {
  const ms = await import('../src/media-studio.js');
  seen.length = 0;
  await ms.generate({ provider: 'fal', prompt: 'night', media: { edit: ['https://example.invalid/a.png'] }, env: { OX_HOME: oxHome, FAL_KEY: 'k', FAL_QUEUE_BASE: `${webBase}/fal` }, wait: { interval: 1 } }).catch((e) => e);
  assert.ok(seen.some((x) => x.url === '/fal/fal-ai/flux-pro/kontext'), seen.map((x) => x.url).join(' '));
});
