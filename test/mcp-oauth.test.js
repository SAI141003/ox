// Signing in to a remote MCP server once (ox mcp login), against a local
// server that plays both the MCP endpoint and its OAuth authorization server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-mcp-oauth-'));
process.env.OX_HOME = path.join(home, '.ox');
const A = await import('../src/mcp-oauth.js');
const { McpHub } = await import('../src/mcp.js');
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

function fakeServer() {
  const seen = { auth: [], session: [] };
  let issued = 0;
  const codes = new Map();
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    let body = '';
    for await (const c of req) body += c;
    const base = `http://127.0.0.1:${server.address().port}`;
    const json = (code, obj, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };
    if (u.pathname === '/.well-known/oauth-protected-resource/mcp') return json(200, { resource: `${base}/mcp`, authorization_servers: [base] });
    if (u.pathname === '/.well-known/oauth-authorization-server') return json(200, { issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`, code_challenge_methods_supported: ['S256'] });
    if (u.pathname === '/register') return json(201, { client_id: 'client-1', ...JSON.parse(body) });
    if (u.pathname === '/authorize') {
      const code = crypto.randomBytes(8).toString('hex');
      codes.set(code, u.searchParams.get('code_challenge'));
      res.writeHead(302, { location: `${u.searchParams.get('redirect_uri')}?code=${code}&state=${u.searchParams.get('state')}` });
      return res.end();
    }
    if (u.pathname === '/token') {
      const f = new URLSearchParams(body);
      if (f.get('grant_type') === 'authorization_code') {
        const challenge = crypto.createHash('sha256').update(f.get('code_verifier')).digest('base64url');
        if (codes.get(f.get('code')) !== challenge) return json(400, { error: 'invalid_grant' });
      } else if (f.get('refresh_token') !== 'refresh-1') return json(400, { error: 'invalid_grant' });
      issued += 1;
      return json(200, { access_token: `token-${issued}`, refresh_token: 'refresh-1', token_type: 'Bearer', expires_in: 3600 });
    }
    if (u.pathname === '/mcp') {
      seen.auth.push(req.headers.authorization ?? null);
      seen.session.push(req.headers['mcp-session-id'] ?? null);
      if (!/^Bearer token-/.test(req.headers.authorization ?? '')) {
        res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` });
        return res.end();
      }
      const msg = JSON.parse(body);
      const result = msg.method === 'initialize' ? { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } : { tools: [{ name: 'search', description: 'search pages', inputSchema: { type: 'object' } }] };
      return json(200, { jsonrpc: '2.0', id: msg.id, result }, { 'mcp-session-id': 'sess-42' });
    }
    res.writeHead(404).end();
  });
  return { server, seen };
}

test('ox mcp login: once in the browser, then the token is used, refreshed, and never asks for a browser in a run', async () => {
  const { server, seen } = fakeServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  try {
    // Not signed in: a run says how, and opens nothing.
    const before = new McpHub({ notes: { url } }, { allowedHosts: ['127.0.0.1'] });
    await before.start();
    assert.match(before.servers.get('notes').stderr.join(' '), /ox mcp login notes/);
    await before.stop?.();

    // The browser step: following the authorize redirect is what the user's browser does.
    let opened = null;
    const rec = await A.login('notes', url, { open: async (u) => { opened = u; await fetch(u); } });
    assert.match(opened, /code_challenge_method=S256/);
    assert.equal(rec.accessToken, 'token-1');
    const file = path.join(process.env.OX_HOME, 'mcp-auth', 'notes.json');
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);

    // A run: the token rides along, and the session from initialize is sent back.
    const hub = new McpHub({ notes: { url } }, { allowedHosts: ['127.0.0.1'] });
    await hub.start();
    assert.equal(hub.servers.get('notes').status, 'ok', hub.servers.get('notes').stderr.join(' '));
    assert.ok(seen.auth.includes('Bearer token-1'));
    assert.ok(seen.session.includes('sess-42'), 'the server session is sent back after initialize');
    await hub.stop?.();

    // An expired token is refreshed quietly.
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...saved, expiresAt: Date.now() - 1000 }));
    assert.equal(await A.bearerFor('notes', url), 'token-2');
    assert.equal(A.logout('notes'), true);
    assert.equal(await A.bearerFor('notes', url), null);
  } finally {
    server.close();
  }
});

test('the connector gallery offers Sign in for a remote connector nobody signed in to', async () => {
  const { galleryView, remoteUrl } = await import('../src/connector-gallery.js');
  assert.equal(remoteUrl({ command: 'npx', args: ['-y', 'mcp-remote', 'https://mcp.notion.com/mcp'] }), 'https://mcp.notion.com/mcp');
  assert.equal(remoteUrl({ url: 'https://mcp.notion.com/mcp' }), 'https://mcp.notion.com/mcp');
  assert.equal(remoteUrl({ command: 'uvx', args: ['workspace-mcp'] }), null);
  const servers = { notion: { url: 'https://mcp.notion.com/mcp' } };
  const view = (signedIn) => galleryView({ servers, signedIn, has: () => false }).find((c) => c.id === 'notion');
  assert.equal(view(() => false).state, 'signin');
  assert.equal(view(() => true).state, 'added');
});
