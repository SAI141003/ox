// Every provider the bot layer advertises must be routable by the transport
// layer. bots.js once listed six providers (zhipu, moonshot, ...) that
// providers/index.js did not know, so their presets resolved fine and then
// died with "unknown provider" on the first request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { BOTS, KEY_ENV, resolveBot } from '../src/bots.js';
import { PROVIDERS, getProvider, discoverLocalModel, streamVia } from '../src/providers/index.js';

test('every KEY_ENV provider has a transport with the same key env var', () => {
  for (const [name, keyEnv] of Object.entries(KEY_ENV)) {
    assert.ok(PROVIDERS[name], `provider '${name}' is advertised but has no transport`);
    assert.equal(PROVIDERS[name].keyEnv, keyEnv, `key env mismatch for '${name}'`);
    assert.equal(typeof getProvider(name).streamChat, 'function');
  }
});

test('every preset bot resolves to a routable provider', () => {
  for (const bot of Object.keys(BOTS)) {
    if (bot === 'ox-openrouter') continue; // explicit model required by design
    const r = resolveBot(bot);
    assert.ok(PROVIDERS[r.provider], `${bot} -> unknown provider '${r.provider}'`);
    assert.ok(r.baseUrl || PROVIDERS[r.provider].baseUrl, `${bot} has no endpoint`);
  }
});

function serve(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}/v1` }));
  });
}

test('keyless local server with model "auto" uses the loaded model', async () => {
  let seenModel = null;
  const { srv, url } = await serve((req, res) => {
    if (req.url === '/v1/models') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'my-local-q4' }] }));
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seenModel = JSON.parse(body).model;
      res.setHeader('content-type', 'text/event-stream');
      res.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
      res.end('data: [DONE]\n\n');
    });
  });
  try {
    assert.equal(await discoverLocalModel(url), 'my-local-q4');
    let text = '';
    for await (const ev of streamVia({ provider: 'lmstudio', model: 'auto', baseUrl: url }, { messages: [{ role: 'user', content: 'x' }] })) {
      if (ev.type === 'text-delta') text += ev.text;
    }
    assert.equal(seenModel, 'my-local-q4');
    assert.equal(text, 'hi');
  } finally {
    srv.close();
  }
});

test('local server with no loaded models fails with an actionable message', async () => {
  const { srv, url } = await serve((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [] }));
  });
  try {
    await assert.rejects(discoverLocalModel(url), /reports no loaded models/);
  } finally {
    srv.close();
  }
});
