import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Sandbox HOME + workspace BEFORE importing src modules (config.js bakes
// CONFIG_DIR from os.homedir() at import time — same pattern as v4b).
// ---------------------------------------------------------------------------

const realHome = process.env.HOME;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-v4c-home-'));
process.env.HOME = home;
fs.mkdirSync(path.join(home, '.ox'), { recursive: true });
process.env.OX_API_KEY = process.env.OX_API_KEY ?? 'test-v4c-key';

const savedEnv = Object.fromEntries(
  ['OX_FALLBACK_BOTS', 'OX_MODEL_WINDOW', 'OX_AUX_BOT', 'OX_BASE_URL', 'OX_MODEL'].map((k) => [k, process.env[k]])
);
for (const k of ['OX_FALLBACK_BOTS', 'OX_MODEL_WINDOW', 'OX_AUX_BOT', 'OX_BASE_URL', 'OX_MODEL']) delete process.env[k];

after(() => {
  fs.rmSync(home, { recursive: true, force: true });
  process.env.HOME = realHome;
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const { runAgent, draftContract, parseContractFields, parseGates, applySubgoal, draftTitle, sanitizeTitle } =
  await import('../src/agent.js');
const { expandContextRefs } = await import('../src/context.js');
const { renderContractBlock } = await import('../src/system-prompt.js');
const {
  createSession,
  appendEvent,
  listSessions,
  loadSession,
  buildSessionExport,
  redactSecrets,
  pruneSessions,
} = await import('../src/session.js');
const { sessionFileFromRef } = await import('../src/cli.js');

// ---------- mock-provider plumbing (loopback HTTP) ----------

const sse = (obj) => `data: ${JSON.stringify(obj)}\n`;

function turn({ text = '', usage = { prompt_tokens: 21, completion_tokens: 13 } } = {}) {
  return [
    text ? sse({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }) : '',
    sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    sse({ choices: [], usage }),
    'data: [DONE]\n\n',
  ].join('');
}

function startServer(t, classify) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      let messages = [];
      try {
        messages = JSON.parse(body)?.messages ?? [];
      } catch {}
      requests.push(messages);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(turn({ text: classify(messages, requests.length) }));
    });
  });
  t.after(() => {
    server.closeAllConnections?.();
    server.close();
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, requests }))
  );
}

const isJudge = (messages) =>
  messages.some((m) => m?.role === 'system' && String(m?.content).includes('completion auditor'));
const isContractDraft = (messages) =>
  messages.length === 1 && String(messages[0]?.content ?? '').includes('Draft a goal contract');
const isTitleCall = (messages) =>
  messages.length === 1 && String(messages[0]?.content ?? '').includes('session title');

const mkTarget = (port, model = 'mock-model') => ({
  provider: 'custom',
  baseUrl: `http://127.0.0.1:${port}/v1`,
  model,
});

async function collectEvents(opts) {
  const events = [];
  for await (const ev of runAgent(opts)) events.push(ev);
  return events;
}

function tmpDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* a throwing hook skips later cleanup: see e2e.test.js */ } });
  return dir;
}

const GOOD_CONTRACT_TEXT = [
  'Sure, here is the contract you asked for:',
  '',
  '```',
  'outcome: ALL_TESTS_PASS and feature flag flipped',
  'verification: npm test green; gate: node -e "process.exit(0)"',
  'constraints: zero new dependencies',
  'boundaries: never touch the bench directory',
  'stop_when: gates pass and docs updated',
  '```',
].join('\n');

// ---------- F3: contract drafting ----------

test('draftContract parses EXACTLY five field:value lines leniently from noisy output', async (t) => {
  const { port } = await startServer(t, (messages) => {
    assert.ok(isContractDraft(messages), 'drafting must be a single tools-omitted call');
    return GOOD_CONTRACT_TEXT;
  });
  const c = await draftContract(mkTarget(port), { goal: 'ship the widget feature' });
  assert.ok(c, 'contract drafted');
  assert.match(c.outcome, /ALL_TESTS_PASS/);
  assert.match(c.verification, /npm test green/);
  assert.equal(c.constraints, 'zero new dependencies');
  assert.equal(c.boundaries, 'never touch the bench directory');
  assert.equal(c.stop_when, 'gates pass and docs updated');
});

test('draftContract degrades to null on junk / failed calls', async (t) => {
  const { port } = await startServer(t, () => 'I cannot help with that, sorry!');
  assert.equal(await draftContract(mkTarget(port), { goal: 'do things' }), null);
});

test('parseContractFields accepts bullet prefixes and stop-when spellings; rejects garbage', () => {
  const c = parseContractFields(
    ['- Outcome: fast builds', '* VERIFICATION: tests exist', 'stop-when: CI is green', 'random noise line'].join('\n')
  );
  assert.ok(c);
  assert.match(c.outcome, /fast builds/);
  assert.match(c.verification, /tests exist/);
  assert.equal(c.stop_when, 'CI is green');
  assert.equal(parseContractFields('nothing usable here'), null);
});

test('parseGates extracts gate: segments from the verification string', () => {
  const gates = parseGates({
    verification: 'tests pass; gate: npm test; docs updated; gate: node check.js',
  });
  assert.deepEqual(gates, ['npm test', 'node check.js']);
  assert.deepEqual(parseGates({ verification: 'no gates here' }), []);
});

// ---------- F3: representation (system prompt + judge source) ----------

test('goalContract lands in the ## GOAL CONTRACT system block and switches the judge source', async (t) => {
  const cwd = tmpDir(t, 'ox-v4c-contract-');
  const contract = {
    outcome: 'CONTRACT_OUTCOME_MARKER met',
    verification: 'checks green',
    constraints: '',
    boundaries: 'bench untouched',
    stop_when: 'STOP_WHEN_MARKER reached',
  };
  let judgeUserContent = null;
  const { port, requests } = await startServer(t, (messages) => {
    if (isJudge(messages)) {
      judgeUserContent = String(messages.find((m) => m?.role === 'user')?.content ?? '');
      return '{"complete": true, "gaps": ""}';
    }
    return 'CONTRACT_RUN_FINAL';
  });

  const events = await collectEvents({
    target: mkTarget(port),
    messages: [{ role: 'user', content: 'RAW_GOAL_MARKER_XY do the thing' }],
    ctx: { cwd },
    auxTarget: null,
    verify: true,
    goalContract: contract,
  });

  assert.ok(events.some((e) => e.type === 'final'));
  const sys = requests[0]?.find((m) => m?.role === 'system');
  assert.ok(sys, 'system prompt captured');
  const sysText = String(sys.content);
  assert.ok(sysText.includes('## GOAL CONTRACT'), 'GOAL CONTRACT block present');
  assert.ok(sysText.includes('outcome: CONTRACT_OUTCOME_MARKER met'));
  assert.ok(sysText.includes('stop_when: STOP_WHEN_MARKER reached'));

  assert.ok(judgeUserContent, 'judge was called');
  const goalSection = judgeUserContent.split('\n\nTRANSCRIPT DIGEST:')[0];
  assert.ok(goalSection.includes('outcome: CONTRACT_OUTCOME_MARKER met'), 'judges contract fields');
  assert.ok(!goalSection.includes('RAW_GOAL_MARKER_XY'), 'raw goal no longer the judge source');
  assert.ok(judgeUserContent.includes('stop_when: STOP_WHEN_MARKER reached'));

  // no gates configured -> no gate events
  assert.equal(events.some((e) => e.type === 'gate'), false);
});

// ---------- F3: shell quality gates ----------

test('gate fail -> continuation -> fixed -> pass -> LLM verifier (no iteration charge)', async (t) => {
  const cwd = tmpDir(t, 'ox-v4c-gatefix-');
  const scratch = tmpDir(t, 'ox-v4c-gatefix-cnt-');
  const counter = path.join(scratch, 'counter.txt');
  // Run 1: counter 0->1, exit 3 (fail). Run 2: counter 1->2, exit 0 (pass).
  // The gate also stamps state INTO the workspace, so round 2 sees a changed
  // repo fingerprint and really re-executes instead of being skipped.
  fs.writeFileSync(
    path.join(scratch, 'gate-fail-once.js'),
    [
      "const fs = require('fs');",
      "const path = require('path');",
      'const p = process.argv[2];',
      'const ws = process.argv[3];',
      'let n = 0;',
      "try { n = Number(fs.readFileSync(p, 'utf8')); } catch {}",
      'n += 1;',
      'fs.writeFileSync(p, String(n));',
      "fs.writeFileSync(path.join(ws, '.gate-state'), String(n));",
      'process.exit(n >= 2 ? 0 : 3);',
      '',
    ].join('\n')
  );
  const gateCmd = `${process.execPath} ${path.join(scratch, 'gate-fail-once.js')} ${JSON.stringify(counter)} ${JSON.stringify(cwd)}`;
  const contract = {
    outcome: 'done',
    verification: `all checks green; gate: ${gateCmd}`,
    constraints: '',
    boundaries: '',
    stop_when: '',
  };

  let agentTurns = 0;
  const { port } = await startServer(t, (messages) => {
    if (isJudge(messages)) return '{"complete": true, "gaps": ""}';
    agentTurns++;
    return agentTurns === 1 ? 'first attempt (gate will fail)' : 'FIXED_FINAL gate now green';
  });

  const events = await collectEvents({
    target: mkTarget(port),
    messages: [{ role: 'user', content: 'make the gate pass' }],
    ctx: { cwd },
    auxTarget: null,
    verify: true,
    goalContract: contract,
  });

  const gateEvents = events.filter((e) => e.type === 'gate');
  assert.deepEqual(
    gateEvents.map((e) => [e.ok, e.exit]),
    [
      [false, 3],
      [true, 0],
    ]
  );
  assert.equal(gateEvents[0].unchanged, undefined, 'first failure really executed');

  const hist = events.find((e) => e.type === 'history').messages;
  const cont = hist.find((m) => m?.role === 'user' && String(m?.content).includes('Quality gate FAILED'));
  assert.ok(cont, 'continuation message appended');
  assert.match(cont.content, new RegExp(`Quality gate FAILED: ${gateCmd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} exited 3`));
  assert.match(cont.content, /Fix and ensure it passes\./);

  const verifications = events.filter((e) => e.type === 'verification');
  assert.equal(verifications.length, 1, 'verifier ran once after gates passed');
  assert.equal(verifications[0].complete, true);
  assert.equal(events.filter((e) => e.type === 'final').length, 1, 'failed gate attempt does not emit final');

  const iterTrail = events.filter((e) => e.type === 'turn-end').map((e) => e.iters);
  assert.deepEqual(iterTrail, [0, 1], 'gate continuation charges 0 iterations; terminal turn stays at 1');
  assert.equal(fs.readFileSync(counter, 'utf8'), '2', 'gate executed exactly twice');
});

test('GIT-FINGERPRINT SKIP: retry-cap exhaustion blocks completion before an approving judge', async (t) => {
  const cwd = tmpDir(t, 'ox-v4c-fp-');
  const scratch = tmpDir(t, 'ox-v4c-fp-cnt-');
  const counter = path.join(scratch, 'counter.txt');
  // Always fails with exit 7, appending one byte per EXECUTION to the counter.
  fs.writeFileSync(
    path.join(scratch, 'gate-always-fail.js'),
    [
      "const fs = require('fs');",
      "fs.appendFileSync(process.argv[2], 'x');",
      'process.exit(7);',
      '',
    ].join('\n')
  );
  const gateCmd = `${process.execPath} ${path.join(scratch, 'gate-always-fail.js')} ${JSON.stringify(counter)}`;
  const contract = {
    outcome: 'done',
    verification: `gate: ${gateCmd}`,
    constraints: '',
    boundaries: '',
    stop_when: '',
  };

  let agentTurns = 0;
  let judgeCalls = 0;
  const { port } = await startServer(t, (messages) => {
    if (isJudge(messages)) {
      judgeCalls++;
      return '{"complete": true, "gaps": ""}';
    }
    agentTurns++;
    return `attempt ${agentTurns} final`;
  });

  const events = await collectEvents({
    target: mkTarget(port),
    messages: [{ role: 'user', content: 'never satisfies the gate' }],
    ctx: { cwd },
    auxTarget: null,
    verify: true,
    goalContract: contract,
  });

  const gateEvents = events.filter((e) => e.type === 'gate');
  assert.equal(gateEvents[0].ok, false);
  assert.equal(gateEvents[0].exit, 7);
  assert.ok(gateEvents[0].unchanged === undefined, 'round 1 executes');
  const skipped = gateEvents.slice(1);
  assert.ok(skipped.length >= 2, 'later rounds skip execution');
  for (const ev of skipped) {
    assert.equal(ev.unchanged, true, 'skip flagged');
    assert.equal(ev.exit, 7, 'last exit remembered');
  }

  // Counter fixture proves executions happened exactly once despite 4 attempts.
  assert.equal(fs.readFileSync(counter, 'utf8').length, 1);

  const hist = events.find((e) => e.type === 'history').messages;
  const conts = hist.filter((m) => m?.role === 'user' && String(m?.content).includes('Quality gate FAILED'));
  assert.ok(conts.length >= 1);
  assert.ok(
    conts.some((m) => String(m.content).includes('(state unchanged since last failure)')),
    'unchanged-state note present in continuation'
  );

  const exhausted = events.find((e) => e.type === 'gate-exhausted');
  assert.ok(exhausted, 'exhaustion note emitted');
  assert.deepEqual(exhausted.pending, [gateCmd]);

  assert.equal(agentTurns, 4, 'required gates stop after the bounded retries');
  assert.equal(judgeCalls, 0, 'an approving judge cannot override exhausted required gates');
  assert.equal(events.filter((e) => e.type === 'verification').length, 0, 'exhausted gates stop before verification');
  assert.equal(events.filter((e) => e.type === 'final').length, 0, 'failed required gates never emit final');
  const errors = events.filter((e) => e.type === 'error');
  assert.equal(errors.length, 1, 'exhaustion terminates with an error');
  assert.match(errors[0].error, /required quality gates failed/);
  assert.ok(errors[0].error.includes(gateCmd), 'error identifies the unmet gate');
  assert.ok(events.indexOf(errors[0]) > events.indexOf(exhausted), 'error follows gate-exhausted');
  const iterTrail = events.filter((e) => e.type === 'turn-end').map((e) => e.iters);
  assert.deepEqual(iterTrail, [0, 0, 0, 1], 'gate loops never accumulate iteration charges');
});

// ---------- F3 surface wiring (/goal + /subgoal smoke) ----------

test('/goal + /subgoal wiring: applySubgoal appends criteria, block renders, gates pick it up', () => {
  const base = parseContractFields(GOOD_CONTRACT_TEXT);
  assert.ok(base);
  const extended = applySubgoal(base, 'gate: npm run lint');
  assert.match(extended.verification, /npm test green; gate: node/);
  assert.match(extended.verification, /; gate: npm run lint$/);
  assert.deepEqual(parseGates(extended), ['node -e "process.exit(0)"', 'npm run lint']);

  const block = renderContractBlock(extended);
  assert.ok(block.startsWith('## GOAL CONTRACT'));
  for (const label of ['outcome:', 'verification:', 'constraints:', 'boundaries:', 'stop_when:']) {
    assert.ok(block.includes(label), `labeled field ${label}`);
  }
  // empty fields are omitted rather than rendered blank
  const sparse = renderContractBlock({ outcome: 'only outcome', constraints: '' });
  assert.ok(!sparse.includes('stop_when'));
  assert.equal(renderContractBlock(null), '');
});

// ---------- F4: @ context references ----------

test('expandContextRefs: unknown tokens stay literal with a once-per-process dim note', (t) => {
  const cwd = tmpDir(t, 'ox-v4c-refs-unknown-');
  const errChunks = [];
  const origErr = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    errChunks.push(String(chunk));
    return origErr(chunk, ...rest);
  };
  try {
    const out = expandContextRefs('please read @definitely-missing-9x7.txt and also @also-absent-3b1.md', cwd);
    assert.ok(out.includes('@definitely-missing-9x7.txt'), 'token left literal');
    assert.ok(out.includes('@also-absent-3b1.md'), 'second unknown token also left literal');
  } finally {
    process.stderr.write = origErr;
  }
  const notes = errChunks.filter((c) => c.includes('@ref') && c.includes('left literal'));
  assert.equal(notes.length, 1, `exactly one once-per-process note, got ${notes.length}`);
});

test('expandContextRefs: inline file blocks capped at 2000 chars; dir trees capped at 40 entries/1000 chars', (t) => {
  const cwd = tmpDir(t, 'ox-v4c-refs-');
  fs.writeFileSync(path.join(cwd, 'big.txt'), 'B'.repeat(3000));
  const sub = path.join(cwd, 'lots');
  fs.mkdirSync(sub);
  for (let i = 0; i < 55; i++) fs.writeFileSync(path.join(sub, `f${String(i).padStart(2, '0')}.txt`), 'x');

  const out = expandContextRefs('see @big.txt and @lots/', cwd);
  assert.ok(out.includes('[begin @big.txt]'));
  const fileBody = out.split('[begin @big.txt]\n')[1].split('\n[end]')[0];
  assert.equal(fileBody.length, 2000, 'file content truncated to 2000 chars');
  assert.ok(fileBody.endsWith('B'));

  assert.ok(out.includes('[begin @lots/]'));
  const treeBody = out.split('[begin @lots/]\n')[1].split('\n[end]')[0];
  const entryLines = treeBody.split('\n').filter((l) => l.endsWith('.txt'));
  assert.ok(entryLines.length <= 40, `at most 40 entries, got ${entryLines.length}`);
  assert.ok(treeBody.includes('truncated'), 'truncation noted');
  assert.ok(treeBody.length <= 1100, `tree body bounded (got ${treeBody.length})`);
});

test('expandContextRefs: @git.diff inlines the working-tree diff best-effort (≤4KB)', (t) => {
  const repo = tmpDir(t, 'ox-v4c-git-');
  const g = (...args) =>
    execFileSync('git', args, { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env } });
  g('init');
  g('config', 'user.email', 'ox@test');
  g('config', 'user.name', 'ox');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'base\n');
  g('add', '.');
  g('commit', '-m', 'init');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'base\nCHANGED_MARKER_LINE\n');

  const out = expandContextRefs('diff please @git.diff', repo);
  assert.ok(out.includes('[begin @git.diff]'));
  const diffBody = out.split('[begin @git.diff]\n')[1].split('\n[end]')[0];
  assert.ok(diffBody.includes('+CHANGED_MARKER_LINE'));
  assert.ok(diffBody.length <= 4096);
  assert.ok(out.includes('diff please'), 'surrounding text preserved');
});

test('expandContextRefs: combined inserted content caps near 8KB (overflow tokens stay literal)', (t) => {
  const cwd = tmpDir(t, 'ox-v4c-cap-');
  for (const name of ['a', 'b', 'c', 'd', 'e']) {
    fs.writeFileSync(path.join(cwd, `${name}.txt`), name.repeat(4000));
  }
  const out = expandContextRefs('@a.txt @b.txt @c.txt @d.txt @e.txt', cwd);
  const opened = out.split('[begin @').length - 1;
  assert.equal(opened, 4, `budget allows exactly 4 blocks before exhaustion, got ${opened}`);
  assert.ok(!out.includes('[begin @e.txt]'), 'overflow token left unexpanded');
  assert.ok(out.includes('@e.txt'), 'overflow token still present literally');
});

// ---------- F5: session titles ----------

test('draftTitle produces one sanitized ≤80-char line; junk yields null', async (t) => {
  const { port } = await startServer(t, (messages) => {
    assert.ok(isTitleCall(messages));
    if (String(messages[0].content).length > 100000) return 'x';
    return '  Fix the Login Bug!!\nsecond line should vanish  ';
  });
  const title = await draftTitle(mkTarget(port), { text: 'some long assistant answer' });
  assert.equal(title, 'Fix the Login Bug!!');
  assert.ok(title.length <= 80);

  const long = await startServer(t, () => `T`.repeat(500));
  const t2 = await draftTitle(mkTarget(long.port), { text: 'answer' });
  assert.ok(t2.length <= 80, `long titles clamp to 80 (got ${t2.length})`);

  const empty = await startServer(t, () => '   ');
  assert.equal(await draftTitle(mkTarget(empty.port), { text: 'answer' }), null);
  assert.equal(sanitizeTitle('a/b\\c:d*e?f"g<h>i|j'), 'abcdefghij');
});

test('listSessions surfaces titles; resume resolves by id AND title prefix', () => {
  const s1 = createSession(process.cwd());
  appendEvent(s1, { t: 'user', text: 'release engineering run' });
  appendEvent(s1, { t: 'assistant', text: 'done' });
  appendEvent(s1, { t: 'title', title: 'Release Engineering Sweep' });
  const s2 = createSession(process.cwd());
  appendEvent(s2, { t: 'user', text: 'other work' });
  const id2 = path.basename(s2.file).match(/-([0-9a-f]{6})\.jsonl$/)[1];

  const rows = listSessions(50);
  const withTitle = rows.find((r) => r.title === 'Release Engineering Sweep');
  assert.ok(withTitle, 'title column populated from meta events');
  assert.equal(withTitle.file, s1.file);

  assert.equal(sessionFileFromRef(withTitle.id), s1.file, 'exact id still resolves');
  assert.equal(sessionFileFromRef('release eng'), s1.file, 'case-insensitive title prefix resolves');
  assert.equal(sessionFileFromRef(id2), s2.file);
  assert.equal(sessionFileFromRef('no-such-title-zzz'), null);
});

// ---------- F5: export / redact ----------

const SECRET_SESSION_EVENTS = [
  { t: 'meta', created: '2026-08-24T10:00:00.000Z', cwd: '/tmp/proj' },
  { t: 'user', text: 'deploy with sk-live-abcdef1234567890 and AKIAABCDEFGHIJKLMNOP and ghp_abcdefghijklmnopqrstuvwxyz' },
  {
    t: 'assistant',
    text: 'using Authorization: Bearer abcdef1234567890abcd and apiKey=hunter2supersecret value',
    tool_calls: [{ id: 'call_x1', type: 'function', function: { name: 'bash', arguments: '{"command":"echo hi"}' } }],
  },
  { t: 'tool-result', callId: 'call_x1', name: 'bash', isError: false, content: 'exit 0\n--- stdout ---\nhi' },
  {
    t: 'user',
    text: 'key block:\n-----BEGIN RSA PRIVATE KEY-----\nMIIBOGSECRETMATERIAL\n-----END RSA PRIVATE KEY-----\n',
  },
];

function secretSessionFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-v4c-export-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* a throwing hook skips later cleanup: see e2e.test.js */ } });
  const file = path.join(dir, '20260824-abc123.jsonl');
  fs.writeFileSync(file, SECRET_SESSION_EVENTS.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return file;
}

test('buildSessionExport: md transcript summarizes tools; jsonl verbatim; redaction kills ≥4 secret classes', (t) => {
  const file = secretSessionFile(t);

  const mdRaw = buildSessionExport(file, { format: 'md' });
  assert.ok(mdRaw.data.startsWith('# ox session 20260824-abc123'));
  assert.ok(mdRaw.data.includes('## user'));
  assert.ok(mdRaw.data.includes('## assistant'));
  assert.ok(mdRaw.data.includes('[called tools: bash({"command":"echo hi"})]'));
  assert.ok(mdRaw.data.includes('## tool result → bash'));
  assert.ok(mdRaw.data.includes('sk-live-abcdef1234567890'), 'raw export keeps secrets');

  const mdRed = buildSessionExport(file, { format: 'md', redact: true });
  for (const secret of [
    'sk-live-abcdef1234567890',
    'AKIAABCDEFGHIJKLMNOP',
    'ghp_abcdefghijklmnopqrstuvwxyz',
    'Bearer abcdef1234567890abcd',
    'apiKey=hunter2supersecret',
    'MIIBOGSECRETMATERIAL',
  ]) {
    assert.ok(!mdRed.data.includes(secret), `redacted md must drop ${secret}`);
  }
  const redactions = mdRed.data.split('[REDACTED]').length - 1;
  assert.ok(redactions >= 4, `expected ≥4 [REDACTED] hits, got ${redactions}`);

  const jl = buildSessionExport(file, { format: 'jsonl', redact: true });
  const eventsBack = jl.data.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(eventsBack.length, SECRET_SESSION_EVENTS.length, 'jsonl is lossless in shape');
  assert.equal(eventsBack[1].t, 'user');
  assert.ok(!jl.data.includes('AKIAABCDEFGHIJKLMNOP'));
  assert.ok(JSON.stringify(redactSecrets({ nested: ['ghp_abcdefghijklmnopqrstuvwxyz'] })).includes('[REDACTED]'));
});

test('ox session export CLI: --out writes 0600 file; stdout md by default; resume-by-title feeds it', async (t) => {
  const ws = tmpDir(t, 'ox-v4c-expws-');
  const s = createSession(ws, { bot: 'm', provider: 'custom' });
  appendEvent(s, { t: 'user', text: 'export me with sk-live-abcdef1234567890 please' });
  appendEvent(s, { t: 'assistant', text: 'EXPORT_DONE' });
  appendEvent(s, { t: 'title', title: 'Export Me Please' });
  const id = path.basename(s.file).match(/-([0-9a-f]{6})\.jsonl$/)[1];

  const out = path.join(ws, 'export.jsonl');
  const r1 = await spawnOx(t, ['session', 'export', id, '--format', 'jsonl', '--redact', '--out', out]);
  assert.equal(r1.code, 0, `stdout: ${r1.stdout}\nstderr: ${r1.stderr}`);
  const st = fs.statSync(out);
  assert.equal(st.mode & 0o777, 0o600, `--out must be 0600, got ${((st.mode & 0o777).toString(8))}`);
  const written = fs.readFileSync(out, 'utf8');
  assert.ok(written.includes('"t":"user"'));
  assert.ok(!written.includes('sk-live-abcdef1234567890'));

  const r2 = await spawnOx(t, ['session', 'export', 'latest']);
  assert.equal(r2.code, 0, r2.stderr);
  assert.ok(r2.stdout.startsWith('# ox session '), 'default md goes to stdout');

  const r3 = await spawnOx(t, ['session', 'export', 'nope-none']);
  assert.equal(r3.code, 3);
});

// ---------- F5: prune ----------

test('pruneSessions: dry-run lists, real run deletes strictly older-than-Nd files (faked utimes)', () => {
  const old1 = createSession(process.cwd());
  const old2 = createSession(process.cwd());
  const young = createSession(process.cwd());
  appendEvent(young, { t: 'user', text: 'keep me' });
  const ancient = new Date(Date.now() - 120 * 86_400_000);
  fs.utimesSync(old1.file, ancient, ancient);
  fs.utimesSync(old2.file, ancient, ancient);

  const dry = pruneSessions({ olderThanDays: 90, dryRun: true });
  assert.ok(dry.dryRun);
  assert.ok(dry.deleted.includes(old1.file) && dry.deleted.includes(old2.file));
  assert.ok(fs.existsSync(old1.file) && fs.existsSync(old2.file), 'dry-run deletes nothing');
  assert.ok(!dry.deleted.includes(young.file));

  const real = pruneSessions({ olderThanDays: 90 });
  assert.equal(real.deleted.length, dry.deleted.length);
  assert.ok(!fs.existsSync(old1.file) && !fs.existsSync(old2.file), 'stale files removed');
  assert.ok(fs.existsSync(young.file), 'fresh file kept');
  assert.ok(real.freedBytes > 0);
});

// ---------- spawned CLI plumbing (isolated HOME already active) ----------

import { spawn } from 'node:child_process';

const OX_BIN = new URL('../bin/ox.js', import.meta.url).pathname;

function spawnOx(t, args, { cwd = process.cwd(), timeoutMs = 25000, extraEnv = {} } = {}) {
  const child = spawn(process.execPath, [OX_BIN, ...args], {
    cwd,
    env: { ...process.env, HOME: home, ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  const done = new Promise((resolve) => {
    const killer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      resolve({ code: null, stdout, stderr: `${stderr}\n[v4c test: timed out after ${timeoutMs}ms]` });
    }, timeoutMs);
    child.on('error', () => {
      clearTimeout(killer);
      resolve({ code: null, stdout, stderr });
    });
    child.on('close', (code) => {
      clearTimeout(killer);
      resolve({ code, stdout, stderr });
    });
  });
  t.after(() => {
    try {
      child.kill('SIGKILL');
    } catch {}
  });
  child.stdin.end();
  return done;
}

test('ox auto --contract: drafts contract, enforces gates, verifies, titles the session (end-to-end)', async (t) => {
  const ws = tmpDir(t, 'ox-v4c-autows-');
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      let messages = [];
      try {
        messages = JSON.parse(body)?.messages ?? [];
      } catch {}
      requests.push(messages);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (isContractDraft(messages)) {
        res.end(
          turn({
            text: [
              'outcome: AUTO_OUTCOME_MARKER widget config parses',
              'verification: sanity checks; gate: true',
              'constraints: keep it tiny',
              'boundaries: bench untouched',
              'stop_when: gate passes once',
            ].join('\n'),
          })
        );
      } else if (isJudge(messages)) {
        res.end(turn({ text: '{"complete": true, "gaps": ""}' }));
      } else if (isTitleCall(messages)) {
        res.end(turn({ text: 'Widget Config Fixed' }));
      } else {
        res.end(turn({ text: 'AUTO_CONTRACT_DONE work finished' }));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(() => {
    server.closeAllConnections?.();
    server.close();
  });

  const r = await spawnOx(t, ['auto', '--contract', 'fix the widget', '-y', '--json'], {
    cwd: ws,
    extraEnv: { OX_BASE_URL: `http://127.0.0.1:${port}/v1`, OX_API_KEY: 'test', OX_AUX_BOT: 'mock-model' },
  });
  assert.equal(r.code, 0, `exit ${r.code}\nstdout: ${r.stdout.slice(0, 1200)}\nstderr: ${r.stderr}`);

  const events = r.stdout
    .split('\n')
    .filter((l) => l.trim().startsWith('{'))
    .map((l) => JSON.parse(l));

  const contractEv = events.find((e) => e.t === 'goal-contract');
  assert.ok(contractEv, 'goal-contract event printed');
  assert.match(contractEv.outcome, /AUTO_OUTCOME_MARKER/);

  const gateOk = events.find((e) => e.t === 'gate' && e.ok === true);
  assert.ok(gateOk, 'gate executed and passed');
  assert.equal(gateOk.cmd, 'true');

  const verdict = events.find((e) => e.t === 'verification');
  assert.ok(verdict?.complete === true, 'LLM verifier completed after gates');

  const summary = events.find((e) => e.t === 'auto-summary');
  assert.ok(summary, 'auto-summary present');
  assert.equal(summary.status, 'complete');
  assert.ok(summary.session && fs.existsSync(summary.session), 'session file recorded');

  // judge judged the CONTRACT (not the raw goal), and the system prompt
  // carried the block — visible in the captured request bodies.
  const judgeReq = requests.find((m) => isJudge(m));
  const judgeUser = String(judgeReq?.find((m) => m?.role === 'user')?.content ?? '');
  assert.ok(judgeUser.includes('outcome: AUTO_OUTCOME_MARKER widget config parses'));

  const sessEvents = loadSession(summary.session);
  assert.ok(sessEvents.some((e) => e.t === 'title' && e.title === 'Widget Config Fixed'), 'title meta event written');
  assert.ok(sessEvents.some((e) => e.t === 'user' && String(e.text).includes('fix the widget')));
});
