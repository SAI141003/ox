// Start cheap, move up when stuck (src/agent.js escalateNow).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const realHome = process.env.HOME;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-esc-home-'));
process.env.HOME = home;
fs.mkdirSync(path.join(home, '.ox'), { recursive: true });
process.env.OX_API_KEY = process.env.OX_API_KEY ?? 'test-esc-key';
after(() => { fs.rmSync(home, { recursive: true, force: true }); process.env.HOME = realHome; });
const { runAgent } = await import('../src/agent.js');
const sse = (o) => `data: ${JSON.stringify(o)}\n\n`;
const call = (n) => [sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `c${n}`, type: 'function', function: { name: 'read_file', arguments: '{"path":"same.txt"}' } }] }, finish_reason: null }] }), sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }), 'data: [DONE]\n\n'].join('');
const text = (t) => [sse({ choices: [{ index: 0, delta: { content: t }, finish_reason: null }] }), sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }), 'data: [DONE]\n\n'].join('');

test('escalate: a run stuck on the same call moves once to the stronger model', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-esc-ws-'));
  fs.writeFileSync(path.join(cwd, 'same.txt'), 'hello');
  const models = [];
  let n = 0;
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => (b += d));
    req.on('end', () => { const body = JSON.parse(b); models.push(body.model); res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(body.model === 'strong-model' ? text('done') : call(++n)); });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => { srv.closeAllConnections?.(); srv.close(); fs.rmSync(cwd, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${srv.address().port}/v1`;
  const config = { bots: { strong: { provider: 'custom', baseUrl: base, model: 'strong-model' } }, escalateBot: 'strong' };
  const events = [];
  for await (const ev of runAgent({ target: { provider: 'custom', baseUrl: base, model: 'cheap-model' }, messages: [{ role: 'user', content: 'read same.txt' }], ctx: { cwd }, config, auxTarget: null, verify: false, maxIterations: 8 })) events.push(ev);
  const sw = events.filter((e) => e.type === 'model_switch' && e.kind === 'escalate');
  assert.equal(sw.length, 1, 'once');
  assert.match(sw[0].reason, /stuck/);
  assert.equal(models[0], 'cheap-model');
  assert.equal(models.at(-1), 'strong-model', 'the next request went to the stronger model');
  assert.ok(events.some((e) => e.type === 'text-delta' && /done/.test(e.text)));
});
