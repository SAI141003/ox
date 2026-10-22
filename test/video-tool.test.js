import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { editVideoTool } from '../src/tools/video.js';
import { probe } from '../src/video-edit.js';

const available = (bin) => spawnSync(bin, ['-version'], { encoding: 'utf8', timeout: 3000 }).status === 0;
const ffmpegAvailable = available('ffmpeg') && available('ffprobe');

function makeFixture(dir, name, { audio = true } = {}) {
  const file = path.join(dir, name);
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=24:d=2'];
  if (audio) args.push('-f', 'lavfi', '-i', 'sine=frequency=440:duration=2');
  args.push('-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p');
  if (audio) args.push('-c:a', 'aac');
  args.push(file);
  const result = spawnSync('ffmpeg', args, { encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, `could not generate fixture: ${result.stderr}`);
  return file;
}

test('edit_video speed makes a verified sibling output and preserves the source', { skip: !ffmpegAvailable && 'ffmpeg/ffprobe are not installed' }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-video-tool-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {} });
  const source = makeFixture(dir, 'source.mp4');
  const before = crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');
  const originalDuration = probe(source).duration;

  const result = await editVideoTool({ op: 'speed', file: 'source.mp4', factor: 2 }, { cwd: dir });
  assert.equal(result.isError, false, result.content);
  const match = /done: (.+)$/.exec(result.content);
  assert.ok(match, result.content);
  const output = match[1];
  assert.notEqual(path.resolve(output), source, 'must never overwrite the source');
  assert.ok(fs.existsSync(output), 'reported output exists');
  assert.ok(probe(output).duration < originalDuration * 0.65, '2x speed materially shortens duration');
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex'), before, 'source bytes remain unchanged');
});

test('edit_video cut, vertical, GIF, polish, understand and silent transcription create usable outputs', { skip: !ffmpegAvailable && 'ffmpeg/ffprobe are not installed' }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-video-ops-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {} });
  const source = makeFixture(dir, 'source.mp4');
  const hash = () => crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');
  const sourceHash = hash();
  const invoke = async (op, extra = {}) => {
    const result = await editVideoTool({ op, file: source, ...extra }, { cwd: dir });
    assert.equal(result.isError, false, `${op}: ${result.content}`);
    return result.content;
  };
  const outputOf = (text) => {
    const found = /: (\/[^\n]+)$/.exec(text);
    assert.ok(found, text);
    assert.ok(fs.existsSync(found[1]), `reported file exists: ${found[1]}`);
    assert.notEqual(path.resolve(found[1]), source, 'operation must not overwrite source');
    return found[1];
  };

  const cut = outputOf(await invoke('cut', { start: 0.5, end: 1.5 }));
  assert.ok(Math.abs(probe(cut).duration - 1) < 0.2, `cut duration ${probe(cut).duration}`);
  const vertical = outputOf(await invoke('vertical'));
  const portrait = probe(vertical);
  assert.equal(portrait.height, 90);
  assert.ok(portrait.width < portrait.height);
  const gif = outputOf(await invoke('gif', { start: 0, end: 1 }));
  assert.match(gif, /\.gif$/);
  assert.ok(probe(gif).duration > 0.5 && probe(gif).duration < 1.5);
  const polished = outputOf(await invoke('polish'));
  assert.ok(probe(polished).duration < 1, `static screen recording should be compressed: ${probe(polished).duration}s`);
  const understood = await invoke('understand');
  assert.match(understood, /Frames/);
  const frames = [...understood.matchAll(/(\/[^,\s]+\.jpg)/g)].map((m) => m[1]);
  assert.ok(frames.length > 0, understood);
  assert.ok(frames.every((frame) => fs.statSync(frame).size > 0), 'extracted frames are readable files');

  const silent = makeFixture(dir, 'silent.mp4', { audio: false });
  const transcription = await editVideoTool({ op: 'transcribe', file: silent }, { cwd: dir });
  assert.equal(transcription.isError, false);
  assert.match(transcription.content, /the file has no sound/);
  const noQuery = await editVideoTool({ op: 'highlights', file: source, query: 'the and' }, { cwd: dir });
  assert.equal(noQuery.isError, true);
  assert.match(noQuery.content, /say what to look for/);
  const backwardsCut = await editVideoTool({ op: 'cut', file: source, start: 1.5, end: 0.5 }, { cwd: dir });
  assert.equal(backwardsCut.isError, true);
  assert.match(backwardsCut.content, /end must be after the start/);
  assert.equal(hash(), sourceHash, 'all operations preserve the original source');
  // understand() intentionally leaves frames available for the agent to inspect.
  for (const frame of frames) { try { fs.rmSync(path.dirname(frame), { recursive: true, force: true }); } catch {} }
});

test('edit_video reports invalid operations and missing source paths without throwing', async () => {
  const unknown = await editVideoTool({ op: 'teleport', file: '/tmp/not-read.mp4' });
  assert.equal(unknown.isError, true);
  assert.match(unknown.content, /unknown op teleport/);
  const missing = await editVideoTool({ op: 'speed', file: '/tmp/ox-video-tool-missing.mp4', factor: 2 });
  assert.equal(missing.isError, true);
  assert.match(missing.content, /ffprobe|not a readable video|No such file/i);
});
