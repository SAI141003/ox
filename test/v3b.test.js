import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OX_BIN = path.join(ROOT, 'bin', 'ox.js');

// ---------------------------------------------------------------------------
// Sandbox HOME + ws BEFORE importing src modules (config.js bakes CONFIG_DIR
// from os.homedir() at import time — same pattern as test/config.test.js).
// ---------------------------------------------------------------------------

const realHome = process.env.HOME;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-v3b-home-'));
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-v3b-ws-'));
process.env.HOME = home;
fs.mkdirSync(path.join(home, '.ox'), { recursive: true });

after(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(ws, { recursive: true, force: true });
  process.env.HOME = realHome;
});

const { loadMcpPolicy, readMcpPolicyDocs } = await import('../src/config.js');
const { resolveMcpPolicy } = await import('../src/agent.js');
const { autoPreflight, buildScheduleBlock, planScheduleInstall } = await import('../src/cli.js');

const writeGlobalConfig = (obj) =>
  fs.writeFileSync(path.join(home, '.ox', 'config.json'), `${JSON.stringify(obj, null, 2)}\n`);
const writeProjectOxJson = (obj) =>
  fs.writeFileSync(path.join(ws, '.ox.json'), `${JSON.stringify(obj, null, 2)}\n`);

const pctx = (policy, origins, extra = {}) => ({
  mcpPolicyContext: {
    policy,
    origins,
    globalServers: new Set(),
    sideEffectsOk: false,
    ...extra,
  },
});

// ---------- policy matrix (unit) ----------

test('policy matrix: explicit mcpPolicy entry beats the template-risk default', () => {
  // browser template is risk=write → default 'ask', but explicit deny wins
  assert.equal(resolveMcpPolicy('mcp__browser__click', pctx({ browser: 'deny' }, {})).decision, 'deny');
  // devtools is read-only → default 'ask', explicit allow wins
  const a = resolveMcpPolicy('mcp__devtools__trace', pctx({ devtools: 'allow' }, {}));
  assert.equal(a.decision, 'allow');
  assert.equal(a.risk, 'read-only');
  assert.equal(a.source, 'project');
});

test('policy matrix: template default is ask with the server risk class attached', () => {
  const b = resolveMcpPolicy('mcp__browser__click', pctx({}, {}));
  assert.equal(b.decision, 'ask');
  assert.equal(b.risk, 'write');
  assert.equal(b.source, null);
  const unknown = resolveMcpPolicy('mcp__nosuch__tool', pctx({}, {}));
  assert.deepEqual(unknown, { decision: 'ask', risk: null, source: null });
  // non-MCP names and malformed qualifiers fall through to plain ask
  assert.equal(resolveMcpPolicy('bash', pctx({}, {})).decision, 'ask');
  assert.equal(resolveMcpPolicy('mcp__broken', pctx({}, {})).decision, 'ask');
});

test('policy matrix: deny blocks even under yolo (explicit config beats approval skipping)', () => {
  const ctx = pctx({ browser: 'deny' }, {}, { sideEffectsOk: true });
  const r = resolveMcpPolicy('mcp__browser__click', ctx);
  assert.equal(r.decision, 'deny');
});

test('policy matrix: money-risk allow downgrades to ask without authorization, warns exactly once', () => {
  const orig = process.stderr.write;
  const lines = [];
  try {
    process.stderr.write = (s) => {
      lines.push(String(s));
      return true;
    };
    const warned = new Set();
    const ctx = pctx({ opentable: 'allow' }, { opentable: 'project' });
    const first = resolveMcpPolicy('mcp__opentable__book', ctx, warned);
    assert.equal(first.decision, 'ask', 'project-scope money allow cannot self-authorize');
    assert.equal(first.risk, 'money');
    const second = resolveMcpPolicy('mcp__opentable__book', ctx, warned);
    assert.equal(second.decision, 'ask');
    // one-time warning naming both authorization paths
    assert.equal(lines.length, 1, `expected single warning, got ${lines.length}: ${lines.join('|')}`);
    assert.match(lines[0], /opentable/);
    assert.match(lines[0], /--side-effects-ok/);
    assert.match(lines[0], /~\/\.ox\/config\.json|config\.json/);
  } finally {
    process.stderr.write = orig;
  }
});

test('policy matrix: money-risk allow stands for global source OR --side-effects-ok', () => {
  const orig = process.stderr.write;
  const seen = [];
  process.stderr.write = (s) => {
    seen.push(String(s));
    return true;
  };
  try {
    const globalCtx = pctx({ opentable: 'allow' }, { opentable: 'global' });
    assert.equal(resolveMcpPolicy('mcp__opentable__book', globalCtx, new Set()).decision, 'allow');
    const flagCtx = pctx({ opentable: 'allow' }, { opentable: 'project' }, { sideEffectsOk: true });
    assert.equal(resolveMcpPolicy('mcp__opentable__book', flagCtx, new Set()).decision, 'allow');
    assert.equal(seen.length, 0, 'authorized allows must not warn');
    // deny on a money server stays deny regardless of flags
    const denyCtx = pctx({ opentable: 'deny' }, {}, { sideEffectsOk: true });
    assert.equal(resolveMcpPolicy('mcp__opentable__book', denyCtx).decision, 'deny');
  } finally {
    process.stderr.write = orig;
  }
});

// ---------- .ox.json loading + precedence ----------

test('.ox.json merges over ~/.ox/config.json mcpPolicy; invalid values dropped; origins tracked', () => {
  writeGlobalConfig({
    mcpServers: { gamma: { command: 'echo' } },
    mcpPolicy: { alpha: 'deny', beta: 'allow', bogus: 'nuke' },
  });
  writeProjectOxJson({ mcpPolicy: { beta: 'ask', delta: 'allow', nope: 'whatever' } });

  assert.deepEqual(loadMcpPolicy(ws), { alpha: 'deny', beta: 'ask', delta: 'allow' });
  const docs = readMcpPolicyDocs(ws);
  assert.equal(docs.origins.alpha, 'global');
  assert.equal(docs.origins.beta, 'project', 'project entry overrides origin tracking too');
  assert.equal(docs.origins.delta, 'project');
  assert.ok(docs.globalServers.has('gamma'), 'global mcpServers feed globalServers');
  assert.ok(docs.globalServers.has('alpha') && docs.globalServers.has('beta'));

  // empty/missing files → empty policy, no throw
  writeGlobalConfig({});
  fs.rmSync(path.join(ws, '.ox.json'), { force: true });
  assert.deepEqual(loadMcpPolicy(ws), {});
});

test('malformed project .ox.json throws loudly naming the file', () => {
  writeGlobalConfig({});
  fs.writeFileSync(path.join(ws, '.ox.json'), '{ broken json');
  assert.throws(() => loadMcpPolicy(ws), (err) => err.message.includes('.ox.json'));
  fs.rmSync(path.join(ws, '.ox.json'), { force: true });
});

// ---------- ox auto preflight (unit) ----------

test('autoPreflight refuses yolo+money-risk without --side-effects-ok', () => {
  const servers = {
    opentable: { command: 'npx', args: ['@striderlabs/mcp-opentable'] },
    browser: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
  };
  const refused = autoPreflight({ yolo: true, sideEffectsOk: false, mcpServers: servers });
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /opentable/);
  assert.match(refused.reason, /--side-effects-ok/);

  assert.equal(autoPreflight({ yolo: true, sideEffectsOk: true, mcpServers: servers }).ok, true);
  assert.equal(autoPreflight({ yolo: true, sideEffectsOk: false, mcpServers: { browser: {} } }).ok, true);
  assert.equal(autoPreflight({ yolo: false, sideEffectsOk: false, mcpServers: servers }).ok, true);
  assert.equal(autoPreflight({ yolo: true, mcpServers: undefined }).ok, true);
});

// ---------- schedule builder + idempotency logic (pure) ----------

test('buildScheduleBlock emits deterministic marker hash + valid cron line', () => {
  const base = {
    goal: 'triage inbox and summarize open PRs',
    at: '07:30',
    maxCostUsd: 0.75,
    keyEnv: 'XAI_API_KEY',
    cwd: '/tmp/work',
    binPath: '/opt/ox/bin/ox.js',
    logFile: '/tmp/.ox/auto.log',
  };
  const a = buildScheduleBlock(base);
  const b = buildScheduleBlock(base);
  assert.equal(a.hash, b.hash, 'hash must be deterministic for install idempotency');
  assert.notEqual(buildScheduleBlock({ ...base, goal: 'different' }).hash, a.hash);
  assert.notEqual(buildScheduleBlock({ ...base, at: '08:30' }).hash, a.hash);

  assert.ok(a.block.includes(`# ox-schedule ${a.hash}`), 'marker comment present');
  assert.match(
    a.cronLine,
    /^30 7 \* \* \* cd '\/tmp\/work' && XAI_API_KEY='[^']*' '.+' '\/opt\/ox\/bin\/ox\.js' auto 'triage inbox and summarize open PRs' --max-cost 0\.75 --yes-edits >> '\/tmp\/\.ox\/auto\.log' 2>&1$/
  );
  assert.ok(a.launchd.includes('launchd'), 'launchd alternative printed');
  assert.ok(a.launchd.includes('plist'), 'launchd plist instructions present');
  assert.ok(a.launchd.includes(`com.ox.auto.${a.hash}`), 'launchd label carries the marker hash');
  const noCost = buildScheduleBlock({ ...base, maxCostUsd: null });
  assert.doesNotMatch(noCost.cronLine, /--max-cost/);
  // goals with quotes survive sh quoting
  const quoted = buildScheduleBlock({ ...base, goal: "it's a test" });
  assert.ok(quoted.cronLine.includes(`'it'\\''s a test'`));
});

test('planScheduleInstall: append when absent, already-installed when marker present', () => {
  const hash = 'deadbeef';
  assert.deepEqual(planScheduleInstall('', hash), { action: 'append' });
  assert.deepEqual(planScheduleInstall('15 9 * * * echo hi\n', hash), { action: 'append' });
  const existing = `# ox-schedule ${hash}\n15 9 * * * ox auto "x" --yes-edits\n`;
  assert.deepEqual(planScheduleInstall(existing, hash), { action: 'already-installed' });
  // a different job's marker does not block this one
  assert.deepEqual(planScheduleInstall('# ox-schedule feedf00d\n0 8 * * * x\n', hash), { action: 'append' });
});

// ---------- subprocess-level checks (sandboxed env, loopback only) ----------

const SCRUB = [
  'XAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY',
  'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'DEEPSEEK_API_KEY',
  'OX_BASE_URL', 'OX_API_KEY', 'OX_MODEL', 'OX_YOLO', 'OX_MAX_COST', 'NO_COLOR',
];

function childEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of SCRUB) delete env[k];
  env.HOME = home;
  env.NO_COLOR = '1';
  return { ...env, ...extra };
}

// 45s, not 25s/30s: both budgets below are watchdogs for a child that will
// never exit, not test assertions - these runs refuse fast (exit 4) or print a
// schedule block. The 25s/30s figures had no slack left once the suite runs
// --test-concurrency=2 and sibling suites deliberately burn 15-33s waiting out
// real timeouts, so external load was enough to fake a failure.
const SPAWN_BUDGET_MS = 45000;

function runOx(args, extraEnv = {}) {
  return spawnSync(process.execPath, [OX_BIN, ...args.map(String)], {
    cwd: ws,
    env: childEnv(extraEnv),
    encoding: 'utf8',
    timeout: SPAWN_BUDGET_MS,
  });
}

// Async runner for tests whose mock provider shares this process (spawnSync
// would block the loop and starve the mock server).
function spawnOxAsync({ args, extraEnv = {}, stdin = '' } = {}) {
  const child = spawn(process.execPath, [OX_BIN, ...args.map(String)], {
    cwd: ws,
    env: childEnv(extraEnv),
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
      try { child.kill('SIGKILL'); } catch {}
      resolve({
        status: null,
        stdout,
        stderr: `${stderr}\n[v3b test: ox did not exit within ${SPAWN_BUDGET_MS}ms - SIGKILLed]`,
      });
    }, SPAWN_BUDGET_MS);
    child.on('error', () => {
      clearTimeout(killer);
      resolve({ status: null, stdout, stderr });
    });
    child.on('close', (code) => {
      clearTimeout(killer);
      resolve({ status: code, stdout, stderr });
    });
  });
  child.stdin.end(stdin);
  return { done, child };
}

test('ox auto: refuses -y while a money-risk MCP server is active (exit 4, nothing runs)', () => {
  // port 9 refuses instantly on loopback — hub start fails fast, offline
  writeGlobalConfig({
    mcpServers: { opentable: { command: 'npx', args: ['@striderlabs/mcp-opentable'] } },
  });
  const r = runOx(['auto', 'book a table', '-y']);
  assert.equal(r.status, 4, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stderr, /opentable/);
  assert.match(r.stderr, /--side-effects-ok/);
  // no provider was ever contacted (no keys configured anyway)
  assert.doesNotMatch(r.stderr, /iteration budget|usage-total/);
});

test('ox auto: preflight passes with --side-effects-ok; forced verify + summary block + session + checkpoint', async () => {
  // local mock provider so the run completes offline in two turns
  const requests = [];
  const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      requests.push(body);
      const answered = body.includes('"role":"tool"');
      const isJudge = body.includes('completion auditor');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (isJudge) {
        res.end(
          [
            sse({ choices: [{ index: 0, delta: { content: '{"complete": true, "gaps": ""}' }, finish_reason: 'stop' }] }),
            sse({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 5 } }),
            'data: [DONE]\\n\\n',
          ].join('')
        );
      } else if (!answered) {
        res.end(
          [
            sse({ choices: [{ index: 0, delta: { content: '' }, finish_reason: null }] }),
            sse({
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [{ index: 0, id: 'call_v3b1', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: path.join(ws, 'note.txt') }) } }],
                  },
                  finish_reason: null,
                },
              ],
            }),
            sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
            sse({ choices: [], usage: { prompt_tokens: 30, completion_tokens: 10 } }),
            'data: [DONE]\n\n',
          ].join('')
        );
      } else {
        res.end(
          [
            sse({ choices: [{ index: 0, delta: { content: 'V3B_AUTO_DONE reading note.txt' }, finish_reason: null }] }),
            sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
            sse({ choices: [], usage: { prompt_tokens: 40, completion_tokens: 12 } }),
            'data: [DONE]\n\n',
          ].join('')
        );
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  fs.writeFileSync(path.join(ws, 'note.txt'), 'v3b autonomous note\n');
  const { done } = spawnOxAsync({
    args: ['auto', 'read note.txt', '-y', '--side-effects-ok', '--json'],
    extraEnv: {
      OX_BASE_URL: `http://127.0.0.1:${port}/v1`,
      OX_API_KEY: 'test',
    },
  });
  const r = await done;
  server.closeAllConnections?.();
  server.close();

  assert.equal(r.status, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  const events = r.stdout
    .split('\n')
    .filter((l) => l.trim().startsWith('{'))
    .map((l) => JSON.parse(l));
  const summary = events.find((e) => e.t === 'auto-summary');
  assert.ok(summary, `no auto-summary event in:\n${r.stdout.slice(0, 800)}`);
  assert.equal(summary.status, 'complete');
  assert.ok(summary.files.some((f) => f.endsWith('note.txt')), `files touched missing note.txt: ${JSON.stringify(summary.files)}`);
  assert.equal(summary.toolCalls >= 1, true);
  assert.ok(typeof summary.session === 'string' && fs.existsSync(summary.session), 'session file recorded and exists');
  assert.ok(fs.existsSync(path.join(home, '.ox', 'sessions')), 'session stored under sandboxed home');
  // verification round ran (forced verify=true)
  assert.ok(events.some((e) => e.t === 'verification'), 'forced verifier did not run');
  // session-end checkpoint + episode written into the workspace
  const cpDir = path.join(ws, '.agent', 'notes');
  assert.ok(fs.existsSync(cpDir) && fs.readdirSync(cpDir).some((f) => f.endsWith('.md')), 'session-end checkpoint missing');
  assert.ok(fs.existsSync(path.join(ws, '.agent', 'episodes')), 'episode audit trail missing');
  // session file actually captured the transcript
  const sessText = fs.readFileSync(summary.session, 'utf8');
  assert.match(sessText, /read note\.txt/);
  assert.match(sessText, /V3B_AUTO_DONE/);
});

test('ox schedule: prints crontab + launchd snippets; non-TTY --install refuses without --yes (exit 4)', () => {
  const printed = runOx(['schedule', 'morning triage', '--at', '07:45', '--max-cost', '2']);
  assert.equal(printed.status, 0, printed.stderr);
  assert.match(printed.stdout, /# ox-schedule [0-9a-f]+/);
  assert.match(printed.stdout, /^45 7 \* \* \* .*auto 'morning triage'/m);
  assert.match(printed.stdout, /--yes-edits/);
  assert.match(printed.stdout, /launchd/);
  assert.match(printed.stdout, /plist/);

  const badAt = runOx(['schedule', 'x', '--at', '25:99']);
  assert.equal(badAt.status, 3);
  assert.match(badAt.stderr, /HH:MM/);

  // never touches the real crontab: refusal happens before any crontab call
  const refused = runOx(['schedule', 'morning triage', '--install']);
  assert.equal(refused.status, 4, `stderr: ${refused.stderr}`);
  assert.match(refused.stderr, /--yes/);
});
