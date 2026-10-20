// Edit a video from chat ("Claude can edit your videos", Recordly, Elorian
// Glimpse), with ffmpeg and whisper.cpp on this machine; nothing is uploaded.
//
//   transcribe   speech → timed text (whisper-cli), kept as .srt next to it
//   captions     the transcript burned in (drawn as images, so any ffmpeg
//                works) or as a soft subtitle track
//   cut          keep start…end
//   speed        faster or slower, audio pitch kept
//   vertical     9:16 (or 1:1) crop from the centre, for shorts
//   highlights   the parts where what you asked about is said, joined
//   gif          a small looping GIF
//   join         clips one after another (sized to the first), for shots made apart
//   polish       a demo that holds attention: still parts sped up, on a
//                padded background (the Recordly idea, in ox's own code)
//   understand   frames at scene changes plus the transcript, for the model
//
// Every result is a new file beside the source; the source is never changed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const run = (cmd, args, { timeout = 30 * 60_000, input } = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024, input });
  if (r.error?.code === 'ENOENT') throw new Error(cmd === 'ffmpeg' || cmd === 'ffprobe' ? 'video editing needs ffmpeg: brew install ffmpeg' : `${cmd} is not installed`);
  return { ok: r.status === 0, out: r.stdout ?? '', err: r.stderr ?? '' };
};
const ff = (args, opts) => {
  const r = run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], opts);
  if (!r.ok) throw new Error(`ffmpeg: ${r.err.trim().split('\n').slice(-2).join(' ')}`);
  return r;
};

export function probe(file) {
  const r = run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height,r_frame_rate', '-of', 'json', file]);
  if (!r.ok) throw new Error(`${path.basename(file)} is not a readable video`);
  const j = JSON.parse(r.out);
  const v = (j.streams ?? []).find((s) => s.codec_type === 'video');
  const [a, b] = String(v?.r_frame_rate ?? '30/1').split('/').map(Number);
  return { duration: Number(j.format?.duration ?? 0), width: v?.width ?? 0, height: v?.height ?? 0, fps: b ? a / b : 30, audio: (j.streams ?? []).some((s) => s.codec_type === 'audio'), video: !!v };
}

export function outPath(file, tag, ext = null) {
  const p = path.parse(path.resolve(file));
  let out = path.join(p.dir, `${p.name}.${tag}${ext ?? p.ext}`);
  for (let i = 2; fs.existsSync(out); i++) out = path.join(p.dir, `${p.name}.${tag}-${i}${ext ?? p.ext}`);
  return out;
}

const ts = (s) => { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${sec.toFixed(3).padStart(6, '0').replace('.', ',')}`; };
/** "1:23", "83", "00:01:23.5" → seconds. */
export function seconds(v) {
  if (typeof v === 'number') return v;
  const parts = String(v ?? '').trim().split(':').map(Number);
  if (!parts.length || parts.some((x) => !Number.isFinite(x))) throw new Error(`not a time: ${v} (use 83, 1:23 or 00:01:23)`);
  return parts.reduce((a, x) => a * 60 + x, 0);
}

// ---------------------------------------------------------------- speech

/** A whisper.cpp model on this machine: OX_WHISPER_MODEL, ~/.ox/models/whisper, or found by Spotlight. */
export function whisperModel(env = process.env) {
  if (env.OX_WHISPER_MODEL && fs.existsSync(env.OX_WHISPER_MODEL)) return env.OX_WHISPER_MODEL;
  const dirs = [path.join(env.OX_HOME || path.join(os.homedir(), '.ox'), 'models', 'whisper'), '/opt/homebrew/share/whisper-cpp', '/usr/local/share/whisper-cpp', path.join(os.homedir(), '.cache', 'whisper.cpp')];
  const pick = (files) => ['small.en', 'base.en', 'small', 'base', 'tiny.en', 'tiny', 'medium', 'large'].map((n) => files.find((f) => path.basename(f) === `ggml-${n}.bin`)).find(Boolean) ?? files[0];
  for (const d of dirs) {
    try { const f = fs.readdirSync(d).filter((x) => /^ggml-.*\.bin$/.test(x)).map((x) => path.join(d, x)); if (f.length) return pick(f); } catch {}
  }
  if (process.platform === 'darwin') {
    const r = spawnSync('mdfind', ['-name', 'ggml-'], { encoding: 'utf8', timeout: 5000 });
    const f = (r.stdout ?? '').split('\n').filter((x) => /\/ggml-[\w.]+\.bin$/.test(x) && !/for-tests/.test(x));
    if (f.length) return pick(f);
  }
  return null;
}

// The dictionary module, loaded once at import (src/dictionary.js has no heavy deps).
let dictMod = null;
try { dictMod = await import('./dictionary.js'); } catch {}
const await_dictionary = () => dictMod?.loadDictionary() ?? null;

export function parseSrt(text) {
  const out = [];
  for (const block of String(text).replace(/\r/g, '').split(/\n\s*\n/)) {
    const m = /(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)\s*\n([\s\S]*)/.exec(block);
    if (!m) continue;
    const t = (h, mi, s, ms) => Number(h) * 3600 + Number(mi) * 60 + Number(s) + Number(ms) / 1000;
    const words = m[9].trim().replace(/\s+/g, ' ');
    if (words && !/^\[.*\]$/.test(words)) out.push({ start: t(m[1], m[2], m[3], m[4]), end: t(m[5], m[6], m[7], m[8]), text: words });
  }
  return out;
}

export const toSrt = (segs) => segs.map((s, i) => `${i + 1}\n${ts(s.start)} --> ${ts(s.end)}\n${s.text}\n`).join('\n');

/** Speech → [{ start, end, text }]; the .srt is kept beside the video and reused. */
// Parakeet (NVIDIA's open speech model, 25 languages, Coucou's offline engine)
// through parakeet-mlx (Apache-2.0) on Apple silicon: `pipx install parakeet-mlx`.
// Used first when installed and no language is forced (OX_STT=whisper skips it).
export function parakeetBin(env = process.env) {
  if (env.OX_STT === 'whisper') return null;
  return ['parakeet-mlx'].find((b) => spawnSync('which', [b]).status === 0) ?? null;
}

function parakeet(bin, file, srtPath) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-parakeet-'));
  const wav = path.join(tmp, 'a.wav');
  ff(['-i', file, '-vn', '-ac', '1', '-ar', '16000', wav]);
  const r = run(bin, [wav, '--output-format', 'srt', '--output-dir', tmp]);
  const out = path.join(tmp, 'a.srt');
  if (!r.ok || !fs.existsSync(out)) { fs.rmSync(tmp, { recursive: true, force: true }); return null; }
  const srt = fs.readFileSync(out, 'utf8');
  fs.writeFileSync(srtPath, srt);
  fs.rmSync(tmp, { recursive: true, force: true });
  return { segments: parseSrt(srt), srt: srtPath, model: 'parakeet' };
}

export function transcribe(file, { model = whisperModel(), language = null } = {}) {
  const p = probe(file);
  if (!p.audio) return { segments: [], srt: null, note: 'the file has no sound' };
  const srtPath = outPath(file, 'transcript', '.srt').replace(/\.transcript-\d+\.srt$/, '.transcript.srt');
  if (fs.existsSync(srtPath) && fs.statSync(srtPath).mtimeMs > fs.statSync(file).mtimeMs) return { segments: parseSrt(fs.readFileSync(srtPath, 'utf8')), srt: srtPath, cached: true };
  const pk = !language && parakeetBin();
  if (pk) { const r = parakeet(pk, file, srtPath); if (r) return r; }
  if (!model) throw new Error('speech-to-text needs a whisper.cpp model (ggml-*.bin): put one in ~/.ox/models/whisper, or set OX_WHISPER_MODEL');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-whisper-'));
  const wav = path.join(tmp, 'a.wav');
  ff(['-i', file, '-vn', '-ac', '1', '-ar', '16000', wav]);
  const bin = ['whisper-cli', 'whisper-cpp', 'main'].find((b) => spawnSync('which', [b]).status === 0);
  if (!bin) throw new Error('speech-to-text needs whisper.cpp: brew install whisper-cpp');
  // Your words as a hint (ox, names, product words), and your dictionary's fixes after.
  let dict = { replace: {} };
  try { dict = (await_dictionary()) ?? dict; } catch {}
  const hint = ['ox', 'OX Island', ...Object.values(dict.replace ?? {})].filter((w) => typeof w === 'string' && w.length < 40).slice(0, 40).join(', ');
  const r = run(bin, ['-m', model, '-f', wav, '-osrt', '-of', path.join(tmp, 'out'), '--prompt', hint, ...(language ? ['-l', language] : []), '-np']);
  if (!r.ok) throw new Error(`whisper: ${r.err.trim().split('\n').pop()}`);
  let srt = fs.readFileSync(path.join(tmp, 'out.srt'), 'utf8');
  try { if (dictMod) srt = srt.split('\n').map((l) => (/-->|^\d+$|^$/.test(l) ? l : dictMod.applyDictionary(l, dict))).join('\n'); } catch {}
  fs.writeFileSync(srtPath, srt);
  fs.rmSync(tmp, { recursive: true, force: true });
  return { segments: parseSrt(srt), srt: srtPath, model: path.basename(model) };
}

// ---------------------------------------------------------------- edits

export function cut(file, start, end) {
  const out = outPath(file, 'cut');
  const a = seconds(start), b = end == null ? null : seconds(end);
  if (b != null && b <= a) throw new Error('the end must be after the start');
  ff(['-ss', String(a), ...(b != null ? ['-to', String(b)] : []), '-i', file, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', out]);
  return { file: out };
}

// atempo takes 0.5…2 per stage: chain stages for bigger changes.
const atempo = (f) => { const st = []; let x = f; while (x > 2) { st.push(2); x /= 2; } while (x < 0.5) { st.push(0.5); x /= 0.5; } st.push(x); return st.map((v) => `atempo=${v.toFixed(4)}`).join(','); };

export function speed(file, factor) {
  const f = Number(factor);
  if (!(f > 0.1 && f <= 16)) throw new Error('speed is a factor between 0.1 and 16 (2 = twice as fast)');
  const p = probe(file);
  const out = outPath(file, `x${f}`);
  ff(['-i', file, '-filter:v', `setpts=PTS/${f}`, ...(p.audio ? ['-filter:a', atempo(f)] : ['-an']), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', out]);
  return { file: out };
}

export function vertical(file, aspect = '9:16') {
  const [aw, ah] = String(aspect).split(':').map(Number);
  if (!aw || !ah) throw new Error('aspect looks like 9:16 or 1:1');
  const out = outPath(file, aspect.replace(':', 'x'));
  ff(['-i', file, '-vf', `crop='min(iw,ih*${aw}/${ah})':'min(ih,iw*${ah}/${aw})',scale=trunc(iw/2)*2:trunc(ih/2)*2`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'copy', out]);
  return { file: out };
}

export function gif(file, { width = 480, fps = 12, start = null, end = null } = {}) {
  const out = outPath(file, 'loop', '.gif');
  ff([...(start != null ? ['-ss', String(seconds(start))] : []), ...(end != null ? ['-to', String(seconds(end))] : []), '-i', file, '-vf', `fps=${fps},scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer`, out]);
  return { file: out };
}

/** Clips one after another, each scaled and padded to the first's frame. Sound kept only when every clip has it. */
export function join(files) {
  const list = [].concat(files ?? []).map(String);
  if (list.length < 2) throw new Error('join needs two or more clips');
  const ps = list.map(probe);
  const { width: w, height: h } = ps[0];
  const sound = ps.every((p) => p.audio);
  const parts = list.map((_, i) => `[${i}:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30[v${i}]`);
  const ins = list.map((_, i) => `[v${i}]${sound ? `[${i}:a]` : ''}`).join('');
  const out = outPath(list[0], 'joined', '.mp4');
  ff([...list.flatMap((f) => ['-i', f]), '-filter_complex', `${parts.join(';')};${ins}concat=n=${list.length}:v=1:a=${sound ? 1 : 0}[v]${sound ? '[a]' : ''}`, '-map', '[v]', ...(sound ? ['-map', '[a]', '-c:a', 'aac'] : []), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', out]);
  return { file: out };
}

/** Captions from the transcript: burned in as drawn images (any ffmpeg), or a soft track. */
export function captions(file, { burn = true } = {}) {
  const tr = transcribe(file);
  if (!tr.segments.length) throw new Error('no speech found to caption');
  const p = probe(file);
  if (!burn || !hasPython()) {
    const out = outPath(file, 'captioned', '.mp4');
    ff(['-i', file, '-i', tr.srt, '-c:v', 'copy', '-c:a', 'copy', '-c:s', 'mov_text', '-metadata:s:s:0', 'language=eng', out]);
    return { file: out, srt: tr.srt, burned: false, lines: tr.segments.length };
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-caps-'));
  const fontPx = Math.max(18, Math.round(p.height * 0.045));
  const script = `
import json, sys
from PIL import Image, ImageDraw, ImageFont
segs = json.load(open(sys.argv[1])); W = int(sys.argv[2]); px = int(sys.argv[3]); out = sys.argv[4]
font = None
for f in ["/System/Library/Fonts/SFNS.ttf", "/System/Library/Fonts/Helvetica.ttc", "/Library/Fonts/Arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"]:
    try: font = ImageFont.truetype(f, px); break
    except Exception: pass
font = font or ImageFont.load_default()
for i, s in enumerate(segs):
    words, lines, cur = s["text"].split(), [], ""
    for w in words:
        t = (cur + " " + w).strip()
        if font.getlength(t) > W * 0.86 and cur: lines.append(cur); cur = w
        else: cur = t
    lines.append(cur)
    lh = int(px * 1.25); h = lh * len(lines) + px // 2
    img = Image.new("RGBA", (W, h), (0, 0, 0, 0)); d = ImageDraw.Draw(img)
    for j, l in enumerate(lines):
        tw = font.getlength(l); x = (W - tw) / 2; y = px // 4 + j * lh
        d.rounded_rectangle([x - px * 0.35, y - px * 0.1, x + tw + px * 0.35, y + lh - px * 0.05], radius=px // 3, fill=(0, 0, 0, 150))
        d.text((x, y), l, font=font, fill=(255, 255, 255, 255), stroke_width=max(1, px // 14), stroke_fill=(0, 0, 0, 255))
    img.save(f"{out}/c{i:04d}.png")
`;
  fs.writeFileSync(path.join(tmp, 'segs.json'), JSON.stringify(tr.segments));
  const r = run('python3', ['-c', script, path.join(tmp, 'segs.json'), String(p.width), String(fontPx), tmp]);
  if (!r.ok) { fs.rmSync(tmp, { recursive: true, force: true }); return captions(file, { burn: false }); }
  // One overlay per line, each shown only while it is spoken.
  const inputs = tr.segments.flatMap((_, i) => ['-i', path.join(tmp, `c${String(i).padStart(4, '0')}.png`)]);
  let chain = '[0:v]';
  const parts = tr.segments.map((s, i) => {
    const o = i === tr.segments.length - 1 ? '[v]' : `[v${i}]`;
    const f = `${chain}[${i + 1}:v]overlay=(W-w)/2:H-h-H*0.06:enable='between(t,${s.start.toFixed(2)},${s.end.toFixed(2)})'${o}`;
    chain = o;
    return f;
  });
  const out = outPath(file, 'captioned', '.mp4');
  fs.writeFileSync(path.join(tmp, 'graph.txt'), parts.join(';'));
  ff(['-i', file, ...inputs, '-filter_complex_script', path.join(tmp, 'graph.txt'), '-map', '[v]', ...(p.audio ? ['-map', '0:a', '-c:a', 'copy'] : []), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', out]);
  fs.rmSync(tmp, { recursive: true, force: true });
  return { file: out, srt: tr.srt, burned: true, lines: tr.segments.length };
}
const hasPython = () => spawnSync('python3', ['-c', 'import PIL'], { timeout: 10_000 }).status === 0;

/** Where what you asked about is said: the matching lines, padded and joined into one clip. */
export function highlights(file, query, { pad = 0.6, maxSeconds = 60 } = {}) {
  const tr = transcribe(file);
  const terms = [...new Set(String(query).toLowerCase().match(/[a-z0-9']{3,}/g) ?? [])].filter((w) => !['the', 'and', 'about', 'where', 'what', 'part', 'parts', 'talks', 'says', 'said'].includes(w));
  if (!terms.length) throw new Error('say what to look for (words that are spoken in the video)');
  const hits = tr.segments.map((s) => ({ ...s, score: terms.filter((t) => s.text.toLowerCase().includes(t)).length })).filter((s) => s.score > 0);
  if (!hits.length) return { file: null, found: 0, note: `nothing in the speech matches: ${terms.join(', ')}` };
  // Merge neighbours; best first until the length budget, then back in time order.
  const spans = [];
  for (const h of hits.sort((a, b) => a.start - b.start)) {
    const s = Math.max(0, h.start - pad), e = h.end + pad, last = spans[spans.length - 1];
    if (last && s <= last.end + 0.5) { last.end = Math.max(last.end, e); last.score += h.score; last.text += ` ${h.text}`; }
    else spans.push({ start: s, end: e, score: h.score, text: h.text });
  }
  let total = 0;
  const kept = [...spans].sort((a, b) => b.score - a.score).filter((s) => (total += s.end - s.start) <= maxSeconds || total === s.end - s.start).sort((a, b) => a.start - b.start);
  const p = probe(file);
  const v = kept.map((s, i) => `[0:v]trim=${s.start.toFixed(2)}:${s.end.toFixed(2)},setpts=PTS-STARTPTS[v${i}]`);
  const a = p.audio ? kept.map((s, i) => `[0:a]atrim=${s.start.toFixed(2)}:${s.end.toFixed(2)},asetpts=PTS-STARTPTS[a${i}]`) : [];
  const joined = kept.map((_, i) => `[v${i}]${p.audio ? `[a${i}]` : ''}`).join('') + `concat=n=${kept.length}:v=1:a=${p.audio ? 1 : 0}[v]${p.audio ? '[a]' : ''}`;
  const out = outPath(file, 'highlights', '.mp4');
  ff(['-i', file, '-filter_complex', [...v, ...a, joined].join(';'), '-map', '[v]', ...(p.audio ? ['-map', '[a]'] : []), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', out]);
  return { file: out, found: kept.length, parts: kept.map((s) => ({ start: Math.round(s.start * 10) / 10, end: Math.round(s.end * 10) / 10, text: s.text.slice(0, 120) })) };
}

/**
 * A screen recording made watchable: parts where nothing changes for over a
 * second are sped up (6×), and the result sits on a padded dark background.
 */
export function polish(file, { idleSpeed = 6, minIdle = 1.0, pad = 0.06, background = '0x111318' } = {}) {
  const p = probe(file);
  const r = run('ffmpeg', ['-hide_banner', '-i', file, '-vf', `freezedetect=n=0.003:d=${minIdle}`, '-map', '0:v', '-f', 'null', '-']);
  const starts = [...r.err.matchAll(/freeze_start: ([\d.]+)/g)].map((m) => Number(m[1]));
  const ends = [...r.err.matchAll(/freeze_end: ([\d.]+)/g)].map((m) => Number(m[1]));
  const still = starts.map((s, i) => ({ start: s, end: ends[i] ?? p.duration })).filter((x) => x.end - x.start >= minIdle);
  // Segments: moving parts at 1×, still parts at idleSpeed×.
  const segs = [];
  let at = 0;
  for (const s of still) { if (s.start > at + 0.05) segs.push({ start: at, end: s.start, f: 1 }); segs.push({ start: s.start, end: s.end, f: idleSpeed }); at = s.end; }
  if (at < p.duration - 0.05) segs.push({ start: at, end: p.duration, f: 1 });
  const W = Math.round(p.width * (1 + pad * 2) / 2) * 2, H = Math.round(p.height * (1 + pad * 2) / 2) * 2;
  const v = segs.map((s, i) => `[0:v]trim=${s.start.toFixed(3)}:${s.end.toFixed(3)},setpts=(PTS-STARTPTS)/${s.f}[v${i}]`);
  const a = p.audio ? segs.map((s, i) => `[0:a]atrim=${s.start.toFixed(3)}:${s.end.toFixed(3)},asetpts=PTS-STARTPTS${s.f !== 1 ? `,${atempo(s.f)}` : ''}[a${i}]`) : [];
  const cat = segs.map((_, i) => `[v${i}]${p.audio ? `[a${i}]` : ''}`).join('') + `concat=n=${segs.length}:v=1:a=${p.audio ? 1 : 0}[cv]${p.audio ? '[a]' : ''}`;
  const frame = `[cv]pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=${background}[v]`;
  const out = outPath(file, 'polished', '.mp4');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-polish-'));
  fs.writeFileSync(path.join(tmp, 'g.txt'), [...v, ...a, cat, frame].join(';'));
  ff(['-i', file, '-filter_complex_script', path.join(tmp, 'g.txt'), '-map', '[v]', ...(p.audio ? ['-map', '[a]'] : []), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', out]);
  fs.rmSync(tmp, { recursive: true, force: true });
  const saved = still.reduce((x, s) => x + (s.end - s.start) * (1 - 1 / idleSpeed), 0);
  return { file: out, before: Math.round(p.duration * 10) / 10, after: Math.round((p.duration - saved) * 10) / 10, stillParts: still.length };
}

/** What the model needs to understand a video: frames at scene changes and the transcript. */
export function understand(file, { maxFrames = 8, width = 768 } = {}) {
  const p = probe(file);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-frames-'));
  // Scene changes first; evenly spaced frames fill up to maxFrames.
  const sc = run('ffmpeg', ['-hide_banner', '-i', file, '-vf', 'scdet=threshold=12', '-an', '-f', 'null', '-']);
  let times = [...sc.err.matchAll(/lavfi\.scd\.time: ([\d.]+)/g)].map((m) => Number(m[1]));
  if (times.length > maxFrames) times = times.filter((_, i) => i % Math.ceil(times.length / maxFrames) === 0);
  for (let i = 0; times.length < maxFrames && i < maxFrames; i++) times.push((p.duration * (i + 0.5)) / maxFrames);
  times = [...new Set(times.map((t) => Math.round(t * 10) / 10))].sort((a, b) => a - b).slice(0, maxFrames);
  const frames = times.map((t, i) => { const f = path.join(dir, `f${i}.jpg`); ff(['-ss', String(t), '-i', file, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '4', f]); return { at: t, file: f }; });
  let transcript = [];
  try { transcript = transcribe(file).segments; } catch {}
  return { duration: p.duration, size: `${p.width}x${p.height}`, frames, transcript, text: transcript.map((s) => `[${Math.floor(s.start / 60)}:${String(Math.floor(s.start % 60)).padStart(2, '0')}] ${s.text}`).join('\n') };
}

// ---------------------------------------------------------------- explainer videos (ManimGX's idea, ox's way)

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** One slide: the title, the step's words, and every step as a flow with this one lit. */
function slideHtml(title, steps, i) {
  const s = steps[i];
  const boxes = steps.map((x, j) => `<div class="b ${j === i ? 'on' : j < i ? 'done' : ''}">${esc(x.label)}</div>`).join('<div class="ar">→</div>');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;width:1280px;height:720px;background:radial-gradient(1200px 700px at 30% 10%,#1d2333,#0f1117);color:#f4f4f6;font-family:-apple-system,"SF Pro Display","Segoe UI",Helvetica,Arial,sans-serif}
    .t{position:absolute;left:80px;top:60px;font-size:30px;color:#9aa4bf;letter-spacing:.02em}
    .n{position:absolute;left:80px;top:140px;font-size:22px;color:#7dd3fc;font-weight:600}
    .h{position:absolute;left:80px;top:175px;font-size:64px;font-weight:700;max-width:1100px;line-height:1.05}
    .p{position:absolute;left:80px;top:300px;font-size:34px;line-height:1.4;max-width:1080px;color:#d7dbe6}
    .f{position:absolute;left:80px;right:80px;bottom:70px;display:flex;align-items:center;gap:10px;flex-wrap:nowrap}
    .b{flex:1;min-width:0;text-align:center;padding:16px 8px;border-radius:14px;border:2px solid #39415a;color:#9aa4bf;font-size:20px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .b.done{border-color:#2f6b55;color:#9fe3c4}
    .b.on{background:#3b9eff;border-color:#3b9eff;color:#fff;font-weight:700;box-shadow:0 0 40px rgba(59,158,255,.45)}
    .ar{color:#4b5470;font-size:24px}
  </style></head><body><div class="t">${esc(title)}</div><div class="n">${i + 1} / ${steps.length}</div><div class="h">${esc(s.label)}</div><div class="p">${esc(s.text)}</div><div class="f">${boxes}</div></body></html>`;
}

/**
 * Steps ("Label: what happens" or {label, text}) → an MP4 with a slide per
 * step, crossfading, each held long enough to read. → { file, slides, seconds }
 */
export async function explainerVideo(title, steps, { out = null, secondsPerStep = null, chrome = null } = {}) {
  const list = steps.map((x, i) => (x && typeof x === 'object' ? { label: String(x.label ?? `Step ${i + 1}`), text: String(x.text ?? '') } : (() => { const m = /^([^:]{1,40}):\s*(.+)$/.exec(String(x)); return m ? { label: m[1].trim(), text: m[2].trim() } : { label: `Step ${i + 1}`, text: String(x) }; })())).slice(0, 12);
  if (list.length < 2) throw new Error('an explainer needs at least two steps');
  const D = await import('./dev-flow.js');
  if (!chrome && !D.chromePath()) throw new Error('making slides needs a Chrome-type browser');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-explain-'));
  const shots = list.map((_, i) => {
    const html = path.join(dir, `s${i}.html`);
    fs.writeFileSync(html, slideHtml(title, list, i));
    return D.screenshot(`file://${html}`, path.join(dir, `s${i}.png`), { width: 1280, height: 720 });
  });
  // Long enough to read: about 2.6 words a second, at least 3.5 s.
  const hold = list.map((x) => secondsPerStep ?? Math.max(3.5, Math.min(9, (x.label.split(/\s+/).length + x.text.split(/\s+/).length) / 2.6)));
  const fade = 0.6;
  const inputs = shots.flatMap((f, i) => ['-loop', '1', '-t', String(hold[i] + fade), '-i', f]);
  let chain = '[0:v]format=yuv420p[v0]';
  let offset = 0;
  for (let i = 1; i < shots.length; i++) {
    offset += hold[i - 1];
    chain += `;[${i}:v]format=yuv420p[s${i}];[v${i - 1}][s${i}]xfade=transition=fade:duration=${fade}:offset=${offset.toFixed(2)}[v${i}]`;
  }
  const file = out ?? path.join(process.cwd(), `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'explainer'}.mp4`);
  ff([...inputs, '-filter_complex', chain, '-map', `[v${shots.length - 1}]`, '-r', '30', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', file]);
  fs.rmSync(dir, { recursive: true, force: true });
  return { file, slides: shots.length, seconds: Math.round(hold.reduce((a, b) => a + b, 0) + fade) };
}
