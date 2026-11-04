// The main computer, on real homes: becoming main takes its owner's yes on the
// other computer, gives a known set of permissions, never screen or control, and
// moves cleanly. Being called main by another computer gives nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as M from '../src/mesh.js';

const home = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ox-mesh-main-'));
const until = async (fn, ms = 5000) => { const t = Date.now(); for (;;) { const v = fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 15)); } };
const asks = (n) => n.status().alerts.filter((a) => a.kind === 'approval');
const on = (id, h) => Object.entries(Object.values(M.readPeers({ home: h })).find((p) => p.id === id).grants).filter(([, v]) => v).map(([k]) => k).sort();

async function pair() {
  const ha = home(), hb = home();
  const base = { port: 0, proxyPort: 0, beacon: false, heartbeat: false, host: '127.0.0.1', approvals: true };
  M.setName('One', { home: ha });
  M.setName('Two', { home: hb });
  const A = await M.startNode({ home: ha, ...base, remoteControl: async () => ({ mime: 'image/png', data: Buffer.from('png'), points: { w: 100, h: 50 } }) });
  const B = await M.startNode({ home: hb, ...base, remoteControl: async (op) => (op === 'screen' ? { mime: 'image/png', data: Buffer.from('png'), points: { w: 100, h: 50 } } : { text: `did ${op}` }) });
  const { code } = A.invite();
  await M.join({ code, at: `127.0.0.1:${A.port}`, name: 'Two', o: { home: hb }, myPort: B.port });
  const idA = M.identity({ home: ha }).id, idB = M.identity({ home: hb }).id;
  return { A, B, ha, hb, idA, idB, close: async () => { await A.close().catch(() => {}); await B.close().catch(() => {}); } };
}

test('asking to be main waits for the other owner; yes gives the known set, and no screen or control', async () => {
  const { A, B, hb, idA, close } = await pair();
  try {
    const asking = A.setMain();
    const ask = (await until(() => asks(B)[0] && asks(B)))[0];
    assert.match(ask.text, /One wants to become your main computer.*Never your screen or controls/);
    assert.deepEqual(ask.options.map((o) => o.label), ['Make it main', 'Not now']);
    assert.deepEqual(on(idA, hb), ['status'], 'nothing is given before the answer');
    B.choose(ask.id, { action: 'approve-once' });
    const r = await asking;
    assert.equal(r.main.name, 'One');
    assert.deepEqual(on(idA, hb), [...M.MAIN_GRANTS].sort());
    assert.equal(on(idA, hb).includes('screen'), false);
    assert.equal(on(idA, hb).includes('control'), false);
    assert.equal(B.mainNow().name, 'One');
    assert.equal(A.mainNow().self, true);
    // It now works without asking; screen and control are still refused.
    await A.ask('Two', 'agents', {});
    assert.equal(asks(B).length, 0);
    await assert.rejects(A.ask('Two', 'screen', {}), /does not allow screen/);
    await assert.rejects(A.ask('Two', 'control-click', { x: 1, y: 1 }), /does not allow control/);
  } finally { await close(); }
});

test('no: nothing changes on either computer, and the reason comes back', async () => {
  const { A, B, ha, hb, idA, close } = await pair();
  try {
    const asking = A.setMain();
    const ask = (await until(() => asks(B)[0] && asks(B)))[0];
    B.choose(ask.id, { action: 'approve-deny' });
    const r = await asking;
    assert.equal(r.results[0].ok, false);
    assert.match(r.results[0].why, /did not accept One as main: its owner declined/);
    assert.equal(M.readMain({ home: ha }), null);
    assert.equal(M.readMain({ home: hb }), null);
    assert.deepEqual(on(idA, hb), ['status']);
  } finally { await close(); }
});

test('switching main: the new main gets the set, and the old loses only what the role gave it', async () => {
  const { A, B, ha, hb, idA, idB, close } = await pair();
  try {
    M.setGrant('One', 'message', true, { home: hb }); // the owner's own choice, before any of this
    const asking = A.setMain();
    B.choose((await until(() => asks(B)[0] && asks(B)))[0].id, { action: 'approve-once' });
    await asking;
    assert.deepEqual(on(idA, hb), [...M.MAIN_GRANTS].sort());

    // From One, the owner says: Two is main now. One's say over One, so no asking.
    const r = await A.setMain('Two');
    assert.equal(r.main.name, 'Two');
    assert.equal(asks(A).length, 0);
    assert.deepEqual(on(idB, ha), [...M.MAIN_GRANTS].sort());
    assert.equal(A.mainNow().name, 'Two');
    assert.equal(B.mainNow().self, true, 'Two hears it is main');
    assert.deepEqual(on(idA, hb), ['message', 'status'], 'One keeps what the owner gave it, and only that');
  } finally { await close(); }
});

test('a computer calling itself main gets no permission on another', async () => {
  const { A, B, hb, idA, idB, close } = await pair();
  try {
    await A.ask('Two', 'main-notice', { id: idA, at: Date.now() + 100000 });
    await A.ask('Two', 'main-notice', { id: idB, at: Date.now() + 100000 });
    assert.deepEqual(on(idA, hb), ['status']);
    await assert.rejects(A.ask('Two', 'agents', {}), /does not allow agents/);
    assert.equal(asks(B).length, 0);
  } finally { await close(); }
});

test('with nobody at the other computer, main is refused plainly', async () => {
  const ha = home(), hb = home();
  const base = { port: 0, proxyPort: 0, beacon: false, heartbeat: false, host: '127.0.0.1' };
  M.setName('One', { home: ha });
  const A = await M.startNode({ home: ha, ...base }), B = await M.startNode({ home: hb, ...base });
  try {
    const { code } = A.invite();
    await M.join({ code, at: `127.0.0.1:${A.port}`, name: 'Two', o: { home: hb }, myPort: B.port });
    const r = await A.setMain();
    assert.match(r.results[0].why, /has nobody to ask/);
    assert.equal(M.readMain({ home: ha }), null);
  } finally { await A.close(); await B.close(); }
});

test('sessions asked for once stay readable for the 30 minutes, without asking each poll', async () => {
  const { A, B, close } = await pair();
  try {
    const first = A.ask('Two', 'agents-ask', {}, { timeoutMs: 15000 });
    const ask = (await until(() => asks(B)[0] && asks(B)))[0];
    assert.match(ask.text, /see, read or message the coding sessions/);
    assert.equal(ask.options[0].label, 'Allow for 30 minutes');
    B.choose(ask.id, { action: 'approve-once' });
    assert.ok(Array.isArray((await first).sessions));
    assert.ok(Array.isArray((await A.ask('Two', 'agents', {})).sessions));
    assert.equal(asks(B).length, 0);
  } finally { await close(); }
});

test('screen and control work once that computer turned each on, and only then', async () => {
  const { A, hb, close } = await pair();
  try {
    M.setGrant('One', 'screen', true, { home: hb });
    const parts = [];
    const shot = await A.ask('Two', 'screen', {}, { onChunk: (c) => parts.push(c) });
    assert.equal(Buffer.concat(parts).toString(), 'png');
    assert.deepEqual(shot.points, { w: 100, h: 50 });
    await assert.rejects(A.ask('Two', 'control-click', { x: 1, y: 1 }), /does not allow control/);
    M.setGrant('One', 'control', true, { home: hb });
    assert.equal((await A.ask('Two', 'control-click', { x: 1, y: 1 })).text, 'did control-click');
  } finally { await close(); }
});

test('the page, the routes and the release step are in place', () => {
  const page = fs.readFileSync(new URL('../src/web/machines.html', import.meta.url), 'utf8');
  const serve = fs.readFileSync(new URL('../src/serve.js', import.meta.url), 'utf8');
  const chat = fs.readFileSync(new URL('../src/web/chat.html', import.meta.url), 'utf8');
  const flow = fs.readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  for (const route of ['/ox/mesh/everything', '/ox/mesh/main', '/ox/mesh/ls', '/ox/mesh/file/read', '/ox/mesh/file/save', '/ox/mesh/screen', '/ox/mesh/control', '/ox/mesh/agent/read']) {
    assert.ok(page.includes(route), route);
    assert.ok(serve.includes(route.replaceAll('/', '\\/')), route);
  }
  assert.match(serve, /path === '\/machines' \? '\.\/web\/machines\.html'/);
  assert.match(chat, /machines: \['laptop', 'Machines'\]/);
  assert.match(flow, /--latest=false/);
  assert.match(flow, /publish:\n\s+needs: package/);
});

// The tools keep sessions under the person's home. ox's own folder used to be
// searched instead, so a session on another computer always read as missing.
test('a real session file on the other computer can be read over the mesh', async () => {
  const { A, hb, close } = await pair();
  const id = crypto.randomUUID();
  const dir = path.join(os.homedir(), '.claude', 'projects', `-ox-mesh-read-${id}`);
  fs.mkdirSync(dir, { recursive: true });
  const line = (type, content) => JSON.stringify({ type, sessionId: id, cwd: dir, timestamp: new Date().toISOString(), message: { role: type, content } });
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), `${line('user', 'are you there')}\n${line('assistant', [{ type: 'text', text: 'yes I am' }])}\n`);
  try {
    M.setGrant('One', 'agents', true, { home: hb });
    const r = await A.ask('Two', 'agent-read', { id: `claude:${id}` }, { timeoutMs: 15000 });
    assert.deepEqual(r.messages.map((m) => m.text), ['are you there', 'yes I am']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); await close(); }
});

test('the page does not offer a key ox refuses to press', () => {
  const page = fs.readFileSync(new URL('../src/web/machines.html', import.meta.url), 'utf8');
  assert.doesNotMatch(page, /data-k="return"/);
});

test('a floor nobody shared offers to ask, instead of a terminal command', () => {
  const office = fs.readFileSync(new URL('../src/web/office.html', import.meta.url), 'utf8');
  const serve = fs.readFileSync(new URL('../src/serve.js', import.meta.url), 'utf8');
  assert.match(office, /f\.needsAccess/);
  assert.match(office, /'\/ox\/mesh\/agents\/ask'/);
  assert.doesNotMatch(serve, /does not share its agents/);
});
