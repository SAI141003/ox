// OX Studio: the catalogue and request mapping ported from open-higgsfield, and
// a whole run (submit -> poll -> download -> history) against a stand-in API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { MODELS, getModel, toPlatform, parseSettings, create, history, waitFor } from '../src/media-studio.js';

test('the catalogue: 38 models, 8 image and 30 video, each with its own settings', () => {
  assert.equal(MODELS.length, 38);
  assert.equal(MODELS.filter((m) => m.surface === 'image').length, 8);
  assert.equal(new Set(MODELS.map((m) => m.id)).size, 38, 'ids are unique');
  for (const m of MODELS) assert.doesNotThrow(() => toPlatform({ model: m.id, prompt: 'a red fox' }), m.id);
});

test('each model gets the request it expects', () => {
  assert.deepEqual(toPlatform({ model: 'soul-2', prompt: 'p', settings: { batchSize: '4' } }), { path: 'higgsfield-ai/soul/v2/standard', body: { prompt: 'p', batch_size: 4, resolution: '720p', aspect_ratio: '1:1', enhance_prompt: false } });
  const k = toPlatform({ model: 'kling-3-pro', prompt: 'p', media: { start: ['https://x/a.png'], end: ['https://x/b.png'] } });
  assert.equal(k.path, 'kling-video/v3.0/pro/image-to-video');
  assert.equal(k.body.last_image_url, 'https://x/b.png');
  assert.equal(k.body.sound, 'on');
  assert.equal(toPlatform({ model: 'kling-3-pro', prompt: 'p' }).path, 'kling-video/v3.0/pro/text-to-video');
  assert.equal(toPlatform({ model: 'wan-3', prompt: 'p', media: { start: ['https://x/a.png'] } }).path, 'alibaba/wan-3.0/image-to-video');
  assert.equal(toPlatform({ model: 'kling-o3', prompt: 'p', media: { start: ['https://x/a.png'] } }).body.first_frame_url, 'https://x/a.png');
  const sd = toPlatform({ model: 'seedance-2.5', prompt: 'p', media: { reference: ['https://x/r.png'], audio: ['https://x/a.wav'] } });
  assert.equal(sd.path, 'bytedance/seedance-2.5/reference-to-video');
  assert.deepEqual(sd.body.audio_urls, ['https://x/a.wav']);
  assert.equal(toPlatform({ model: 'seedance-2.5-extend', prompt: 'p', media: { video: ['https://x/v.mp4'] } }).body.video_url, 'https://x/v.mp4');
});

test('settings and inputs are checked against what the model declares', () => {
  assert.throws(() => parseSettings(getModel('kling-3-pro'), { duration: 99 }), /between 3 and 15/);
  assert.throws(() => parseSettings(getModel('soul-2'), { aspectRatio: '5:1' }), /one of/);
  assert.throws(() => toPlatform({ model: 'soul-2', prompt: 'p', media: { start: ['https://x/a.png'] } }), /takes no start/);
  assert.throws(() => toPlatform({ model: 'kling-3-pro', prompt: 'p', media: { start: ['file:///etc/passwd'] } }), /https/);
  assert.throws(() => getModel('nope'), /unknown model/);
});

test('a whole run: submit, poll to completion, keep the file and the recipe', async (t) => {
  let polls = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      if (req.url === '/out.png') { res.end(Buffer.from('PNGDATA')); return; }
      if (req.headers.authorization !== 'Key id1:sec1') { res.statusCode = 401; res.end('{"detail":"bad key"}'); return; }
      if (req.method === 'POST' && req.url === '/higgsfield-ai/soul/cinema') {
        assert.equal(JSON.parse(body).prompt, 'a lighthouse at dusk');
        res.end(JSON.stringify({ request_id: 'req-1', status: 'queued' })); return;
      }
      if (req.url === '/requests/req-1/status') {
        polls++;
        res.end(JSON.stringify(polls < 2 ? { request_id: 'req-1', status: 'in_progress' } : { request_id: 'req-1', status: 'completed', images: [{ url: `http://127.0.0.1:${server.address().port}/out.png` }] }));
        return;
      }
      if (req.url === '/out.png') { res.end(Buffer.from('PNGDATA')); return; }
      res.statusCode = 404; res.end('{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const saved = { ...process.env };
  process.env.OX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-studio-'));
  process.env.HIGGSFIELD_API_KEY = 'id1:sec1';
  process.env.HIGGSFIELD_API_BASE = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { for (const k of ['OX_HOME', 'HIGGSFIELD_API_KEY', 'HIGGSFIELD_API_BASE']) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
  const seen = [];
  const r = await create({ model: 'soul-cinema', prompt: 'a lighthouse at dusk', settings: { aspectRatio: '16:9' }, onStatus: (s) => seen.push(s.status), wait: { interval: 5 } });
  assert.equal(r.status, 'completed');
  assert.deepEqual(seen, ['in_progress', 'completed']);
  assert.equal(fs.readFileSync(r.files[0], 'utf8'), 'PNGDATA');
  const h = history();
  assert.equal(h[0].id, r.id);
  assert.equal(h[0].settings.aspectRatio, '16:9', 'the recipe is kept so reuse restores it');
  assert.equal(h[0].status, 'completed');
});

test('no single company: fal, OpenAI and a local Stable Diffusion server each make a picture', async (t) => {
  const { generate } = await import('../src/media-studio.js');
  const PNG = Buffer.from('IMG').toString('base64');
  let falPolls = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const port = server.address().port;
      if (req.url === '/v1/images/generations') { assert.equal(req.headers.authorization, 'Bearer sk-test'); assert.equal(JSON.parse(body).model, 'gpt-image-2'); res.end(JSON.stringify({ data: [{ b64_json: PNG }] })); return; }
      if (req.url === '/sdapi/v1/txt2img') { assert.equal(JSON.parse(body).steps, 8); res.end(JSON.stringify({ images: [PNG, PNG] })); return; }
      if (req.method === 'POST' && req.url === '/fal-ai/flux/schnell') { assert.equal(req.headers.authorization, 'Key fal-k'); res.end(JSON.stringify({ request_id: 'f1', status_url: `http://127.0.0.1:${port}/fal-ai/flux/schnell/requests/f1/status`, response_url: `http://127.0.0.1:${port}/fal-ai/flux/schnell/requests/f1` })); return; }
      if (req.url.endsWith('/requests/f1/status')) { falPolls++; res.end(JSON.stringify({ status: falPolls < 2 ? 'IN_PROGRESS' : 'COMPLETED' })); return; }
      if (req.url.endsWith('/requests/f1')) { res.end(JSON.stringify({ images: [{ url: `http://127.0.0.1:${port}/img.png` }] })); return; }
      if (req.url === '/img.png') { res.end('FALIMG'); return; }
      res.statusCode = 404; res.end('{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const saved = process.env.OX_HOME;
  process.env.OX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-studio2-'));
  t.after(() => { if (saved === undefined) delete process.env.OX_HOME; else process.env.OX_HOME = saved; });
  const env = { OPENAI_API_KEY: 'sk-test', OPENAI_BASE_URL: `${base}/v1`, FAL_KEY: 'fal-k', FAL_QUEUE_BASE: base, OX_SD_URL: base };
  const prevSd = process.env.OX_SD_URL; process.env.OX_SD_URL = base;
  t.after(() => { if (prevSd === undefined) delete process.env.OX_SD_URL; else process.env.OX_SD_URL = prevSd; });
  const o = await generate({ provider: 'openai', model: 'gpt-image-2', prompt: 'a cat', env });
  assert.equal(fs.readFileSync(o.files[0], 'utf8'), 'IMG');
  const l = await generate({ provider: 'local', model: 'local', prompt: 'a cat', settings: { steps: 8 }, env });
  assert.equal(l.files.length, 2);
  const f = await generate({ provider: 'fal', model: 'fal-ai/flux/schnell', prompt: 'a cat', env, wait: { interval: 1 } });
  assert.equal(fs.readFileSync(f.files[0], 'utf8'), 'FALIMG');
  await assert.rejects(() => generate({ provider: 'openai', model: 'gpt-image-2', prompt: 'x', env: {} }), /no OpenAI key/);
  await assert.rejects(() => generate({ provider: 'fal', model: '../etc', prompt: 'x', env }), /fal model id/);
});

test('create_media: the agent picks a provider from the keys you have, and asks first', async () => {
  const { pick, createMediaTool } = await import('../src/tools/media.js');
  const off = { OX_STUDIO_LOCAL: '0' };
  assert.deepEqual(pick({ kind: 'image' }, { ...off, OPENAI_API_KEY: 'k' }), { provider: 'openai', model: 'gpt-image-2' });
  assert.deepEqual(pick({ kind: 'image' }, off), { provider: 'local', model: 'local' }, 'no keys: a Stable Diffusion server here');
  assert.deepEqual(pick({ kind: 'video' }, { ...off, HIGGSFIELD_API_KEY: 'a:b' }), { provider: 'higgsfield', model: 'kling-3-pro' });
  assert.match(pick({ kind: 'video' }, off).error, /No video maker is set up.*ox studio local install/);
  assert.match(pick({ kind: 'video', provider: 'openai' }, off).error, /image only/);
  // This Mac set up: it comes first, for images, edits and clips; a named provider still wins.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-mac-pick-'));
  const L = await import('../src/studio-local.js');
  fs.mkdirSync(path.dirname(L.sdBin({ OX_HOME: home })), { recursive: true }); fs.writeFileSync(L.sdBin({ OX_HOME: home }), '');
  fs.mkdirSync(path.dirname(L.modelPath('sd-turbo', { OX_HOME: home })), { recursive: true }); fs.writeFileSync(L.modelPath('sd-turbo', { OX_HOME: home }), '');
  await new Promise((r) => setTimeout(r, 5100)); // past the 5 s readiness cache
  const mac = { OX_HOME: home, OPENAI_API_KEY: 'k' };
  assert.deepEqual(pick({ kind: 'image' }, mac), { provider: 'device', model: 'mac-image' });
  assert.deepEqual(pick({ kind: 'image', edit: true }, mac), { provider: 'device', model: 'mac-edit' });
  assert.deepEqual(pick({ kind: 'video' }, mac), { provider: 'device', model: 'mac-video' });
  assert.deepEqual(pick({ kind: 'image', provider: 'openai' }, mac), { provider: 'openai', model: 'gpt-image-2' });
  assert.match((await createMediaTool({ prompt: '' })).content, /prompt is required/);
  const { classifyTool } = await import('../src/resource-class.js');
  assert.equal(classifyTool('create_media'), 'approval_gated');
  const { narrowToolSchemas, BUILTIN_SCHEMAS } = await import('../src/tools/index.js');
  const offered = (msg) => narrowToolSchemas(BUILTIN_SCHEMAS, { message: msg }).map((s) => s.name);
  assert.ok(offered('make a cinematic video of a lighthouse').includes('create_media'));
  assert.ok(!offered('fix the failing test in auth.ts').includes('create_media'), 'not offered (no tokens spent) when the turn is not about media');
});

test('polling survives one dropped round but not three, and failures are terminal', async () => {
  let n = 0;
  const flaky = { status: async () => { n++; if (n === 1) throw new Error('blip'); return { status: n < 3 ? 'queued' : 'nsfw' }; } };
  assert.equal((await waitFor(flaky, 'r', { interval: 1 })).status, 'nsfw');
  const dead = { status: async () => { throw new Error('down'); } };
  await assert.rejects(() => waitFor(dead, 'r', { interval: 1 }), /down/);
});
