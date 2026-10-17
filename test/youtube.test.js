// youtube_transcript: links and ids are read, captions become text with time
// marks, and missing captions or a blocked video say so plainly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { videoId, transcriptText, youtubeTranscriptTool } from '../src/tools/youtube.js';
import { classifyTool } from '../src/resource-class.js';

test('video ids from every link shape', () => {
  for (const s of ['aircAruvnKk', 'https://www.youtube.com/watch?v=aircAruvnKk&t=3s', 'https://youtu.be/aircAruvnKk', 'https://youtube.com/shorts/aircAruvnKk']) assert.equal(videoId(s), 'aircAruvnKk', s);
  assert.equal(videoId('not a video'), null);
});

test('captions become text with a mark about every 30 s', () => {
  const t = transcriptText({ events: [{ tStartMs: 0, segs: [{ utf8: 'Hello' }] }, { tStartMs: 5000, segs: [{ utf8: ' world.' }] }, { tStartMs: 31000, segs: [{ utf8: 'Next part.' }] }] });
  assert.equal(t, '[0:00] Hello world.\n[0:31] Next part.');
});

test('a video, its transcript, and the plain failures', async () => {
  const player = { playabilityStatus: { status: 'OK' }, videoDetails: { title: 'But what is a neural network?', author: '3Blue1Brown', lengthSeconds: '1124' }, captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ languageCode: 'en', baseUrl: 'https://x/t?v=1' }, { languageCode: 'es', baseUrl: 'https://x/t?v=2' }] } } };
  const fetchImpl = async (url) => ({ json: async () => (String(url).includes('player') ? player : { events: [{ tStartMs: 0, segs: [{ utf8: 'This is a 3.' }] }] }) });
  const r = await youtubeTranscriptTool({ video: 'https://youtu.be/aircAruvnKk' }, { fetchImpl });
  assert.match(r.content, /But what is a neural network\? — 3Blue1Brown/);
  assert.match(r.content, /18:44 · transcript: en · also in es/);
  assert.match(r.content, /\[0:00\] This is a 3\./);
  const none = await youtubeTranscriptTool({ video: 'aircAruvnKk' }, { fetchImpl: async () => ({ json: async () => ({ playabilityStatus: { status: 'OK' }, videoDetails: { title: 'Quiet' } }) }) });
  assert.match(none.content, /has no captions/);
  assert.equal(none.isError, true);
  assert.equal((await youtubeTranscriptTool({ video: 'nope' })).isError, true);
  assert.equal(classifyTool('youtube_transcript'), 'pure_read');
});
