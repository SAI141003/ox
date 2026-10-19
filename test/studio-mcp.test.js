// OX Studio for any agent (src/studio-mcp.js, src/studio-catalog.js): routing,
// hosts, jobs, the MCP server, and the engine paths it adds, against stand-ins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

process.env.OX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-studio-'));
const S = await import('../src/studio-mcp.js');
const C = await import('../src/studio-catalog.js');

test('the catalog: every model has a kind, a licence and a fal id; defaults exist', () => {
  for (const m of C.OPEN_MODELS) {
    assert.ok(m.id && m.name && m.kind && m.license && m.good, m.id);
    assert.match(m.fal, /^fal-ai\//, m.id);
  }
  for (const id of Object.values(C.DEFAULTS)) assert.ok(C.find(id), id);
  assert.equal(new Set(C.OPEN_MODELS.map((m) => m.id)).size, C.OPEN_MODELS.length);
  assert.match(C.withCamera('a fox in snow', 'orbit'), /^a fox in snow\. Camera: the camera orbits/);
  assert.equal(C.withCamera('a fox', 'nope'), 'a fox');
});

test('hosts: nothing to run on says which key; fal, hf and local are picked by what is set', () => {
  const flux = C.find('flux-schnell');
  assert.throws(() => S.hostFor(flux, { env: {} }), /FAL_KEY.*HF_TOKEN.*OX_SD_URL/s);
  assert.equal(S.hostFor(flux, { env: { FAL_KEY: 'k' } }), 'fal');
  assert.equal(S.hostFor(flux, { env: { HF_TOKEN: 't' } }), 'hf');
  assert.equal(S.hostFor(flux, { env: { OX_SD_URL: 'http://127.0.0.1:7860' } }), 'local');
  assert.throws(() => S.hostFor(C.find('wan-2.2'), { env: { HF_TOKEN: 't' } }), /needs a fal key/);
  assert.throws(() => S.hostFor(flux, { host: 'hf', env: { FAL_KEY: 'k' } }), /cannot run on hf/);
});

test('routing: words go to Qwen-Image, aspect and camera become model settings', () => {
  const env = { FAL_KEY: 'k' };
  assert.equal(S.plan('generate_image', { prompt: 'a red fox' }, { env }).model, 'fal-ai/flux/schnell');
  assert.equal(S.plan('generate_image', { prompt: 'a poster that says "OPEN LATE"' }, { env }).model, 'fal-ai/qwen-image');
  const wide = S.plan('generate_image', { prompt: 'a fox', aspect: '16:9', n: 9 }, { env });
  assert.deepEqual(wide.settings, { image_size: 'landscape_16_9', num_images: 4 });
  assert.throws(() => S.plan('generate_image', { prompt: 'x', aspect: '2:1' }, { env }), /aspect is one of/);
  const v = S.plan('generate_video', { prompt: 'a fox runs', camera: 'crash-zoom', aspect: '9:16' }, { env });
  assert.equal(v.model, 'fal-ai/wan/v2.2-a14b/text-to-video');
  assert.match(v.prompt, /Camera: sudden fast crash zoom/);
  assert.equal(v.settings.aspect_ratio, '9:16');
  const i2v = S.plan('generate_video', { prompt: 'she turns', image: 'https://x/a.png' }, { env });
  assert.equal(i2v.model, 'fal-ai/wan/v2.2-a14b/image-to-video');
  assert.deepEqual(i2v.media, { start: ['https://x/a.png'] });
  assert.throws(() => S.plan('generate_video', { prompt: 'x', model: 'flux-schnell' }, { env }), /makes image, not video/);
  assert.equal(S.plan('edit_image', { image: '/a.png', prompt: 'make it night' }, { env }).model, 'fal-ai/qwen-image-edit');
  assert.deepEqual(S.plan('upscale', { image: '/a.png' }, { env }).media, { start: ['/a.png'] });
  assert.equal(S.plan('remove_background', { image: '/a.png' }, { env }).model, 'fal-ai/birefnet');
  assert.throws(() => S.plan('lip_sync', { video: 'https://v' }, { env }), /needs a video.*and an audio/);
  assert.deepEqual(S.plan('generate_audio', { prompt: 'rain on a tin roof', seconds: 90 }, { env }).settings, { seconds_total: 47 });
  const hf = S.plan('generate_image', { prompt: 'a fox' }, { env: { HF_TOKEN: 't' } });
  assert.deepEqual([hf.provider, hf.model], ['hf', 'black-forest-labs/FLUX.1-schnell']);
  const local = S.plan('generate_image', { prompt: 'a fox', aspect: '16:9' }, { env: { OX_SD_URL: 'http://x' } });
  assert.deepEqual(local.settings, { width: 1024, height: 576 });
});

test('jobs: an image waits for its file; a video returns a job that jobs_wait finishes', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const calls = [];
  const st = S.createStudio({
    env: { FAL_KEY: 'k' },
    generate: async (o) => { calls.push(o); if (o.model.includes('wan')) await gate; return { id: 'r1', status: 'completed', files: [`/out/${calls.length}.${o.model.includes('wan') ? 'mp4' : 'png'}`], urls: [] }; },
    history: () => [{ id: 'r1', status: 'completed', label: 'FLUX.1 [schnell]', prompt: 'a fox', files: ['/out/1.png'] }],
  });
  assert.match(await st.call('generate_image', { prompt: 'a fox' }), /^job \w+ done \(FLUX\.1 \[schnell\]\): \/out\/1\.png$/);
  const started = await st.call('generate_video', { prompt: 'a fox runs', camera: 'orbit' });
  const id = /job (\w+) is running/.exec(started)?.[1];
  assert.ok(id, started);
  assert.match(calls[1].prompt, /Camera: the camera orbits/);
  release();
  assert.match(await st.call('jobs_wait', { ids: [id] }), /done \(Wan 2\.2 A14B\): \/out\/2\.mp4/);
  await assert.rejects(st.call('jobs_wait', { ids: ['nope'] }), /no job nope/);
  assert.match(await st.call('history', {}), /r1 completed · FLUX\.1 \[schnell\] · "a fox" · \/out\/1\.png/);
  const failing = S.createStudio({ env: { FAL_KEY: 'k' }, generate: async () => { throw new Error('fal said no'); } });
  assert.match(await failing.call('upscale', { image: '/a.png' }), /failed \(Real-ESRGAN\): fal said no/);
});

test('models_explore says what is ready; recipes and video ops are reachable', async () => {
  const st = S.createStudio({ env: { HF_TOKEN: 't' }, video: { join: (files) => ({ file: `${files[0]}.joined.mp4` }), explainerVideo: async (t, steps) => ({ file: '/x.mp4', slides: steps.length, seconds: 12 }) } });
  const all = await st.call('models_explore', {});
  assert.match(all, /flux-schnell \(image\).*ready on hf/);
  assert.match(all, /wan-2\.2 \(video\).*needs a host key/);
  assert.match(all, /Camera moves for generate_video: dolly-in/);
  assert.match(await st.call('workflow_instructions', {}), /product-photoshoot: Product photoshoot/);
  assert.match(await st.call('workflow_instructions', { name: 'character-sheet' }), /^Character sheet.*\n1\. /s);
  await assert.rejects(st.call('workflow_instructions', { name: 'x' }), /recipes:/);
  assert.equal(await st.call('video_edit', { op: 'join', files: ['/a.mp4', '/b.mp4'] }), 'join done: /a.mp4.joined.mp4');
  await assert.rejects(st.call('video_edit', { op: 'cut' }), /file is the video/);
  assert.equal(await st.call('explainer_video', { title: 'T', steps: ['A: a', 'B: b'] }), 'explainer done: /x.mp4 (2 slides, 12 s)');
});

test('the MCP server: initialize, list 13 tools, calls answer independently', async () => {
  const input = new PassThrough(), output = new PassThrough();
  const got = [];
  output.on('data', (d) => String(d).split('\n').filter(Boolean).forEach((l) => got.push(JSON.parse(l))));
  let release;
  const slow = new Promise((r) => { release = r; });
  const studio = { call: async (name) => { if (name === 'jobs_wait') { await slow; return 'waited'; } if (name === 'bad') throw new Error('unknown tool bad'); return `ok ${name}`; } };
  S.serveStudioMcp({ input, output, studio });
  const send = (o) => input.write(`${JSON.stringify(o)}\n`);
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'jobs_wait', arguments: {} } });
  send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'models_explore', arguments: {} } });
  send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'bad', arguments: {} } });
  await new Promise((r) => setTimeout(r, 30));
  const by = (id) => got.find((m) => m.id === id);
  assert.equal(by(1).result.serverInfo.name, 'ox-studio');
  assert.equal(by(2).result.tools.length, 13);
  assert.equal(by(3), undefined, 'the slow wait has not answered yet');
  assert.equal(by(4).result.content[0].text, 'ok models_explore');
  assert.equal(by(5).result.isError, true);
  release();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(by(3).result.content[0].text, 'waited');
});

test('engine: fal upscale (image.url), a local file sent as a data URI, audio results, and Hugging Face', async () => {
  const ms = await import('../src/media-studio.js');
  const src = path.join(process.env.OX_HOME, 'in.png');
  fs.writeFileSync(src, Buffer.from('89504e470d0a1a0a', 'hex'));
  const sent = [];
  const fake = (result) => async (url, init = {}) => {
    sent.push({ url: String(url), body: init.body ? String(init.body) : '' });
    const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
    if (init.method === 'POST') return json({ request_id: 'q1', status_url: 'https://queue/s', response_url: 'https://queue/r' });
    if (String(url) === 'https://queue/s') return json({ status: 'COMPLETED' });
    if (String(url) === 'https://queue/r') return json(result);
    return new Response(Buffer.from('filebytes'), { status: 200 });
  };
  const wait = { interval: 1, sleep: async () => {} };
  const up = await ms.generate({ provider: 'fal', model: 'fal-ai/esrgan', prompt: '', media: { start: [src] }, fetchImpl: fake({ image: { url: 'https://cdn/x.png' } }), env: { FAL_KEY: 'k' }, wait });
  assert.equal(up.status, 'completed');
  assert.equal(up.surface, 'image');
  assert.ok(fs.existsSync(up.files[0]));
  const body = JSON.parse(sent[0].body);
  assert.match(body.image_url, /^data:image\/png;base64,/);
  assert.equal(body.prompt, undefined, 'no empty prompt sent');
  const snd = await ms.generate({ provider: 'fal', model: 'fal-ai/stable-audio', prompt: 'rain', fetchImpl: fake({ audio_file: { url: 'https://cdn/a.wav' } }), env: { FAL_KEY: 'k' }, wait });
  assert.equal(snd.surface, 'audio');
  assert.match(snd.files[0], /\.wav$/);
  await assert.rejects(ms.generate({ provider: 'fal', model: 'fal-ai/esrgan', prompt: '', env: { FAL_KEY: 'k' } }), /a prompt is needed/);
  const hfCalls = [];
  const hf = await ms.generate({ provider: 'hf', model: 'black-forest-labs/FLUX.1-schnell', prompt: 'a fox', env: { HF_TOKEN: 't', HF_INFERENCE_BASE: 'https://hf.test/models' }, fetchImpl: async (url, init) => { hfCalls.push({ url, init }); return new Response(Buffer.from('jpegbytes'), { status: 200, headers: { 'content-type': 'image/jpeg' } }); } });
  assert.equal(hfCalls[0].url, 'https://hf.test/models/black-forest-labs/FLUX.1-schnell');
  assert.equal(hfCalls[0].init.headers.Authorization, 'Bearer t');
  assert.match(hf.files[0], /1\.jpg$/);
  await assert.rejects(ms.generate({ provider: 'hf', model: 'x/y', prompt: 'a', env: { HF_TOKEN: 't', HF_INFERENCE_BASE: 'https://hf.test' }, fetchImpl: async () => new Response('{"error":"loading"}', { status: 200, headers: { 'content-type': 'application/json' } }) }), /answered without an image/);
});
