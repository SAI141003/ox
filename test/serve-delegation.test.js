// In the app, a chat can hand work to a helper agent and the helper really
// runs (the subagent tool used to be offered with nothing behind it), and the
// agents can see each other's progress (agent_status) and message each other.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const OX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ox.js');
const offers = [];
const model = http.createServer((req, res) => {
  let b = '';
  req.on('data', (d) => (b += d));
  req.on('end', () => {
    const j = JSON.parse(b || '{}');
    const sse = (o) => `data: ${JSON.stringify(o)}\n\n`;
    const say = (text) => res.end(sse({ choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n');
    const call = (name, args) => res.end(sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `c${offers.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] }) + 'data: [DONE]\n\n');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const msgs = j.messages ?? [];
    const users = msgs.filter((m) => m.role === 'user').map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
    const tool = [...msgs].reverse().find((m) => m.role === 'tool');
    offers.push((j.tools ?? []).map((t) => t.function?.name ?? t.name));
    if (/COUNT-THE-FILES/.test(users)) return say('HELPER-DONE: there are 2 files');   // the helper's own run
    if (!tool) return call('subagent', { task: 'COUNT-THE-FILES in this folder and report the number', description: 'counter' });
    return say(`LEAD-DONE after: ${String(tool.content).slice(0, 300)}`);
  });
});
await new Promise((r) => model.listen(0, '127.0.0.1', r));
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-delegate-'));
fs.writeFileSync(path.join(cwd, 'a.txt'), 'a');
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/_API_KEY$|^OX_/.test(k)));
Object.assign(env, { HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'ox-delegate-h-')), OX_ISLAND: '0', OX_NO_PLUGINS: '1', OX_NO_AWAKE: '1', OX_LEARN: '0', OX_USAGE_LOG: '0', OX_BASE_URL: `http://127.0.0.1:${model.address().port}/v1`, OX_API_KEY: 'x' });
const port = 40000 + Math.floor(Math.random() * 20000);
const srv = spawn(process.execPath, [OX, 'serve', '--port', String(port)], { cwd, env, stdio: 'ignore' });
after(() => { srv.kill(); model.close(); });
for (let i = 0; i < 100; i++) {
  try { await fetch(`http://127.0.0.1:${port}/`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
}

test('a chat in the app delegates to a helper that really runs, and the agents can see each other', async () => {
  const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'custom:m', stream: true, ox_mode: 'orchestrate', messages: [{ role: 'user', content: 'split this up: count the files here using a helper agent' }] }),
  });
  const text = await r.text();
  const content = text.split('\n\n').map((f) => f.replace(/^data: /, '')).filter((f) => f && f !== '[DONE]')
    .map((f) => { try { return JSON.parse(f); } catch { return {}; } }).map((f) => f.choices?.[0]?.delta?.content ?? '').join('');
  assert.doesNotMatch(content, /not configured/);
  assert.match(content, /LEAD-DONE after:[\s\S]*HELPER-DONE: there are 2 files/);
  const leadOffer = offers[0];
  for (const t of ['subagent', 'agent_status', 'agent_message.send', 'agent_observe']) assert.ok(leadOffer.includes(t), `lead offered ${t}: ${leadOffer.join(',')}`);
});
