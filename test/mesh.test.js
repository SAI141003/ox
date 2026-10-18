// ox mesh (src/mesh.js): pairing with a one-time code, the sealed channel,
// grants set on the machine that gives, model calls through another machine,
// φ liveness and the watchdog's alerts with choices.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import * as M from '../src/mesh.js';

const home = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ox-mesh-'));

// A stand-in for Ollama on the giving machine.
async function fakeOllama() {
  const calls = [];
  const s = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      if (req.url === '/api/tags') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ models: [{ name: 'tiny:latest', size: 1 }] }));
      if (req.url === '/v1/chat/completions') {
        calls.push(JSON.parse(raw));
        return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'pong from B' } }] }));
      }
      res.writeHead(404).end();
    });
  });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${s.address().port}`, calls, close: () => new Promise((r) => s.close(r)) };
}

const node = (h, extra = {}) => M.startNode({ home: h, port: 0, proxyPort: 0, beacon: false, heartbeat: false, host: '127.0.0.1', ...extra });

test('identity: id is a hash of the key, made once, named', () => {
  const h = home();
  const a = M.identity({ home: h });
  assert.match(a.id, /^[A-Z2-7]{16}$/);
  assert.equal(M.identity({ home: h }).id, a.id);
  assert.equal(M.setName('Studio Mac', { home: h }), 'Studio Mac');
  assert.equal(M.identity({ home: h }).name, 'Studio Mac');
  assert.equal((fs.statSync(a.file).mode & 0o777).toString(8), '600');
});

test('codes: 60 bits in OX-XXXX-XXXX-XXXX, never the same twice', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) { const c = M.newCode(); assert.match(c, /^OX-[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/); seen.add(c); }
  assert.equal(seen.size, 200);
});

test('pair with a code, then status, grants, a model call on the other machine, and forget', async () => {
  const ha = home(), hb = home();
  M.setName('Studio Mac', { home: ha });
  const ollama = await fakeOllama();
  const A = await node(ha);
  const B = await node(hb, { ollamaUrl: ollama.url });
  try {
    const { code } = A.invite();
    const peer = await M.join({ code: code.toLowerCase().replace(/-/g, ' '), at: `127.0.0.1:${A.port}`, name: 'Gaming laptop', o: { home: hb }, myPort: B.port });
    assert.equal(peer.name, 'Studio Mac');
    assert.equal(M.findPeer('gaming laptop', { home: ha }).id, M.identity({ home: hb }).id, 'A pinned B under the name B chose');
    assert.equal(A.state.invite, null, 'the code is used up');

    // Status is on by default.
    const s = await A.ask('Gaming laptop', 'stats');
    assert.deepEqual(s.models.map((m) => m.name), ['tiny:latest']);
    assert.ok(typeof s.load === 'number' && typeof s.mem === 'number');

    // Model calls are off until B allows them, on B.
    await assert.rejects(A.ask('Gaming laptop', 'infer', { body: { model: 'tiny', messages: [] } }), /does not allow model calls/);
    M.setGrant('Studio Mac', 'infer', true, { home: hb });

    // Through A's local endpoint, as an OpenAI-compatible server.
    const r = await fetch(`http://127.0.0.1:${A.proxyPort}/mesh/${encodeURIComponent('Gaming laptop')}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'tiny', messages: [{ role: 'user', content: 'ping' }] }),
    });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).choices[0].message.content, 'pong from B');
    assert.equal(ollama.calls.length, 1);

    // Tasks stay off.
    await assert.rejects(A.ask('Gaming laptop', 'run', { prompt: 'hi' }), /does not allow tasks/);

    // Heartbeat fills the machine list.
    await A.heartbeat();
    const ms = A.machines();
    assert.equal(ms.length, 1);
    assert.equal(ms[0].name, 'Gaming laptop');
    assert.equal(ms[0].error, null);

    // Forgotten on B: B refuses A from then on.
    M.forget('Studio Mac', { home: hb });
    await A.close();
    const A2 = await node(ha);
    try {
      await assert.rejects(A2.ask('Gaming laptop', 'stats'), /not a paired machine/);
    } finally { await A2.close(); }
  } finally {
    await B.close().catch(() => {});
    await A.close().catch(() => {});
    await ollama.close();
  }
});

test('three wrong codes close the invite; a code without an invite is refused', async () => {
  const ha = home(), hb = home();
  const A = await node(ha);
  try {
    await assert.rejects(M.join({ code: 'OX-AAAA-AAAA-AAAA', at: `127.0.0.1:${A.port}`, o: { home: hb } }), /no invite/);
    A.invite();
    for (let i = 0; i < 3; i++) await assert.rejects(M.join({ code: 'OX-AAAA-AAAA-AAAA', at: `127.0.0.1:${A.port}`, o: { home: hb } }), /wrong code|closed|refused/);
    assert.equal(A.state.invite, null);
    assert.deepEqual(M.readPeers({ home: ha }), {});
    assert.deepEqual(M.readPeers({ home: hb }), {});
  } finally { await A.close(); }
});

test('a reinstalled machine (new key, same id claimed) is refused', async () => {
  const ha = home(), hb = home();
  const A = await node(ha);
  const B = await node(hb);
  try {
    const { code } = A.invite();
    await M.join({ code, at: `127.0.0.1:${A.port}`, o: { home: hb }, myPort: B.port });
    // B's key changes underneath A's pin.
    const peers = JSON.parse(fs.readFileSync(path.join(ha, 'mesh', 'peers.json'), 'utf8'));
    const id = Object.keys(peers.peers)[0];
    peers.peers[id].pub = Buffer.alloc(32, 7).toString('base64');
    fs.writeFileSync(path.join(ha, 'mesh', 'peers.json'), JSON.stringify(peers));
    await assert.rejects(A.ask(id, 'stats'), /key changed/);
  } finally { await B.close(); await A.close(); }
});

test('φ rises when heartbeats stop', () => {
  const p = new M.Phi();
  for (let t = 0; t <= 50_000; t += 5000) p.beat(t);
  assert.ok(p.phi(55_000) < 1, 'on time');
  assert.ok(p.phi(70_000) >= 8, 'three beats late: suspect');
});

test('watchdog: sustained load and a plan near its limit become alerts with choices, never actions', () => {
  const busy = { id: 'A', name: 'Gaming laptop', phi: 0, stats: { load: 0.95, mem: 0.5, models: [], providers: [], plans: [{ label: 'Claude', percent: 88, window: '5-hour' }] } };
  const idle = { id: 'B', name: 'Studio Mac', phi: 0, stats: { load: 0.1, mem: 0.3, models: [{ name: 'qwen2.5:7b' }], providers: ['openrouter'], plans: [] } };
  let alerts = M.watchdog([busy, idle], { now: 0 });
  assert.ok(!alerts.some((a) => a.kind === 'overloaded'), 'not yet sustained');
  const credits = alerts.find((a) => a.kind === 'credits');
  assert.match(credits.text, /Claude plan is at 88 % of its 5-hour window/);
  assert.deepEqual(credits.options.map((o) => o.model ?? o.action), ['mesh:Studio Mac/qwen2.5:7b', 'mesh:Studio Mac/openrouter', 'keep']);
  alerts = M.watchdog([busy, idle], { now: 61_000 });
  const load = alerts.find((a) => a.kind === 'overloaded');
  assert.match(load.text, /CPU 95 %/);
  assert.equal(load.options[0].label, 'Move its ox work to Studio Mac');
  assert.ok(load.options.some((o) => o.action === 'pause') && load.options.some((o) => o.action === 'snooze'));
  const down = M.watchdog([{ ...idle, phi: 13 }], { now: 0 })[0];
  assert.equal(down.kind, 'down');
});

test('mesh:<machine>/<model> resolves to this machine\'s loopback endpoint, keyless', async () => {
  const { resolveBot } = await import('../src/bots.js');
  const t = resolveBot('mesh:Gaming laptop/qwen2.5:7b', {});
  assert.equal(t.provider, 'custom');
  assert.equal(t.model, 'qwen2.5:7b');
  assert.equal(t.baseUrl, 'http://127.0.0.1:47872/mesh/Gaming%20laptop/v1');
  assert.equal(t.keyEnv, null);
});

test('control endpoint: status and invite for local tools only; choices snooze or name a model', async () => {
  const h = home();
  const A = await node(h);
  try {
    const base = `http://127.0.0.1:${A.proxyPort}/mesh-control`;
    assert.equal((await fetch(`${base}/status`)).status, 404, 'no header: refused (a web page cannot add it without a preflight)');
    const rebound = await new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: A.proxyPort, path: '/mesh-control/status', headers: { 'x-ox-mesh': '1', host: 'evil.example' } }, (r) => { r.resume(); resolve(r.statusCode); }).on('error', reject));
    assert.equal(rebound, 404, 'a rebound host name is refused');
    assert.equal((await fetch(`${base}/invite`, { method: 'POST', headers: { 'x-ox-mesh': '1', 'content-type': 'text/plain' }, body: '{}' })).status, 404, 'a form-style post is refused');
    const st = await M.control('status', { proxyPort: A.proxyPort });
    assert.equal(st.me.id, A.me.id);
    assert.equal(st.invite.open, false);
    const inv = await M.control('invite', { proxyPort: A.proxyPort, method: 'POST' });
    assert.match(inv.code, /^OX-/);
    assert.equal((await M.control('status', { proxyPort: A.proxyPort })).invite.open, true);

    A.state.alerts = [{ id: 'x:plan:claude', kind: 'credits', text: 't', options: [] }, { id: 'y:load', kind: 'overloaded', text: 't', options: [] }];
    assert.deepEqual(A.choose('x:plan:claude', { action: 'use-model', model: 'mesh:B/qwen' }).model, 'mesh:B/qwen');
    assert.match(A.choose('y:load', { action: 'snooze' }).done, /5 minutes/);
    assert.equal(A.state.alerts.length, 0);
    assert.ok(A.state.snoozed['y:load'] > Date.now());
    assert.throws(() => A.choose('gone', { action: 'snooze' }), /gone/);
    A.state.alerts = [{ id: 'z', kind: 'overloaded', text: 't', options: [] }];
    assert.equal(A.choose('z', { action: 'pause' }).done, null, 'moving or pausing work is never done by itself');
  } finally { await A.close(); }
});

test('v2: describe, agents, shared folders (no escaping them), audit, presets and lockdown', async () => {
  const ha = home(), hb = home();
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-share-'));
  fs.writeFileSync(path.join(shared, 'report.txt'), 'hello from B');
  fs.mkdirSync(path.join(shared, 'sub'));
  const secret = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-secret-'));
  fs.writeFileSync(path.join(secret, 'keys.txt'), 'nope');
  fs.symlinkSync(secret, path.join(shared, 'escape'));
  const A = await node(ha);
  const B = await node(hb);
  try {
    const { code } = A.invite();
    await M.join({ code, at: `127.0.0.1:${A.port}`, name: 'Laptop B', o: { home: hb }, myPort: B.port });
    const d = await A.ask('Laptop B', 'describe', {}, { timeoutMs: 20_000 });
    assert.ok(d.cores >= 1 && d.memGb >= 1 && typeof d.os === 'string' && Array.isArray(d.tools));
    await assert.rejects(A.ask('Laptop B', 'agents'), /does not allow agents/);
    await assert.rejects(A.ask('Laptop B', 'ls', { path: shared }), /does not allow files/);

    // Presets, set on B for A.
    M.setGrant(M.identity({ home: ha }).name, 'full', true, { home: hb });
    const g = Object.values(M.readPeers({ home: hb }))[0].grants;
    assert.deepEqual(g, { status: true, infer: true, tasks: true, files: true, agents: true });
    assert.ok(Array.isArray((await A.ask('Laptop B', 'agents', {}, { timeoutMs: 20_000 })).sessions));

    // Files only inside what B shares; a symlink out of it does not count.
    M.setRoots(M.identity({ home: ha }).name, [shared], { home: hb });
    const ls = await A.ask('Laptop B', 'ls', { path: shared });
    assert.deepEqual(ls.entries.map((e) => e.name).sort(), ['escape', 'report.txt', 'sub']);
    const chunks = [];
    const got = await A.ask('Laptop B', 'pull', { path: path.join(shared, 'report.txt') }, { onChunk: (b) => chunks.push(b) });
    assert.equal(Buffer.concat(chunks).toString(), 'hello from B');
    assert.equal(got.size, 12);
    await assert.rejects(A.ask('Laptop B', 'pull', { path: path.join(shared, 'escape', 'keys.txt') }), /outside the folders/);
    await assert.rejects(A.ask('Laptop B', 'ls', { path: os.homedir() }), /outside the folders/);
    await assert.rejects(A.ask('Laptop B', 'pull', { path: `${shared}/../${path.basename(secret)}/keys.txt` }), /outside the folders/);

    // Every request is in B's audit log.
    const { readAudit } = await import('../src/mesh-services.js');
    const ops = readAudit(path.join(hb)).map((r) => r.op);
    for (const op of ['describe', 'agents', 'ls', 'pull']) assert.ok(ops.includes(op), op);

    // Lockdown: back to status only, at once.
    assert.equal(M.lockdown({ home: hb }), 1);
    await assert.rejects(A.ask('Laptop B', 'agents'), /does not allow agents/);
    assert.ok((await A.ask('Laptop B', 'describe', {}, { timeoutMs: 20_000 })).cores >= 1, 'status stays');
  } finally { await B.close(); await A.close(); }
});
