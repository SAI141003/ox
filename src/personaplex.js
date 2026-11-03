// PersonaPlex (NVIDIA, MIT code, NVIDIA Open Model License weights): full-duplex
// speech to speech. It listens while it talks, takes interruptions and
// back-channels ("mm-hm") like a person, and keeps a persona from a text prompt
// plus a voice prompt. A 7B model on an NVIDIA GPU (A100/H100-class; tested on
// an A100 80 GB), so it runs on a GPU machine of yours, not on a Mac.
//
// ox's part: where your PersonaPlex server is (`ox personaplex url <link>`),
// whether it answers (its own WebSocket handshake: /api/chat sends 0x00 once
// the persona prompt is loaded), the persona prompt written from what ox knows
// about you and how you like ox to talk, the commands to set it up on a Linux
// GPU box, and the app's side panel opening its live voice page.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CONFIG = (env = process.env) => path.join(env.OX_HOME || path.join(os.homedir(), '.ox'), 'personaplex.json');

export const VOICES = Object.freeze([
  ...[0, 1, 2, 3].map((n) => ({ id: `NATF${n}.pt`, label: `Natural female ${n + 1}` })),
  ...[0, 1, 2, 3].map((n) => ({ id: `NATM${n}.pt`, label: `Natural male ${n + 1}` })),
  ...[0, 1, 2, 3, 4].map((n) => ({ id: `VARF${n}.pt`, label: `Varied female ${n + 1}` })),
  ...[0, 1, 2, 3, 4].map((n) => ({ id: `VARM${n}.pt`, label: `Varied male ${n + 1}` })),
]);

export function readConfig({ env = process.env } = {}) {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(CONFIG(env), 'utf8')) ?? {}; } catch {}
  const url = String(env.OX_PERSONAPLEX_URL || saved.url || '').replace(/\/+$/, '');
  return { url: url || null, voice: VOICES.some((v) => v.id === saved.voice) ? saved.voice : 'NATF2.pt', persona: typeof saved.persona === 'string' ? saved.persona : '' };
}

export function saveConfig(patch, { env = process.env } = {}) {
  const cur = readConfig({ env });
  const next = { url: cur.url, voice: cur.voice, persona: cur.persona, ...patch };
  if (next.url != null) {
    next.url = String(next.url).trim().replace(/\/+$/, '');
    if (next.url && !/^https?:\/\/[^\s/]+/.test(next.url)) throw new Error('the PersonaPlex link starts with https:// (or http://), e.g. https://gpu-box:8998');
  }
  if (next.voice && !VOICES.some((v) => v.id === next.voice)) throw new Error(`unknown voice: ${next.voice} (ox personaplex voices)`);
  fs.mkdirSync(path.dirname(CONFIG(env)), { recursive: true });
  fs.writeFileSync(CONFIG(env), JSON.stringify(next, null, 2), { mode: 0o600 });
  return readConfig({ env });
}

/**
 * The persona prompt: who it is and how it talks, then what it knows about you
 * (from ox's memory, a few lines). PersonaPlex reads this once, at the start.
 */
export async function personaPrompt({ name = 'ox', custom = '', memory = null } = {}) {
  if (custom.trim()) return custom.trim().slice(0, 1500);
  let about = memory;
  if (about == null) {
    try { about = await (await import('./memory-graph.js')).memoryPromptBlockAsync({ task: 'a spoken conversation' }); } catch { about = ''; }
  }
  // Only the remembered facts themselves (its bullet lines), not the block's headings and instructions.
  const facts = String(about ?? '').split('\n').filter((l) => /^\s*[-*•]\s+/.test(l)).map((l) => l.replace(/^\s*[-*•]\s+/, '').replace(/\s*\([^)]*\)\s*$/, '').trim()).filter((l) => l.length > 6).slice(0, 8);
  return [
    `You are ${name}, a wise and friendly assistant on the user's computer. Talk like a person: short sentences, warm, direct, a little dry humour. Let the user interrupt; answer what they asked, then stop.`,
    facts.length ? `What you know about the user: ${facts.join('; ')}.` : '',
  ].filter(Boolean).join(' ').slice(0, 1500);
}

/** The live voice page, with the persona and the voice to use. */
export function chatUrl(cfg, prompt) {
  if (!cfg?.url) return null;
  const u = new URL(cfg.url);
  u.searchParams.set('text_prompt', prompt);
  u.searchParams.set('voice_prompt', cfg.voice);
  return u.toString();
}

/**
 * Does the server answer? Opens /api/chat with the persona and waits for its
 * handshake byte (0x00), which it sends only once the prompts are loaded.
 * → { ok, ms, error? }
 */
export async function probe(cfg, { prompt = 'You are a helpful assistant.', timeoutMs = 60_000, WebSocketImpl = globalThis.WebSocket } = {}) {
  if (!cfg?.url) return { ok: false, error: 'no PersonaPlex server set: ox personaplex url https://<gpu-box>:8998' };
  if (!WebSocketImpl) return { ok: false, error: 'this Node has no WebSocket (Node 22 or newer)' };
  const u = new URL('/api/chat', cfg.url);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.searchParams.set('text_prompt', prompt);
  u.searchParams.set('voice_prompt', cfg.voice);
  const t0 = Date.now();
  return await new Promise((resolve) => {
    let ws;
    const done = (r) => { clearTimeout(timer); try { ws?.close(); } catch {} resolve({ ms: Date.now() - t0, ...r }); };
    const timer = setTimeout(() => done({ ok: false, error: `no handshake in ${Math.round(timeoutMs / 1000)} s` }), timeoutMs);
    try { ws = new WebSocketImpl(u.toString()); } catch (e) { done({ ok: false, error: String(e?.message ?? e) }); return; }
    ws.binaryType = 'arraybuffer';
    ws.onmessage = (m) => {
      const b = m.data instanceof ArrayBuffer ? new Uint8Array(m.data) : null;
      if (b && b[0] === 0x00) done({ ok: true });
    };
    ws.onerror = () => done({ ok: false, error: `could not reach ${u.host} (is the server up? a self-signed certificate must be trusted once in your browser)` });
    ws.onclose = () => done({ ok: false, error: 'the server closed the connection before its handshake' });
  });
}

/** Setting it up on a Linux machine with an NVIDIA GPU (the steps from NVIDIA's README). */
export function setupSteps() {
  return [
    '# On a Linux machine with an NVIDIA GPU (A100/H100-class; --cpu-offload helps with less memory):',
    '# 1. accept the model licence once: https://huggingface.co/nvidia/personaplex-7b-v1',
    'sudo apt install -y libopus-dev git python3-venv',
    'git clone https://github.com/NVIDIA/personaplex && cd personaplex',
    'python3 -m venv .venv && . .venv/bin/activate && pip install moshi/.',
    'export HF_TOKEN=<your Hugging Face token>   # stays on that machine',
    'SSL_DIR=$(mktemp -d); python -m moshi.server --ssl "$SSL_DIR" --host 0.0.0.0',
    '# 2. on this Mac: ox personaplex url https://<that machine>:8998',
  ].join('\n');
}
