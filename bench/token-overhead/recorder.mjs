// A stand-in model server that records exactly what each agent sends.
// OpenAI chat completions, OpenAI Responses (Codex), Anthropic Messages (Claude Code).
import http from 'node:http';
import fs from 'node:fs';
const [out, port = '48100'] = process.argv.slice(2);
const TEXT = 'Doing well, thanks! How can I help?';
http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    let j = {}; try { j = JSON.parse(b); } catch {}
    const tag = req.headers['x-bench-tag'] || process.env.TAG || '';
    fs.appendFileSync(out, JSON.stringify({ at: Date.now(), url: req.url, tag, body: j }) + '\n');
    const u = req.url.split('?')[0];
    if (u.endsWith('/messages') && !u.includes('count_tokens')) {
      if (j.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const ev = (e, d) => res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`);
        ev('message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: j.model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } });
        ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
        ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: TEXT } });
        ev('content_block_stop', { type: 'content_block_stop', index: 0 });
        ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } });
        ev('message_stop', { type: 'message_stop' });
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: j.model, content: [{ type: 'text', text: TEXT }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 9 } }));
    }
    if (u.includes('count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"input_tokens":1}'); }
    if (u.endsWith('/responses')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const ev = (d) => res.write(`event: ${d.type}\ndata: ${JSON.stringify(d)}\n\n`);
      const item = { id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: TEXT, annotations: [] }] };
      ev({ type: 'response.created', response: { id: 'resp_1', status: 'in_progress', output: [] } });
      ev({ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
      ev({ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: TEXT });
      ev({ type: 'response.output_item.done', output_index: 0, item });
      ev({ type: 'response.completed', response: { id: 'resp_1', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 9, total_tokens: 10 } } });
      return res.end();
    }
    if (u.endsWith('/models')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"data":[{"id":"bench-model","object":"model"}]}'); }
    // chat completions
    if (j.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model: j.model, choices: [{ index: 0, delta: { role: 'assistant', content: TEXT } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model: j.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 9, total_tokens: 10 } })}\n\n`);
      return res.end('data: [DONE]\n\n');
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'c1', object: 'chat.completion', model: j.model, choices: [{ index: 0, message: { role: 'assistant', content: TEXT }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 9, total_tokens: 10 } }));
  });
}).listen(Number(port), '127.0.0.1');
