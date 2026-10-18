import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-up-home-'));
process.env.OX_HOME = home;
const U = await import('../src/uploads.js');
const hasFfmpeg = spawnSync('/bin/sh', ['-c', 'command -v ffmpeg']).status === 0;
const hasPdf = spawnSync('/bin/sh', ['-c', 'command -v pdftotext']).status === 0;

test('kinds and safe names', () => {
  assert.equal(U.kindOf('clip.MP4'), 'video');
  assert.equal(U.kindOf('x', 'video/webm'), 'video');
  assert.equal(U.kindOf('a.m4a'), 'audio');
  assert.equal(U.kindOf('doc.pdf'), 'pdf');
  assert.equal(U.kindOf('data.xlsx'), 'file');
  assert.equal(U.safeName('../../etc/passwd'), 'passwd', 'no path escapes');
  assert.equal(U.safeName('a b(1).mov'), 'a b(1).mov');
});

test('an upload is streamed to ~/.ox/uploads with its size, and an oversized one is refused and removed', async () => {
  const r = await U.saveUpload(Readable.from([Buffer.from('hello'), Buffer.from(' world')]), 'note.bin');
  assert.equal(r.size, 11);
  assert.ok(r.file.startsWith(path.join(home, 'uploads')));
  assert.equal(fs.readFileSync(r.file, 'utf8'), 'hello world');
  await assert.rejects(U.saveUpload(Readable.from([Buffer.alloc(2048)]), 'big.bin', { limit: 1024 }), /over/);
  const day = fs.readdirSync(path.join(home, 'uploads'))[0];
  assert.ok(!fs.readdirSync(path.join(home, 'uploads', day)).some((f) => f.endsWith('big.bin')));
});

test('a real video becomes frames with times, its length and its path', { skip: !hasFfmpeg && 'no ffmpeg' }, () => {
  const v = path.join(home, 'clip.mp4');
  spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=4:size=320x240:rate=10', '-pix_fmt', 'yuv420p', v]);
  const d = U.describeUpload(v, 'clip.mp4', 'video/mp4', fs.statSync(v).size);
  assert.equal(d.kind, 'video');
  assert.equal(d.frames.length, 6);
  assert.ok(d.frames.every((f) => f.data.length > 100 && f.t >= 0 && f.t <= 4));
  assert.ok(Math.abs(d.duration - 4) < 0.5);
  assert.match(d.note, /The 6 images attached are frames from it/);
  assert.match(d.note, new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('a PDF gives its text', { skip: !(hasPdf && hasFfmpeg) && 'no pdftotext' }, () => {
  // A minimal one-page PDF that says "Hello ox".
  const pdf = '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 100]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length 41>>stream\nBT /F1 18 Tf 20 40 Td (Hello ox) Tj ET\nendstream endobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF';
  const f = path.join(home, 'a.pdf');
  fs.writeFileSync(f, pdf);
  const d = U.describeUpload(f, 'a.pdf', 'application/pdf', pdf.length);
  assert.equal(d.kind, 'pdf');
  assert.match(String(d.text), /Hello ox/);
});

test('the app sends any file to /ox/upload, and routing reads what was typed', () => {
  const html = fs.readFileSync(new URL('../src/web/chat.html', import.meta.url), 'utf8');
  assert.match(html, /fetch\('\/ox\/upload'/);
  assert.doesNotMatch(html, /is over 200 KB\. Point ox at it by path instead/);
  assert.match(html, /accept="image\/png,image\/jpeg,image\/gif,image\/webp,video\/\*"/);
  const serve = fs.readFileSync(new URL('../src/serve.js', import.meta.url), 'utf8');
  assert.match(serve, /const typedText = /);
});
