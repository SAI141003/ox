import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

test('ox brain over MCP: remember, search, read, supersede, retire', async () => {
  const { serveBrainMcp, createBrainTools, BRAIN_MCP_TOOLS } = await import('../src/brain-mcp.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-brainmcp-'));
  const input = new PassThrough(), output = new PassThrough();
  const replies = new Map();
  let buf = '';
  output.on('data', (d) => { buf += d; let nl; while ((nl = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1); replies.set(m.id, m); } });
  serveBrainMcp({ input, output, call: createBrainTools({ dir, embed: null }) });
  let id = 0;
  const rpc = async (method, params) => { const n = ++id; input.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`); for (let i = 0; i < 200 && !replies.has(n); i++) await new Promise((r) => setTimeout(r, 10)); return replies.get(n).result; };
  const tool = async (name, args) => (await rpc('tools/call', { name, arguments: args })).content[0].text;
  assert.equal((await rpc('initialize', {})).serverInfo.name, 'ox-brain');
  assert.equal((await rpc('tools/list', {})).tools.length, BRAIN_MCP_TOOLS.length);
  assert.match(await tool('remember', { title: 'Invoice terms', body: 'Acme pays net-30.', tags: ['billing'] }), /saved/);
  assert.match(await tool('search', { query: 'Acme net-30' }), /Invoice terms/);
  assert.match(await tool('remember', { title: 'Invoice terms 2026', body: 'Acme pays net-45 from November.', supersedes: ['Invoice terms'] }), /saved/);
  assert.match(await tool('read_note', { title: 'Invoice terms' }), /no longer current/);
  assert.doesNotMatch(await tool('list_notes', {}), /- Invoice terms \(/);
  assert.match(await tool('retire_note', { title: 'Invoice terms 2026', reason: 'contract ended' }), /no longer current/);
  assert.equal((await rpc('tools/call', { name: 'read_note', arguments: { title: 'nope' } })).isError, true);
  fs.rmSync(dir, { recursive: true, force: true });
});
