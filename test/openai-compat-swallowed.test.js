// Ollama (0.40, qwen2.5), streaming with tools, can swallow an answer that
// starts like a tool call: usage says tokens were generated, but no text and
// no call arrive. ox asks once more without streaming and gets the answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { makeOpenAICompat } from '../src/providers/openai-compat.js';

function server(handler) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => handler(JSON.parse(b), res)); });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}
const tools = [{ name: 'read_file', description: 'read', input_schema: { type: 'object', properties: {} } }];
const collect = async (it) => { const out = []; for await (const e of it) out.push(e); return out; };

test('a swallowed streamed answer is recovered with one non-streaming request', async (t) => {
  const seen = [];
  const s = await server((body, res) => {
    seen.push(body.stream);
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 50, completion_tokens: 207 } })}\n\n`);
      return res.end('data: [DONE]\n\n');
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '```ox-ui\n{"type":"text","text":"hi"}\n```' }, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 30 } }));
  });
  t.after(() => s.close());
  const chat = makeOpenAICompat({ name: 'test' });
  const ev = await collect(chat({ model: 'm', messages: [{ role: 'user', content: 'x' }], tools, baseUrl: `http://127.0.0.1:${s.address().port}/v1` }));
  assert.deepEqual(seen, [true, false]);
  assert.equal(ev.filter((e) => e.type === 'text-delta').map((e) => e.text).join(''), '```ox-ui\n{"type":"text","text":"hi"}\n```');
  assert.equal(ev.filter((e) => e.type === 'done').length, 1);
  assert.equal(ev.at(-1).type, 'done');
});

test('a normal stream, or one with no tokens at all, is never asked twice', async (t) => {
  let calls = 0;
  const s = await server((body, res) => {
    calls++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: body.messages[0].content === 'empty' ? '' : 'hello' } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: body.messages[0].content === 'empty' ? 0 : 1 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  t.after(() => s.close());
  const chat = makeOpenAICompat({ name: 'test' });
  const base = `http://127.0.0.1:${s.address().port}/v1`;
  const a = await collect(chat({ model: 'm', messages: [{ role: 'user', content: 'x' }], tools, baseUrl: base }));
  assert.equal(a.find((e) => e.type === 'text-delta').text, 'hello');
  await collect(chat({ model: 'm', messages: [{ role: 'user', content: 'empty' }], tools, baseUrl: base }));
  assert.equal(calls, 2);
});
