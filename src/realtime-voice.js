// A live voice call with ox: speak and be answered as you speak, interrupt it,
// and hand it work. OpenAI's Realtime model does the talking (speech in, speech
// out, over WebRTC); anything beyond conversation is handed to ox as an ordinary
// chat turn, with the same tools and approvals, and its answer is spoken back.
//
// The key never reaches the page. The browser sends its WebRTC offer to this
// server, which forwards it to OpenAI with your key and returns only the SDP
// answer; the audio then flows between the browser and OpenAI directly. So the
// app page keeps its connect-src 'self' policy and holds no secret at all.
//
// PersonaPlex (src/personaplex.js) is the other live voice: full duplex on your
// own GPU, no key. This one needs OPENAI_API_KEY and works on any machine.

export const REALTIME_MODEL = 'gpt-realtime';
export const REALTIME_VOICES = Object.freeze(['marin', 'cedar', 'alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse']);
const CALLS_URL = 'https://api.openai.com/v1/realtime/calls';
const MAX_SDP = 64 * 1024;

export function realtimeKey(env = process.env) {
  const k = String(env.OPENAI_API_KEY ?? '').trim();
  return k || null;
}

export const realtimeAvailable = (env = process.env) => !!realtimeKey(env);

// The one tool the voice model has: give ox the job. ox does it in the open chat,
// so every approval, Send/Delete rule and sandbox applies exactly as when typed.
export const HAND_TO_OX = Object.freeze({
  type: 'function',
  name: 'hand_to_ox',
  description:
    'Give ox a task to do on this computer: code, files, apps, the web, messages, anything beyond talking. ' +
    'ox does it in the open chat (asking the person before anything risky) and returns what it did. ' +
    'Say briefly that you are handing it over, then wait for the result before describing it.',
  parameters: {
    type: 'object',
    properties: { task: { type: 'string', description: 'The task, complete and in the words the person used.' } },
    required: ['task'],
  },
});

export function sessionConfig({ instructions = '', voice = 'marin', model = REALTIME_MODEL } = {}) {
  return {
    type: 'realtime',
    model,
    instructions: [
      'You are ox, talking with the person live by voice. Keep replies short and spoken: no lists, no markdown, no code read aloud.',
      'You can be interrupted; stop and listen when they speak.',
      'For anything that needs doing on their computer, call hand_to_ox with the task; never pretend you did it yourself.',
      instructions,
    ].filter(Boolean).join('\n'),
    audio: { output: { voice: REALTIME_VOICES.includes(voice) ? voice : 'marin' }, input: { turn_detection: { type: 'semantic_vad' } } },
    tools: [HAND_TO_OX],
    tool_choice: 'auto',
  };
}

/** A WebRTC offer from the page must look like one, and be small, before it goes anywhere. */
export function checkOffer(sdp) {
  const s = String(sdp ?? '');
  if (!s.startsWith('v=0') || !/\r?\nm=audio /.test(s)) throw new Error('that is not a WebRTC audio offer');
  if (Buffer.byteLength(s) > MAX_SDP) throw new Error('the offer is too large');
  return s;
}

/**
 * Forward the page's offer to OpenAI with the key; → the SDP answer text.
 * Only the answer comes back to the page, never the key or a token.
 */
export async function startCall({ sdp, instructions = '', voice, env = process.env, fetchImpl = fetch, timeoutMs = 20_000 } = {}) {
  const key = realtimeKey(env);
  if (!key) throw new Error('a live call needs an OpenAI key: add OPENAI_API_KEY (ox keys) and try again');
  const form = new FormData();
  form.set('sdp', checkOffer(sdp));
  form.set('session', JSON.stringify(sessionConfig({ instructions, voice })));
  const r = await fetchImpl(CALLS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await r.text();
  if (!r.ok) {
    let why = text;
    try { why = JSON.parse(text)?.error?.message ?? text; } catch {}
    // An upstream error never echoes the key, but strip anything key-shaped anyway.
    // OpenAI echoes a masked key ("sk-abc-****1234"); none of it goes back to the page.
    const clean = String(why).split(key).join('…').replace(/\bsk-\S+/g, '(your key)');
    throw new Error(`OpenAI refused the call (${r.status}): ${clean.slice(0, 300)}`);
  }
  if (!text.startsWith('v=0')) throw new Error('OpenAI answered with something that is not an SDP answer');
  return text;
}
