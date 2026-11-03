// Pairing, then chatting, on two ox homes with real nodes: both directions, a
// real `ox -p` turn on the other machine's model, and a task run over the mesh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as M from '../src/mesh.js';
import { meshCatalogEntries } from '../src/serve.js';

const OX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ox.js');
const home = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ox-mesh-chat-'));

// A local model server, answering both plain and streaming requests.
async function fakeModel(words) {
  const s = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      if (req.url === '/api/tags') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ models: [{ name: 'tiny:latest', size: 1 }] }));
      if (!req.url.endsWith('/chat/completions')) return res.writeHead(404).end();
      if (JSON.parse(raw).stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: words }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
        return res.end('data: [DONE]\n\n');
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: words }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${s.address().port}`, close: () => new Promise((r) => { s.closeAllConnections?.(); s.close(r); }) };
}

const node = (h, extra = {}) => M.startNode({ home: h, port: 0, proxyPort: 0, beacon: false, heartbeat: false, host: '127.0.0.1', ...extra });

function runOx(args, env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [OX, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    const t = setTimeout(() => p.kill('SIGKILL'), 60_000);
    p.on('close', (code) => { clearTimeout(t); resolve({ code, out }); });
  });
}

test('paired computers chat both ways once each allows the other', async () => {
  const ha = home(), hb = home();
  M.setName('Studio', { home: ha });
  const modelA = await fakeModel('hello from Studio');
  const modelB = await fakeModel('hello from Laptop');
  const A = await node(ha, { ollamaUrl: modelA.url });
  const B = await node(hb, { ollamaUrl: modelB.url });
  try {
    const { code } = A.invite();
    await M.join({ code, at: `127.0.0.1:${A.port}`, name: 'Laptop', o: { home: hb }, myPort: B.port });

    // Connected, status only: a chat either way is refused and says where to allow it.
    const body = { model: 'tiny', messages: [{ role: 'user', content: 'hi' }] };
    await assert.rejects(A.ask('Laptop', 'infer', { body }), /Answer chats in OX › Settings › Offline & devices › Manage Studio/);
    await assert.rejects(B.ask('Studio', 'infer', { body }), /Answer chats in OX › Settings › Offline & devices › Manage Laptop/);

    M.setGrant('Studio', 'infer', true, { home: hb }); // on Laptop: Studio may chat
    M.setGrant('Laptop', 'infer', true, { home: ha }); // on Studio: Laptop may chat

    const through = async (proxy, machine) => {
      const r = await fetch(`http://127.0.0.1:${proxy}/mesh/${encodeURIComponent(machine)}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal(r.status, 200);
      return (await r.json()).choices[0].message.content;
    };
    assert.equal(await through(A.proxyPort, 'Laptop'), 'hello from Laptop');
    assert.equal(await through(B.proxyPort, 'Studio'), 'hello from Studio');

    // The other computer's models are what the app's model list offers.
    await A.heartbeat();
    const ids = meshCatalogEntries(A.machines()).map((m) => m.id);
    assert.ok(ids.includes('mesh:Laptop/tiny:latest'), `the model list offers it: ${ids}`);

    // A real turn from the terminal on Studio, answered by Laptop's model.
    const turn = await runOx(['-p', 'hi', '--model', 'mesh:Laptop/tiny:latest'], { HOME: ha, OX_HOME: path.join(ha, '.ox'), OX_MESH_PROXY_PORT: String(A.proxyPort), OX_ISLAND: '0', OX_LEARN: '0', OX_NO_KEYSTORE: '1', OX_NO_PLUGINS: '1', OX_NO_BUILTIN_SKILLS: '1' });
    assert.equal(turn.code, 0, turn.out);
    assert.match(turn.out, /hello from Laptop/);
  } finally {
    await A.close().catch(() => {});
    await B.close().catch(() => {});
    await modelA.close();
    await modelB.close();
  }
});

test('a task sent to a paired computer runs there and its output comes back', async () => {
  const ha = home(), hb = home();
  M.setName('Studio', { home: ha });
  const model = await fakeModel('task done on Laptop');
  const saved = { ...process.env };
  // The task runs as `ox -p` on the machine that serves it, with that machine's settings.
  Object.assign(process.env, { HOME: hb, OX_HOME: path.join(hb, '.ox'), OX_BASE_URL: `${model.url}/v1`, OX_MODEL: 'tiny', OX_API_KEY: 'test-key', OX_ISLAND: '0', OX_LEARN: '0', OX_NO_KEYSTORE: '1', OX_NO_PLUGINS: '1', OX_NO_BUILTIN_SKILLS: '1' });
  const A = await node(ha);
  const B = await node(hb);
  try {
    const { code } = A.invite();
    await M.join({ code, at: `127.0.0.1:${A.port}`, name: 'Laptop', o: { home: hb }, myPort: B.port });
    await assert.rejects(A.ask('Laptop', 'run', { prompt: 'hi' }), /Run tasks in OX › Settings › Offline & devices › Manage Studio/);
    M.setGrant('Studio', 'tasks', true, { home: hb });
    const chunks = [];
    const r = await A.ask('Laptop', 'run', { prompt: 'say done', cwd: hb }, { timeoutMs: 60_000, onChunk: (c) => chunks.push(Buffer.from(c).toString('utf8')) });
    assert.equal(r.code, 0, chunks.join(''));
    assert.match(chunks.join(''), /task done on Laptop/);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    await A.close().catch(() => {});
    await B.close().catch(() => {});
    await model.close();
  }
});
