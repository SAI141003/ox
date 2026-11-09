// The live voice call: the key stays on the server, only an SDP answer reaches the page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startCall, checkOffer, sessionConfig, realtimeAvailable, HAND_TO_OX } from '../src/realtime-voice.js';

const OFFER = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
const ANSWER = 'v=0\r\no=- 3 4 IN IP4 0.0.0.0\r\ns=-\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';

test('only with a key, and only a real audio offer of sane size is forwarded', () => {
  assert.equal(realtimeAvailable({}), false);
  assert.equal(realtimeAvailable({ OPENAI_API_KEY: 'sk-test' }), true);
  assert.throws(() => checkOffer('hello'), /not a WebRTC audio offer/);
  assert.throws(() => checkOffer('v=0\r\nm=video 9 X\r\n'), /not a WebRTC audio offer/);
  assert.throws(() => checkOffer(OFFER + 'a=x\r\n'.repeat(20000)), /too large/);
  assert.equal(checkOffer(OFFER), OFFER);
});

test('the offer goes to OpenAI with the key, the answer comes back, and nothing else does', async () => {
  let seen = null;
  const fetchImpl = async (url, init) => {
    seen = { url, auth: init.headers.Authorization, sdp: init.body.get('sdp'), session: JSON.parse(init.body.get('session')) };
    return new Response(ANSWER, { status: 201 });
  };
  const sdp = await startCall({ sdp: OFFER, voice: 'cedar', instructions: 'Their name is Sai.', env: { OPENAI_API_KEY: 'sk-secret-123456789' }, fetchImpl });
  assert.equal(sdp, ANSWER);
  assert.equal(seen.url, 'https://api.openai.com/v1/realtime/calls');
  assert.equal(seen.auth, 'Bearer sk-secret-123456789');
  assert.equal(seen.sdp, OFFER);
  assert.equal(seen.session.type, 'realtime');
  assert.equal(seen.session.audio.output.voice, 'cedar');
  assert.match(seen.session.instructions, /Their name is Sai\./);
  assert.deepEqual(seen.session.tools.map((t) => t.name), ['hand_to_ox']);
  assert.ok(!sdp.includes('sk-'), 'the page gets an SDP answer, not the key');
});

test('without a key it says what to do; an upstream error never carries a key back', async () => {
  await assert.rejects(startCall({ sdp: OFFER, env: {} }), /needs an OpenAI key/);
  const fetchImpl = async () => new Response(JSON.stringify({ error: { message: 'Incorrect API key provided: sk-secr*********6789. Also sk-secret-123456789.' } }), { status: 401 });
  await assert.rejects(startCall({ sdp: OFFER, env: { OPENAI_API_KEY: 'sk-secret-123456789' }, fetchImpl }), (e) => {
    assert.match(e.message, /refused the call \(401\)/);
    assert.ok(!e.message.includes('sk-secret-123456789'));
    assert.ok(!/sk-|6789/.test(e.message), `no part of the key, masked or not: ${e.message}`);
    return true;
  });
  await assert.rejects(startCall({ sdp: OFFER, env: { OPENAI_API_KEY: 'sk-x' }, fetchImpl: async () => new Response('<html>', { status: 200 }) }), /not an SDP answer/);
});

test('the voice model can only hand work to ox, and an unknown voice falls back', () => {
  const s = sessionConfig({ voice: 'nobody' });
  assert.equal(s.audio.output.voice, 'marin');
  assert.equal(s.tools.length, 1);
  assert.equal(HAND_TO_OX.parameters.required[0], 'task');
  assert.match(s.instructions, /never pretend you did it yourself/);
});
