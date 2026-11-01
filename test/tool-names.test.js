import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

test('tool names go out provider-safe and calls come back under ox\'s own name', async () => {
  const { makeOpenAICompat, wireToolName } = await import('../src/providers/openai-compat.js');
  assert.equal(wireToolName('agent_message.send'), 'agent_message_send');
  let sent = null;
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
      sent = JSON.parse(b);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'agent_message_send', arguments: '{}' } }] } }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise((r) => srv.listen(0, r));
  try {
    const chat = makeOpenAICompat({ name: 't' });
    const evs = [];
    for await (const ev of chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 'agent_message.send', description: 'd', input_schema: { type: 'object', properties: {} } }], baseUrl: `http://127.0.0.1:${srv.address().port}`, apiKey: 'k' })) evs.push(ev);
    assert.equal(sent.tools[0].function.name, 'agent_message_send');
    assert.equal(evs.find((e) => e.type === 'tool-call').call.name, 'agent_message.send');
  } finally { srv.close(); }
});
