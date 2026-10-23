// Local model discovery: positive identification, approval gating, revocation.
//
// Every stub here binds an EPHEMERAL loopback port from a temp server. Nothing
// binds 11434/8080/8000/1234 and nothing touches a real Ollama: the point of
// the discovery contract is that the answer depends only on what the process
// RETURNS, not on which port it happens to be listening on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

import {
  DEFAULT_PROBE_TIMEOUT_MS,
  LOCAL_ORIGINS,
  approvalQuestion,
  approveEndpoint,
  canPrompt,
  forgetEndpoint,
  isEndpointApproved,
  listApprovedEndpoints,
  listModels,
  normalizeEndpointUrl,
  parseOllamaTags,
  parseOpenAIModels,
  presetModelWarning,
  probeOrigin,
  readTrustRecords,
  scanLocalEndpoints,
} from '../src/local-inference.js';
import { isReachable, ollamaReachability } from '../src/model-registry.js';
import { readConfigDoc, saveConfigDoc } from '../src/config.js';

const REPO = path.resolve(import.meta.dirname, '..');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// A loopback stub. `handler(req, res)` decides what comes back; sockets are
// tracked so a deliberately silent server can be torn down cleanly.
async function startStub(handler) {
  const sockets = new Set();
  const server = http.createServer(handler);
  server.on('connection', s => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise(res => server.listen(0, '127.0.0.1', res));
  const { port } = server.address();
  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise(res => server.close(res));
    },
  };
}

const json = (res, body, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

const OLLAMA_TAGS = {
  models: [
    { name: 'qwen2.5:0.5b', model: 'qwen2.5:0.5b', size: 397821319, details: { family: 'qwen2', parameter_size: '494.03M', quantization_level: 'Q4_K_M' } },
    { name: 'tinyllama:1.1b', model: 'tinyllama:1.1b', size: 637700138, details: { family: 'llama', parameter_size: '1B', quantization_level: 'Q4_0' } },
  ],
};

const OPENAI_MODELS = {
  object: 'list',
  data: [
    { id: 'local-model-a', object: 'model' },
    { id: 'local-model-b', object: 'model' },
  ],
};

// An ollama-shaped stub, used wherever the test needs a positive hit.
function ollamaStub() {
  return startStub((req, res) => {
    if (req.url === '/api/version') return json(res, { version: '9.9.9-test' });
    if (req.url === '/api/tags') return json(res, OLLAMA_TAGS);
    if (req.url === '/v1/models') return json(res, { object: 'list', data: OLLAMA_TAGS.models.map(m => ({ id: m.name })) });
    json(res, { error: 'not found' }, 404);
  });
}

// ---------------------------------------------------------------------------
// 1. Detection requires positive identification.
// This is the `curl -s` false-positive regression guard.
// ---------------------------------------------------------------------------
test('a responding socket that does not identify as a known runtime is NOT reported', async () => {
  const cases = [
    ['404 with an HTML body', (req, res) => { res.writeHead(404, { 'content-type': 'text/html' }); res.end('<html>404</html>'); }],
    ['500 with a JSON error body', (req, res) => json(res, { error: 'boom' }, 500)],
    ['200 with an unrelated JSON object', (req, res) => json(res, { hello: 'world' })],
    ['200 with an empty object', (req, res) => json(res, {})],
    ['200 with a JSON array', (req, res) => json(res, [1, 2, 3])],
    ['200 with unparseable bytes', (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('not json at all'); }],
    ['200 with a version of the wrong type', (req, res) => json(res, { version: 42 })],
  ];

  for (const [label, handler] of cases) {
    const stub = await startStub(handler);
    try {
      assert.equal(await probeOrigin(stub.origin), null, `${label}: must not identify`);
      const found = await scanLocalEndpoints({ origins: [stub.origin] });
      assert.deepEqual(found, [], `${label}: scan must report nothing`);
    } finally {
      await stub.close();
    }
  }
});

test('the socket really did answer 200 — the old curl -s detector would have called it Ollama', async () => {
  // Proves the regression is real rather than theoretical: `res.ok` is true here,
  // which is exactly the check the previous `execSync('curl -s ...')` reduced to
  // (curl exits 0 on 404 AND 500, so it was worse still).
  const stub = await startStub((req, res) => json(res, { hello: 'world' }));
  try {
    const res = await fetch(`${stub.origin}/api/version`, { signal: AbortSignal.timeout(2000) });
    assert.equal(res.ok, true, 'stub answers 2xx, so a status-only check passes');
    assert.equal(await probeOrigin(stub.origin), null, 'but positive identification still rejects it');
  } finally {
    await stub.close();
  }
});

test('an ollama-shaped /api/version IS reported, with version and models', async () => {
  const stub = await ollamaStub();
  try {
    const f = await probeOrigin(stub.origin);
    assert.equal(f.protocol, 'ollama');
    assert.equal(f.runtime, 'ollama');
    assert.equal(f.version, '9.9.9-test');
    assert.deepEqual(f.models.map(m => m.name), ['qwen2.5:0.5b', 'tinyllama:1.1b']);
    assert.equal(f.models[0].sizeBytes, 397821319);
    assert.ok(f.models[0].size);
  } finally {
    await stub.close();
  }
});

test('a generic OpenAI-compatible server is identified as such, not as Ollama', async () => {
  const stub = await startStub((req, res) => {
    if (req.url === '/v1/models') return json(res, OPENAI_MODELS);
    json(res, { error: 'not found' }, 404);
  });
  try {
    const f = await probeOrigin(stub.origin);
    assert.equal(f.protocol, 'openai-compat');
    assert.notEqual(f.protocol, 'ollama');
    assert.deepEqual(f.models.map(m => m.name), ['local-model-a', 'local-model-b']);
  } finally {
    await stub.close();
  }
});

test('the default scan list includes the four well-known local ports', () => {
  assert.deepEqual(
    LOCAL_ORIGINS.map(o => o.origin).sort(),
    ['http://localhost:11434', 'http://localhost:1234', 'http://localhost:8000', 'http://localhost:8080'].sort()
  );
});

// ---------------------------------------------------------------------------
// 2. A dead port times out fast and does not hang.
// ---------------------------------------------------------------------------
test('a refused port resolves immediately and a silent port hits the timeout', async () => {
  // Refused: nothing is listening.
  const dead = await startStub(() => {});
  const deadOrigin = dead.origin;
  await dead.close();

  let t0 = Date.now();
  assert.equal(await probeOrigin(deadOrigin), null, 'a refused port identifies as nothing');
  const refusedMs = Date.now() - t0;
  assert.ok(refusedMs < 2000, `refused port must not hang (took ${refusedMs}ms)`);

  // Silent: the connection is accepted and the request is never answered, so
  // only the AbortSignal timeout can end the wait.
  const silent = await startStub(() => {});
  try {
    t0 = Date.now();
    assert.equal(await probeOrigin(silent.origin, { timeoutMs: 300 }), null);
    const timeoutMs = Date.now() - t0;
    assert.ok(timeoutMs < 2000, `silent port must time out, not hang (took ${timeoutMs}ms)`);
    assert.ok(timeoutMs >= 200, `should actually have waited for the timeout (took ${timeoutMs}ms)`);
  } finally {
    await silent.close();
  }
});

// ---------------------------------------------------------------------------
// 3. listModels() parses both shapes and tolerates malformed responses.
// ---------------------------------------------------------------------------
test('parseOllamaTags reads name and size, and rejects junk', () => {
  const parsed = parseOllamaTags(OLLAMA_TAGS);
  assert.deepEqual(parsed.map(m => m.name), ['qwen2.5:0.5b', 'tinyllama:1.1b']);
  assert.equal(parsed[0].sizeBytes, 397821319);
  assert.equal(parsed[0].family, 'qwen2');
  assert.equal(parsed[0].quantization, 'Q4_K_M');

  for (const junk of [null, undefined, {}, [], 'nope', 42, { models: 'no' }, { models: [null, 3, {}, { name: '  ' }] }]) {
    assert.deepEqual(parseOllamaTags(junk), [], `tolerates ${JSON.stringify(junk)}`);
  }
  // `model` is the documented fallback when `name` is absent.
  assert.deepEqual(parseOllamaTags({ models: [{ model: 'only-model' }] }).map(m => m.name), ['only-model']);
});

test('parseOpenAIModels reads data[].id, and rejects junk', () => {
  assert.deepEqual(parseOpenAIModels(OPENAI_MODELS).map(m => m.name), ['local-model-a', 'local-model-b']);
  for (const junk of [null, undefined, {}, [], 'nope', { data: 'no' }, { data: [null, {}, { id: '' }] }]) {
    assert.deepEqual(parseOpenAIModels(junk), [], `tolerates ${JSON.stringify(junk)}`);
  }
});

test('listModels talks /api/tags to ollama and /v1/models to everyone else', async () => {
  const seen = [];
  const stub = await startStub((req, res) => {
    seen.push(req.url);
    if (req.url === '/api/version') return json(res, { version: '9.9.9-test' });
    if (req.url === '/api/tags') return json(res, OLLAMA_TAGS);
    if (req.url === '/v1/models') return json(res, OPENAI_MODELS);
    json(res, {}, 404);
  });
  try {
    const ollamaModels = await listModels({ baseUrl: stub.origin, protocol: 'ollama' });
    assert.deepEqual(ollamaModels.map(m => m.name), ['qwen2.5:0.5b', 'tinyllama:1.1b']);
    assert.ok(seen.includes('/api/tags'), 'ollama uses /api/tags');

    const compatModels = await listModels({ baseUrl: stub.origin, protocol: 'openai-compat' });
    assert.deepEqual(compatModels.map(m => m.name), ['local-model-a', 'local-model-b']);
    assert.ok(seen.includes('/v1/models'), 'openai-compat uses /v1/models');
  } finally {
    await stub.close();
  }

  // Malformed over the wire must not throw — it returns [].
  const broken = await startStub((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('<html>gateway</html>'); });
  try {
    assert.deepEqual(await listModels(broken.origin), []);
    assert.deepEqual(await listModels('not a url at all ::'), []);
  } finally {
    await broken.close();
  }
});

// ---------------------------------------------------------------------------
// 4/5/6/9. Approval writes a trust record and gates isReachable.
// ---------------------------------------------------------------------------
test('approval writes the trust record and preserves unrelated config keys', async () => {
  const dir = tmpDir('ox-local-trust-');
  try {
    // A config carrying keys this feature knows nothing about.
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'config.json'),
      `${JSON.stringify({
        someFutureKey: { keep: 'me' },
        mcpServers: { fs: { command: 'npx', args: ['-y', 'server-fs'] } },
        skill_pins: ['keep-me'],
        local_endpoints: { 'http://localhost:9999': { runtime: 'ollama', base_url: 'http://localhost:9999' } },
      }, null, 2)}\n`
    );

    const stub = await ollamaStub();
    try {
      const found = await probeOrigin(stub.origin);
      const rec = approveEndpoint(found, { dir, now: new Date('2026-01-02T03:04:05.000Z') });

      assert.equal(rec.base_url, normalizeEndpointUrl(stub.origin));
      assert.equal(rec.runtime_version, '9.9.9-test');
      assert.deepEqual(rec.models.map(m => m.name), ['qwen2.5:0.5b', 'tinyllama:1.1b']);
      assert.equal(rec.approved_at, '2026-01-02T03:04:05.000Z');

      const doc = readConfigDoc({ dir });
      assert.deepEqual(doc.someFutureKey, { keep: 'me' }, 'unknown keys survive');
      assert.deepEqual(doc.mcpServers.fs, { command: 'npx', args: ['-y', 'server-fs'] });
      assert.deepEqual(doc.skill_pins, ['keep-me']);
      assert.ok(doc.local_endpoints['http://localhost:9999'], 'a pre-existing record is not clobbered');
      assert.ok(doc.local_endpoints[rec.base_url], 'the new record is present');

      // saveConfigDoc itself also preserves unknown keys.
      saveConfigDoc(d => { d.anotherKey = 1; }, { dir });
      assert.equal(readConfigDoc({ dir }).anotherKey, 1);
      assert.deepEqual(readConfigDoc({ dir }).someFutureKey, { keep: 'me' });
    } finally {
      await stub.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a discovered endpoint is NOT usable before approval, and IS after', async () => {
  const dir = tmpDir('ox-local-gate-');
  const config = { configDir: dir };
  let env = {};
  try {
    const stub = await ollamaStub();
    try {
      const found = await probeOrigin(stub.origin);
      assert.ok(found, 'the stub really is discovered');
      // Point ox at the stub the same way a real non-default install would, so
      // the endpoint the approval is checked against IS the endpoint the request
      // would be sent to. Without this the gate would approve :11434 while
      // traffic went to :8080.
      env = { OX_OLLAMA_BASE_URL: stub.origin };

      // 5. Discovered but not approved -> the provider is not reachable and the
      // answer is "not-approved", not "approved" by accident.
      assert.equal(isReachable({ provider: 'ollama' }, config, env), false);
      assert.equal(ollamaReachability({ config, env }).source, 'not-approved');
      assert.equal(isEndpointApproved(found.baseUrl, { dir }), false);
      assert.deepEqual(listApprovedEndpoints({ dir }), []);

      // 6. Approve -> reachable, and the reason is the persisted record.
      approveEndpoint(found, { dir });
      assert.equal(isEndpointApproved(found.baseUrl, { dir }), true);
      assert.equal(isReachable({ provider: 'ollama' }, config, env), true);
      const r = ollamaReachability({ config, env });
      assert.equal(r.source, 'approved');
      assert.equal(r.record.version, '9.9.9-test');

      // The manual override still works, unchanged, for backward compatibility.
      assert.equal(ollamaReachability({ config, env: { OX_OLLAMA_AVAILABLE: '1' } }).source, 'env-override');
      // An approval for one port must NOT make a different port reachable, even
      // with a live ollama-protocol server on it.
      const other = await startStub((req, res) => {
        if (req.url === '/api/version') return json(res, { version: '2.0.0' });
        if (req.url === '/api/tags') return json(res, { models: [] });
        json(res, {}, 404);
      });
      try {
        approveEndpoint(await probeOrigin(other.origin), { dir });
        assert.equal(
          isReachable({ provider: 'ollama' }, config, { OX_OLLAMA_BASE_URL: other.origin }),
          true,
          'the port that is actually used is approved'
        );
        assert.equal(
          isReachable({ provider: 'ollama' }, config, {}),
          false,
          'default :11434 is NOT covered by an approval for another port'
        );
      } finally {
        await other.close();
      }
      // Non-ollama providers are unaffected.
      assert.equal(isReachable({ provider: 'anthropic' }, config, { ANTHROPIC_API_KEY: 'x' }), true);
      assert.equal(isReachable({ provider: 'anthropic' }, config, {}), false);
    } finally {
      await stub.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('revocation removes the trust record and isReachable goes false again', async () => {
  const dir = tmpDir('ox-local-revoke-');
  const config = { configDir: dir };
  let env = {};
  try {
    const stub = await ollamaStub();
    try {
      const found = await probeOrigin(stub.origin);
      env = { OX_OLLAMA_BASE_URL: stub.origin };
      approveEndpoint(found, { dir });
      assert.equal(isReachable({ provider: 'ollama' }, config, env), true);

      // 9. Revoke, by full URL and by bare port.
      assert.deepEqual(forgetEndpoint(found.baseUrl, { dir }), { removed: true, key: found.baseUrl });
      assert.equal(isReachable({ provider: 'ollama' }, config, env), false);
      assert.deepEqual(listApprovedEndpoints({ dir }), []);

      approveEndpoint(found, { dir });
      assert.equal(isReachable({ provider: 'ollama' }, config, env), true);
      assert.equal(forgetEndpoint(String(found.port), { dir }).removed, true, 'a bare port revokes too');
      assert.equal(isReachable({ provider: 'ollama' }, config, env), false);

      // Revoking something that was never approved is a no-op, not a crash.
      const res = forgetEndpoint('65500', { dir });
      assert.equal(res.removed, false);
      assert.equal(res.reason, 'not-approved');
      assert.equal(forgetEndpoint('', { dir }).removed, false);
    } finally {
      await stub.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a malformed or unreadable config yields no approvals rather than a crash', () => {
  const dir = tmpDir('ox-local-bad-');
  try {
    fs.writeFileSync(path.join(dir, 'config.json'), '{ this is not json');
    assert.deepEqual(readTrustRecords({ dir }), []);
    assert.equal(isEndpointApproved('http://localhost:11434', { dir }), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 7. The approval prompt names the URL and the models.
// ---------------------------------------------------------------------------
test('the approval prompt shows the endpoint, the models and what approving means', async () => {
  const stub = await ollamaStub();
  try {
    const found = await probeOrigin(stub.origin);
    const text = approvalQuestion(found);

    assert.ok(text.includes(found.baseUrl), 'prompt contains the exact URL');
    assert.ok(text.includes('localhost'), 'prompt names the host');
    for (const m of found.models) assert.ok(text.includes(m.name), `prompt lists model ${m.name}`);
    assert.ok(text.includes('qwen2.5:0.5b') && text.includes('tinyllama:1.1b'));
    assert.ok(text.includes('Ollama'), 'prompt names the runtime');
    assert.ok(text.includes('9.9.9-test'), 'prompt shows the reported version');

    // What approving MEANS has to be spelled out, not implied.
    assert.match(text, /send your prompts/i);
    assert.match(text, /anything listening on that port receives all of it/i);
    assert.ok(text.includes('ox local forget'), 'prompt states how to revoke');
    assert.match(text, /\[?asked once/, 'prompt states that it will not ask again');
    assert.ok(text.trim().length > 200, 'not a bare yes/no');
  } finally {
    await stub.close();
  }
});

test('the default Ollama preset discovers an installed model without a stale mismatch', async () => {
  const dir = tmpDir('ox-local-preset-');
  try {
    // A server whose inventory differs from the old fixed preset.
    const stub = await startStub((req, res) => {
      if (req.url === '/api/version') return json(res, { version: '1.2.3' });
      if (req.url === '/api/tags') return json(res, { models: [{ name: 'some-other-model:1b', size: 1024 }] });
      json(res, {}, 404);
    });
    try {
      const found = await probeOrigin(stub.origin);
      const warn = presetModelWarning(found);
      assert.equal(warn, null, 'auto discovery makes the default usable');

      approveEndpoint(found, { dir });
      // The trust record stores what was found; the preset remains auto.
      const rec = readTrustRecords({ dir })[0];
      assert.deepEqual(rec.models.map(m => m.name), ['some-other-model:1b']);
      const preset = (await import('../src/bots.js')).BOTS['ox-ollama'];
      assert.equal(preset.model, 'auto', 'the preset remains explicit auto discovery');
    } finally {
      await stub.close();
    }

    // No warning when the default model is discovered from the server.
    const okStub = await ollamaStub();
    try {
      assert.equal(presetModelWarning(await probeOrigin(okStub.origin)), null);
    } finally {
      await okStub.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 8. Non-interactive: no prompt, no connect, report, exit 0.
// ---------------------------------------------------------------------------
test('non-interactive mode does not prompt and does not connect', async () => {
  const dir = tmpDir('ox-local-nonint-');
  try {
    assert.equal(canPrompt({ stdin: { isTTY: false }, stdout: { isTTY: false } }), false);
    assert.equal(canPrompt({ stdin: { isTTY: true }, stdout: { isTTY: false } }), false);
    assert.equal(canPrompt({ stdin: { isTTY: true }, stdout: { isTTY: true } }), true);

    const out = execFileSync(process.execPath, [path.join(REPO, 'bin', 'ox.js'), 'local', '--json'], {
      encoding: 'utf8',
      env: { ...process.env, HOME: dir, USERPROFILE: dir, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const report = JSON.parse(out);
    assert.equal(report.interactive, false);
    assert.deepEqual(report.connected, [], 'nothing was connected');
    assert.ok(Array.isArray(report.found), 'it still reports what it found');
    for (const f of report.found) assert.equal(f.approved, false, 'nothing auto-approved');
    // Nothing was written to disk.
    assert.equal(fs.existsSync(path.join(dir, '.ox', 'config.json')), false, 'no approval was persisted');
    assert.deepEqual(readTrustRecords({ dir }), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ox local --no-prompt reports the finding and exits 0 without prompting', async () => {
  const dir = tmpDir('ox-local-noprompt-');
  try {
    const res = require_spawn([path.join(REPO, 'bin', 'ox.js'), 'local', '--no-prompt'], { HOME: dir });
    assert.equal(res.status, 0, `expected exit 0, got ${res.status}: ${res.stderr}`);
    assert.match(res.stdout, /local inference/);
    // The real ports on this machine decide which of the two honest reports
    // appears: a server found but not approved, or none found at all. Either
    // way nothing is asked and nothing is written, which is what this tests.
    assert.match(res.stdout, /not connected|no local model server identified/i);
    assert.equal(fs.existsSync(path.join(dir, '.ox', 'config.json')), false, 'nothing written');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ox doctor reports discovery without connecting', async () => {
  const dir = tmpDir('ox-local-doctor-');
  try {
    const res = require_spawn([path.join(REPO, 'bin', 'ox.js'), 'doctor'], { HOME: dir });
    assert.equal(res.status, 0);
    assert.match(res.stdout, /local model discovery|no local model server identified/);
    assert.match(res.stdout, /approve with: ox local|not approved|APPROVED/);
    assert.equal(fs.existsSync(path.join(dir, '.ox', 'config.json')), false, 'doctor never approves anything');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 10. Concurrency: several dead ports stay bounded.
// ---------------------------------------------------------------------------
test('probing several unreachable ports concurrently stays well inside a serial budget', async () => {
  const count = 6;
  const stubs = [];
  for (let i = 0; i < count; i++) stubs.push(await startStub(() => {})); // accept, never answer
  const timeoutMs = 300;
  const serialBudget = timeoutMs * count;
  try {
    const origins = stubs.map(s => s.origin);
    const t0 = Date.now();
    const results = await scanLocalEndpoints({ origins, timeoutMs });
    const elapsed = Date.now() - t0;

    assert.deepEqual(results, [], 'nothing identified — they never answer');
    assert.ok(elapsed < serialBudget / 2, `concurrent (${elapsed}ms) should beat serial (${serialBudget}ms)`);
    assert.ok(elapsed < 5000, `must stay bounded (took ${elapsed}ms)`);
  } finally {
    for (const s of stubs) await s.close();
  }
});

test('a scan over a mix of live and dead origins reports only the live one', async () => {
  const live = await ollamaStub();
  const silent = await startStub(() => {});
  try {
    const found = await scanLocalEndpoints({ origins: [live.origin, silent.origin], timeoutMs: 300 });
    assert.equal(found.length, 1);
    assert.equal(found[0].protocol, 'ollama');
    assert.equal(normalizeEndpointUrl(found[0].baseUrl), normalizeEndpointUrl(live.origin));
  } finally {
    await live.close();
    await silent.close();
  }
});

// ---------------------------------------------------------------------------
// Normalization + module-load-order guard (config -> model-registry ->
// local-inference -> config is a cycle; it is safe only while every cyclic
// binding is used inside a function body, so assert all three entry points).
// ---------------------------------------------------------------------------
test('normalizeEndpointUrl canonicalizes aliases, strips paths, rejects junk', () => {
  const want = 'http://localhost:11434';
  for (const v of [
    'http://localhost:11434', 'http://localhost:11434/', 'http://localhost:11434/v1',
    'http://127.0.0.1:11434', 'http://127.0.0.1:11434/v1', 'localhost:11434',
    '11434', '127.0.0.1:11434',
  ]) {
    assert.equal(normalizeEndpointUrl(v), want, `${v} -> ${want}`);
  }
  // A bare numeric authority is a PORT. WHATWG URL parsing turns `http://11434`
  // into 0.0.44.170, which silently fails to match the real record.
  assert.equal(normalizeEndpointUrl('11434'), want);
  assert.equal(normalizeEndpointUrl('11434/api'), want);
  for (const junk of ['', '   ', null, undefined, 'file:///tmp/x', 'ftp://localhost:21', 'not a url']) {
    assert.ok(normalizeEndpointUrl(junk) !== want, `${JSON.stringify(junk)} must not normalize to the ollama key`);
  }
  assert.equal(normalizeEndpointUrl('file:///tmp/x'), null);
  assert.equal(normalizeEndpointUrl(''), null);
  assert.equal(normalizeEndpointUrl('http://localhost:8080'), 'http://localhost:8080', 'a different port is a different key');
});

test('modules load cleanly from any entry point (import cycle guard)', async () => {
  for (const entry of ['../src/config.js', '../src/model-registry.js', '../src/local-inference.js', '../src/bots.js', '../src/cli.js']) {
    const mod = await import(entry);
    assert.ok(mod, `${entry} loads`);
  }
  // And the cyclic functions actually work once loaded.
  const dir = tmpDir('ox-local-cycle-');
  try {
    assert.equal(isReachable({ provider: 'ollama' }, { configDir: dir }, {}), false);
    assert.equal(typeof DEFAULT_PROBE_TIMEOUT_MS, 'number');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Small spawn helper (execFileSync, but tolerant of a non-zero exit).
function require_spawn(argv, env) {
  const r = spawnSync(process.execPath, argv, {
    encoding: 'utf8',
    env: { ...process.env, ...env, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
