// Dictation quality for OX Buddy, in the spirit of Wispr Flow: what you said,
// written the way you meant it.
//
//   1. Recognize: whisper.cpp (`whisper-cli`) on the recorded audio when a
//      model is installed (`ox voice setup`), primed with the project's own
//      vocabulary; otherwise the transcript the island's recognizer produced.
//   2. Clean: fillers out ("um", "uh", "you know"), stutters collapsed ("the
//      the"), spoken commands ("new line", "new paragraph"), spacing and
//      punctuation fixed, sentences capitalized.
//   3. Correct: spoken names of things in this project become the real names
//      ("package dot json" -> package.json, "use state" -> useState, "read me"
//      -> README.md), matched only against names that exist here.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';

// ---- 2. cleanup ---------------------------------------------------------------

const FILLERS = /\b(?:um+|uh+|erm+|er|ah+|hmm+|mhm|uh-huh)\b[,.]?\s*/gi;
// "like" and "you know" only as discourse fillers: set off by commas or at the start.
const SOFT_FILLERS = /(?:^|,\s*)(?:you know|i mean|like|so yeah|kind of like)\s*,\s*/gi;

export function cleanTranscript(raw) {
  let s = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  s = s.replace(FILLERS, '').replace(SOFT_FILLERS, (m) => (m.startsWith(',') ? ', ' : ''));
  // Stutters and repeated words: "the the", "I I I".
  s = s.replace(/\b(\w+)(?:\s+\1\b)+/gi, '$1');
  // Spoken layout and punctuation commands.
  s = s
    .replace(/\s*\bnew paragraph\b[,.]?\s*/gi, '\n\n')
    .replace(/\s*\bnew line\b[,.]?\s*/gi, '\n')
    .replace(/\s*\b(?:full stop|period)\b(?=\s|$)/gi, '.')
    .replace(/\s*\bcomma\b(?=\s|$)/gi, ',')
    .replace(/\s*\bquestion mark\b(?=\s|$)/gi, '?')
    .replace(/\s*\bexclamation (?:mark|point)\b(?=\s|$)/gi, '!');
  // Spacing: none before punctuation, one after; no doubled punctuation.
  s = s
    .replace(/[ \t]+([,.;:!?])/g, '$1')
    .replace(/([,;:!?])(?=[^\s\d"')\]])/g, '$1 ')
    .replace(/\.(?=[A-Za-z]{2,}\b)(?![a-z]{1,5}\b)/g, '. ')
    .replace(/([,.;:!?])\1+/g, '$1')
    .replace(/,\s*([.!?])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
  // Capitalize sentence starts and the pronoun I.
  s = s.replace(/(^|[.!?]\s+|\n)([a-z])/g, (_, a, b) => a + b.toUpperCase()).replace(/\bi\b(?=\s|'|$)/g, 'I');
  // End with punctuation if the speaker didn't.
  // Each line ends with punctuation; a question gets "?" when its last sentence asks one.
  const QUESTION = /^(?:(?:so|and|but|ok|okay|hey|well),? )?(?:what|why|how|where|when|who|which|can|could|should|would|is|are|do|does|did|will)\b/i;
  s = s
    .split('\n')
    .map((line) => {
      if (!line.trim() || /[.!?:)"'`]$/.test(line)) return line;
      const last = line.split(/(?<=[.!?])\s+/).pop();
      return line + (QUESTION.test(last) ? '?' : '.');
    })
    .join('\n');
  return s;
}

// ---- 3. project vocabulary ----------------------------------------------------

/** Names worth recognizing in this project: file names and code identifiers. */
export function projectVocabulary(cwd = process.cwd(), { limit = 400 } = {}) {
  const words = new Set();
  let files = [];
  try {
    files = execFileSync('git', ['ls-files'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, maxBuffer: 16 * 1024 * 1024 }).split('\n').filter(Boolean);
  } catch {
    try { files = fs.readdirSync(cwd); } catch {}
  }
  for (const f of files.slice(0, 5000)) {
    const base = path.basename(f);
    if (base.length >= 4 && base.length <= 40) words.add(base);
  }
  // camelCase / PascalCase / snake_case identifiers from the first source files.
  for (const f of files.filter((x) => /\.(m?[jt]sx?|py|swift|go|rs|rb)$/.test(x)).slice(0, 60)) {
    let src = '';
    try { src = fs.readFileSync(path.join(cwd, f), 'utf8').slice(0, 60_000); } catch {}
    for (const m of src.matchAll(/\b(?:[a-z]+[A-Z][A-Za-z0-9]*|[A-Z][a-z]+[A-Z][A-Za-z0-9]*|[a-z]+_[a-z0-9_]+)\b/g)) {
      if (m[0].length >= 6 && m[0].length <= 32) words.add(m[0]);
      if (words.size >= limit * 3) break;
    }
  }
  return [...words].slice(0, limit * 3);
}

const squash = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Replace spoken forms of project names with the names themselves. */
export function correctVocabulary(text, vocab = []) {
  if (!vocab.length) return text;
  const byFull = new Map();
  const byStem = new Map();
  for (const v of vocab) {
    const full = squash(v);
    if (full.length >= 5 && !byFull.has(full)) byFull.set(full, v);
    const stem = squash(v.replace(/\.[a-z0-9]+$/i, ''));
    if (/\./.test(v) && stem.length >= 5 && !byStem.has(stem)) byStem.set(stem, v);
  }
  let s = text;
  // "<words> dot <ext>" -> a file name; the real one when it exists here.
  s = s.replace(/\b((?:[A-Za-z0-9_-]+\s+){0,3}[A-Za-z0-9_-]+)\s+dot\s+([A-Za-z0-9]{1,6})\b/gi, (m, name, ext) => {
    const joined = `${squash(name)}${squash(ext)}`;
    if (byFull.has(joined)) return byFull.get(joined);
    // Only the last word joins when nothing matches ("open the config dot json").
    const words = name.split(/\s+/);
    const last = words.pop();
    return `${words.length ? `${words.join(' ')} ` : ''}${last.toLowerCase()}.${ext.toLowerCase()}`;
  });
  // Spans of 2-4 spoken words whose letters spell a project name ("use state").
  const tokens = s.split(/(\s+)/);
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    let replaced = false;
    for (let n = 4; n >= 2 && !replaced; n--) {
      const span = [];
      for (let k = i; k < tokens.length && span.length < n; k += 2) span.push(tokens[k]);
      if (span.length < n) continue;
      const core = span.map((w) => w.replace(/[^A-Za-z0-9]/g, ''));
      const key = core.join('').toLowerCase();
      const hit = byFull.get(key) ?? byStem.get(key);
      if (hit && key.length >= 6) {
        const trail = span[span.length - 1].match(/[^A-Za-z0-9]+$/)?.[0] ?? '';
        out.push(hit + trail);
        i += (n - 1) * 2;
        replaced = true;
      }
    }
    if (!replaced) out.push(tokens[i]);
  }
  return out.join('');
}

// ---- 1. whisper.cpp ------------------------------------------------------------

export const MODELS_DIR = path.join(os.homedir(), '.ox', 'models');
export const WHISPER_MODELS = {
  'base.en': { file: 'ggml-base.en.bin', mb: 142 },
  'small.en': { file: 'ggml-small.en.bin', mb: 466 },
  'medium.en': { file: 'ggml-medium.en.bin', mb: 1500 },
};

/** The installed whisper model to use (OX_WHISPER_MODEL, else the best in ~/.ox/models), or null. */
export function whisperModel(env = process.env) {
  if (env.OX_WHISPER_MODEL) return fs.existsSync(env.OX_WHISPER_MODEL) ? env.OX_WHISPER_MODEL : null;
  for (const name of ['medium.en', 'small.en', 'base.en']) {
    const f = path.join(MODELS_DIR, WHISPER_MODELS[name].file);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

export function whisperBinary(env = process.env) {
  const candidates = [env.OX_WHISPER_BIN, 'whisper-cli', 'whisper-cpp'].filter(Boolean);
  for (const c of candidates) {
    try {
      execFileSync(c, ['--help'], { stdio: 'ignore', timeout: 5000 });
      return c;
    } catch (e) {
      if (e?.status != null) return c; // ran, just exited non-zero on --help
    }
  }
  return null;
}

/** Transcribe an audio file with whisper.cpp; null when whisper is unavailable. */
export function transcribeFile(file, { vocab = [], env = process.env, timeoutMs = 60_000 } = {}) {
  const bin = whisperBinary(env);
  const model = whisperModel(env);
  if (!bin || !model) return Promise.resolve(null);
  // whisper.cpp wants 16 kHz mono WAV; macOS ships afconvert.
  let wav = file;
  if (!/\.wav$/i.test(file) && process.platform === 'darwin') {
    wav = `${file}.16k.wav`;
    try {
      execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', file, wav], { stdio: 'ignore', timeout: 20_000 });
    } catch {
      return Promise.resolve(null);
    }
  }
  // The prompt primes spelling: project names, written the way they are.
  const prompt = vocab.slice(0, 60).join(', ');
  const args = ['-m', model, '-f', wav, '-nt', '-np', '-l', 'en', ...(prompt ? ['--prompt', prompt] : [])];
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (wav !== file) fs.rm(wav, { force: true }, () => {});
      if (err) return resolve(null);
      resolve(String(stdout).replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim() || null);
    });
  });
}

/**
 * The full pipeline: whisper on the audio when possible, else the recognizer's
 * text; then cleanup and project-name correction. Returns { text, via }.
 */
export async function dictate({ text = '', audioPath = null, cwd = process.cwd(), env = process.env } = {}) {
  const vocab = projectVocabulary(cwd);
  let raw = text;
  let via = 'recognizer';
  if (audioPath) {
    const heard = await transcribeFile(audioPath, { vocab, env });
    if (heard) { raw = heard; via = 'whisper'; }
  }
  return { text: correctVocabulary(cleanTranscript(raw), vocab), via, raw };
}
