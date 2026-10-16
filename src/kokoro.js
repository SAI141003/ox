// A natural voice for ox: Kokoro-82M (Apache-2.0) through kokoro-onnx (MIT),
// on the CPU, offline. Kept apart from everything else in ~/.ox/voice:
//
//   venv/                     a private Python (uv), so nothing system-wide changes
//   kokoro/kokoro-v1.0.int8.onnx, kokoro/voices-v1.0.bin   from kokoro-onnx's release
//
// The model loads once into a long-lived worker and every sentence after that
// reuses it; text goes over stdin as JSON, never on a command line.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import readline from 'node:readline';

export const VOICE_DIR = () => process.env.OX_VOICE_DIR || path.join(process.env.OX_HOME || path.join(os.homedir(), '.ox'), 'voice');
const PY_BIN = () => path.join(VOICE_DIR(), 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const MODEL = () => path.join(VOICE_DIR(), 'kokoro', 'kokoro-v1.0.int8.onnx');
const VOICES = () => path.join(VOICE_DIR(), 'kokoro', 'voices-v1.0.bin');
const RELEASE = 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0';
export const FILES = Object.freeze([
  { name: 'kokoro-v1.0.int8.onnx', bytes: 92361271 },
  { name: 'voices-v1.0.bin', bytes: 28214398 },
]);
export const DEFAULT_VOICE = 'af_heart';

// Voices people pick first (Kokoro's own grades put af_heart and af_bella on top).
export const VOICE_LABELS = Object.freeze({
  af_heart: 'Heart · American, warm', af_bella: 'Bella · American, bright', af_nicole: 'Nicole · American, soft',
  am_michael: 'Michael · American', am_fenrir: 'Fenrir · American, deep', am_puck: 'Puck · American, lively',
  bf_emma: 'Emma · British', bf_isabella: 'Isabella · British', bm_george: 'George · British', bm_fable: 'Fable · British',
});

export function kokoroStatus() {
  const python = fs.existsSync(PY_BIN());
  const files = FILES.map((f) => {
    const p = path.join(VOICE_DIR(), 'kokoro', f.name);
    const size = fs.existsSync(p) ? fs.statSync(p).size : 0;
    return { ...f, path: p, ok: size === f.bytes };
  });
  return { ready: python && files.every((f) => f.ok), python, files, dir: VOICE_DIR() };
}

// One worker per process: started on first use, model kept in memory.
const WORKER = `
import sys, json
import soundfile as sf
from kokoro_onnx import Kokoro
k = Kokoro(sys.argv[1], sys.argv[2])
print(json.dumps({"ready": True, "voices": sorted(k.get_voices())}), flush=True)
for line in sys.stdin:
    try:
        r = json.loads(line)
        samples, rate = k.create(r["text"], voice=r.get("voice") or "${DEFAULT_VOICE}", speed=float(r.get("speed") or 1.0), lang=r.get("lang") or "en-us")
        sf.write(r["out"], samples, rate)
        print(json.dumps({"id": r["id"], "ok": True, "seconds": len(samples) / rate}), flush=True)
    except Exception as e:
        print(json.dumps({"id": r.get("id") if isinstance(r, dict) else None, "ok": False, "error": str(e)[:300]}), flush=True)
`;

let worker = null;
function startWorker() {
  if (worker) return worker;
  const st = kokoroStatus();
  if (!st.ready) throw new Error('Kokoro is not set up. Run: ox voice install');
  const p = spawn(PY_BIN(), ['-I', '-c', WORKER, MODEL(), VOICES()], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const pending = new Map();
  let err = '';
  let readyResolve, readyReject;
  const ready = new Promise((res, rej) => { readyResolve = res; readyReject = rej; });
  p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
  readline.createInterface({ input: p.stdout }).on('line', (line) => {
    let m; try { m = JSON.parse(line); } catch { return; }
    if (m.ready) return readyResolve(m.voices);
    const w = pending.get(m.id); if (!w) return;
    pending.delete(m.id);
    m.ok ? w.resolve(m) : w.reject(new Error(`Kokoro: ${m.error}`));
  });
  const fail = (why) => {
    worker = null;
    readyReject(new Error(why));
    for (const w of pending.values()) w.reject(new Error(why));
    pending.clear();
  };
  p.on('error', (e) => fail(`Kokoro could not start: ${e.message}`));
  p.on('exit', (code) => fail(`Kokoro stopped (${code}): ${err.trim().split('\n').slice(-2).join(' ')}`));
  p.unref?.();
  let n = 0;
  worker = {
    ready,
    proc: p,
    say(req) {
      const id = ++n;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        p.stdin.write(`${JSON.stringify({ ...req, id })}\n`);
      });
    },
  };
  return worker;
}

export async function kokoroVoices() {
  return startWorker().ready;
}

// Writes a WAV and resolves { out, seconds }.
export async function kokoroSpeak(text, { voice = DEFAULT_VOICE, speed = 1, lang = 'en-us', out = null } = {}) {
  const t = String(text ?? '').trim().slice(0, 5000);
  if (!t) throw new Error('nothing to say');
  if (voice && !/^[a-z]{2}_[a-z]+$/.test(voice)) throw new Error(`unknown voice ${voice}`);
  const w = startWorker();
  await w.ready;
  const file = out ?? path.join(os.tmpdir(), `ox-kokoro-${process.pid}-${Date.now()}.wav`);
  const r = await w.say({ text: t, voice, speed, lang, out: file });
  return { out: file, seconds: r.seconds };
}

export function stopKokoro() {
  if (worker) { try { worker.proc.kill(); } catch {} worker = null; }
}

// What ox voice install does, step by step, each shown before it runs.
export function installSteps() {
  const dir = VOICE_DIR();
  return [
    { what: 'a private Python 3.12 for the voice (uv)', cmd: 'uv', args: ['venv', path.join(dir, 'venv'), '--python', '3.12'] },
    { what: 'kokoro-onnx and soundfile into it', cmd: 'uv', args: ['pip', 'install', '--python', PY_BIN(), 'kokoro-onnx', 'soundfile'] },
    ...FILES.map((f) => ({ what: `${f.name} (${Math.round(f.bytes / 1e6)} MB) from kokoro-onnx's release`, cmd: 'curl', args: ['-sL', '--fail', '-o', path.join(dir, 'kokoro', f.name), `${RELEASE}/${f.name}`] })),
  ];
}

export function installKokoro({ log = console.log } = {}) {
  if (spawnSync('uv', ['--version'], { encoding: 'utf8' }).status !== 0) {
    throw new Error('uv is needed to make the voice its own Python: https://docs.astral.sh/uv/ (brew install uv)');
  }
  fs.mkdirSync(path.join(VOICE_DIR(), 'kokoro'), { recursive: true });
  const st = kokoroStatus();
  for (const s of installSteps()) {
    const file = s.cmd === 'curl' ? s.args[3] : null;
    if (file && st.files.find((f) => f.path === file)?.ok) { log(`✓ ${s.what} (already here)`); continue; }
    if (s.args[0] === 'venv' && st.python) { log(`✓ ${s.what} (already here)`); continue; }
    log(`… ${s.what}`);
    const r = spawnSync(s.cmd, s.args, { stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`failed: ${s.what}`);
  }
  const after = kokoroStatus();
  if (!after.ready) throw new Error(`files did not come down whole: ${after.files.filter((f) => !f.ok).map((f) => f.name).join(', ')}`);
  return after;
}
