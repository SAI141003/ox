import { spawn } from 'node:child_process';
import { createVoiceMcpServer } from './voice-mcp.js';

export const VOICE_MODE_SCHEMA_VERSION = '1.0.0';

export class VoiceSession {
  constructor(cwd, opts = {}) {
    this.cwd = cwd; this.opts = opts;
    this._running = false; this._sttBackend = 'whisper'; this._ttsBackend = 'kokoro';
    this._mcp = createVoiceMcpServer(); this._transcripts = []; this._responses = [];
    this._onTranscript = null; this._onResponse = null; this._onStatus = null;
  }
  _setStatus(s) { this._status = s; if (this._onStatus) this._onStatus(s); }
  async start(opts = {}) {
    this._running = true; this._setStatus('listening');
    await this._mcp.start();
    if (opts.sttBackend) this._sttBackend = opts.sttBackend;
    if (opts.ttsBackend) this._ttsBackend = opts.ttsBackend;
  }
  async stop() { this._running = false; this._setStatus('stopped'); await this._mcp.stop(); }
  isRunning() { return this._running; }
  async sendAudio(audio) {
    this._setStatus('transcribing');
    const result = await this._mcp.call('speech_to_text', { audio });
    const transcript = result.content ?? '';
    this._transcripts.push(transcript);
    if (this._onTranscript) this._onTranscript(transcript);
    this._setStatus('processing');
    const response = await this._process(transcript);
    this._responses.push(response);
    if (this._onResponse) this._onResponse(response);
    this._setStatus('speaking');
    await this._mcp.call('text_to_speech', { text: response });
    this._setStatus('idle');
    return response;
  }
  async _process(text) {
    if (this.opts.onMessage) return this.opts.onMessage(text);
    return `(echo: ${text.slice(0, 100)})`;
  }
  onTranscript(cb) { this._onTranscript = cb; }
  onResponse(cb) { this._onResponse = cb; }
  setStatus(cb) { this._onStatus = cb; if (this._status) cb(this._status); }
}

const PLATFORM_ADAPTERS = {
  cli: { start: () => ({ platform: 'cli', input: 'microphone' }), receive: (s) => s },
  telegram: { start: () => ({ platform: 'telegram', type: 'voice' }), receive: (s) => s },
  discord: { start: () => ({ platform: 'discord', type: 'voice' }), receive: (s) => s },
};

export function createVoiceMode(cwd) {
  let session = null; let running = false; let statusVal = 'stopped';
  const platforms = new Set(); let activePlatform = 'cli';

  async function start(opts = {}) {
    session = new VoiceSession(cwd, opts);
    running = true; statusVal = 'starting';
    await session.start(opts); statusVal = 'ok';
  }
  async function stop() { if (!session) return; running = false; statusVal = 'stopped'; await session.stop(); session = null; }
  function isRunning() { return running; }
  async function sendAudio(audio) { if (!session) throw new Error('voice mode not started'); return session.sendAudio(audio); }
  function onTranscript(cb) { if (session) session.onTranscript(cb); }
  function onResponse(cb) { if (session) session.onResponse(cb); }
  function setStatus(cb) { if (session) session.setStatus(cb); }
  function getPlatforms() { return Object.keys(PLATFORM_ADAPTERS); }
  function setPlatform(p) { if (!PLATFORM_ADAPTERS[p]) throw new Error(`unknown platform: ${p}`); activePlatform = p; }

  return { start, stop, isRunning, sendAudio, onTranscript, onResponse, setStatus, getPlatforms, setPlatform };
}
