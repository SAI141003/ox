// Studio on your own ComfyUI (src/media-studio.js provider "comfyui"), against a stand-in server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-comfy-'));
process.env.OX_HOME = path.join(home, '.ox');
const S = await import('../src/media-studio.js');
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

test('comfyui: the standard graph on your first checkpoint, queued, waited for, and the image brought home', async (t) => {
  const seen = { graph: null, polls: 0 };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (u.pathname === '/object_info/CheckpointLoaderSimple') return json({ CheckpointLoaderSimple: { input: { required: { ckpt_name: [['sd_xl_base_1.0.safetensors', 'other.ckpt']] } } } });
    if (u.pathname === '/prompt') { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { seen.graph = JSON.parse(b).prompt; json({ prompt_id: 'p1' }); }); return; }
    if (u.pathname === '/history/p1') { seen.polls++; return json(seen.polls < 2 ? {} : { p1: { status: { status_str: 'success' }, outputs: { 9: { images: [{ filename: 'ox_00001_.png', subfolder: '', type: 'output' }] } } } }); }
    if (u.pathname === '/view') { assert.equal(u.searchParams.get('filename'), 'ox_00001_.png'); res.writeHead(200, { 'content-type': 'image/png' }); return res.end(PNG); }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  process.env.OX_COMFYUI_URL = `http://127.0.0.1:${srv.address().port}`;
  const r = await S.generate({ provider: 'comfyui', model: 'default', prompt: 'a red fox playing guitar', settings: { width: 512, height: 512 } });
  assert.equal(seen.graph[4].inputs.ckpt_name, 'sd_xl_base_1.0.safetensors', 'your first checkpoint');
  assert.equal(seen.graph[6].inputs.text, 'a red fox playing guitar');
  assert.equal(seen.graph[5].inputs.width, 512);
  assert.ok(seen.polls >= 2, 'waited for the run');
  const files = r.files ?? r.outputs ?? [];
  assert.equal(files.length, 1);
  assert.deepEqual(fs.readFileSync(files[0]).subarray(0, 8), PNG.subarray(0, 8));
  assert.match(r.label, /ComfyUI · sd_xl_base/);
});

test('comfyui: says how to start it when nothing answers', async () => {
  process.env.OX_COMFYUI_URL = 'http://127.0.0.1:9';
  await assert.rejects(S.generate({ provider: 'comfyui', model: 'default', prompt: 'x' }), /no ComfyUI answered at http:\/\/127\.0\.0\.1:9.*python main\.py/);
});
