// Type errors after an edit, from a language server on this machine. A small fake server speaks
// the real protocol here, so nothing needs installing.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-lsp-'));
const log = path.join(dir, 'server.log');
const server = path.join(dir, 'fake-lsp.mjs');
fs.writeFileSync(server, `
const send = (m) => { const b = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...m })); process.stdout.write('Content-Length: ' + b.length + '\\r\\n\\r\\n'); process.stdout.write(b); };
let buf = Buffer.alloc(0);
const diagnose = (uri, text) => {
  send({ method: 'textDocument/publishDiagnostics', params: { uri, diagnostics: [] } });
  setTimeout(() => {
    const diagnostics = [];
    text.split('\\n').forEach((l, i) => {
      if (l.includes('BAD')) diagnostics.push({ severity: 1, range: { start: { line: i, character: l.indexOf('BAD') } }, message: 'Cannot find name BAD.\\nmore detail' });
      if (l.includes('MEH')) diagnostics.push({ severity: 2, range: { start: { line: i, character: 0 } }, message: 'only a warning' });
    });
    send({ method: 'textDocument/publishDiagnostics', params: { uri, diagnostics } });
  }, 30);
};
process.stdin.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  for (;;) {
    const end = buf.indexOf('\\r\\n\\r\\n'); if (end < 0) return;
    const len = Number(/content-length: (\\d+)/i.exec(buf.subarray(0, end).toString())[1]);
    if (buf.length < end + 4 + len) return;
    const m = JSON.parse(buf.subarray(end + 4, end + 4 + len).toString()); buf = buf.subarray(end + 4 + len);
    if (m.method === 'initialize') { send({ id: 99, method: 'workspace/configuration', params: { items: [{}] } }); send({ id: m.id, result: { capabilities: {} } }); }
    if (m.method === 'textDocument/didOpen') diagnose(m.params.textDocument.uri, m.params.textDocument.text);
    if (m.method === 'textDocument/didChange') diagnose(m.params.textDocument.uri, m.params.contentChanges[0].text);
  }
});
`);
const bin = path.join(dir, 'fake-lsp');
fs.writeFileSync(bin, `#!/bin/sh\necho started >> "${log}"\nexec "${process.execPath}" "${server}"\n`);
fs.chmodSync(bin, 0o755);
const project = path.join(dir, 'proj');
fs.mkdirSync(project);
fs.writeFileSync(path.join(project, 'package.json'), '{}');
const env = { ...process.env, OX_LSP: '1', OX_LSP_SERVER: bin };

const L = await import('../src/lsp.js');
after(() => { L.closeAllLsp(); fs.rmSync(dir, { recursive: true, force: true }); });

test('errors come back after a write, warnings do not, and the fix clears them on the same server', async () => {
  const f = path.join(project, 'a.ts');
  fs.writeFileSync(f, 'const x = 1;\nconst y = BAD;\nconst z = MEH;\n');
  const note = await L.diagnosticsFor(f, { cwd: project, env });
  assert.match(note, /reports 1 error in this file/);
  assert.match(note, /a\.ts:2:11 Cannot find name BAD\./);
  assert.doesNotMatch(note, /warning|more detail/);
  fs.writeFileSync(f, 'const x = 1;\n');
  assert.equal(await L.diagnosticsFor(f, { cwd: project, env }), '');
  assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 1, 'one server for the project');
});

test('the edit tool result carries the error', async () => {
  const { editFileTool, writeFileTool } = await import('../src/tools/fs.js');
  const saved = { OX_LSP: process.env.OX_LSP, OX_LSP_SERVER: process.env.OX_LSP_SERVER };
  Object.assign(process.env, { OX_LSP: '1', OX_LSP_SERVER: bin });
  try {
    const ctx = { cwd: project, yolo: true };
    const w = await writeFileTool({ path: 'b.ts', content: 'const a = BAD;\n' }, ctx);
    assert.equal(w.isError, undefined, w.content);
    assert.match(w.content, /b\.ts:1:11 Cannot find name BAD/);
    const e = await editFileTool({ path: 'b.ts', old_string: 'BAD', new_string: '2' }, ctx);
    assert.doesNotMatch(e.content, /language server/);
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('no server, another kind of file, or switched off: nothing said, nothing started', async () => {
  const f = path.join(project, 'c.ts');
  fs.writeFileSync(f, 'BAD');
  const bare = { ...process.env, OX_LSP: '1', OX_LSP_SERVER: '', PATH: path.join(dir, 'nothing') };
  assert.equal(L.serverFor(f, { cwd: project, env: bare }), null);
  assert.equal(await L.diagnosticsFor(f, { cwd: project, env: bare }), '');
  assert.equal(await L.diagnosticsFor(f, { cwd: project, env: { ...env, OX_LSP: '0' } }), '');
  assert.equal(await L.diagnosticsFor(f, { cwd: project, env, config: { lsp: false } }), '');
  const notes = path.join(project, 'notes.md');
  fs.writeFileSync(notes, 'BAD');
  assert.equal(await L.diagnosticsFor(notes, { cwd: project, env }), '');
  const { NODE_TEST_CONTEXT, ...plain } = process.env;
  assert.equal(L.lspEnabled({ NODE_TEST_CONTEXT: 'x' }), false, 'a test never starts your real servers by accident');
  assert.equal(L.lspEnabled(plain.OX_LSP === '0' ? {} : { ...plain, OX_LSP: undefined }), true);
});

test('a server that never answers costs a few seconds at most, and says nothing', async () => {
  const mute = path.join(dir, 'mute');
  fs.writeFileSync(mute, '#!/bin/sh\nsleep 30\n');
  fs.chmodSync(mute, 0o755);
  const f = path.join(project, 'd.ts');
  fs.writeFileSync(f, 'BAD');
  const t = Date.now();
  assert.equal(await L.diagnosticsFor(f, { cwd: project, env: { ...env, OX_LSP_SERVER: mute }, startMs: 300 }), '');
  assert.ok(Date.now() - t < 2000);
});
