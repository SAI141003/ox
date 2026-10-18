// ox speaks: Kokoro's natural voice when set up, the system voice everywhere
// else, or VoxCPM for cloning a voice.
//
//   kokoro   Kokoro-82M (Apache-2.0) on the CPU, offline: src/kokoro.js, set up
//            with `ox voice install` (about 120 MB in ~/.ox/voice).
//   system   macOS `say`, Windows' built-in SpeechSynthesizer, Linux espeak-ng /
//            espeak / spd-say. Nothing to install.
//   voxcpm   OpenBMB's VoxCPM2 (Apache-2.0): natural voices in 30 languages and
//            cloning from a reference clip. Optional: `pip install voxcpm` (a 2B
//            model; an NVIDIA GPU with ~8 GB is what its makers test on). Run
//            through Python; ox never installs or downloads it on its own.
//
// Text is passed as an argument or environment value, never inside a command,
// and a cloned voice is only ever the reference file you point at.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { kokoroStatus, kokoroSpeak, DEFAULT_VOICE } from './kokoro.js';

const PY = () => process.env.OX_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');

// VoxCPM2 through its own Python API. Loads the model per call: simple and
// stateless; long-running use would keep it warm.
const VOXCPM_BRIDGE = `
import sys
from voxcpm import VoxCPM
import soundfile as sf
text, out, ref = sys.argv[1], sys.argv[2], (sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] else None)
model = VoxCPM.from_pretrained(sys.argv[4] if len(sys.argv) > 4 and sys.argv[4] else "openbmb/VoxCPM2", load_denoiser=False)
kw = dict(text=text, cfg_value=2.0, inference_timesteps=10)
if ref: kw["reference_wav_path"] = ref
wav = model.generate(**kw)
rate = getattr(getattr(model, "tts_model", None), "sample_rate", None) or 48000
sf.write(out, wav, rate)
print(out)
`;

function has(cmd) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { encoding: 'utf8' });
  return r.status === 0;
}

export function voxcpmAvailable(env = process.env) {
  const r = spawnSync(PY(), ['-c', 'import voxcpm, soundfile'], { env, encoding: 'utf8', timeout: 20_000 });
  return r.status === 0;
}

export function systemVoice(platform = process.platform) {
  if (platform === 'darwin') return has('say') ? 'say' : null;
  if (platform === 'win32') return 'powershell';
  for (const c of ['espeak-ng', 'espeak', 'spd-say']) if (has(c)) return c;
  return null;
}

export function engines(env = process.env) {
  return {
    system: systemVoice(),
    kokoro: kokoroStatus().ready,
    voxcpm: voxcpmAvailable(env),
    install: { kokoro: 'ox voice install   (Kokoro-82M, about 120 MB, offline, in ~/.ox/voice)', voxcpm: 'pip install voxcpm   (then ox speak --engine voxcpm; needs PyTorch, an NVIDIA GPU with ~8 GB is what VoxCPM is tested on)' },
  };
}

// argv for the system voice (no shell, text as data).
export function systemCommand(text, { platform = process.platform, out = null, voice = systemVoice(platform) } = {}) {
  if (platform === 'darwin') return { cmd: 'say', args: [...(out ? ['-o', out, '--data-format=LEI16@22050'] : []), '--', text], env: {} };
  if (platform === 'win32') {
    const ps = out
      ? "Add-Type -AssemblyName System.Speech; $s=New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SetOutputToWaveFile($env:OX_TTS_OUT); $s.Speak($env:OX_TTS_TEXT); $s.Dispose()"
      : "Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak($env:OX_TTS_TEXT)";
    return { cmd: 'powershell', args: ['-NoProfile', '-NonInteractive', '-Command', ps], env: { OX_TTS_TEXT: text, ...(out ? { OX_TTS_OUT: out } : {}) } };
  }
  if (!voice) return null;
  if (voice === 'spd-say') return { cmd: 'spd-say', args: ['-w', '--', text], env: {} };
  return { cmd: voice, args: [...(out ? ['-w', out] : []), '--', text], env: {} };
}

function playCommand(file, platform = process.platform) {
  if (platform === 'darwin') return ['afplay', [file]];
  if (platform === 'win32') return ['powershell', ['-NoProfile', '-Command', '(New-Object Media.SoundPlayer $env:OX_TTS_OUT).PlaySync()']];
  for (const c of ['paplay', 'aplay', 'ffplay']) if (has(c)) return c === 'ffplay' ? [c, ['-nodisp', '-autoexit', '-loglevel', 'quiet', file]] : [c, [file]];
  return null;
}

function runQuiet(cmd, args, env = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env }, windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => resolve({ ok: false, err: e.message }));
    p.on('close', (code) => resolve({ ok: code === 0, err: err.trim().split('\n').slice(-2).join(' ') }));
  });
}

// Speak (or, with `out`, write a WAV). Returns { ok, engine, out?, message }.
// ---- Fish Audio's lessons, in ox's own voice: sound starts after the first
// sentence (the next one renders while this one plays), and emotion tags at
// the start of a sentence, like (excited) (calm) (whispering) (sad), change
// how it is said. Measured on Kokoro: a 4-sentence reply played after ~17 s
// whole; the first sentence alone is ~1.9 s with the model warm.
const EMOTIONS = { excited: 1.15, happy: 1.1, cheerful: 1.1, urgent: 1.15, calm: 0.92, serious: 0.92, sad: 0.86, whispering: 0.88, whisper: 0.88, gentle: 0.9 };
const SAY_RATE = { excited: 230, happy: 215, cheerful: 215, urgent: 235, calm: 170, serious: 170, sad: 155, whispering: 160, whisper: 160, gentle: 165 };

/** "(excited) It worked!" → [{ text: "It worked!", mood: "excited", speed: 1.15 }], one per sentence. */
export function sentences(text) {
  const out = [];
  let mood = null;
  for (const raw of String(text ?? '').replace(/\s+/g, ' ').match(/[^.!?…]+[.!?…]+["')\]]*|[^.!?…]+$/g) ?? []) {
    let t = raw.trim();
    const tag = /^[([]\s*([a-z]+)\s*[)\]]\s*/i.exec(t);
    if (tag && EMOTIONS[tag[1].toLowerCase()]) { mood = tag[1].toLowerCase(); t = t.slice(tag[0].length); }
    if (t) out.push({ text: t, mood, speed: mood ? EMOTIONS[mood] : 1 });
  }
  // Very short pieces ride with the next one (no gaps between "Done." and the rest).
  const merged = [];
  for (const x of out) { const last = merged[merged.length - 1]; if (last && last.text.length < 18 && last.mood === x.mood) last.text += ` ${x.text}`; else merged.push({ ...x }); }
  return merged;
}

/** Live speech, sentence by sentence: render the next while this one plays. */
async function speakStreamed(parts, { voice, env }) {
  let next = kokoroSpeak(parts[0].text, { voice, speed: parts[0].speed });
  let firstAt = null;
  const t0 = Date.now();
  for (let i = 0; i < parts.length; i++) {
    const r = await next;
    next = i + 1 < parts.length ? kokoroSpeak(parts[i + 1].text, { voice, speed: parts[i + 1].speed }) : null;
    const play = playCommand(r.out);
    firstAt ??= Date.now() - t0;
    if (play && !env.OX_TTS_SILENT) await runQuiet(play[0], play[1], { OX_TTS_OUT: r.out });
    try { fs.unlinkSync(r.out); } catch {}
  }
  return firstAt;
}

export async function speak(text, { engine = 'auto', voice = null, out = null, model = null, env = process.env } = {}) {
  const t = String(text ?? '').trim();
  if (!t) return { ok: false, message: 'nothing to say' };
  // A Kokoro voice is a name (af_heart); a path is a clip to clone with VoxCPM.
  const kokoroVoice = voice && /^[a-z]{2}_[a-z]+$/.test(voice) ? voice : null;
  if (voice && !kokoroVoice && !fs.existsSync(voice)) return { ok: false, message: `no reference clip at ${voice}` };
  const wantKokoro = engine === 'kokoro' || (engine === 'auto' && !(voice && !kokoroVoice) && env.OX_TTS_ENGINE !== 'system' && env.OX_TTS_ENGINE !== 'voxcpm');
  if (wantKokoro && kokoroStatus().ready) {
    try {
      const parts = sentences(t);
      // Speaking now (not writing a file): start after the first sentence.
      if (!out && parts.length > 1) {
        const firstMs = await speakStreamed(parts, { voice: kokoroVoice ?? env.OX_TTS_VOICE ?? DEFAULT_VOICE, env });
        return { ok: true, engine: 'kokoro', out: null, message: 'spoken', firstSoundMs: firstMs, sentences: parts.length };
      }
      const r = await kokoroSpeak(parts.map((p) => p.text).join(' ') || t, { voice: kokoroVoice ?? env.OX_TTS_VOICE ?? DEFAULT_VOICE, out, speed: parts[0]?.speed ?? 1 });
      if (!out) {
        const play = playCommand(r.out);
        if (play) await runQuiet(play[0], play[1], { OX_TTS_OUT: r.out });
        try { fs.unlinkSync(r.out); } catch {}
      }
      return { ok: true, engine: 'kokoro', out: out ?? null, message: out ? `wrote ${out}` : 'spoken' };
    } catch (e) {
      if (engine === 'kokoro') return { ok: false, engine: 'kokoro', message: e.message };
      // auto: fall through to the system voice, and say so in the result
      const sys = await speak(t, { engine: 'system', out, env });
      return { ...sys, message: `${sys.message} (Kokoro failed: ${e.message})` };
    }
  }
  if (engine === 'kokoro') return { ok: false, engine: 'kokoro', message: `Kokoro is not set up. ${engines(env).install.kokoro}` };
  const useVox = engine === 'voxcpm' || (engine === 'auto' && (voice || env.OX_TTS_ENGINE === 'voxcpm') && voxcpmAvailable(env));
  if (engine === 'voxcpm' && !voxcpmAvailable(env)) {
    return { ok: false, engine: 'voxcpm', message: `VoxCPM is not installed for ${PY()}. ${engines(env).install.voxcpm}` };
  }
  if (useVox) {
    const wav = out ?? path.join(os.tmpdir(), `ox-speak-${process.pid}-${Date.now()}.wav`);
    const r = await runQuiet(PY(), ['-c', VOXCPM_BRIDGE, t, wav, voice ?? '', model ?? ''], {});
    if (!r.ok || !fs.existsSync(wav)) return { ok: false, engine: 'voxcpm', message: `VoxCPM failed: ${r.err || 'no audio written'}` };
    if (!out) {
      const play = playCommand(wav);
      if (play) await runQuiet(play[0], play[1], { OX_TTS_OUT: wav });
      try { fs.unlinkSync(wav); } catch {}
    }
    return { ok: true, engine: 'voxcpm', out: out ?? null, message: out ? `wrote ${out}` : 'spoken' };
  }
  const parts = sentences(t);
  const mood = parts.find((p) => p.mood)?.mood;
  const c = systemCommand(parts.map((p) => p.text).join(' ') || t, { out });
  if (c && mood && SAY_RATE[mood] && c.cmd === 'say') c.args = ['-r', String(SAY_RATE[mood]), ...c.args];
  if (!c) return { ok: false, engine: 'system', message: 'no system voice found (install espeak-ng)' };
  const r = await runQuiet(c.cmd, c.args, c.env);
  return r.ok ? { ok: true, engine: 'system', out, message: out ? `wrote ${out}` : 'spoken' } : { ok: false, engine: 'system', message: r.err || 'the system voice failed' };
}
