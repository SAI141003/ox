import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.OX_API_KEY = process.env.OX_API_KEY ?? 'test-v02a-key';

const origHome = process.env.HOME;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-v02a-home-'));
process.env.HOME = home;
const cwdA = path.join(home, 'proj-a');
const cwdB = path.join(home, 'proj-b');
fs.mkdirSync(cwdA, { recursive: true });
fs.mkdirSync(cwdB, { recursive: true });
const savedEnv = Object.fromEntries(
  ['OX_FALLBACK_BOTS', 'OX_MODEL_WINDOW', 'OX_AUX_BOT', 'OX_BASE_URL', 'OX_MODEL'].map((k) => [k, process.env[k]])
);
for (const k of Object.keys(savedEnv)) delete process.env[k];

after(() => {
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  fs.rmSync(home, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const { runAgent } = await import('../src/agent.js');
const { buildContext } = await import('../src/context.js');
const { writeSessionNote } = await import('../src/memory.js');
const session = await import('../src/session.js');
const {
  editFileTool,
  globTool,
  grepTool,
  listDirTool,
  pruneBackups,
  writeFileTool,
} = await import('../src/tools/fs.js');

const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

function turn({ text = '', calls = [], usage = { prompt_tokens: 21, completion_tokens: 13 } } = {}) {
  const out = [];
  if (text) {
    out.push(sse({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }));
  }
  calls.forEach((call, index) => {
    out.push(
      sse({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index,
                  id: call.id,
                  type: 'function',
                  function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      })
    );
  });
  out.push(sse({ choices: [{ index: 0, delta: {}, finish_reason: calls.length ? 'tool_calls' : 'stop' }] }));
  out.push(sse({ choices: [], usage }));
  out.push('data: [DONE]\n\n');
  return out.join('');
}

function startServer(t, handler) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      let messages = [];
      try {
        messages = JSON.parse(body)?.messages ?? [];
      } catch {}
      const response = handler(messages);
      res.writeHead(response?.status ?? 200, { 'content-type': 'text/event-stream' });
      res.end(typeof response === 'string' ? response : response.body);
    });
  });
  t.after(() => {
    server.closeAllConnections?.();
    server.close();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

const isJudge = (messages) =>
  messages.some((m) => m?.role === 'system' && String(m?.content).includes('completion auditor'));

const mockTarget = (port) => ({
  provider: 'custom',
  baseUrl: `http://127.0.0.1:${port}/v1`,
  model: 'mock-model',
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

// ---------- capability 1: independent goal verifier ----------

test('verifier: incomplete -> gap nudge -> continuation -> complete; JSON-in-prose parsed; usage counted', async (t) => {
  const cwd = tmpDir(t, 'ox-v02a-verify-');
  let judgeCalls = 0;
  let agentTurns = 0;
  const port = await startServer(t, (messages) => {
    if (isJudge(messages)) {
      judgeCalls++;
      return turn({
        text:
          judgeCalls === 1
            ? 'My assessment:\n\nSure thing, here it is:\n```json\n{"complete": false, "gaps": "tests not updated"}\n```\nRegards.'
            : 'Verdict: {"complete": true, "gaps": ""}',
        usage: { prompt_tokens: 111, completion_tokens: 7 },
      });
    }
    agentTurns++;
    return turn({ text: agentTurns === 1 ? 'partial work done' : 'V2_FINAL fully done now' });
  });

  const events = await collectEvents({
    target: mockTarget(port),
    messages: [{ role: 'user', content: 'add feature X and update tests' }],
    ctx: { cwd },
    verify: true,
  });

  assert.equal(judgeCalls, 2, 'verifier ran twice');
  assert.equal(agentTurns, 2, 'agent continued after the gap verdict');

  const verifications = events.filter((e) => e.type === 'verification');
  assert.equal(verifications.length, 2);
  assert.deepEqual(
    verifications.map((v) => [v.round, v.complete]),
    [
      [1, false],
      [2, true],
    ]
  );
  assert.match(verifications[0].gaps, /tests not updated/, 'gaps extracted from fenced JSON-in-prose');
  assert.equal(verifications[1].gaps, '');

  const finals = events.filter((e) => e.type === 'final');
  assert.equal(finals.length, 1, 'failed verification attempts do not emit final');
  assert.equal(finals[0].message.content, 'V2_FINAL fully done now');
  assert.ok(events.indexOf(finals[0]) > events.indexOf(verifications[1]), 'final follows successful verification');
  const hist = events.find((e) => e.type === 'history');
  const nudge = hist.messages.find(
    (m) => m?.role === 'user' && String(m?.content).includes('Your work is incomplete')
  );
  assert.ok(nudge, 'continuation nudge present in history');
  assert.match(nudge.content, /Unmet criteria: tests not updated\. Continue\./);

  // totals include verifier usage: agent 2*(21+13) + judge 2*(111+7)
  const total = events.find((e) => e.type === 'usage-total');
  assert.equal(total.inputTokens, 264);
  assert.equal(total.outputTokens, 40);
});

test('verifier: disabled by default (no verification events, single turn)', async (t) => {
  const cwd = tmpDir(t, 'ox-v02a-noverify-');
  let requests = 0;
  const port = await startServer(t, () => {
    requests++;
    return turn({ text: 'plain final' });
  });
  const events = await collectEvents({
    target: mockTarget(port),
    messages: [{ role: 'user', content: 'just finish' }],
    ctx: { cwd },
  });
  assert.equal(requests, 1);
  assert.equal(events.some((e) => e.type === 'verification'), false);
  assert.equal(events.filter((e) => e.type === 'final').length, 1);
});

test('verifier: unparsable verdict treated as incomplete but bounded to two rounds', async (t) => {
  const cwd = tmpDir(t, 'ox-v02a-junkjudge-');
  let judgeCalls = 0;
  let agentTurns = 0;
  const port = await startServer(t, (messages) => {
    if (isJudge(messages)) {
      judgeCalls++;
      return turn({ text: 'I cannot decide, sorry.', usage: { prompt_tokens: 5, completion_tokens: 5 } });
    }
    agentTurns++;
    return turn({ text: `attempt ${agentTurns}` });
  });
  const events = await collectEvents({
    target: mockTarget(port),
    messages: [{ role: 'user', content: 'do the thing' }],
    ctx: { cwd },
    verify: true,
  });
  assert.equal(judgeCalls, 2, 'bounded at VERIFY_MAX_ROUNDS');
  assert.equal(agentTurns, 2);
  const verifications = events.filter((e) => e.type === 'verification');
  assert.equal(verifications.length, 2);
  assert.equal(verifications[0].complete, false);
  assert.equal(verifications[1].complete, false, 'terminal round remains incomplete when the LLM verdict is incomplete');
  assert.ok(verifications.every((e) => e.llm.complete === false && e.verifierPassed === true));
  assert.ok(events.some((e) => e.type === 'error'), 'unresolved verification fails the run');
  assert.equal(events.filter((e) => e.type === 'final').length, 0, 'malformed verdicts never emit final');
});

test('verifier: judge HTTP exception fails closed despite passing local checks', async (t) => {
  const cwd = tmpDir(t, 'ox-v02a-judge-error-');
  let judgeCalls = 0;
  let agentTurns = 0;
  const port = await startServer(t, (messages) => {
    if (isJudge(messages)) {
      judgeCalls++;
      return { status: 400, body: 'JUDGE_EXCEPTION_MARKER' };
    }
    agentTurns++;
    return turn({ text: `attempt ${agentTurns}` });
  });
  const events = await collectEvents({
    target: mockTarget(port),
    auxTarget: null,
    messages: [{ role: 'user', content: 'finish only after verification' }],
    ctx: { cwd },
    verify: true,
  });
  assert.equal(judgeCalls, 2, 'judge exceptions are bounded to two rounds');
  assert.equal(agentTurns, 2);
  const verifications = events.filter((e) => e.type === 'verification');
  assert.equal(verifications.length, 2);
  for (const ev of verifications) {
    assert.equal(ev.complete, false);
    assert.equal(ev.llm.complete, false);
    assert.equal(ev.verifierPassed, true, 'local checks cannot override a failed judge');
    assert.match(ev.gaps, /goal judge error:.*JUDGE_EXCEPTION_MARKER/);
  }
  assert.equal(events.filter((e) => e.type === 'final').length, 0, 'judge exceptions never emit final');
  const errors = events.filter((e) => e.type === 'error');
  assert.equal(errors.length, 1);
  assert.match(errors[0].error, /verification failed after 2 round\(s\).*JUDGE_EXCEPTION_MARKER/);
  const history = events.find((e) => e.type === 'history').messages;
  assert.ok(history.some((m) => m.role === 'user' && String(m.content).includes('Unmet criteria: goal judge error:')));
});

test('verifier: local verifier exception fails closed despite an approving judge', async (t) => {
  const cwd = tmpDir(t, 'ox-v02a-verifier-error-');
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ scripts: {} }));
  const existsSync = fs.existsSync;
  let verifierCalls = 0;
  t.mock.method(fs, 'existsSync', (file) => {
    if (file === path.join(cwd, 'node_modules', '.bin', 'eslint')) {
      verifierCalls++;
      throw new Error('VERIFIER_EXCEPTION_MARKER');
    }
    return existsSync(file);
  });
  let judgeCalls = 0;
  let agentTurns = 0;
  const port = await startServer(t, (messages) => {
    if (isJudge(messages)) {
      judgeCalls++;
      return turn({ text: '{"complete":true,"gaps":""}' });
    }
    agentTurns++;
    return turn({ text: `attempt ${agentTurns}` });
  });
  const events = await collectEvents({
    target: mockTarget(port),
    auxTarget: null,
    messages: [{ role: 'user', content: 'finish only after lint verification' }],
    ctx: { cwd },
    verify: true,
    goalContract: { outcome: 'done', verification: 'lint', constraints: '', boundaries: '', stop_when: '' },
  });
  assert.equal(judgeCalls, 2);
  assert.equal(verifierCalls, 2, 'the local verifier threw on both bounded rounds');
  assert.equal(agentTurns, 2);
  const verifications = events.filter((e) => e.type === 'verification');
  assert.equal(verifications.length, 2);
  for (const ev of verifications) {
    assert.equal(ev.complete, false);
    assert.equal(ev.llm.complete, true, 'judge approval cannot override a verifier exception');
    assert.equal(ev.verifierPassed, false);
    assert.equal(ev.verifierReport, null);
    assert.equal(ev.verifierError, 'VERIFIER_EXCEPTION_MARKER');
    assert.match(ev.gaps, /verifier error: VERIFIER_EXCEPTION_MARKER/);
  }
  assert.equal(events.filter((e) => e.type === 'final').length, 0, 'verifier exceptions never emit final');
  const errors = events.filter((e) => e.type === 'error');
  assert.equal(errors.length, 1);
  assert.match(errors[0].error, /verification failed after 2 round\(s\).*VERIFIER_EXCEPTION_MARKER/);
  const history = events.find((e) => e.type === 'history').messages;
  assert.ok(history.some((m) => m.role === 'user' && String(m.content).includes('Unmet criteria: verifier error:')));
});

test('verifier: real test failure blocks completion and feeds guidance', async (t) => {
  const cwd = tmpDir(t, 'ox-v02a-realverify-');
  fs.writeFileSync(
    path.join(cwd, 'package.json'),
    JSON.stringify({
      scripts: {
        test: 'node -e "process.exit(1)"',
        lint: 'node -e "process.exit(0)"',
        build: 'node -e "process.exit(0)"',
      },
    })
  );
  const contract = {
    outcome: 'done',
    verification: 'tests lint build security',
    constraints: '',
    boundaries: '',
    stop_when: '',
  };
  let agentTurns = 0;
  const port = await startServer(t, (messages) => {
    if (isJudge(messages)) return turn({ text: '{"complete": true, "gaps": ""}' });
    agentTurns++;
    return turn({ text: `attempt ${agentTurns}` });
  });
  const events = await collectEvents({
    target: mockTarget(port),
    messages: [{ role: 'user', content: 'make the tests pass' }],
    ctx: { cwd },
    verify: true,
    goalContract: contract,
  });
  const verifications = events.filter((e) => e.type === 'verification');
  assert.equal(verifications.length, 2);
  assert.ok(verifications.every((e) => e.complete === false));
  assert.equal(verifications[0].llm.complete, true);
  assert.equal(verifications[0].verifierPassed, false);
  assert.ok(verifications[0].checks.some((check) => check.name === 'tests' && check.passed === false));
  const history = events.find((e) => e.type === 'history').messages;
  assert.ok(history.some((m) => m?.role === 'user' && String(m.content).includes('tests')));
  assert.ok(events.some((e) => e.type === 'error'));
  assert.equal(events.filter((e) => e.type === 'final').length, 0, 'failed verifier never emits final');
});

// ---------- capability 2: structured checkpoints ----------

test('checkpoint: forced compaction writes 11-field checkpoint reusing the summary', async (t) => {
  const cwd = tmpDir(t, 'ox-v02a-compact-');
  let requests = 0;
  const port = await startServer(t, () => {
    requests++;
    if (requests === 1) return turn({ text: 'COMPACT_SUMMARY_MARKER preserved decisions here' });
    return turn({ text: 'final after compaction' });
  });

  const bigUser = 'y'.repeat(4000);
  const messages = [
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'u2' },
    { role: 'assistant', content: 'a2' },
    { role: 'user', content: 'u3' },
    { role: 'assistant', content: 'a3' },
    { role: 'user', content: bigUser },
  ];
  const events = await collectEvents({
    target: mockTarget(port),
    messages,
    ctx: { cwd, modelWindow: 500 },
  });

  assert.ok(events.some((e) => e.type === 'compaction'), 'compaction occurred');
  assert.equal(requests, 2, 'one summary request + one final turn');

  const ckDir = path.join(cwd, '.agent', 'notes');
  assert.ok(fs.existsSync(ckDir), 'checkpoints dir created');
  const files = fs.readdirSync(ckDir).filter((f) => f.endsWith('.md'));
  assert.ok(files.length >= 1, 'checkpoint file exists');
  const bodies = files.map((f) => fs.readFileSync(path.join(ckDir, f), 'utf8'));

  const compactCk = bodies.find((b) => b.includes('Phase: compaction'));
  assert.ok(compactCk, 'compaction-phase checkpoint written');
  assert.match(compactCk, /COMPACT_SUMMARY_MARKER/, 'produced summary reused as decisions[0]');

  const preCk = bodies.find((b) => b.includes('Phase: pre-compaction'));
  assert.ok(preCk, '70%-of-window crossing wrote a pre-compaction checkpoint');

  for (const body of [compactCk, preCk]) {
    for (const field of [
      'Goal:',
      'Status:',
      'Phase:',
      'Files touched',
      'Decisions',
      'Errors seen',
      'Next steps',
      'Tokens in-out',
      'Cost USD',
      'Model:',
      'Date:',
    ]) {
      assert.ok(body.includes(field), `template field '${field}' present`);
    }
    assert.ok(body.split('\n').length <= 60, 'checkpoint capped at 60 lines');
  }
});

test('checkpoint: pruning keeps the newest 20 files', (t) => {
  const cwd = tmpDir(t, 'ox-v02a-prune-');
  for (let i = 1; i <= 23; i++) {
    const goal = `goal number ${String(i).padStart(2, '0')} slug${i}`;
    assert.equal(writeSessionNote(cwd, { phase: 'prune-test', goal, status: 'ok', model: 'm' }), true);
  }
  const dir = path.join(cwd, '.agent', 'notes');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
  assert.equal(files.length, 20, 'older checkpoints pruned beyond 20');
  assert.ok(files.some((f) => f.includes('slug23')), 'newest checkpoint kept');
  assert.ok(!files.some((f) => f.includes('slug01')), 'oldest checkpoint pruned');
});

// ---------- capability 3: patch backups ----------

test('backups: edit_file and write_file back up originals; suppressed by OX_NO_BACKUPS; pruneBackups prunes oldest', async (t) => {
  const dir = tmpDir(t, 'ox-v02a-bak-');
  const abs = path.join(dir, 'code.txt');
  fs.writeFileSync(abs, 'original body\n');

  const edited = await editFileTool({ path: abs, old_string: 'original', new_string: 'EDITED' }, { cwd: dir });
  assert.equal(edited.isError, undefined);
  assert.equal(fs.readFileSync(abs, 'utf8'), 'EDITED body\n');

  const root = path.join(dir, '.ox-backups');
  let stamps = fs.readdirSync(root);
  assert.equal(stamps.length, 1);
  assert.match(stamps[0], /^\d{8}-\d{6}/, 'timestamped backup dir');
  assert.equal(fs.readFileSync(path.join(root, stamps[0], 'code.txt'), 'utf8'), 'original body\n');

  await writeFileTool({ path: abs, content: 'replaced entirely\n' }, { cwd: dir, yolo: true });
  stamps = fs.readdirSync(root);
  assert.equal(stamps.length, 2, 'write_file overwrite also backed up');
  const lastBackup = fs.readFileSync(path.join(root, stamps.sort()[0], 'code.txt'), 'utf8');
  assert.equal(lastBackup, 'original body\n');

  const dir2 = tmpDir(t, 'ox-v02a-bak2-');
  const f2 = path.join(dir2, 'b.txt');
  fs.writeFileSync(f2, 'keep\n');
  process.env.OX_NO_BACKUPS = '1';
  try {
    const res = await writeFileTool({ path: f2, content: 'replaced\n' }, { cwd: dir2, yolo: true });
    assert.equal(res.isError, undefined);
    assert.equal(fs.readFileSync(f2, 'utf8'), 'replaced\n');
    assert.equal(fs.existsSync(path.join(dir2, '.ox-backups')), false, 'no backups when suppressed');
  } finally {
    delete process.env.OX_NO_BACKUPS;
  }

  const dir3 = tmpDir(t, 'ox-v02a-bak3-');
  const root3 = path.join(dir3, '.ox-backups');
  for (const [name, payload] of [
    ['20240101-000000', 'a'.repeat(2000)],
    ['20240102-000000', 'b'.repeat(2000)],
    ['20240103-000000', 'c'.repeat(2000)],
  ]) {
    fs.mkdirSync(path.join(root3, name), { recursive: true });
    fs.writeFileSync(path.join(root3, name, 'data.bin'), payload);
  }
  const deleted = await pruneBackups(dir3, 5000);
  assert.equal(deleted, 1, 'oldest dir removed to get under maxBytes');
  assert.deepEqual(fs.readdirSync(root3).sort(), ['20240102-000000', '20240103-000000']);
});

test('backups: .ox-backups is skipped by glob/grep/list_dir and the context tree walker', async (t) => {
  const dir = tmpDir(t, 'ox-v02a-bakskip-');
  fs.mkdirSync(path.join(dir, '.ox-backups', '20240101-000000'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.ox-backups', '20240101-000000', 'leak.txt'), 'BAKSKIP_TOKEN here\n');
  fs.writeFileSync(path.join(dir, 'real.txt'), 'ordinary content\n');

  const g = await globTool({ pattern: '**/*', path: dir });
  assert.ok(g.content.includes('real.txt'));
  assert.ok(!g.content.includes('leak.txt'), 'glob skips .ox-backups');

  const gr = await grepTool({ pattern: 'BAKSKIP_TOKEN|ordinary', path: dir });
  assert.match(gr.content, /real\.txt:1:/);
  assert.ok(!gr.content.includes('leak.txt'), 'grep skips .ox-backups');

  const ld = await listDirTool({ path: dir, depth: 4 });
  assert.ok(ld.content.includes('real.txt'));
  assert.ok(!ld.content.includes('.ox-backups'), 'list_dir skips .ox-backups');

  const tree = buildContext({ cwd: dir }).tree;
  assert.ok(tree.includes('real.txt'));
  assert.ok(!tree.includes('.ox-backups'), 'context tree walker skips .ox-backups');
});

// ---------- capability 4: session history search ----------

test('searchSessions: match across event types, cwd filter, limit, torn-line tolerance', (t) => {
  const sA = session.createSession(cwdA);
  session.appendEvent(sA, { t: 'user', text: 'please find the ZEBRA marker' });
  session.appendEvent(sA, { t: 'assistant', text: 'zebra handled promptly' });

  const sB = session.createSession(cwdB);
  session.appendEvent(sB, { t: 'user', text: 'unrelated question about pelicans' });
  fs.appendFileSync(sB.file, '{"t":"user","te\n'); // torn line mid-file (truncated write)
  session.appendEvent(sB, { t: 'tool-result', callId: 'c1', content: 'tool output mentions zebra-in-tool' });

  assert.doesNotThrow(() => session.searchSessions('zebra'));
  const hits = session.searchSessions('zebra');
  assert.ok(hits.length >= 3, `found matches across both sessions (${hits.length})`);
  for (const h of hits) {
    assert.equal(typeof h.file, 'string');
    assert.ok(!Number.isNaN(Date.parse(h.date)));
    assert.ok(h.snippet.length <= 160, 'snippet capped at 160 chars');
    assert.ok(h.snippet.toLowerCase().includes('zebra'));
  }

  const fromB = hits.find((h) => h.cwd === cwdB);
  assert.ok(fromB, 'cwd surfaced from meta');
  assert.match(fromB.snippet, /zebra-in-tool/, 'tool-result events searched too');

  const filtered = session.searchSessions('zebra', { cwd: cwdA });
  assert.ok(filtered.length >= 1);
  assert.ok(filtered.every((h) => h.cwd === cwdA), 'cwd filter restricts results');

  const limited = session.searchSessions('zebra', { limit: 1 });
  assert.equal(limited.length, 1, 'limit respected');

  assert.deepEqual(session.searchSessions(''), [], 'empty query yields no results');
  assert.deepEqual(session.searchSessions('zebra', { cwd: path.join(home, 'proj-zzz') }), []);
});
