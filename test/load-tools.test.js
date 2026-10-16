// Tools on demand: a narrowed offer lists the rest by name, and the model can
// load one itself with load_tools; the next request carries its definition.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAgent } from '../src/agent.js';

test('load_tools brings a withheld tool into the next request', async (t) => {
  const seen = [];
  let n = 0;
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
      const body = JSON.parse(b);
      seen.push((body.tools ?? []).map((x) => x.function?.name));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      if (n++ === 0) {
        send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'load_tools', arguments: '{"names":["web_fetch"]}' } }] } }] });
        send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
      } else {
        send({ choices: [{ index: 0, delta: { content: 'done' } }] });
        send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 1 } });
      }
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-load-'));
  const target = { bot: 'stub', provider: 'custom', model: 'm', baseUrl: `http://127.0.0.1:${srv.address().port}/v1`, keyEnv: null };
  const events = [];
  for await (const e of runAgent({ target, messages: [{ role: 'user', content: 'fix the database migration scripts' }], ctx: { cwd, mode: 'code' }, config: {}, maxIterations: 4, verify: false })) events.push(e);
  assert.ok(seen.length >= 2, `requests: ${seen.length}`);
  assert.ok(seen[0].includes('load_tools'), `first offer: ${seen[0]}`);
  assert.ok(!seen[0].includes('web_fetch'), 'web_fetch starts withheld');
  assert.ok(seen[1].includes('web_fetch'), `second offer: ${seen[1]}`);
  // The tool's answer travels to the model in the conversation.
  const hist = events.filter((e) => e.type === 'history').at(-1)?.messages ?? [];
  const reply = hist.find((m) => m.role === 'tool' && /Loaded:/.test(String(m.content)));
  assert.match(String(reply?.content ?? ''), /Loaded: web_fetch/);
});
