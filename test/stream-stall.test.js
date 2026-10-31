// A provider that stops sending is cut off and retried, not waited on for minutes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { makeOpenAICompat } from '../src/providers/openai-compat.js';

const serve = (handler) => new Promise((resolve) => { const s = http.createServer(handler).listen(0, '127.0.0.1', () => resolve(s)); });

test('a stream that goes quiet is cut off with a clear error', async () => {
  const s = await serve((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'hi' } }] })}\n\n`); }); });
  process.env.OX_STREAM_IDLE_MS = '300';
  try {
    const stream = makeOpenAICompat({ name: 't' })({ model: 'm', messages: [{ role: 'user', content: 'x' }], baseUrl: `http://127.0.0.1:${s.address().port}/v1` });
    const t0 = Date.now();
    const got = [];
    await assert.rejects(async () => { for await (const ev of stream) got.push(ev); }, /stream stalled \(nothing for 0 s\)/);
    assert.ok(Date.now() - t0 < 3000, 'cut off quickly');
    assert.equal(got[0]?.text, 'hi', 'what arrived before the stall was passed on');
  } finally { delete process.env.OX_STREAM_IDLE_MS; s.closeAllConnections?.(); s.close(); }
});

test('no reply at all is cut off too', async () => {
  const s = await serve((req) => { req.resume(); });
  process.env.OX_STREAM_FIRST_MS = '300';
  try {
    const stream = makeOpenAICompat({ name: 't' })({ model: 'm', messages: [{ role: 'user', content: 'x' }], baseUrl: `http://127.0.0.1:${s.address().port}/v1` });
    await assert.rejects(async () => { for await (const _ of stream) {} }, /stream stalled \(no reply in 0 s\)/);
  } finally { delete process.env.OX_STREAM_FIRST_MS; s.closeAllConnections?.(); s.close(); }
});
