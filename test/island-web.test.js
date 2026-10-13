// The web island (Windows/Linux, and anywhere): a live ox run shows up, its
// approval can be answered over loopback HTTP with the launch token, and
// nothing works without the token.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createIslandServer, createRunWatcher } from '../src/island-web.js';
import { listIpcSockets, socketPathFor } from '../src/ipc.js';

const OX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ox.js');

test('sockets are named pipes on Windows and files elsewhere', () => {
  assert.equal(socketPathFor('run-7', os.tmpdir(), 'win32'), '\\\\.\\pipe\\ox-ipc-run-7');
  assert.equal(socketPathFor('run-7', os.tmpdir(), 'darwin'), path.join(os.tmpdir(), 'ox-ipc-run-7.sock'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-socks-'));
  fs.writeFileSync(path.join(dir, 'ox-ipc-a.sock'), '');
  fs.writeFileSync(path.join(dir, 'other.sock'), '');
  assert.deepEqual(listIpcSockets(dir, 'linux'), [path.join(dir, 'ox-ipc-a.sock')]);
});

// A model that wants to write a file: the run parks on an approval.
const server = http.createServer((req, res) => {
  let b = '';
  req.on('data', (d) => (b += d));
  req.on('end', () => {
    const j = JSON.parse(b || '{}');
    const sse = (o) => `data: ${JSON.stringify(o)}\n\n`;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if ((j.messages ?? []).some((m) => m.role === 'tool')) {
      res.end(sse({ choices: [{ index: 0, delta: { content: 'done' }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n');
    } else {
      const call = { index: 0, id: 'c1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'approved.txt', content: 'yes' }) } };
      res.end(sse({ choices: [{ index: 0, delta: { tool_calls: [call] }, finish_reason: 'tool_calls' }] }) + 'data: [DONE]\n\n');
    }
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
after(() => server.close());

test('a run appears on the web island and its approval is answered from there', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-iw-home-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-iw-proj-'));
  // The island is "live" for this HOME: runs started under it open their socket.
  fs.mkdirSync(path.join(home, '.ox'), { recursive: true });
  fs.writeFileSync(path.join(home, '.ox', 'island.json'), JSON.stringify({ pid: process.pid, kind: 'web' }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/_API_KEY$|^OX_/.test(k)));
  Object.assign(env, { HOME: home, NO_COLOR: '1', OX_NO_PLUGINS: '1', OX_NO_BUILTIN_SKILLS: '1', OX_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`, OX_API_KEY: 'x' });
  const run = spawn(process.execPath, [OX, '--bot', 'custom:m', '-p', 'write approved.txt'], { cwd, env });
  let out = '';
  run.stdout.on('data', (d) => (out += d));
  run.stderr.on('data', (d) => (out += d));
  const done = new Promise((r) => run.on('close', r));

  // Only this test's run: the machine may have real ox runs open too.
  const mine = socketPathFor(`run-${run.pid}`);
  const island = await createIslandServer({ watcher: createRunWatcher({ list: () => listIpcSockets().filter((s) => s === mine) }) });
  after(() => island.close());
  const base = `http://127.0.0.1:${island.port}`;
  const get = (p, headers = {}) => fetch(base + p, { headers: { 'x-ox-token': island.token, ...headers } });

  assert.equal((await fetch(`${base}/api/state`)).status, 401, 'no token, no data');
  // fetch will not send a custom Host, so this one is a raw request: the shape a
  // DNS-rebinding page produces.
  const rebound = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: island.port, path: '/api/state', headers: { host: 'evil.example', 'x-ox-token': island.token } }, (res) => { res.resume(); resolve(res.statusCode); });
  });
  assert.equal(rebound, 403, 'a foreign Host is refused');
  assert.match(await (await get(`/?t=${island.token}`)).text(), /<title>ox island<\/title>/);

  let pending = null;
  for (let i = 0; i < 100 && !pending; i++) {
    await new Promise((r) => setTimeout(r, 150));
    const st = await (await get('/api/state')).json();
    const r = st.runs.find((x) => x.approvals.length);
    if (r) pending = { socket: r.socket, ...r.approvals[0], project: r.project };
  }
  assert.ok(pending, `the run's approval reached the island\n${out}`);
  assert.equal(pending.tool, 'write_file');
  assert.equal(pending.project, path.basename(cwd));
  const bad = await fetch(`${base}/api/answer`, { method: 'POST', headers: { 'x-ox-token': island.token }, body: JSON.stringify({ ...pending, decision: 'yes please' }) });
  assert.equal(bad.status, 400, 'only allow/deny/ask go on the wire');
  const ans = await (await fetch(`${base}/api/answer`, { method: 'POST', headers: { 'x-ox-token': island.token }, body: JSON.stringify({ socket: pending.socket, id: pending.id, decision: 'allow' }) })).json();
  assert.equal(ans.ok, true);
  await done;
  assert.equal(fs.readFileSync(path.join(cwd, 'approved.txt'), 'utf8'), 'yes', out);
});
