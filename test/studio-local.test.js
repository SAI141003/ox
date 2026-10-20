// Studio on this Mac's own chip (src/studio-local.js): sizes, camera moves,
// what is ready, and downloads that are refused unless their checksum matches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const L = await import('../src/studio-local.js');

test('sizes stay near the model\'s 512 px, in multiples of 64, in the asked shape', () => {
  assert.deepEqual(L.sizeFor('1:1'), { width: 512, height: 512 });
  const wide = L.sizeFor('16:9');
  assert.ok(wide.width > wide.height && wide.width % 64 === 0 && wide.height % 64 === 0, JSON.stringify(wide));
  const tall = L.sizeFor('9:16');
  assert.deepEqual([tall.width, tall.height], [wide.height, wide.width]);
  assert.deepEqual(L.sizeFor('nonsense'), { width: 512, height: 512 });
});

test('every camera move in the catalog has a crop path, inside the frame', async () => {
  const C = await import('../src/studio-catalog.js');
  for (const k of Object.keys(C.CAMERA)) {
    const m = L.MOVES[k];
    assert.ok(m, k);
    for (const [z, x, y] of m) { assert.ok(z >= 1 && z <= 2, k); assert.ok(x >= 0 && x <= 1 && y >= 0 && y <= 1, k); }
  }
});

test('a fresh machine: nothing set up but the cut-out (built into macOS 14+) and quick upscale', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-local-'));
  const s = L.status({ OX_HOME: home });
  assert.equal(s.engine, false);
  assert.equal(s.can.image, false);
  assert.equal(s.can.video, false);
  assert.equal(s.can.cutout, process.platform === 'darwin' && Number(os.release().split('.')[0]) >= 23);
  assert.ok(s.ramGB > 0);
});

test('a download whose checksum does not match is refused and nothing is kept; generating says how to set up', async () => {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') return;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-local-'));
  const env = { OX_HOME: home };
  // The engine is "present"; the model download is served tampered bytes.
  const bin = L.sdBin(env);
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, '');
  const bad = Buffer.from('not the model');
  const fetchImpl = async () => new Response(new Blob([bad]).stream(), { status: 200 });
  await assert.rejects(L.install({ models: ['taesd'], env, fetchImpl }), /did not match its checksum/);
  assert.ok(!fs.existsSync(L.modelPath('taesd', env)));
  assert.ok(!fs.existsSync(`${L.modelPath('taesd', env)}.part`));
  await assert.rejects(L.textToImage({ prompt: 'x', outDir: home, env }), /not set up for image yet: run ox studio local install/);
});
