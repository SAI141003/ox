// ox's voice: system speech as data (never inside a command), and the VoxCPM
// bridge, exercised against stand-in voxcpm/soundfile modules that record the
// call (the real model is a 2B download).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { systemCommand, speak } from '../src/tts.js';

test('the system voice gets the text as an argument or env value, never as code', () => {
  const evil = '"; rm -rf ~; echo "';
  const mac = systemCommand(evil, { platform: 'darwin' });
  assert.deepEqual(mac.args.slice(-2), ['--', evil]);
  const win = systemCommand(evil, { platform: 'win32' });
  assert.equal(win.env.OX_TTS_TEXT, evil);
  assert.ok(!win.args.join(' ').includes('rm -rf'));
  const lin = systemCommand(evil, { platform: 'linux', voice: 'espeak-ng' });
  assert.deepEqual(lin.args, ['--', evil]);
});

const havePython = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['--version']).status === 0;

test('VoxCPM: the bridge loads the model, passes text and the reference clip, writes the WAV', { skip: !havePython && 'no python' }, async () => {
  const stub = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-voxcpm-stub-'));
  const log = path.join(stub, 'calls.json');
  fs.mkdirSync(path.join(stub, 'voxcpm'));
  fs.writeFileSync(path.join(stub, 'voxcpm', '__init__.py'), `
import json
class _M:
    class tts_model: sample_rate = 48000
    def generate(self, **kw):
        json.dump({"kw": kw}, open(${JSON.stringify(log)}, "w"))
        return [0.0] * 10
class VoxCPM:
    @staticmethod
    def from_pretrained(name, load_denoiser=True):
        open(${JSON.stringify(log)} + ".model", "w").write(name)
        return _M()
`);
  fs.writeFileSync(path.join(stub, 'soundfile.py'), 'def write(path, data, rate):\n    open(path, "wb").write(b"RIFF" + str(rate).encode())\n');
  const ref = path.join(stub, 'me.wav');
  fs.writeFileSync(ref, 'RIFF');
  const out = path.join(stub, 'out.wav');
  const saved = process.env.PYTHONPATH;
  process.env.PYTHONPATH = stub;
  try {
    const r = await speak('hello from ox', { engine: 'voxcpm', voice: ref, out });
    assert.equal(r.ok, true, r.message);
    assert.equal(r.engine, 'voxcpm');
    assert.equal(fs.readFileSync(out, 'utf8'), 'RIFF48000');
    const call = JSON.parse(fs.readFileSync(log, 'utf8')).kw;
    assert.equal(call.text, 'hello from ox');
    assert.equal(call.reference_wav_path, ref);
    assert.equal(fs.readFileSync(`${log}.model`, 'utf8'), 'openbmb/VoxCPM2');
  } finally {
    if (saved === undefined) delete process.env.PYTHONPATH; else process.env.PYTHONPATH = saved;
  }
});

test('a missing reference clip is refused before anything runs', async () => {
  const r = await speak('hi', { engine: 'voxcpm', voice: '/no/such/clip.wav' });
  assert.equal(r.ok, false);
  assert.match(r.message, /no reference clip/);
});
