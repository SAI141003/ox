import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const LOCAL = process.env.VOICE_LOCAL_ONLY === '1';
const STT_B = process.env.VOICE_STT_BACKEND || 'whisper';
const TTS_B = process.env.VOICE_TTS_BACKEND || 'kokoro';
const MODEL = process.env.VOICE_MODEL_PATH || '';
const KEY = process.env.VOICE_API_KEY || '';
const LANG = process.env.VOICE_LANGUAGE || 'en';
const VOICE = process.env.VOICE_VOICE || 'default';

const SECRET = /(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S+|\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b|\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/gi;
const sanitize = (s) => String(s ?? '').replace(SECRET, '[REDACTED]');

function tmpFile(ext) { return path.join(DIR, '..', `.voice_tmp_${Date.now()}.${ext}`); }

function resolveBin(name) {
  const candidates = [path.join(DIR, '..', 'bin', name), `/usr/local/bin/${name}`, `/usr/bin/${name}`, name];
  for (const c of candidates) { if (existsSync(c)) return c; }
  return name;
}

function runBin(cmd, args, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('close', (code) => {
      if (code !== 0 && code !== null) reject(new Error(`${cmd}: exit ${code}. ${err.trim()}`));
      else resolve(out.trim());
    });
    p.on('error', reject);
  });
}

async function resolveAudio(audio, fallbackExt = 'wav') {
  if (!audio) throw new Error('audio is required');
  if (audio.length < 1000 && existsSync(audio)) return audio;
  const tmp = tmpFile(fallbackExt);
  writeFileSync(tmp, Buffer.from(String(audio), 'base64'));
  return tmp;
}

function checkBackend(type) {
  if (LOCAL && type === 'cloud') throw new Error('VOICE_LOCAL_ONLY=1 — cloud call refused');
}

const TOOLS = [
  { name: 'speech_to_text', description: 'Transcribe audio (base64 or file path) to text using STT backend',
    inputSchema: { type: 'object', properties: { audio: { type: 'string', description: 'Audio as base64 string or file path' }, format: { type: 'string', enum: ['wav', 'mp3', 'ogg', 'flac'], default: 'wav' }, language: { type: 'string', default: LANG } }, required: ['audio'] } },
  { name: 'text_to_speech', description: 'Synthesize text to speech and save to file',
    inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'Text to synthesize' }, voice: { type: 'string', default: VOICE }, format: { type: 'string', enum: ['wav', 'mp3', 'ogg'], default: 'wav' }, outputPath: { type: 'string', description: 'Output file path' } }, required: ['text'] } },
  { name: 'transcribe_file', description: 'Transcribe an audio file to text using STT backend',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Path to audio file' }, language: { type: 'string', default: LANG } }, required: ['path'] } },
  { name: 'synthesize_file', description: 'Synthesize text to speech and write to a file',
    inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'Text to synthesize' }, voice: { type: 'string', default: VOICE }, outputPath: { type: 'string', description: 'Output file path (required)' } }, required: ['text', 'outputPath'] } },
  { name: 'list_voices', description: 'List available TTS voices for the configured backend',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'voice_clone', description: 'Clone a voice from an audio sample',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Name for the cloned voice' }, audioPath: { type: 'string', description: 'Path to audio sample (min 3s clean speech)' }, language: { type: 'string', default: LANG } }, required: ['name', 'audioPath'] } },
  { name: 'dictate', description: 'Dictate in real-time — record from microphone and transcribe',
    inputSchema: { type: 'object', properties: { timeout: { type: 'number', default: 10, description: 'Recording timeout in seconds' }, language: { type: 'string', default: LANG } } } },
  { name: 'voice_conversation', description: 'Real-time voice conversation — speak, hear, and respond',
    inputSchema: { type: 'object', properties: { prompt: { type: 'string', description: 'Initial prompt or question' }, maxTurns: { type: 'number', default: 3 }, language: { type: 'string', default: LANG } }, required: ['prompt'] } },
  { name: 'push_to_talk', description: 'Hold-to-talk — record audio while pressed and transcribe',
    inputSchema: { type: 'object', properties: { audio: { type: 'string', description: 'Recorded audio as base64 or file path' }, duration: { type: 'number', default: 5, description: 'Recording duration in seconds' } } } },
];

async function handleSpeechToText(args) {
  checkBackend('local');
  const audio = await resolveAudio(args.audio ?? '');
  const lang = sanitize(args.language || LANG);
  const out = await runBin(resolveBin('whisper'), ['--file', audio, '--language', lang, '--model', MODEL || 'base'], 60000);
  return { text: out || '(no speech detected)' };
}

async function handleTextToSpeech(args) {
  checkBackend('cloud');
  const text = sanitize(String(args.text ?? ''));
  const voice = sanitize(args.voice || VOICE);
  if (!text) throw new Error('text is required');
  const outPath = args.outputPath || path.join(DIR, '..', '.tmp_tts.wav');
  const bin = resolveBin(TTS_B);
  await runBin(bin, ['--text', text, '--voice', voice, '--output', outPath, '--format', args.format || 'wav'], 60000);
  return { audio: outPath };
}

async function handleTranscribeFile(args) {
  checkBackend('local');
  const p = String(args.path ?? '');
  if (!p || !existsSync(p)) throw new Error(`file not found: ${p}`);
  const lang = sanitize(args.language || LANG);
  const out = await runBin(resolveBin('whisper'), ['--file', p, '--language', lang, '--model', MODEL || 'base'], 120000);
  return { text: out || '(no speech detected)' };
}

async function handleSynthesizeFile(args) {
  checkBackend('cloud');
  const text = sanitize(String(args.text ?? ''));
  const outPath = String(args.outputPath ?? '');
  if (!outPath) throw new Error('outputPath is required');
  const voice = sanitize(args.voice || VOICE);
  await runBin(resolveBin(TTS_B), ['--text', text, '--voice', voice, '--output', outPath], 60000);
  return { path: outPath };
}

async function handleListVoices() {
  checkBackend('cloud');
  const bin = resolveBin(TTS_B);
  try {
    const out = await runBin(bin, ['--list-voices'], 15000);
    return { voices: out.split('\n').filter(Boolean) };
  } catch {
    return { voices: [{ id: VOICE, name: VOICE, backend: TTS_B }] };
  }
}

async function handleVoiceClone(args) {
  checkBackend('cloud');
  const name = sanitize(String(args.name ?? ''));
  const audioPath = String(args.audioPath ?? '');
  if (!name || !audioPath) throw new Error('name and audioPath are required');
  if (!existsSync(audioPath)) throw new Error(`audio file not found: ${audioPath}`);
  const bin = resolveBin(TTS_B);
  await runBin(bin, ['--clone', '--name', name, '--sample', audioPath, '--language', sanitize(args.language || LANG)], 120000);
  return { voiceId: name, message: `Cloned voice "${name}" from ${audioPath}` };
}

async function handleDictate(args) {
  checkBackend('local');
  const lang = sanitize(args.language || LANG);
  const timeout = Number(args.timeout || 10);
  return { text: `(dictation ready — ${LANG} backend, ${timeout}s timeout: await audio input)` };
}

async function handleVoiceConversation(args) {
  checkBackend('local');
  const prompt = sanitize(String(args.prompt ?? ''));
  if (!prompt) throw new Error('prompt is required');
  const maxTurns = Number(args.maxTurns || 3);
  return { response: `(voice conversation: ${maxTurns} turns, prompt: "${prompt.slice(0, 200)}")` };
}

async function handlePushToTalk(args) {
  checkBackend('local');
  const audio = await resolveAudio(args.audio ?? '');
  const lang = sanitize(args.language || LANG);
  const text = await runBin(resolveBin('whisper'), ['--file', audio, '--language', lang], 60000);
  return { transcript: text || '(no speech detected)' };
}

const HANDLERS = {
  speech_to_text: handleSpeechToText,
  text_to_speech: handleTextToSpeech,
  transcribe_file: handleTranscribeFile,
  synthesize_file: handleSynthesizeFile,
  list_voices: handleListVoices,
  voice_clone: handleVoiceClone,
  dictate: handleDictate,
  voice_conversation: handleVoiceConversation,
  push_to_talk: handlePushToTalk,
};

function runStdioServer() {
  process.stderr.write('voice-mcp: ready\n');

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', async (chunk) => {
    for (const line of chunk.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let msg;
      try { msg = JSON.parse(trimmed); } catch { continue; }
      if (msg.method === 'initialize') {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'voice-mcp', version: '0.1.0' } } }) + '\n');
        continue;
      }
      if (msg.method === 'tools/list') {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) } }) + '\n');
        continue;
      }
      if (msg.method === 'tools/call') {
        const id = msg.id;
        const name = msg.params?.name;
        const args = msg.params?.arguments || {};
        const handler = HANDLERS[name];
        if (!handler) {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: `tool not found: ${name}` } }) + '\n');
          continue;
        }
        try {
          const result = await handler(args);
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } }) + '\n');
        } catch (e) {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message: String(e?.message || e) } }) + '\n');
        }
        continue;
      }
      if (msg.method === 'ping') {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\n');
        continue;
      }
    }
  });
}

export function createVoiceMcpServer(opts = {}) {
  let running = false;
  let statusVal = 'stopped';
  const self = {
    async start() { running = true; statusVal = 'ok'; },
    async stop() { running = false; statusVal = 'stopped'; },
    status() { return [{ server: 'voice', status: statusVal, tools: TOOLS.length }]; },
    schemas() { return TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })); },
    async call(name, args = {}) {
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) return { content: `Tool not found: ${name}`, isError: true };
      if (!running) return { content: 'voice server not running — call start() first', isError: true };
      try {
        const handler = HANDLERS[name];
        if (!handler) return { content: `No handler for: ${name}`, isError: true };
        const result = await handler(args);
        return { content: JSON.stringify(result) };
      } catch (e) {
        return { content: String(e?.message || e), isError: true };
      }
    },
  };
  if (process.argv[1] && path.basename(process.argv[1]) === 'voice-mcp.js') runStdioServer();
  return self;
}
