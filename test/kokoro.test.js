// The natural voice: ready only when the private Python and both model files
// are whole; asked for when not set up, it says how to set it up instead of
// pretending; voice names are checked before anything reaches Python.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-voice-'));
process.env.OX_VOICE_DIR = dir;
const k = await import('../src/kokoro.js');
const tts = await import('../src/tts.js');
test.after(() => { delete process.env.OX_VOICE_DIR; fs.rmSync(dir, { recursive: true, force: true }); });

test('not ready until the Python and both files are whole', () => {
  let st = k.kokoroStatus();
  assert.equal(st.ready, false);
  fs.mkdirSync(path.join(dir, 'kokoro'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'kokoro', 'voices-v1.0.bin'), 'partial');
  st = k.kokoroStatus();
  assert.equal(st.files.find((f) => f.name === 'voices-v1.0.bin').ok, false); // wrong size: a cut download
});

test('asked for Kokoro when it is not set up: a clear message, not silence', async () => {
  const r = await tts.speak('hello', { engine: 'kokoro', env: {} });
  assert.equal(r.ok, false);
  assert.match(r.message, /ox voice install/);
  await assert.rejects(k.kokoroSpeak('hi', { voice: '../../etc' }), /unknown voice|not set up/);
});

test('ox voice install shows each step: a private Python, the package, both files', () => {
  const steps = k.installSteps();
  assert.equal(steps.length, 4);
  assert.ok(steps.every((s) => s.args.every((a) => !a.includes(' && '))));
  assert.ok(steps.slice(2).every((s) => s.args.at(-1).startsWith('https://github.com/thewh1teagle/kokoro-onnx/releases/download/')));
});
