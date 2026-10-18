import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Sandbox HOME BEFORE importing src modules (config.js bakes CONFIG_DIR from
// os.homedir() at import time — same pattern as wave5a).
// ---------------------------------------------------------------------------

const realHome = process.env.HOME;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-w5b-home-'));
process.env.HOME = home;
fs.mkdirSync(path.join(home, '.ox'), { recursive: true });
process.env.OX_API_KEY = process.env.OX_API_KEY ?? 'test-w5b-key';
for (const k of ['OX_AUDIT', 'OX_TWO_PASS', 'OX_COMPACT_AT', 'OX_KEEP_TURNS']) delete process.env[k];

after(() => {
  fs.rmSync(home, { recursive: true, force: true });
  process.env.HOME = realHome;
});

const { narrowToolSchemas, significantKeywords, relevantSkillToolNames } = await import(
  '../src/tools/index.js'
);
const { parseChain, classifySegments } = await import('../src/tools/exec.js');
const { readOnlyAutoVerdict } = await import('../src/approval.js');
const configmod = await import('../src/config.js');
const { runAgent, summarizeMessages, buildSummarizePrompt } = await import('../src/agent.js');
const { buildContext } = await import('../src/context.js');

function tmpDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const sse = (obj) => `data: ${JSON.stringify(obj)}\n`;

function textTurn(text = '') {
  return [
    text ? sse({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }) : '',
    sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    sse({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 5 } }),
    'data: [DONE]\n\n',
  ].join('');
}

function callTurn(id, name, args) {
  return [
    sse({
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
          finish_reason: null,
        },
      ],
    }),
    sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
    sse({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 5 } }),
    'data: [DONE]\n\n',
  ].join('');
}

// Server that records every parsed request body and answers by request count.
function startCountingServer(t, answerByN) {
  const bodies = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      let parsed = {};
      try {
        parsed = JSON.parse(body);
      } catch {}
      bodies.push(parsed);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(answerByN(bodies.length, parsed));
    });
  });
  t.after(() => {
    server.closeAllConnections?.();
    server.close();
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, bodies }))
  );
}

async function collectEvents(opts) {
  const events = [];
  for await (const ev of runAgent(opts)) events.push(ev);
  return events;
}

function readAuditRows() {
  const file = path.join(home, '.ox', 'audit.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// H: tool-offer narrowing
// ---------------------------------------------------------------------------

const CORE_EIGHT = ['read_file', 'edit_file', 'write_file', 'bash', 'grep', 'glob', 'list_dir', 'todo_write'];

function schema(name) {
  return { name, description: `tool ${name}`, input_schema: { type: 'object', properties: {} } };
}

test('significantKeywords strips stopwords and short tokens', () => {
  const kw = significantKeywords('Use the bash tool with care for refactoring the parser');
  assert.ok(kw.includes('bash'));
  assert.ok(kw.includes('refactoring'));
  assert.ok(!kw.includes('with'), 'stopword stripped');
  assert.ok(!kw.includes('use'), '<4-char tokens dropped');
  assert.deepEqual([...new Set(significantKeywords('bash bash BASH'))], ['bash']);
});

test('relevantSkillToolNames: naming a tool OR >=2 shared keywords unlocks declared tools', () => {
  const available = [...CORE_EIGHT, 'mcp__db__query', 'mcp__db__migrate', 'mcp__web__fetch'];
  const idx = '- db-helper — Database migration workflows; use mcp__db__query and mcp__db__migrate (read path to invoke: /x/SKILL.md)';
  const names = relevantSkillToolNames({
    skillIndex: idx,
    message: 'refactor the database migration scripts tonight',
    available,
  });
  assert.deepEqual(names.sort(), ['mcp__db__migrate', 'mcp__db__query']);
  // GATE-CONFLICT GUARD: the two conditions are alternatives. This line NAMES
  // mcp__db__query and shares only one keyword ('warehouse') — the old conjunctive
  // gate dropped it, which is why MCP tools were withheld ~always.
  const named = relevantSkillToolNames({
    skillIndex: '- q — Queries the warehouse via mcp__db__query (read path to invoke: /z/SKILL.md)',
    message: 'warehouse round trip',
    available,
  });
  assert.deepEqual(named, ['mcp__db__query']);
  // neither condition met: nothing is unlocked
  const bare = '- journal — Keeps a personal diary of the day (read path to invoke: /y/SKILL.md)';
  assert.deepEqual(relevantSkillToolNames({ skillIndex: bare, message: 'warehouse round trip', available }), []);
  assert.deepEqual(relevantSkillToolNames({ skillIndex: idx, message: '', available }), []);
});

test('narrowToolSchemas: no-op at or below the 12-tool threshold', () => {
  const offer12 = [...CORE_EIGHT, 'mcp__x__a', 'mcp__x__b', 'mcp__x__c', 'mcp__x__d'].map(schema);
  assert.equal(narrowToolSchemas(offer12, { message: 'anything', relevantSkillTools: [] }), offer12);
  const offer8 = CORE_EIGHT.map(schema);
  assert.equal(narrowToolSchemas(offer8, { message: 'bash it', relevantSkillTools: ['bash'] }), offer8);
});

test('narrowToolSchemas: message-dependent selection — memory_* only when memory-relevant', () => {
  const extra = [
    'mcp__db__query',
    'mcp__db__migrate',
    'mcp__web__fetch',
    'mcp__misc__a',
    'mcp__misc__b',
    'mcp__misc__c',
    'memory_save',
  ];
  const offer = [...CORE_EIGHT, ...extra].map(schema);
  const skillIndex =
    '- db-helper — Database migration workflows; use mcp__db__query and mcp__db__migrate (read path to invoke: /x/SKILL.md)';
  const narrowed = narrowToolSchemas(offer, { message: 'refactor the database migration scripts', relevantSkillTools: skillIndex });
  const names = narrowed.map((s) => s.name);
  assert.equal(names.length, 10, `core 8 + 2 declared = 10, got ${names.length}`);
  for (const c of CORE_EIGHT) assert.ok(names.includes(c), `core ${c} survives`);
  assert.ok(names.includes('mcp__db__query'));
  assert.ok(names.includes('mcp__db__migrate'));
  assert.ok(!names.includes('memory_save'), 'memory_* withheld when the message is not about memory');
  assert.ok(!names.includes('mcp__web__fetch'));
  assert.ok(!names.includes('mcp__misc__a'));
  // the same offer keeps memory_* once the message says "remember"
  const memNames = narrowToolSchemas(offer, {
    message: 'remember that we chose Postgres',
    relevantSkillTools: skillIndex,
  }).map((s) => s.name);
  assert.ok(memNames.includes('memory_save'), 'memory_* kept on a memory keyword');
  // array form of relevantSkillTools works too
  const arrForm = narrowToolSchemas(offer, {
    message: 'refactor the database migration scripts',
    relevantSkillTools: ['mcp__db__query'],
  });
  assert.ok(arrForm.map((s) => s.name).includes('mcp__db__query'));
});

test('narrowToolSchemas: fail-open below 4 survivors returns the full list', () => {
  const offer = ['read_file', ...Array.from({ length: 13 }, (_, i) => `mcp__z__t${i}`)].map(schema);
  assert.equal(offer.length, 14);
  const out = narrowToolSchemas(offer, { message: 'refactor the database migration scripts', relevantSkillTools: [] });
  assert.equal(out, offer, 'only read_file would survive -> fail open');
});

test('runAgent emits exactly one tool-narrowing event and sends the narrowed offer', async (t) => {
  const cwd = tmpDir(t, 'ox-w5b-narrow-');
  const mcpTools = ['query', 'migrate', 'fetch', 'a', 'b', 'c', 'd'].map((name) => ({
    server: name === 'query' || name === 'migrate' ? 'db' : 'web',
    name,
    description: `${name} tool`,
  }));
  const skillIndex =
    '- db-helper — Database migration workflows; use mcp__db__query and mcp__db__migrate (read path to invoke: /x/SKILL.md)';
  const { port, bodies } = await startCountingServer(t, () => textTurn('ok'));
  const target = { provider: 'custom', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'mock-model' };
  const events = await collectEvents({
    target,
    messages: [{ role: 'user', content: 'fix the database migration scripts' }],
    ctx: { cwd, mcpTools, skillIndex },
    config: {},
    auxTarget: null,
    verify: false,
  });
  const narrows = events.filter((e) => e.type === 'tool-narrowing');
  assert.equal(narrows.length, 1, 'one narrowing event per turn');
  // 7 mcp + 27 builtin (incl. 7 operator, 2 mail, web_fetch/web_search/critique, create_media, edit_video, install_skill, code_graph, youtube_transcript, current_page, social_research, library) + show_ui + 1 subagent = 38.
  assert.equal(narrows[0].total, 38);
  // core nine + two declared db tools + load_tools (the withheld ones stay one call away)
  assert.equal(narrows[0].offered, 12, 'core nine + two declared db tools + load_tools');
  const wireNames = (bodies[0]?.tools ?? []).map((x) => x.function?.name);
  assert.equal(wireNames.length, 12);
  assert.ok(wireNames.includes('load_tools'));
  assert.ok(wireNames.includes('mcp__db__query'));
  assert.ok(!wireNames.includes('mcp__web__fetch'));
  // The network tools are relevance-gated, not unconditional: a migration-fix
  // prompt does not carry them.
  assert.ok(!wireNames.includes('web_fetch'), `wire: ${wireNames.join(',')}`);
  assert.ok(!wireNames.includes('web_search'), `wire: ${wireNames.join(',')}`);

  // config tools.narrow=false disables the classifier entirely
  const events2 = await collectEvents({
    target,
    messages: [{ role: 'user', content: 'fix the database migration scripts' }],
    ctx: { cwd, mcpTools, skillIndex },
    config: { tools: { narrow: false } },
    auxTarget: null,
    verify: false,
  });
  assert.equal(events2.some((e) => e.type === 'tool-narrowing'), false);
  const disabledBody = bodies[bodies.length - 1];
  assert.equal((disabledBody?.tools ?? []).length, 38, 'full offer (incl. show_ui and subagent) sent when disabled');
});

// ---------------------------------------------------------------------------
// I: two-pass compaction
// ---------------------------------------------------------------------------

test('compactionPassKnobs maps detail levels to word budgets; OX_TWO_PASS forces pass 2', () => {
  const k = configmod.compactionPassKnobs;
  assert.deepEqual(k({}), { twoPass: false, detail: 'balanced', wordBudget: 300 });
  assert.equal(k({ compaction: { detail: 'none' } }).wordBudget, 80);
  assert.equal(k({ compaction: { detail: 'minimal' } }).wordBudget, 150);
  assert.equal(k({ compaction: { detail: 'verbose' } }).wordBudget, 500);
  assert.equal(k({ compaction: { detail: 'bogus' } }).detail, 'balanced');
  assert.equal(k({ compaction: { two_pass: true } }).twoPass, true);
  process.env.OX_TWO_PASS = '1';
  try {
    assert.equal(k({}).twoPass, true, 'env override wins');
    assert.equal(k({ compaction: { two_pass: false } }).twoPass, true);
  } finally {
    delete process.env.OX_TWO_PASS;
  }
});

test('loadConfig reads compaction.{two_pass,detail} + tools.narrow with sane defaults', () => {
  const cfgFile = path.join(home, '.ox', 'config.json');
  fs.writeFileSync(cfgFile, '{}');
  try {
    let cfg = configmod.loadConfig();
    assert.deepEqual(cfg.compaction, { two_pass: false, detail: 'balanced' });
    assert.equal(cfg.tools.narrow, true);

    fs.writeFileSync(
      cfgFile,
      JSON.stringify({ compaction: { two_pass: true, detail: 'verbose' }, tools: { narrow: false } })
    );
    cfg = configmod.loadConfig();
    assert.deepEqual(cfg.compaction, { two_pass: true, detail: 'verbose' });
    assert.equal(cfg.tools.narrow, false);

    fs.writeFileSync(cfgFile, JSON.stringify({ compaction: { detail: 'shouty' } }));
    cfg = configmod.loadConfig();
    assert.equal(cfg.compaction.detail, 'balanced', 'invalid detail falls back');
  } finally {
    fs.writeFileSync(cfgFile, '{}\n');
  }
});

test('buildSummarizePrompt encodes the detail word budget', () => {
  assert.match(buildSummarizePrompt('T', { wordBudget: 80 }), /In 80 words or fewer/);
  assert.match(buildSummarizePrompt('T', { wordBudget: 500 }), /In 500 words or fewer/);
  assert.match(buildSummarizePrompt('T', {}), /In 300 words or fewer/, 'balanced default');
  assert.match(buildSummarizePrompt('T', { wordBudget: NaN }), /In 300 words or fewer/);
});

test('summarizeMessages two-pass: second aux call distills against the goal contract', async (t) => {
  const { port, bodies } = await startCountingServer(t, (_n, parsed) => {
    const prompt = parsed?.messages?.[0]?.content ?? '';
    return /ACTIONABLE/.test(prompt)
      ? textTurn('distilled actionable remainder')
      : textTurn('first pass summary with decisions');
  });
  const target = { provider: 'custom', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'mock-model' };
  const msgs = [
    { role: 'user', content: 'do the thing' },
    { role: 'assistant', content: 'started the thing' },
  ];
  const res = await summarizeMessages(target, msgs, null, {
    twoPass: true,
    wordBudget: 150,
    goalContract: { outcome: 'ship the parser fix' },
  });
  assert.equal(res.text, 'distilled actionable remainder');
  assert.equal(bodies.length, 2, 'exactly one extra aux call');
  assert.match(bodies[0]?.messages?.[0]?.content ?? '', /150 words or fewer/);
  const p2 = bodies[1]?.messages?.[0]?.content ?? '';
  assert.match(p2, /Distill further to what remains ACTIONABLE for the stated goal/);
  assert.match(p2, /STATED GOAL:/);
  assert.match(p2, /outcome: ship the parser fix/);
  assert.match(p2, /first pass summary with decisions/, 'second pass sees the first summary');
  assert.deepEqual(res.usage, { inputTokens: 10, outputTokens: 10 }, 'usage accumulated across both calls');

  // without twoPass there is exactly one call and no contract text anywhere
  const single = await summarizeMessages(target, msgs, null, { wordBudget: 500 });
  assert.equal(single.text, 'first pass summary with decisions');
  assert.equal(bodies.length, 3);
  assert.match(bodies[2]?.messages?.[0]?.content ?? '', /500 words or fewer/);

  // two-pass without a goal contract still runs, minus the STATED GOAL block
  await summarizeMessages(target, msgs, null, { twoPass: true });
  assert.equal(bodies.length, 5);
  assert.doesNotMatch(bodies[4]?.messages?.[0]?.content ?? '', /STATED GOAL:/);
  assert.match(bodies[4]?.messages?.[0]?.content ?? '', /ACTIONABLE/);
});

test('runAgent compaction honors two_pass + detail end-to-end against a mock', async (t) => {
  const cwd = tmpDir(t, 'ox-w5b-compact-');
  const big = 'filler sentence about nothing in particular. ';
  const messages = [
    { role: 'user', content: big.repeat(60) },
    { role: 'assistant', content: 'ack one' },
    { role: 'user', content: big.repeat(60) },
    { role: 'assistant', content: 'ack two' },
    { role: 'assistant', content: 'ack three' },
    { role: 'user', content: 'now finish the task please' },
  ];
  const { port, bodies } = await startCountingServer(t, (n) =>
    n === 1 ? textTurn('summary one: half done') : n === 2 ? textTurn('only the gate step remains') : textTurn('done')
  );
  const target = { provider: 'custom', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'mock-model' };
  const events = await collectEvents({
    target,
    auxTarget: target,
    messages,
    ctx: { cwd, modelWindow: 900 },
    config: { compaction: { two_pass: true, detail: 'minimal' } },
    verify: false,
  });
  assert.ok(events.some((e) => e.type === 'compaction'), 'compaction ran');
  assert.match(bodies[0]?.messages?.[0]?.content ?? '', /150 words or fewer/);
  const p2 = bodies[1]?.messages?.[0]?.content ?? '';
  assert.match(p2, /Distill further to what remains ACTIONABLE/);
  assert.match(p2, /summary one: half done/);
  const hist = events.find((e) => e.type === 'history')?.messages ?? [];
  const summaryMsg = hist.find((m) => m.role === 'user' && String(m.content).startsWith('[ox: summary'));
  assert.ok(summaryMsg, 'summary replaced the compacted turns');
  assert.match(summaryMsg.content, /only the gate step remains/, 'the SECOND-pass text lands in history');
});

// ---------------------------------------------------------------------------
// J: deeper-wins layered rules
// ---------------------------------------------------------------------------

test('deeper-wins: nested conflicting instruction concatenates AFTER the root one', (t) => {
  const repo = tmpDir(t, 'ox-w5b-rules-');
  const w = (rel, body) => {
    const p = path.join(repo, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  };
  w('AGENTS.md', 'RULE-ROOT: ALWAYS USE TABS FOR INDENTATION\n');
  w(path.join('sub', 'AGENTS.md'), 'RULE-SUB: ALWAYS USE SPACES FOR INDENTATION\n');
  w('.ox.md', 'OXMD-MARKER root dotfile rule\n');
  w(path.join('rules', 'style.md'), 'RULES-DIR-MARKER\n');
  w(path.join('.ox', 'rules', 'deep.md'), 'OX-RULES-DIR-MARKER\n');

  const out = buildContext({ cwd: path.join(repo, 'sub') }).memoryFiles;
  const iRoot = out.indexOf('RULE-ROOT');
  const iSub = out.indexOf('RULE-SUB');
  assert.ok(iRoot !== -1 && iSub !== -1, 'both layers accumulate');
  assert.ok(iRoot < iSub, 'nested instruction appears LATER so it wins conflicts');
  assert.ok(out.includes('OXMD-MARKER'));
  assert.ok(out.includes('RULES-DIR-MARKER'));
  assert.ok(out.includes('OX-RULES-DIR-MARKER'));
  assert.ok(out.includes(path.join(repo, 'rules', 'style.md')), 'source path label kept');
  assert.ok(out.includes(path.join(repo, '.ox', 'rules', 'deep.md')));

  // gitignore-aware: ignored rules dirs never contribute
  w('.gitignore', 'ignored-rules/\n');
  w(path.join('ignored-rules', 'AGENTS.md'), 'IGNORED-MARKER\n');
  const out2 = buildContext({ cwd: repo }).memoryFiles;
  assert.ok(!out2.includes('IGNORED-MARKER'), 'gitignored rule files skipped');
});

test('layered rules cap raised to 48KB with a truncation notice', (t) => {
  const repo = tmpDir(t, 'ox-w5b-cap-');
  const w = (rel, body) => {
    const p = path.join(repo, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  };
  w('AGENTS.md', 'A'.repeat(30_000));
  w(path.join('sub', 'rules', 'big.md'), 'B'.repeat(30_000));
  const out = buildContext({ cwd: path.join(repo, 'sub') }).memoryFiles;
  assert.match(out, /truncated at 48000 chars/);
  assert.ok(out.length < 50_000, 'output capped near 48KB');
});

// ---------------------------------------------------------------------------
// K: read-only auto-approve ladder
// ---------------------------------------------------------------------------

test('classifier floors: sort --compress-program mutates; chains classify across all segments', () => {
  assert.equal(classifySegments(parseChain('ls -la && git status --short')), 'readonly');
  assert.equal(classifySegments(parseChain('pwd ; whoami')), 'readonly');
  assert.equal(classifySegments(parseChain('sort --compress-program=gzip big.txt | head -1')), 'mutating');
  assert.equal(classifySegments(parseChain('sort big.txt')), 'readonly');
  assert.equal(classifySegments(parseChain('ls && rm x')), 'mutating');
});

test('readOnlyAutoVerdict gates on mode/strict/yolo/tool', () => {
  const bash = { command: 'ls -la' };
  assert.equal(readOnlyAutoVerdict('bash', bash, {}).auto, true);
  assert.equal(readOnlyAutoVerdict('bash', bash, { approval: 'default' }).auto, true);
  assert.equal(readOnlyAutoVerdict('bash', bash, { approval: 'accept-edits' }).auto, false);
  assert.equal(readOnlyAutoVerdict('bash', bash, { approval: 'plan' }).auto, false);
  assert.equal(readOnlyAutoVerdict('bash', bash, { strictApprovals: true }).auto, false);
  assert.equal(readOnlyAutoVerdict('bash', bash, { yolo: true }).auto, false);
  assert.equal(readOnlyAutoVerdict('write_file', { path: '/x' }, {}).auto, false);
  assert.equal(readOnlyAutoVerdict('bash', { command: 'ls && rm x' }, {}).auto, false);
  assert.equal(readOnlyAutoVerdict('bash', { command: '   ' }, {}).auto, false);
});

// Runs one bash call through the agent and reports prompting + audit trail.
async function ladderRun(t, command, ctxExtra = {}) {
  const cwd = tmpDir(t, 'ox-w5b-ladder-');
  try {
    fs.execSync('git init -q', { cwd, stdio: 'ignore' });
  } catch {}
  let prompts = 0;
  const sessionId = `ses-w5b-${Math.random().toString(36).slice(2, 8)}`;
  const { port } = await startCountingServer(t, (n) =>
    n === 1 ? callTurn('c1', 'bash', { command }) : textTurn('finished')
  );
  const events = await collectEvents({
    target: { provider: 'custom', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'mock-model' },
    messages: [{ role: 'user', content: 'run it' }],
    ctx: {
      cwd,
      sessionId,
      requestApproval: async () => {
        prompts++;
        return true;
      },
      ...ctxExtra,
    },
    config: {},
    auxTarget: null,
    verify: false,
  });
  const rows = readAuditRows();
  const decisionRows = rows.filter((r) => r.session === sessionId);
  return { events, prompts, rows: decisionRows, allRows: rows };
}

test('readonly ladder: ls && git status auto-approves silently, audited as readonly-classifier', async (t) => {
  const { events, prompts, rows, allRows } = await ladderRun(t, 'ls -la && git status --short');
  assert.equal(prompts, 0, 'no interactive prompt for provably read-only chains');
  const auto = events.find((e) => e.type === 'approval' && e.decision === 'auto');
  assert.ok(auto, 'auto-approval event emitted for dim UI rendering');
  assert.equal(auto.mode, 'read-only');
  assert.equal(auto.name, 'bash');
  const decision = rows.find((r) => r.tool === 'bash' && r.t !== 'outcome');
  assert.ok(decision, 'decision recorded even though nothing prompted');
  assert.equal(decision.decision, 'allow');
  assert.equal(decision.actor, 'readonly-classifier');
  assert.equal(decision.rule, 'readonly-auto');
  const outcome = allRows.find((r) => r.ref === decision.ref && r.t === 'outcome');
  assert.ok(outcome, 'outcome linked to the auto-approved decision');
});

test('readonly ladder: ls && rm x is mutating -> prompts, audited as user-approved', async (t) => {
  const { events, prompts, rows } = await ladderRun(t, 'ls && rm x');
  assert.equal(prompts, 1, 'mutating segment forces the prompt');
  assert.equal(events.some((e) => e.type === 'approval'), false, 'no auto event');
  const decision = rows.find((r) => r.tool === 'bash' && r.t !== 'outcome');
  assert.equal(decision.actor, 'approval');
  assert.equal(decision.rule, 'user-approved');
});

test('readonly ladder: sort --compress-program hits the mutating floor and prompts', async (t) => {
  const { prompts } = await ladderRun(t, 'sort --compress-program=gzip big.txt | head -1');
  assert.equal(prompts, 1);
});

test('--strict-approvals disables the classifier: even pwd prompts', async (t) => {
  const { prompts, rows } = await ladderRun(t, 'pwd', { strictApprovals: true });
  assert.equal(prompts, 1, 'classifier off -> everything prompts');
  const decision = rows.find((r) => r.tool === 'bash' && r.t !== 'outcome');
  assert.equal(decision.actor, 'approval');
});
