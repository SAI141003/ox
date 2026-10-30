// OX Studio on this Mac's own power: no key, no account, nothing leaves the
// machine. A native Metal program (stable-diffusion.cpp) runs small open
// models; macOS's own Vision framework cuts subjects out; ffmpeg does motion.
//
//   image    SD-Turbo (1-4 steps, ~512 px), text to image
//   edit     the same model, image to image (keeps the layout, changes the look)
//   video    a "living picture": a generated keyframe, its camera move, a few
//            re-imagined keyframes along it, and smooth frames in between
//   upscale  2x: "detail" redraws fine detail with the same model (a hires fix), "quick" is a sharp resize
//   cutout   Apple Vision foreground mask (built into macOS 14+, no download)
//
// Everything is pinned and checked: the program by its GitHub release digest,
// each model by its sha256, so a changed download is refused.
//
//   ~/.ox/studio-local/bin-<tag>/sd-cli    the program
//   ~/.ox/studio-local/models/*.gguf|pth   the models
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

export const root = (env = process.env) => path.join(env.OX_HOME || path.join(os.homedir(), '.ox'), 'studio-local');

export const ENGINE = Object.freeze({
  tag: 'master-929-3f8527a',
  url: 'https://github.com/leejet/stable-diffusion.cpp/releases/download/master-929-3f8527a/sd-master-3f8527a-bin-Darwin-macOS-26.6.2-arm64.zip',
  sha256: '1c8ee6c8e413e3335b1223bbc657ea5d86dae1819f8426a98b84c265587eb192',
  size: 35049086,
  license: 'MIT',
});

export const MODELS = Object.freeze({
  'sd-turbo': {
    name: 'SD-Turbo (8-bit)', kind: 'image', file: 'sd_turbo-f16-q8_0.gguf', size: 2023745376,
    url: 'https://huggingface.co/Green-Sky/SD-Turbo-GGUF/resolve/19a31586d02d64a73b4419bc193b3ecfaf38e1f0/sd_turbo-f16-q8_0.gguf',
    sha256: 'd50be7655f0a554cf8041c145d88b210bd5f3c545423119dee62ae08cae51580',
    license: 'Stability AI Community (free under $1M a year revenue)', native: 512,
  },
  // A tiny decoder (Tiny AutoEncoder, MIT): the last step in ~1 s instead of ~14 s, a little softer.
  taesd: {
    name: 'TAESD (fast decoder)', kind: 'decoder', file: 'taesd.safetensors', size: 9793292,
    url: 'https://huggingface.co/madebyollin/taesd/resolve/614f76814bbe30edbe2e627ace1c2234c81a2c0e/diffusion_pytorch_model.safetensors',
    sha256: 'db169d69145ec4ff064e49d99c95fa05d3eb04ee453de35824a6d0f325513549',
    license: 'MIT',
  },
});

const binDir = (env) => path.join(root(env), `bin-${ENGINE.tag}`);
export const sdBin = (env = process.env) => path.join(binDir(env), 'sd-cli');
export const modelPath = (id, env = process.env) => path.join(root(env), 'models', MODELS[id].file);
const freeBytes = (dir) => {
  // The nearest folder that exists (the studio folder may not, before setup).
  let d = dir;
  while (d && !fs.existsSync(d) && path.dirname(d) !== d) d = path.dirname(d);
  try { const s = fs.statfsSync(d); return s.bavail * s.bsize; } catch { return null; }
};

/** What this Mac can do on its own right now, and what a download would add. */
export function status(env = process.env) {
  // Read only: asking what this Mac can do must not create folders (a check
  // that wrote ~/.ox/studio-local tripped the "real home untouched" test on CI).
  const engine = fs.existsSync(sdBin(env));
  const models = Object.fromEntries(Object.entries(MODELS).map(([id, m]) => [id, { ...m, ready: fs.existsSync(modelPath(id, env)) }]));
  const vision = process.platform === 'darwin' && Number(os.release().split('.')[0]) >= 23; // macOS 14+
  const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
  const can = {
    image: engine && models['sd-turbo'].ready,
    edit: engine && models['sd-turbo'].ready,
    video: engine && models['sd-turbo'].ready && ffmpeg,
    upscale: ffmpeg,
    cutout: vision,
  };
  return {
    platform: process.platform, arch: process.arch, chip: chipName(), ramGB: Math.round(os.totalmem() / 2 ** 30), freeGB: Math.round((freeBytes(root(env)) ?? 0) / 2 ** 30 * 10) / 10,
    engine, models, vision, ffmpeg, can, supported: process.platform === 'darwin' && process.arch === 'arm64',
  };
}

function chipName() {
  if (process.platform !== 'darwin') return os.cpus()[0]?.model ?? '';
  return (spawnSync('sysctl', ['-n', 'machdep.cpu.brand_string'], { encoding: 'utf8' }).stdout ?? '').trim();
}

// ------------------------------------------------------------------ install

async function fetchTo(url, dest, { sha256, size, onProgress = () => {}, fetchImpl = globalThis.fetch }) {
  const free = freeBytes(path.dirname(dest));
  if (free != null && free < size + 1.5 * 2 ** 30) throw new Error(`not enough disk: ${Math.round(size / 2 ** 20)} MB needed plus 1.5 GB kept free for macOS, ${Math.round(free / 2 ** 20)} MB free`);
  const r = await fetchImpl(url, { redirect: 'follow' });
  if (!r.ok || !r.body) throw new Error(`download failed (${r.status}) ${url}`);
  const part = `${dest}.part`;
  const out = fs.createWriteStream(part);
  const hash = crypto.createHash('sha256');
  let got = 0, last = 0;
  for await (const chunk of r.body) {
    hash.update(chunk); got += chunk.length;
    if (!out.write(chunk)) await new Promise((res) => out.once('drain', res));
    if (got - last > 16 * 2 ** 20) { last = got; onProgress(got, size); }
  }
  await new Promise((res, rej) => out.end((e) => (e ? rej(e) : res())));
  const digest = hash.digest('hex');
  if (digest !== sha256) { fs.rmSync(part, { force: true }); throw new Error(`the download did not match its checksum (${digest.slice(0, 12)}… instead of ${sha256.slice(0, 12)}…); nothing was kept`); }
  fs.renameSync(part, dest);
  return dest;
}

/** Already-downloaded file that matches: keep it (a checksum pass, no download). */
function verified(file, sha256) {
  if (!fs.existsSync(file)) return false;
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(8 * 2 ** 20);
  try { let n; while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n)); } finally { fs.closeSync(fd); }
  return h.digest('hex') === sha256;
}

/** Download the program and the models asked for (default: what images need). */
export async function install({ models = ['sd-turbo', 'taesd'], env = process.env, onStep = () => {}, fetchImpl } = {}) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Studio on this machine runs on Apple silicon Macs for now');
  fs.mkdirSync(path.join(root(env), 'models'), { recursive: true });
  if (!fs.existsSync(sdBin(env))) {
    onStep('engine', `stable-diffusion.cpp ${ENGINE.tag} (${Math.round(ENGINE.size / 2 ** 20)} MB)`);
    fs.mkdirSync(binDir(env), { recursive: true });
    const zip = path.join(binDir(env), 'engine.zip');
    await fetchTo(ENGINE.url, zip, { sha256: ENGINE.sha256, size: ENGINE.size, fetchImpl });
    const u = spawnSync('unzip', ['-oq', zip, '-d', binDir(env)], { encoding: 'utf8' });
    fs.rmSync(zip, { force: true });
    if (u.status !== 0 || !fs.existsSync(sdBin(env))) throw new Error(`could not unpack the engine: ${u.stderr}`);
    // Downloaded with fetch, so no quarantine flag; keep it that way only for these files.
    fs.chmodSync(sdBin(env), 0o755);
  }
  for (const id of models) {
    const m = MODELS[id];
    if (!m) throw new Error(`models: ${Object.keys(MODELS).join(', ')}`);
    const dest = modelPath(id, env);
    if (fs.existsSync(dest)) continue;
    // A finished download left by a run that stopped before renaming it.
    if (fs.existsSync(`${dest}.part`) && fs.statSync(`${dest}.part`).size === m.size && verified(`${dest}.part`, m.sha256)) { fs.renameSync(`${dest}.part`, dest); continue; }
    onStep('model', `${m.name} (${Math.round(m.size / 2 ** 20)} MB)`);
    await fetchTo(m.url, dest, { sha256: m.sha256, size: m.size, fetchImpl, onProgress: (g, t) => onStep('progress', `${Math.round((g / t) * 100)}%`) });
  }
  return status(env);
}

// ------------------------------------------------------------------ running

function runSd(args, { env = process.env, timeoutMs = 10 * 60_000, onLine = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(sdBin(env), args, { cwd: binDir(env), env: { ...process.env, DYLD_LIBRARY_PATH: binDir(env) } });
    let err = '';
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('the generator took too long and was stopped')); }, timeoutMs);
    const read = (d) => { const s = String(d); err = (err + s).slice(-4000); for (const l of s.split(/\r|\n/)) if (l.trim()) onLine(l.trim()); };
    p.stdout.on('data', read); p.stderr.on('data', read);
    p.on('error', (e) => { clearTimeout(t); reject(e); });
    p.on('close', (code) => { clearTimeout(t); code === 0 ? resolve() : reject(new Error(`the generator stopped (exit ${code}): ${err.split('\n').filter((l) => /error|fail|unable|cannot/i.test(l)).slice(-2).join(' ') || err.slice(-300)}`)); });
  });
}

/** Sizes near the model's native 512 px, multiples of 64. */
export function sizeFor(aspect = '1:1', native = 512) {
  const [w, h] = String(aspect).split(':').map(Number);
  if (!w || !h) return { width: native, height: native };
  const area = native * native;
  const width = Math.round(Math.sqrt((area * w) / h) / 64) * 64;
  return { width, height: Math.round(area / width / 64) * 64 };
}

// The model and, for fast runs, the tiny decoder (when it is there).
const base = (env, fast) => ['-m', modelPath('sd-turbo', env), ...(fast && fs.existsSync(modelPath('taesd', env)) ? ['--taesd', modelPath('taesd', env)] : []), '--cfg-scale', '1.0', '--sampling-method', 'euler_a'];

const need = (env, what) => { const s = status(env); if (!s.can[what]) throw new Error(`this Mac is not set up for ${what} yet: run ox studio local install (or press Set up in Studio)`); return s; };

/** Text → images. → [files] */
export async function textToImage({ prompt, aspect = '1:1', n = 1, seed = null, steps = null, fast = false, outDir, env = process.env, onLine } = {}) {
  need(env, 'image');
  if (!String(prompt ?? '').trim()) throw new Error('a prompt is needed');
  const { width, height } = sizeFor(aspect, MODELS['sd-turbo'].native);
  fs.mkdirSync(outDir, { recursive: true });
  const s0 = seed ?? Math.floor(Math.random() * 2 ** 31);
  const files = [];
  for (let i = 0; i < Math.max(1, Math.min(4, n)); i++) {
    const out = path.join(outDir, `${i + 1}.png`);
    await runSd([...base(env, fast), '-p', String(prompt), '-o', out, '-W', String(width), '-H', String(height), '--steps', String(steps ?? (fast ? 2 : 4)), '-s', String(s0 + i)], { env, onLine });
    files.push(out);
  }
  return { files, seed: s0, width, height };
}

/** Image + instruction → a changed image that keeps the layout. strength: how much may change (0.2-0.8). */
export async function imageToImage({ image, prompt, strength = 0.5, seed = null, steps = 4, aspect = null, fast = false, outDir, out = null, env = process.env, onLine } = {}) {
  need(env, 'edit');
  if (!fs.existsSync(image)) throw new Error('the image is a file on this Mac');
  const dims = probeSize(image);
  const { width, height } = aspect ? sizeFor(aspect) : fit(dims);
  const file = out ?? path.join(outDir, '1.png');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Turbo models need enough steps that steps × strength is at least one.
  const st = Math.max(steps, Math.ceil(1 / Math.max(0.1, strength)));
  await runSd([...base(env, fast), '-p', String(prompt), '-i', image, '--strength', String(strength), '-o', file, '-W', String(width), '-H', String(height), '--steps', String(st), '-s', String(seed ?? Math.floor(Math.random() * 2 ** 31))], { env, onLine });
  return { files: [file] };
}

function probeSize(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  const [w, h] = (r.stdout ?? '').trim().split(',').map(Number);
  return { w: w || 512, h: h || 512 };
}
const fit = ({ w, h }) => sizeFor(`${w}:${h}`);

/**
 * 2x larger. detail: resized, then the model redraws fine detail at low
 * strength (a hires fix; minutes on an M3). quick: a sharp resize, instant.
 * (Real-ESRGAN was tried: slower than both on this Metal build.)
 */
export async function upscale({ image, prompt = '', mode = 'detail', outDir, env = process.env, onLine } = {}) {
  const st = need(env, 'upscale');
  const out = path.join(outDir, '1.png');
  fs.mkdirSync(outDir, { recursive: true });
  const { w, h } = probeSize(image);
  const W = Math.min(2048, w * 2), H = Math.round((h * W) / w);
  const big = mode === 'detail' && st.can.edit ? path.join(outDir, 'resized.png') : out;
  const r = spawnSync('ffmpeg', ['-y', '-v', 'error', '-i', image, '-vf', `scale=${W}:${H}:flags=lanczos,unsharp=5:5:0.6`, big], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`could not resize: ${(r.stderr ?? '').slice(-200)}`);
  if (big === out) return { files: [out], mode: 'quick' };
  const w64 = Math.round(W / 64) * 64, h64 = Math.round(H / 64) * 64;
  await runSd([...base(env, true), '-p', String(prompt || 'sharp detail, high resolution, crisp textures'), '-i', big, '--strength', '0.3', '--steps', '4', '-W', String(w64), '-H', String(h64), '--vae-tiling', '-s', '7', '-o', out], { env, onLine, timeoutMs: 15 * 60_000 });
  fs.rmSync(big, { force: true });
  // This sd-cli build gives img2img back at the model's native 512 whatever -W
  // says: an "upscale" that came back the same size is taken to the size asked.
  const got = probeSize(out);
  if (got.w < W || got.h < H) {
    const tmp = path.join(outDir, 'detail.png');
    fs.renameSync(out, tmp);
    const s = spawnSync('ffmpeg', ['-y', '-v', 'error', '-i', tmp, '-vf', `scale=${W}:${H}:flags=lanczos,unsharp=3:3:0.4`, out], { encoding: 'utf8' });
    fs.rmSync(tmp, { force: true });
    if (s.status !== 0) throw new Error(`could not finish the upscale: ${(s.stderr ?? '').slice(-200)}`);
  }
  return { files: [out], mode: 'detail' };
}

// Apple Vision's foreground mask (macOS 14+): compiled once, then a native call.
const CUTOUT_SWIFT = String.raw`import Foundation
import Vision
import CoreImage
import ImageIO
import UniformTypeIdentifiers
let a = CommandLine.arguments
guard a.count == 3, let src = CIImage(contentsOf: URL(fileURLWithPath: a[1])) else { FileHandle.standardError.write("usage: cutout in out.png\n".data(using: .utf8)!); exit(2) }
let req = VNGenerateForegroundInstanceMaskRequest()
let h = VNImageRequestHandler(ciImage: src)
do { try h.perform([req]) } catch { FileHandle.standardError.write("vision failed: \(error)\n".data(using: .utf8)!); exit(3) }
guard let r = req.results?.first else { FileHandle.standardError.write("no subject found\n".data(using: .utf8)!); exit(4) }
let buf = try r.generateMaskedImage(ofInstances: r.allInstances, from: h, croppedToInstancesExtent: false)
let out = CIImage(cvPixelBuffer: buf)
let ctx = CIContext()
guard let cg = ctx.createCGImage(out, from: out.extent), let dst = CGImageDestinationCreateWithURL(URL(fileURLWithPath: a[2]) as CFURL, UTType.png.identifier as CFString, 1, nil) else { exit(5) }
CGImageDestinationAddImage(dst, cg, nil)
exit(CGImageDestinationFinalize(dst) ? 0 : 6)
`;

function cutoutBin(env) {
  const bin = path.join(root(env), 'cutout-v1');
  if (fs.existsSync(bin)) return bin;
  const src = path.join(root(env), 'cutout-v1.swift');
  fs.mkdirSync(root(env), { recursive: true });
  fs.writeFileSync(src, CUTOUT_SWIFT);
  const r = spawnSync('swiftc', ['-O', '-o', bin, src], { encoding: 'utf8', timeout: 180_000 });
  if (r.status !== 0) throw new Error(`could not build the cut-out tool (needs Xcode command line tools): ${(r.stderr ?? '').slice(-200)}`);
  return bin;
}

/** The subject on a clear background, by macOS's own Vision. */
export async function cutout({ image, outDir, env = process.env } = {}) {
  need(env, 'cutout');
  const out = path.join(outDir, '1.png');
  fs.mkdirSync(outDir, { recursive: true });
  const r = spawnSync(cutoutBin(env), [image, out], { encoding: 'utf8', timeout: 120_000 });
  if (r.status !== 0) throw new Error((r.stderr || 'the cut-out failed').trim());
  return { files: [out] };
}

// ------------------------------------------------------------------ video

/** Camera moves as a crop path over the frame: [zoom, x, y] at the start and the end (x, y: 0-1 centre). */
export const MOVES = Object.freeze({
  'dolly-in': [[1, 0.5, 0.5], [1.35, 0.5, 0.5]],
  'push-in': [[1, 0.5, 0.5], [1.2, 0.5, 0.45]],
  'dolly-out': [[1.35, 0.5, 0.5], [1, 0.5, 0.5]],
  'crash-zoom': [[1, 0.5, 0.5], [1.7, 0.5, 0.5]],
  orbit: [[1.25, 0.3, 0.5], [1.25, 0.7, 0.5]],
  'whip-pan': [[1.3, 0.25, 0.5], [1.3, 0.75, 0.5]],
  'crane-up': [[1.25, 0.5, 0.72], [1.25, 0.5, 0.28]],
  fpv: [[1.1, 0.45, 0.6], [1.6, 0.55, 0.45]],
  handheld: [[1.12, 0.48, 0.5], [1.15, 0.52, 0.48]],
  'bullet-time': [[1.3, 0.35, 0.5], [1.3, 0.65, 0.5]],
  static: [[1.05, 0.5, 0.5], [1.05, 0.5, 0.5]],
});

const lerp = (a, b, t) => a + (b - a) * t;
const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

/**
 * A "living picture" clip, all on this Mac: the first frame from the prompt (or
 * your image), then keyframes along the camera move, each re-imagined lightly
 * from the crop before it (so leaves move, light shifts, faces breathe), and
 * smooth frames in between. → { files: [mp4], frames: [keyframe pngs] }
 */
export async function livingPicture({ prompt, image = null, aspect = '16:9', camera = 'push-in', seconds = 5, keyframes = 5, motion = 0.32, seed = null, outDir, env = process.env, onStep = () => {}, onLine } = {}) {
  need(env, 'video');
  const move = MOVES[camera] ?? MOVES['push-in'];
  const { width, height } = image ? fit(probeSize(image)) : sizeFor(aspect);
  fs.mkdirSync(outDir, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-living-'));
  const s0 = seed ?? Math.floor(Math.random() * 2 ** 31);
  let first = path.join(work, 'k0.png');
  if (image) {
    onStep('first frame', 'from your image');
    spawnSync('ffmpeg', ['-y', '-v', 'error', '-i', image, '-vf', `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`, first]);
  } else {
    onStep('first frame', prompt);
    await runSd([...base(env, false), '-p', String(prompt), '-o', first, '-W', String(width), '-H', String(height), '--steps', '4', '-s', String(s0)], { env, onLine });
  }
  // Each keyframe: the crop the camera sees at that moment, scaled back up, lightly re-imagined.
  const frames = [first];
  for (let k = 1; k < keyframes; k++) {
    const t = ease(k / (keyframes - 1));
    const [z, cx, cy] = [0, 1, 2].map((i) => lerp(move[0][i], move[1][i], t));
    const cw = Math.round(width / z), ch = Math.round(height / z);
    const x = Math.round(Math.min(width - cw, Math.max(0, cx * width - cw / 2)));
    const y = Math.round(Math.min(height - ch, Math.max(0, cy * height - ch / 2)));
    const crop = path.join(work, `c${k}.png`);
    spawnSync('ffmpeg', ['-y', '-v', 'error', '-i', first, '-vf', `crop=${cw}:${ch}:${x}:${y},scale=${width}:${height}:flags=lanczos`, crop]);
    const out = path.join(work, `k${k}.png`);
    onStep('keyframe', `${k + 1}/${keyframes}`);
    await runSd([...base(env, true), '-p', String(prompt || 'the same scene, natural motion, photographic detail'), '-i', crop, '--strength', String(motion), '-o', out, '-W', String(width), '-H', String(height), '--steps', String(Math.ceil(1 / motion) + 1), '-s', String(s0 + k)], { env, onLine });
    frames.push(out);
  }
  // Join: each keyframe dissolves into the next, then frames are made in between (motion-compensated).
  onStep('motion', `${seconds}s at 24 fps`);
  const hold = seconds / (frames.length - 1);
  const fade = Math.min(hold * 0.9, hold - 0.05);
  const inputs = frames.flatMap((f) => ['-loop', '1', '-t', String(hold + fade), '-i', f]);
  let chain = `[0:v]format=yuv420p,setsar=1[v0]`;
  for (let i = 1; i < frames.length; i++) chain += `;[${i}:v]format=yuv420p,setsar=1[s${i}];[v${i - 1}][s${i}]xfade=transition=fade:duration=${fade.toFixed(2)}:offset=${(hold * i - fade).toFixed(2)}[v${i}]`;
  const outW = width * 2, outH = height * 2;
  chain += `;[v${frames.length - 1}]scale=${outW}:${outH}:flags=lanczos,minterpolate=fps=24:mi_mode=blend,trim=duration=${seconds}[out]`;
  const file = path.join(outDir, '1.mp4');
  const r = spawnSync('ffmpeg', ['-y', '-v', 'error', ...inputs, '-filter_complex', chain, '-map', '[out]', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', file], { encoding: 'utf8', timeout: 10 * 60_000 });
  if (r.status !== 0) throw new Error(`could not make the clip: ${(r.stderr ?? '').slice(-300)}`);
  const kept = frames.map((f, i) => { const d = path.join(outDir, `key${i + 1}.png`); fs.copyFileSync(f, d); return d; });
  fs.rmSync(work, { recursive: true, force: true });
  return { files: [file], frames: kept, seed: s0, width: outW, height: outH };
}
