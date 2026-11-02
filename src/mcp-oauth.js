// Sign in to a remote MCP server (Notion, Canva, Linear...) the standard MCP
// way: OAuth 2.1 with PKCE and dynamic client registration, done ONCE from
// `ox mcp login <name>`. The token is kept in ~/.ox/mcp-auth/<name>.json
// (0600) and refreshed quietly; a run never opens a browser. That is what the
// npx mcp-remote bridge did on every run when nobody had signed in.
//
// The same flow Insomnia's MCP client uses (Kong/insomnia
// packages/insomnia/src/main/mcp/oauth-client-provider.ts), without the SDK.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';

const dir = (env = process.env) => path.join(env.OX_HOME || path.join(os.homedir(), '.ox'), 'mcp-auth');
const safe = (name) => String(name).replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 80) || 'server';
const fileFor = (name, env) => path.join(dir(env), `${safe(name)}.json`);
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function readAuth(name, env = process.env) {
  try { return JSON.parse(fs.readFileSync(fileFor(name, env), 'utf8')); } catch { return null; }
}

function saveAuth(name, data, env = process.env) {
  fs.mkdirSync(dir(env), { recursive: true, mode: 0o700 });
  fs.writeFileSync(fileFor(name, env), JSON.stringify(data, null, 2), { mode: 0o600 });
}

export function logout(name, env = process.env) {
  try { fs.rmSync(fileFor(name, env)); return true; } catch { return false; }
}

async function getJson(url, fetchImpl) {
  const r = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
  if (!r.ok) return null;
  try { return await r.json(); } catch { return null; }
}

/**
 * Where to sign in for this MCP url: the protected-resource metadata it
 * points to (a 401's WWW-Authenticate, or /.well-known), then its
 * authorization server's metadata.
 */
export async function discover(url, { fetchImpl = fetch } = {}) {
  const u = new URL(url);
  let resourceMeta = null;
  try {
    const probe = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'ox', version: '1' } } }),
      signal: AbortSignal.timeout(10_000),
    });
    const hdr = probe.headers.get('www-authenticate') ?? '';
    const m = /resource_metadata="([^"]+)"/i.exec(hdr);
    if (m) resourceMeta = await getJson(new URL(m[1], url).toString(), fetchImpl);
    if (probe.ok && !hdr) return { open: true };
  } catch {}
  if (!resourceMeta) {
    for (const p of [`/.well-known/oauth-protected-resource${u.pathname.replace(/\/$/, '')}`, '/.well-known/oauth-protected-resource']) {
      resourceMeta = await getJson(`${u.origin}${p}`, fetchImpl);
      if (resourceMeta) break;
    }
  }
  const issuer = resourceMeta?.authorization_servers?.[0] ?? u.origin;
  const iu = new URL(issuer);
  const tail = iu.pathname.replace(/\/$/, '');
  let as = null;
  for (const p of [`/.well-known/oauth-authorization-server${tail}`, `/.well-known/openid-configuration${tail}`, `${tail}/.well-known/openid-configuration`]) {
    as = await getJson(`${iu.origin}${p}`, fetchImpl);
    if (as?.authorization_endpoint && as?.token_endpoint) break;
    as = null;
  }
  if (!as) throw new Error(`could not find where to sign in for ${url} (no OAuth metadata)`);
  return { resource: resourceMeta?.resource ?? url, scopes: resourceMeta?.scopes_supported ?? as.scopes_supported ?? [], as };
}

async function postForm(url, form, fetchImpl) {
  const r = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!r.ok || !json) throw new Error(`${new URL(url).host} refused: ${json?.error_description ?? json?.error ?? `HTTP ${r.status}`}`);
  return json;
}

const tokenRecord = (prev, t) => ({
  ...prev,
  accessToken: t.access_token,
  refreshToken: t.refresh_token ?? prev.refreshToken ?? null,
  tokenType: t.token_type ?? 'Bearer',
  expiresAt: t.expires_in ? Date.now() + Number(t.expires_in) * 1000 : null,
  at: new Date().toISOString(),
});

/**
 * The browser sign-in, once. open(url) shows the page (the CLI uses the
 * system browser); resolves with the saved record (no token in it is printed).
 */
export async function login(name, url, { open, say = () => {}, fetchImpl = fetch, env = process.env, timeoutMs = 5 * 60_000 } = {}) {
  const d = await discover(url, { fetchImpl });
  if (d.open) return { open: true };
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));

  // A one-shot listener on this machine only, for the redirect back.
  let finish;
  const got = new Promise((resolve, reject) => { finish = { resolve, reject }; });
  const server = http.createServer((req, res) => {
    const q = new URL(req.url, 'http://localhost').searchParams;
    if (!req.url.startsWith('/callback')) { res.writeHead(404).end(); return; }
    const ok = q.get('state') === state && q.get('code');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8"><title>ox</title><body style="font:16px system-ui;padding:40px">${ok ? 'Signed in. You can close this tab and go back to ox.' : 'Sign-in did not finish. Go back to ox and try again.'}</body>`);
    if (ok) finish.resolve(q.get('code'));
    else finish.reject(new Error(q.get('error_description') || q.get('error') || 'the sign-in was not completed'));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const redirectUri = `http://localhost:${server.address().port}/callback`;
  const timer = setTimeout(() => finish.reject(new Error('no sign-in within 5 minutes')), timeoutMs);
  timer.unref?.();
  try {
    let clientId = null, clientSecret = null;
    if (d.as.registration_endpoint) {
      const r = await fetchImpl(d.as.registration_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ client_name: 'ox', client_uri: 'https://github.com/SAI141003/ox', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }),
        signal: AbortSignal.timeout(15_000),
      });
      const reg = await r.json().catch(() => null);
      if (!r.ok || !reg?.client_id) throw new Error(`${new URL(d.as.registration_endpoint).host} would not register ox: ${reg?.error_description ?? reg?.error ?? `HTTP ${r.status}`}`);
      clientId = reg.client_id; clientSecret = reg.client_secret ?? null;
    } else {
      throw new Error('this server does not let apps register themselves; add a token by hand with --header "Authorization: Bearer …"');
    }
    const auth = new URL(d.as.authorization_endpoint);
    for (const [k, v] of Object.entries({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: 'S256', state, resource: d.resource, ...(d.scopes.length ? { scope: d.scopes.join(' ') } : {}) })) auth.searchParams.set(k, v);
    say(`opening ${auth.host} to sign in…`);
    await open(auth.toString());
    const code = await got;
    const t = await postForm(d.as.token_endpoint, { grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier, resource: d.resource, ...(clientSecret ? { client_secret: clientSecret } : {}) }, fetchImpl);
    if (!t.access_token) throw new Error('the server sent no access token');
    const rec = tokenRecord({ url, resource: d.resource, tokenEndpoint: d.as.token_endpoint, clientId, clientSecret }, t);
    saveAuth(name, rec, env);
    return rec;
  } finally {
    clearTimeout(timer);
    server.close();
  }
}

/** A fresh token for this server, refreshing it when it is about to expire; null when not signed in. */
export async function bearerFor(name, url, { fetchImpl = fetch, env = process.env, force = false } = {}) {
  const a = readAuth(name, env);
  if (!a?.accessToken || (a.url && url && a.url !== url)) return null;
  const stale = force || (a.expiresAt && Date.now() > a.expiresAt - 60_000);
  if (!stale) return a.accessToken;
  if (!a.refreshToken) return force ? null : a.accessToken;
  try {
    const t = await postForm(a.tokenEndpoint, { grant_type: 'refresh_token', refresh_token: a.refreshToken, client_id: a.clientId, resource: a.resource, ...(a.clientSecret ? { client_secret: a.clientSecret } : {}) }, fetchImpl);
    const rec = tokenRecord(a, t);
    saveAuth(name, rec, env);
    return rec.accessToken;
  } catch {
    return null;
  }
}
