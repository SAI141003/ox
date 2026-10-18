// Video edits (src/video-edit.js) and image edits (src/media-studio.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as V from '../src/video-edit.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

test('srt round trip and time parsing', () => {
  const segs = [{ start: 0, end: 1.5, text: 'hello there' }, { start: 61.25, end: 63, text: 'second line' }];
  assert.deepEqual(V.parseSrt(V.toSrt(segs)), segs);
  assert.equal(V.seconds('1:23'), 83);
  assert.equal(V.seconds('00:01:23.5'), 83.5);
  assert.throws(() => V.seconds('soon'), /not a time/);
});

test('cut, speed, vertical, gif and polish on a real clip; the source is never changed', { skip: !hasFfmpeg && 'needs ffmpeg' }, () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-vid-'));
  const src = path.join(d, 'clip.mp4');
  spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=15:duration=2', '-f', 'lavfi', '-i', 'color=c=gray:size=320x180:rate=15:duration=2', '-filter_complex', '[0:v][1:v]concat=n=2:v=1[v]', '-map', '[v]', '-c:v', 'libx264', src]);
  const before = fs.statSync(src).mtimeMs;
  assert.ok(Math.abs(V.probe(V.cut(src, 1, 2).file).duration - 1) < 0.2);
  assert.ok(Math.abs(V.probe(V.speed(src, 2).file).duration - 2) < 0.3);
  const v = V.probe(V.vertical(src).file);
  assert.ok(v.height > v.width);
  assert.ok(fs.statSync(V.gif(src).file).size > 1000);
  const p = V.polish(src);
  assert.equal(p.stillParts, 1, 'the gray half is still');
  assert.ok(p.after < p.before);
  assert.equal(fs.statSync(src).mtimeMs, before);
  assert.match(V.outPath(src, 'cut'), /clip\.cut-2\.mp4$/, 'never overwrites an earlier result');
});

test('image edit requests: OpenAI /images/edits with the file, OpenRouter with the image inline', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-img-'));
  process.env.OX_HOME = home;
  const S = await import('../src/media-studio.js');
  const img = path.join(home, 'in.png');
  fs.writeFileSync(img, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
  const calls = [];
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const body = url.includes('openrouter') ? { choices: [{ message: { images: [{ image_url: { url: `data:image/png;base64,${png}` } }] } }] } : { data: [{ b64_json: png }] };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const a = await S.generate({ provider: 'openai', prompt: 'make it red', media: { edit: [img] }, fetchImpl, env: { OPENAI_API_KEY: 'k' } });
  assert.match(calls[0].url, /\/images\/edits$/);
  assert.ok(calls[0].init.body instanceof FormData);
  assert.equal(calls[0].init.body.get('prompt'), 'make it red');
  assert.equal(a.files.length, 1);
  const b = await S.generate({ provider: 'openrouter', prompt: 'make it red', media: { edit: [img] }, fetchImpl, env: { OPENROUTER_API_KEY: 'k' } });
  const sent = JSON.parse(calls[1].init.body);
  assert.deepEqual(sent.modalities, ['image', 'text']);
  assert.match(sent.messages[0].content[1].image_url.url, /^data:image\/png;base64,/);
  assert.equal(b.files.length, 1);
  const { pick } = await import('../src/tools/media.js');
  assert.equal(pick({ kind: 'image', edit: true }, { HIGGSFIELD_API_KEY: 'x', OPENROUTER_API_KEY: 'k' }).provider, 'openrouter', 'an edit goes to a provider that edits');
});
