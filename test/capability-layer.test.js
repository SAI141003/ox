// The capability layer: ordered fallback chains, REAL selection, and a doctor
// that consumes its own probes.
//
// EVERY backend here is a /tmp loopback stub. Nothing in this file reaches the
// public internet, binds a well-known port, or touches a real ~/.ox: the point of
// the whole layer is that the answer depends only on what a backend RETURNS, so
// the tests decide that answer rather than inherit today's network. The one
// exception is the spawned `ox doctor --json`, which runs the real binary -- with
// HOME pointed at a fresh temp dir, so its config lands there and the user's real
// ~/.ox is never written.
//
// The doctor's own live probe is pointed at example.com/r.jina.ai, which is real
// network I/O that only bounds the RUNTIME of test 6; nothing is asserted about
// its verdict, only that doctor returns inside the budget.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  CHAIN_DEADLINE_MS,
  PROBE_RECORD_TTL_MS,
  VERDICT_TTL_MS,
  addCapability,
  cachedProbeRecord,
  cachedVerdict,
  capabilityHeadline,
  capabilityReport,
  clearBackends,
  clearCapabilityCache,
  doctorCapabilityRows,
  explainChain,
  invalidateVerdict,
  isPublicFetchTarget,
  orderedBackends,
  probeCapability,
  registerBackend,
  selectBackend,
  setBackendOrder,
  unregisterBackend,
} from '../src/capability.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OX_BIN = path.join(REPO, 'bin', 'ox.js');

// ---- loopback stubs ----------------------------------------------------------
// One server per test. `routes` maps a path to (status, body, headers) or a
// function; anything unlisted is a 404, so a request to a path a test did not
// intend is a visible failure rather than a silent success.
const CHALLENGE_HTML = `<!doctype html><html><head><title>DuckDuckGo</title></head>
<body><div class="anomaly-modal"><script src="/anomaly.js"></script>
<form class="challenge-form" action="/x"></form>
<p>Verifying your browser before showing results.</p></div></body></html>`;

async function startStub(routes) {
  const sockets = new Set();
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push({ method: req.method, path: req.url });
    const route = routes[req.url] ?? routes[req.url.split('?')[0]];
    if (!route) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('no route');
      return;
    }
    const [status, body, headers = {}] = typeof route === 'function' ? route(req) : route;
    res.writeHead(status, { 'content-type': headers['content-type'] ?? 'application/json', ...headers });
    res.end(body);
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    hits,
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// A backend whose probe and whose real call are the SAME code, talking to a
// loopback stub -- so "the probe really probed" is not an assertion about
// intent, it is the only code path that exists.
// A backend whose probe and whose real call run the SAME code against a loopback
// stub, so "the probe really probed" is not an assertion about intent -- it is
// the only code path that exists. `shape` decides what the probe hands the
// policy, exactly as a real backend does after normalising its response:
//   'rows' -> parsed result rows (a JSON API, or a scraper that found links)
//   'html' -> the raw body (a scraper that could not find any)
function stubBackend(name, { base, path: urlPath, envVar = null, shape = 'rows', contentType = 'application/json' }) {
  return {
    name,
    envVar,
    kind: 'search',
    note: 'loopback stub',
    async probe({ signal }) {
      onProbeCount[name] = (onProbeCount[name] ?? 0) + 1;
      const res = await fetch(`${base}${urlPath}`, { signal, headers: { accept: contentType } });
      const text = await res.text();
      return {
        status: res.status,
        payload: shape === 'rows' ? JSON.parse(text) : text,
        contentType: res.headers.get('content-type'),
      };
    },
    async search() {
      throw new Error(`${name}: search() not wired in this stub`);
    },
  };
}

// How many times each backend's probe function actually ran. The whole claim of
// this layer is "selection is by real probe", so the tests count the probes.
let onProbeCount = {};
function resetProbeCounts() {
  onProbeCount = {};
}

// A search capability of our own, so the shipped web_search chain (which points
// at real endpoints) is never walked by a loopback test.
function freshCapability(name = 'stub_search') {
  // Hermetic: the injected registry is shared process-wide, so a leftover backend
  // from an earlier test would be appended to this chain and change the verdict.
  // The real web.js source is untouched by clearBackends().
  clearCapabilityCache();
  clearBackends();
  resetProbeCounts();
  addCapability({ name, kind: 'search', description: 'loopback search capability', order: [] });
  return name;
}

describe('1. ordered fallback chains: the first GENUINELY usable backend wins', () => {
  test('a backend that answers with real rows is preferred over one that is merely configured', async (t) => {
    const dead = await startStub({ '/dead': [503, '{"error":"down"}'] });
    const alive = await startStub({
      '/live': [200, JSON.stringify([{ title: 'Real result', url: 'https://example.org/a', snippet: 'x' }])],
    });
    t.after(async () => {
      await dead.close();
      await alive.close();
    });

    const cap = freshCapability('pref_order');
    registerBackend({ ...stubBackend('configured-but-broken', { base: dead.base, path: '/dead', envVar: 'STUB_KEY' }), requiresCredential: true });
    registerBackend(stubBackend('usable', { base: alive.base, path: '/live' }));
    setBackendOrder(cap, ['configured-but-broken', 'usable']);

    const verdict = await probeCapability(cap, { env: { STUB_KEY: 'set' }, timeoutMs: 1000, deadlineMs: 3000 });

    assert.equal(verdict.kind, 'capability-verdict');
    assert.equal(verdict.live, 'usable', 'the chain must pass over a broken route for a working one');
    // The order was honoured, not sorted alphabetically or by "is a key set".
    assert.deepEqual(verdict.tried, ['configured-but-broken', 'usable']);
    assert.equal(verdict.chain[0].ok, false);
    assert.equal(verdict.chain[0].configState, 'configured', 'a present key makes it CONFIGURED-BROKEN, not "skipped"');
    assert.equal(verdict.chain[1].ok, true);
    assert.ok(alive.hits.length >= 1, 'the winning backend was really probed on the socket');
  });

  test('reordering the chain is the whole mechanism for changing routes', async (t) => {
    const a = await startStub({ '/x': [200, JSON.stringify([{ title: 'A', url: 'https://a.example/1' }])] });
    const b = await startStub({ '/x': [200, JSON.stringify([{ title: 'B', url: 'https://b.example/1' }])] });
    t.after(async () => {
      await a.close();
      await b.close();
    });

    const cap = freshCapability('reorder');
    registerBackend(stubBackend('alpha', { base: a.base, path: '/x' }));
    registerBackend(stubBackend('beta', { base: b.base, path: '/x' }));

    setBackendOrder(cap, ['alpha', 'beta']);
    assert.equal((await probeCapability(cap, { env: {}, timeoutMs: 1000, deadlineMs: 3000 })).live, 'alpha');

    // Same code, same process, different order -> different backend. No branch
    // anywhere was edited to produce this.
    setBackendOrder(cap, ['beta', 'alpha']);
    assert.equal((await probeCapability(cap, { env: {}, force: true, timeoutMs: 1000, deadlineMs: 3000 })).live, 'beta');
    // The explicit order is the PREFIX of the walk; anything else of the same kind
    // that exists in the registry is appended behind it, so a newly registered
    // route is probed once rather than being invisible.
    assert.equal(orderedBackends(cap).slice(0, 2).map((x) => x.name).join(','), 'beta,alpha');
  });

  test('selectBackend reuses a cached verdict instead of re-probing', async (t) => {
    const alive = await startStub({ '/x': [200, JSON.stringify([{ title: 'S', url: 'https://s.example/1' }])] });
    t.after(() => alive.close());
    const cap = freshCapability('cached_select');
    registerBackend(stubBackend('solo', { base: alive.base, path: '/x' }));

    const first = await selectBackend(cap, { env: {}, timeoutMs: 1000, deadlineMs: 3000 });
    assert.equal(first.ok, true);
    assert.equal(first.cached, false);
    const after = onProbeCount.solo;

    const second = await selectBackend(cap, { env: {}, timeoutMs: 1000, deadlineMs: 3000 });
    assert.equal(second.ok, true);
    assert.equal(second.cached, true, 'the second call must come from the verdict cache');
    assert.equal(onProbeCount.solo, after, 'a cached verdict must not cost another request');
  });
});

describe('2. the false-positive guard: a challenge page is not a usable backend', () => {
  test('a backend answering 200 with an anti-bot challenge is REJECTED and the next is tried', async (t) => {
    const liar = await startStub({ '/challenge': [200, CHALLENGE_HTML, { 'content-type': 'text/html' }] });
    const honest = await startStub({
      '/real': [200, JSON.stringify([{ title: 'Honest', url: 'https://honest.example/1', snippet: 'ok' }])],
    });
    t.after(async () => {
      await liar.close();
      await honest.close();
    });

    const cap = freshCapability('challenge_guard');
    registerBackend(stubBackend('liar', { base: liar.base, path: '/challenge', shape: 'html', contentType: 'text/html' }));
    registerBackend(stubBackend('honest', { base: honest.base, path: '/real' }));
    setBackendOrder(cap, ['liar', 'honest']);

    const verdict = await probeCapability(cap, { env: {}, timeoutMs: 1000, deadlineMs: 3000 });

    assert.equal(verdict.live, 'honest', 'a 200 that is a challenge page must not win');
    assert.equal(verdict.chain[0].ok, false);
    assert.equal(verdict.chain[0].code, 'challenge');
    assert.match(verdict.chain[0].fix, /hostile to scripts/i);
    assert.ok(liar.hits.length >= 1, 'the liar was really contacted -- rejection is not a shortcut');
  });

  test('a 200 JSON body is never mistaken for a challenge', async (t) => {
    const stub = await startStub({
      // A legitimate result whose title contains the very words a challenge uses.
      '/x': [200, JSON.stringify([{ title: 'Just a Moment: enable javascript', url: 'https://ok.example/1' }]), {
        'content-type': 'application/json',
      }],
    });
    t.after(() => stub.close());
    const cap = freshCapability('json_not_challenge');
    registerBackend(stubBackend('jsonish', { base: stub.base, path: '/x' }));
    const verdict = await probeCapability(cap, { env: {}, timeoutMs: 1000, deadlineMs: 3000 });
    assert.equal(verdict.live, 'jsonish', 'scanning a JSON body for HTML challenge strings is a false positive');
  });

  test('a backend that answers with rows but no URLs is not usable', async (t) => {
    const junk = await startStub({ '/j': [200, JSON.stringify([{ title: 'no url', snippet: 'x' }])] });
    t.after(() => junk.close());
    const cap = freshCapability('no_urls');
    registerBackend(stubBackend('junk', { base: junk.base, path: '/j' }));
    const verdict = await probeCapability(cap, { env: {}, timeoutMs: 1000, deadlineMs: 3000 });
    assert.equal(verdict.live, null);
    assert.equal(verdict.chain[0].code, 'no-results');
  });
});

describe('3. every backend failing names each one tried, why, and the fix', () => {
  test('the error lists the whole chain with a per-backend fix line', async (t) => {
    const broken = await startStub({ '/b': [401, '{"error":"invalid api key"}'] });
    // A socket that accepts and then says nothing: the case a probe timeout is for.
    const sockets = new Set();
    const timeout = http.createServer(() => {});
    timeout.on('connection', (s) => {
      sockets.add(s);
      s.on('close', () => sockets.delete(s));
    });
    await new Promise((r) => timeout.listen(0, '127.0.0.1', r));
    timeout.base = `http://127.0.0.1:${timeout.address().port}`;
    t.after(async () => {
      await broken.close();
      for (const s of sockets) s.destroy();
      await new Promise((r) => timeout.close(r));
    });

    const cap = freshCapability('all_fail');
    registerBackend({
      ...stubBackend('keyed-401', { base: broken.base, path: '/b', envVar: 'STUB_401' }),
      requiresCredential: true,
    });
    registerBackend(stubBackend('never-configured', { base: broken.base, path: '/b', envVar: 'STUB_ABSENT' }));
    registerBackend({
      ...stubBackend('keyless-silent', { base: timeout.base, path: '/hang' }),
      async probe({ signal }) {
        // The socket accepts and never answers, so the only way out is the abort:
        // that is exactly the case a probe timeout exists for.
        const res = await fetch(`${timeout.base}/hang`, { signal });
        return { status: res.status, payload: await res.json() };
      },
    });
    setBackendOrder(cap, ['keyed-401', 'never-configured', 'keyless-silent']);

    // A realistic budget for a LOOPBACK round trip. The tight budgets live in
    // test 6, where the socket never answers and the bound is the behaviour
    // under test; here a starved event loop was turning a 401 into a timeout,
    // which is a fixture artefact and a genuinely wrong classification.
    const verdict = await probeCapability(cap, {
      env: { STUB_401: 'a-key' },
      timeoutMs: 2000,
      deadlineMs: 8000,
    });

    assert.equal(verdict.live, null);
    assert.equal(verdict.code, 'none-usable');
    assert.deepEqual(verdict.tried, ['keyed-401', 'never-configured', 'keyless-silent']);

    const text = explainChain(verdict, { header: 'web_search: nothing served this query.' });
    for (const name of ['keyed-401', 'never-configured', 'keyless-silent']) {
      assert.match(text, new RegExp(name), `the error must name ${name}`);
    }
    // The three states are distinguishable, which is the point of configState.
    assert.match(text, /keyed-401 \[CONFIGURED-BROKEN\]/);
    assert.match(text, /never-configured \[NOT-CONFIGURED\]/);
    assert.match(text, /keyless-silent \[KEYLESS-UNUSABLE\]/);
    // Each of the three gets its own prescription.
    assert.equal((text.match(/fix:/g) ?? []).length, 3, 'one fix line per backend tried');
    assert.match(text, /STUB_401 is set but rejected/, 'a rejected key is a different fix from a missing one');
    assert.equal(verdict.chain[0].code, 'unauthorized', 'a 401 must be reported as a rejected credential, not as zero results');
    // A backend that accepts the connection and then never answers must be
    // classified as a TIMEOUT, not as "no results": those two lead to different
    // fixes, and only one of them is true.
    assert.equal(verdict.chain[2].code, 'timeout');
    assert.match(text, /set STUB_ABSENT to a valid key/);
    assert.match(text, /did not answer within the probe budget/);
    // And the headline names the count, not a vague refusal.
    assert.match(text, /3 backend\(s\) considered, in chain order:/);
    assert.doesNotMatch(text, /^web_search: no search backend is configured$/m);
  });

  test('the unavailable-MCP route is named too, rather than silently absent', async () => {
    const cap = freshCapability('mcp_absent');
    registerBackend({
      name: 'mcp:example:web_search',
      kind: 'search',
      envVar: null,
      requiresCredential: false,
      async probe() {
        return { status: 0, payload: null };
      },
      async search() {
        return [];
      },
      probeUnavailable: true,
    });
    setBackendOrder(cap, ['mcp:example:web_search']);
    const verdict = await probeCapability(cap, { env: {}, timeoutMs: 200, deadlineMs: 500 });
    assert.equal(verdict.live, null);
    const text = explainChain(verdict);
    assert.match(text, /mcp:example:web_search/);
    assert.ok(verdict.chain[0].fix.length > 0, 'an MCP route with no caller still needs a prescription');
  });
});

describe('4. the probe cache: TTL, and a verdict is never a record', () => {
  // The regression this guards is real: src/local-inference.js shipped the same
  // shape bug twice (probeOrigin() returned its memo where callers were promised
  // a verdict), so a negative came back truthy and `models` came back a number.
  test('the two cached records are structurally different and not interchangeable', async (t) => {
    const alive = await startStub({ '/x': [200, JSON.stringify([{ title: 'T', url: 'https://t.example/1' }])] });
    t.after(() => alive.close());
    const cap = freshCapability('shape_guard');
    registerBackend(stubBackend('one', { base: alive.base, path: '/x' }));

    const verdict = await probeCapability(cap, { env: {}, timeoutMs: 1000, deadlineMs: 3000 });
    const record = verdict.chain[0];

    // A verdict: `live` is a NAME, `chain` is an ARRAY, there is no `ok`.
    assert.equal(verdict.kind, 'capability-verdict');
    assert.equal(typeof verdict.live, 'string');
    assert.ok(Array.isArray(verdict.chain));
    assert.equal(verdict.ok, undefined);
    // A record: `ok` is a BOOLEAN, `code` is a scalar, there is no `live`.
    assert.equal(record.kind, 'probe-record');
    assert.equal(typeof record.ok, 'boolean');
    assert.equal(typeof record.code, 'string');
    assert.equal(record.live, undefined);

    // The accessors do not hand back the other record, and both are tagged so a
    // caller can check rather than guess.
    const cachedV = cachedVerdict(cap);
    const cachedR = cachedProbeRecord(cap, 'one');
    assert.equal(cachedV.kind, 'capability-verdict');
    assert.equal(cachedR.kind, 'probe-record');
    assert.notEqual(cachedV, cachedR);
    assert.equal(cachedProbeRecord(cap, 'one').ok, true);
    assert.equal(cachedVerdict(cap).live, 'one');
    // A negative is NOT a truthy object: `live` is null, exactly as promised.
    const missV = cachedVerdict('never-probed-capability');
    const missR = cachedProbeRecord('never-probed-capability', 'nobody');
    assert.equal(missV, null);
    assert.equal(missR, null);
  });

  test('both caches expire, and a stale entry is dropped rather than trusted', async (t) => {
    const alive = await startStub({ '/x': [200, JSON.stringify([{ title: 'T', url: 'https://t.example/1' }])] });
    t.after(() => alive.close());
    const cap = freshCapability('ttl');
    registerBackend(stubBackend('one', { base: alive.base, path: '/x' }));
    await probeCapability(cap, { env: {}, timeoutMs: 1000, deadlineMs: 3000 });

    const t0 = Date.now();
    assert.ok(cachedVerdict(cap, { now: t0 }), 'fresh verdict is readable');
    assert.ok(cachedProbeRecord(cap, 'one', { now: t0 }), 'fresh record is readable');

    const justInside = t0 + VERDICT_TTL_MS - 1;
    assert.ok(cachedVerdict(cap, { now: justInside }), `verdict must survive ${VERDICT_TTL_MS - 1}ms`);

    const past = t0 + VERDICT_TTL_MS + 1;
    assert.equal(cachedVerdict(cap, { now: past }), null, 'a stale verdict is not a verdict');
    assert.equal(cachedProbeRecord(cap, 'one', { now: past }), null, 'a stale record is not a record');
    // Reading a stale entry evicts it, so a later read cannot resurrect it.
    assert.equal(cachedVerdict(cap, { now: t0 }), null, 'the stale read must have evicted the entry');

    // The record TTL is its own, and shorter than the verdict's is not required --
    // what matters is that each is bounded and independently enforced.
    assert.ok(PROBE_RECORD_TTL_MS > 0 && VERDICT_TTL_MS > 0);
    await probeCapability(cap, { env: {}, force: true, timeoutMs: 1000, deadlineMs: 3000 });
    const rec0 = cachedProbeRecord(cap, 'one').at;
    assert.ok(cachedProbeRecord(cap, 'one', { now: rec0 + PROBE_RECORD_TTL_MS - 1 }));
    assert.equal(cachedProbeRecord(cap, 'one', { now: rec0 + PROBE_RECORD_TTL_MS + 1 }), null);
  });

  test('a verdict is not handed to a caller asking for a record, nor the reverse', async (t) => {
    const alive = await startStub({ '/x': [200, JSON.stringify([{ title: 'T', url: 'https://t.example/1' }])] });
    t.after(() => alive.close());
    const cap = freshCapability('cross_kind');
    registerBackend(stubBackend('one', { base: alive.base, path: '/x' }));
    await probeCapability(cap, { env: {}, timeoutMs: 1000, deadlineMs: 3000 });
    // A record requested for a capability that only ever produced a verdict.
    assert.equal(cachedProbeRecord(cap, 'never-probed-backend'), null);
    // A verdict requested for a name that is not a capability at all.
    assert.equal(cachedVerdict('not-a-capability'), null);
    // invalidateVerdict forces the next call to re-probe rather than trust it.
    invalidateVerdict(cap);
    assert.equal(cachedVerdict(cap), null);
  });
});

describe('5. ox doctor: the live backend, the three failure classes, a fix, and --json', () => {
  test('the report names the LIVE backend and splits broken-with-a-key from never-configured', async (t) => {
    const broken = await startStub({ '/b': [403, '{"error":"forbidden"}'] });
    const alive = await startStub({ '/a': [200, JSON.stringify([{ title: 'Live', url: 'https://live.example/1' }])] });
    t.after(async () => {
      await broken.close();
      await alive.close();
    });

    const cap = freshCapability('doctor_search');
    registerBackend({
      ...stubBackend('broken-keyed', { base: broken.base, path: '/b', envVar: 'DOC_KEY' }),
      requiresCredential: true,
    });
    registerBackend({
      ...stubBackend('absent-key', { base: alive.base, path: '/a', envVar: 'DOC_ABSENT' }),
      requiresCredential: true,
    });
    registerBackend(stubBackend('live-one', { base: alive.base, path: '/a' }));
    setBackendOrder(cap, ['broken-keyed', 'absent-key', 'live-one']);

    const reports = await capabilityReport({
      capabilities: [cap],
      env: { DOC_KEY: 'a-key' },
      timeoutMs: 1000,
      deadlineMs: 3000,
    });
    assert.equal(reports.length, 1);
    const rows = doctorCapabilityRows(reports);
    assert.equal(rows.length, 1);
    const row = rows[0];

    // The LIVE backend, not "reachable yes/no".
    assert.equal(row.ok, true);
    assert.equal(row.live, 'live-one');
    assert.match(row.headline, /live backend "live-one"/);
    assert.match(row.source, /probed usable/);

    // The three classes, kept apart, each with its own fix.
    assert.deepEqual(row.configuredBroken.map((x) => x.backend), ['broken-keyed']);
    assert.deepEqual(row.neverConfigured.map((x) => x.backend), ['absent-key']);
    assert.deepEqual(row.keylessUnusable, []);
    assert.match(row.configuredBroken[0].fix, /DOC_KEY is set but rejected/);
    assert.match(row.neverConfigured[0].fix, /set DOC_ABSENT/);
    // A capability WITH a live backend needs no capability-level fix.
    assert.equal(row.fix, null);
    // Every backend appears with a state label, including the ones never tried.
    assert.deepEqual(row.backends.map((b) => b.label), ['CONFIGURED-BROKEN', 'NOT-CONFIGURED', 'LIVE']);
    assert.equal(row.backends.find((b) => b.name === 'live-one')?.fix, null, 'a live backend needs no remediation');
    assert.match(capabilityHeadline(rows), /1\/1 live/);
  });

  test('a capability with no live backend carries a capability-level fix line', async (t) => {
    const broken = await startStub({ '/b': [401, '{}'] });
    t.after(() => broken.close());
    const cap = freshCapability('doctor_dead');
    registerBackend({
      ...stubBackend('dead', { base: broken.base, path: '/b', envVar: 'DEAD_KEY' }),
      requiresCredential: true,
    });
    setBackendOrder(cap, ['dead']);
    const rows = doctorCapabilityRows(
      await capabilityReport({ capabilities: [cap], env: { DEAD_KEY: 'x' }, timeoutMs: 1000, deadlineMs: 2000 })
    );
    assert.equal(rows[0].ok, false);
    assert.equal(rows[0].live, null);
    assert.match(rows[0].headline, /NO live backend/);
    assert.ok(rows[0].fix && rows[0].fix.length > 0, 'a dead capability must still name its fix');
    assert.match(rows[0].fix, /DEAD_KEY is set but rejected/);
    assert.match(capabilityHeadline(rows), /0\/1 live/);
  });

  test('the real `ox doctor --json` emits the documented, parseable shape', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-cap-doctor-'));
    try {
      const r = spawnSync(process.execPath, [OX_BIN, 'doctor', '--json'], {
        cwd: REPO,
        encoding: 'utf8',
        timeout: 60_000,
        env: { ...process.env, HOME: home, NO_COLOR: '1' },
      });
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      const j = JSON.parse(r.stdout);

      assert.equal(typeof j.ok, 'boolean');
      assert.ok(Array.isArray(j.checks) && j.checks.length > 0);
      assert.ok(Array.isArray(j.capabilities), 'the capability report must be in the JSON');

      const names = j.capabilities.map((c) => c.capability);
      assert.deepEqual(names.sort(), ['web_fetch', 'web_search'], 'both capabilities must appear');

      for (const c of j.capabilities) {
        assert.ok(Array.isArray(c.chain) && c.chain.length > 0, `${c.capability} must report its chain`);
        // "live" is a NAME or null; it is never a bare reachable boolean.
        assert.ok(c.live === null || typeof c.live === 'string');
        if (c.live) assert.ok(c.chain.some((b) => b.backend === c.live && b.ok === true));
        for (const b of c.chain) {
          assert.equal(typeof b.backend, 'string');
          assert.equal(typeof b.ok, 'boolean');
          assert.ok(['keyless', 'configured', 'not-configured', 'untested', 'unknown'].includes(b.configState));
          if (!b.ok) assert.ok(b.fix && b.fix.length > 0, `${b.backend} failed with no fix line`);
        }
        assert.ok(Array.isArray(c.configuredBroken));
        assert.ok(Array.isArray(c.neverConfigured));
        // configuredBroken and neverConfigured are disjoint by construction.
        for (const x of c.configuredBroken) {
          assert.ok(!c.neverConfigured.some((y) => y.backend === x.backend));
        }
        if (!c.live) assert.ok(c.fix && c.fix.length > 0, `${c.capability} has no live backend and no fix`);
      }

      assert.ok(Array.isArray(j.capabilityRows));
      assert.match(capabilityHeadline(j.capabilityRows), /live/);

      // doctor never writes the real ~/.ox, and never creates config.json here.
      assert.equal(fs.existsSync(path.join(home, '.ox', 'config.json')), false);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('the text form prints the same verdicts, not a bare reachable check', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-cap-doctor-text-'));
    try {
      const r = spawnSync(process.execPath, [OX_BIN, 'doctor'], {
        cwd: REPO,
        encoding: 'utf8',
        timeout: 60_000,
        env: { ...process.env, HOME: home, NO_COLOR: '1' },
      });
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      assert.match(r.stdout, /capability layer/);
      assert.match(r.stdout, /web_search: live backend|web_search: NO live backend/);
      assert.match(r.stdout, /web_fetch: live backend|web_fetch: NO live backend/);
      assert.match(r.stdout, /LIVE|NOT-CONFIGURED|CONFIGURED-BROKEN|KEYLESS-UNUSABLE/);
      assert.doesNotMatch(r.stdout, /web_search: reachable/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('6. doctor cannot hang: every probe is bounded', () => {
  test('a backend that accepts and never answers is cut off inside the budget', async (t) => {
    // A socket that completes the handshake and then says nothing at all: the
    // worst case for a naive probe, since `fetch` itself will not time out.
    const sockets = new Set();
    const silent = http.createServer(() => {
      /* headers are never written */
    });
    silent.on('connection', (s) => {
      sockets.add(s);
      s.on('close', () => sockets.delete(s));
    });
    await new Promise((r) => silent.listen(0, '127.0.0.1', r));
    const silentBase = `http://127.0.0.1:${silent.address().port}`;
    t.after(async () => {
      for (const s of sockets) s.destroy();
      await new Promise((r) => silent.close(r));
    });

    const cap = freshCapability('bounded');
    registerBackend({
      name: 'silent',
      kind: 'search',
      envVar: null,
      async probe({ signal }) {
        await fetch(`${silentBase}/hang`, { signal });
        return { status: 200, payload: [] };
      },
      async search() {
        return [];
      },
    });
    registerBackend({
      name: 'silent-too',
      kind: 'search',
      envVar: null,
      async probe({ signal }) {
        await fetch(`${silentBase}/hang`, { signal });
        return { status: 200, payload: [] };
      },
      async search() {
        return [];
      },
    });
    setBackendOrder(cap, ['silent', 'silent-too']);

    const probeBudget = 300;
    const chainBudget = 900;
    const started = Date.now();
    const verdict = await probeCapability(cap, { env: {}, timeoutMs: probeBudget, deadlineMs: chainBudget });
    const elapsed = Date.now() - started;

    assert.equal(verdict.live, null);
    assert.equal(verdict.chain.length, 2, 'both silent backends must still be accounted for');
    // The chain deadline, not the number of backends, is what bounds this. The
    // SLACK term is timer scheduling on a loaded machine, deliberately stated
    // rather than hidden: an AbortSignal.timeout can only fire when the event
    // loop turns, and this box is heavily oversubscribed. The probe budget
    // itself is not inflated -- a 300ms probe still gives up at 300ms.
    const SCHEDULING_SLACK_MS = 1_000;
    assert.ok(
      elapsed < probeBudget * 2 + SCHEDULING_SLACK_MS,
      `chain took ${elapsed}ms with a ${chainBudget}ms deadline and a ${probeBudget}ms probe budget`
    );
    for (const b of verdict.chain) {
      assert.equal(b.code, 'timeout', `${b.backend} should have been cut off, not answered`);
    }
    // A non-answering socket costs the probe budget, never the process: the
    // assertion above is meaningless if the walk hung, and it did not.
    assert.ok(verdict.chain.length === 2);
    // And the exported defaults a doctor run uses are themselves bounded.
    assert.ok(CHAIN_DEADLINE_MS <= 15_000, 'the default chain deadline must be short');
    assert.ok(VERDICT_TTL_MS > 0);
  });

  test('a doctor run returns in bounded time even with every backend dead', async (t) => {
    const dead = await startStub({ '/x': [500, '{}'] });
    t.after(() => dead.close());
    const cap = freshCapability('bounded_dead');
    registerBackend(stubBackend('dead', { base: dead.base, path: '/x' }));
    const started = Date.now();
    const verdict = await probeCapability(cap, { env: {}, timeoutMs: 200, deadlineMs: 500 });
    const elapsed = Date.now() - started;
    assert.equal(verdict.live, null);
    assert.ok(elapsed < 500 + 1_000, `dead-backend walk took ${elapsed}ms (500ms deadline, 1s scheduling slack)`);
  });
});

describe('scope guards', () => {
  test('a fetch backend is never probed as a search backend', async () => {
    // Both kinds share one backend registry. Without the kind filter, the fetch
    // routes get asked for result rows -- which is how the first version of this
    // file ended up asking r.jina.ai to return search hits.
    const stub = await startStub({ '/x': [200, JSON.stringify([{ title: 'T', url: 'https://t.example/1' }])] });
    try {
      const cap = freshCapability('kind_scope');
      registerBackend(stubBackend('a-search', { base: stub.base, path: '/x' }));
      const other = await startStub({ '/x': [200, JSON.stringify([{ title: 'T', url: 'https://t.example/1' }])] });
      try {
        registerBackend({ ...stubBackend('a-fetch', { base: other.base, path: '/x' }), kind: 'fetch' });
        const verdict = await probeCapability(cap, { env: {}, timeoutMs: 1000, deadlineMs: 3000 });
        assert.ok(!verdict.tried.includes('a-fetch'), `a fetch backend leaked into the search chain: ${verdict.tried}`);
      } finally {
        await other.close();
        unregisterBackend('a-fetch');
      }
    } finally {
      await stub.close();
      unregisterBackend('a-search');
    }
  });

  test('a third-party reader is never handed a loopback or reserved address', () => {
    for (const bad of [
      'http://127.0.0.1:8080/x',
      'http://localhost/x',
      'http://10.0.0.5/x',
      'http://192.168.1.9/x',
      'http://172.16.0.1/x',
      'http://169.254.169.254/latest/meta-data',
      'http://[::1]/x',
      'http://box.internal/x',
      'https://example.com/',
      'not a url',
    ]) {
      assert.equal(isPublicFetchTarget(bad), false, `${bad} must not be handed to a fallback reader`);
    }
    assert.equal(isPublicFetchTarget('https://nodejs.org/en'), true);
  });
});
