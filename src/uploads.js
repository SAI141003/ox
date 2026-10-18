// Files dropped or picked in the app, of any kind: saved under
// ~/.ox/uploads/<date>/, then made readable for a model.
//   video  key frames (ffmpeg) a vision model can look at, plus its length,
//          and the saved path so ox can work on the file itself
//   audio  its length and path
//   pdf    its text (pdftotext), and the path
//   other  the path (ox reads, converts or runs it with its tools)
// Text files under 200 KB never come here: the app puts them in the message.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

export const MAX_UPLOAD = 1024 * 1024 * 1024; // 1 GB
const UPLOAD_DIR = () => path.join(process.env.OX_HOME || path.join(os.homedir(), '.ox'), 'uploads');
const VIDEO = /\.(mp4|m4v|mov|webm|mkv|avi|mpg|mpeg|3gp)$/i;
const AUDIO = /\.(mp3|m4a|wav|aac|flac|ogg|opus|aiff?)$/i;

export function kindOf(name, type = '') {
  if (VIDEO.test(name) || /^video\//.test(type)) return 'video';
  if (AUDIO.test(name) || /^audio\//.test(type)) return 'audio';
  if (/\.pdf$/i.test(name) || type === 'application/pdf') return 'pdf';
  if (/^image\//.test(type)) return 'image';
  return 'file';
}

export function safeName(name) {
  const base = path.basename(String(name || 'file')).replace(/[^\w.\- ()]+/g, '_').replace(/^\.+/, '').slice(0, 120);
  return base || 'file';
}

/** Stream a request body to disk (refusing anything over MAX_UPLOAD). */
export function saveUpload(req, name, { limit = MAX_UPLOAD } = {}) {
  return new Promise((resolve, reject) => {
    const day = new Date().toISOString().slice(0, 10);
    const dir = path.join(UPLOAD_DIR(), day);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `${crypto.randomBytes(4).toString('hex')}-${safeName(name)}`);
    const out = fs.createWriteStream(file, { mode: 0o600 });
    let size = 0, failed = false;
    const fail = (e) => { if (failed) return; failed = true; out.destroy(); fs.rmSync(file, { force: true }); reject(e); };
    req.on('data', (c) => { size += c.length; if (size > limit) { fail(new Error(`over ${Math.round(limit / 1048576)} MB`)); req.destroy(); } });
    req.on('error', fail);
    out.on('error', fail);
    req.pipe(out);
    out.on('finish', () => { if (!failed) resolve({ file, size }); });
  });
}

const has = (bin) => spawnSync('/bin/sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' }).status === 0;

function durationOf(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8', timeout: 20000 });
  const d = Number(String(r.stdout).trim());
  return Number.isFinite(d) && d > 0 ? d : null;
}

/** Up to `count` frames spread over the video, as JPEG (base64) with a small thumbnail. */
export function videoFrames(file, { count = 6, width = 1024, run = spawnSync } = {}) {
  if (!has('ffmpeg')) return { frames: [], note: 'ffmpeg is not installed, so no frames (brew install ffmpeg)' };
  const duration = durationOf(file);
  const times = duration ? Array.from({ length: count }, (_, i) => Math.max(0, (duration * (i + 0.5)) / count)) : [0];
  const frames = [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-frames-'));
  try {
    for (const [i, t] of times.entries()) {
      const big = path.join(tmp, `f${i}.jpg`), small = path.join(tmp, `t${i}.jpg`);
      run('ffmpeg', ['-v', 'error', '-y', '-ss', t.toFixed(2), '-i', file, '-frames:v', '1', '-vf', `scale='min(${width},iw)':-2`, '-q:v', '4', big], { timeout: 30000 });
      run('ffmpeg', ['-v', 'error', '-y', '-i', big, '-vf', 'scale=240:-2', '-q:v', '6', small], { timeout: 15000 });
      if (!fs.existsSync(big)) continue;
      frames.push({ t: Math.round(t * 10) / 10, data: fs.readFileSync(big).toString('base64'), thumb: fs.existsSync(small) ? `data:image/jpeg;base64,${fs.readFileSync(small).toString('base64')}` : null });
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  return { frames, duration };
}

function pdfText(file, { maxChars = 60_000 } = {}) {
  if (!has('pdftotext')) return null;
  const r = spawnSync('pdftotext', ['-l', '40', '-layout', file, '-'], { encoding: 'utf8', timeout: 30000, maxBuffer: 32 * 1024 * 1024 });
  const t = String(r.stdout ?? '').trim();
  return t ? t.slice(0, maxChars) : null;
}

// Speech in a video or recording up to 15 minutes, with whisper.cpp when a model is on this Mac.
let videoEdit = null;
try { videoEdit = await import('./video-edit.js'); } catch {}
function speechOf(file, duration) {
  if (!videoEdit || process.env.NODE_TEST_CONTEXT || !duration || duration > 900 || !videoEdit.whisperModel()) return null;
  try {
    const t = videoEdit.transcribe(file);
    return t.segments.length ? t.segments.map((s) => `[${Math.floor(s.start / 60)}:${String(Math.floor(s.start % 60)).padStart(2, '0')}] ${s.text}`).join('\n').slice(0, 20_000) : null;
  } catch { return null; }
}

/** What the app puts in the message for a saved upload. */
export function describeUpload(file, name, type = '', size = 0) {
  const kind = kindOf(name, type);
  const out = { path: file, name: safeName(name), size, kind };
  if (kind === 'video') {
    const v = videoFrames(file);
    out.duration = v.duration ?? null;
    out.frames = v.frames;
    out.note = `Video ${out.name}${v.duration ? `, ${Math.round(v.duration)} s` : ''}, saved at ${file}. ${v.frames.length ? `The ${v.frames.length} images attached are frames from it, at ${v.frames.map((f) => `${f.t} s`).join(', ')}.` : v.note ?? ''} Use the path to work on the file itself (more frames, the sound, a clip; edit_video cuts, captions, speeds up, finds highlights).`;
    // What is said in it too (Elorian Glimpse: a video is pictures and speech), when it is short enough.
    const said = speechOf(file, v.duration);
    if (said) { out.text = said; out.note += ' What is said in it, with times:'; }
  } else if (kind === 'audio') {
    const d = has('ffprobe') ? durationOf(file) : null;
    out.duration = d;
    out.note = `Audio ${out.name}${d ? `, ${Math.round(d)} s` : ''}, saved at ${file}.`;
    const said = speechOf(file, d);
    if (said) { out.text = said; out.note += ' What is said, with times:'; }
  } else if (kind === 'pdf') {
    out.text = pdfText(file);
    out.note = `PDF ${out.name}, saved at ${file}.${out.text ? ' Its text:' : ' (its text could not be extracted; read it with tools)'}`;
  } else {
    out.note = `File ${out.name} (${Math.round(size / 1024)} KB), saved at ${file}. Read, convert or run it with your tools.`;
  }
  return out;
}
