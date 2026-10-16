import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Sandbox HOME BEFORE importing src modules (config.js bakes CONFIG_DIR from
// os.homedir() at import time) so the runAgent wiring check writes nowhere real.
const realHome = process.env.HOME;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-narrow-home-'));
process.env.HOME = home;
fs.mkdirSync(path.join(home, '.ox'), { recursive: true });
process.env.OX_API_KEY = process.env.OX_API_KEY ?? 'test-narrow-key';
after(() => {
  fs.rmSync(home, { recursive: true, force: true });
  process.env.HOME = realHome;
});

const {
  narrowToolSchemas,
  relevantSkillToolNames,
  listToolSchemas,
  NARROW_CORE_TOOLS,
  NARROW_MIN_SAVING,
  MEMORY_KEYWORDS,
  OPERATOR_KEYWORDS,
  OPERATOR_TOOLS,
} = await import('../src/tools/index.js');
const { buildSystemPrompt, WITHHELD_LIST_CAP } = await import('../src/system-prompt.js');
const { estimateTokens } = await import('../src/context.js');
const { runAgent } = await import('../src/agent.js');

// A realistic 20-tool offer: every builtin plus the four real memory schemas
// (memory.js keeps them behind ctx.memory.schemas()).
const OFFER = listToolSchemas({ memory: { schemas: () => memorySchemas(), dispatch: async () => ({}) } });

function memorySchemas() {
  return [
    {
      name: 'memory_list',
      description:
        'List every typed entry in persistent project memory (.agent/MEMORY.md), grouped by type (user | feedback | project | lesson) with pointers to their topic notes.',
      input_schema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'memory_get',
      description:
        "Read memory content. Args: topic (optional string) \u2014 a topic note name like 'gotchas' returns that note's full markdown; omitted or empty returns the MEMORY.md index itself.",
      input_schema: {
        type: 'object',
        properties: { topic: { type: 'string', description: "Topic note name (e.g. 'gotchas'); omit to get the whole index." } },
        additionalProperties: false,
      },
    },
    {
      name: 'memory_add',
      description:
        "Persist one durable fact to project memory. Args: type ('user'|'feedback'|'project'|lesson), statement (REQUIRED one-line fact), topic (optional slug naming topics/<slug>.md), detail (optional longer markdown appended to the topic note).",
      input_schema: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['user', 'feedback', 'project', 'lesson'] },
          statement: { type: 'string', description: 'One-line fact, phrased as a complete statement.' },
          topic: { type: 'string', description: 'Optional topic slug; defaults are derived from the statement.' },
        },
        required: ['type', 'statement'],
        additionalProperties: false,
      },
    },
    {
      name: 'memory_search',
      description:
        'Grep across everything under .agent/ (index, topic notes, episodes) ranked by date-prefix recency, most recent first. Args: query (REQUIRED substring, case-insensitive).',
      input_schema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Case-insensitive substring to search for.' } },
        required: ['query'],
        additionalProperties: false,
      },
    },
  ];
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

const names = (offer) => offer.map((s) => s.name);
// The word that makes each operator tool relevant to a message.
const OPERATOR_STEMS = {
  open_app: 'app',
  open_url: 'url|browser|http',
  open_path: 'folder|path',
  open_window: 'window',
  type_text: 'type|click',
  screenshot: 'screenshot|screen',
  notify: 'notify|notification',
};
const MEMORY_NAMES = ['memory_list', 'memory_get', 'memory_add', 'memory_search'];

test('1. coding prompt: core kept, memory_*/operator/mcp all withheld', () => {
  const out = narrowToolSchemas(OFFER, { message: 'fix the failing test', relevantSkillTools: [] });
  const kept = names(out);
  const offered = new Set(names(OFFER));
  // A short, single-target task: planning and delegation wait behind load_tools.
  const WAIT = ['todo_write', 'subagent'];
  for (const core of NARROW_CORE_TOOLS) {
    if (!offered.has(core)) continue; // report_result is subagent-only, never on the main path
    if (WAIT.includes(core)) assert.ok(!kept.includes(core), `${core} waits on a short task`);
    else assert.ok(kept.includes(core), `core ${core} survives`);
  }
  // A task with several steps keeps them.
  const big = names(narrowToolSchemas(OFFER, { message: 'refactor the auth module, then update every test', relevantSkillTools: [] }));
  for (const w of WAIT) if (offered.has(w)) assert.ok(big.includes(w), `${w} kept for a multi-step task`);
  for (const m of MEMORY_NAMES) assert.ok(!kept.includes(m), `${m} withheld on a coding prompt`);
  for (const op of OPERATOR_TOOLS) assert.ok(!kept.includes(op), `${op} withheld on a coding prompt`);
  assert.ok(!kept.some((n) => n.startsWith('mcp__')), 'mcp withheld on a coding prompt');
});

test('2. desktop prompt: operator tools are KEPT (defect-2 regression guard)', () => {
  const out = narrowToolSchemas(OFFER, {
    message: 'take a screenshot and open it in a browser',
    relevantSkillTools: [],
  });
  const kept = names(out);
  for (const op of ['screenshot', 'open_url']) {
    assert.ok(kept.includes(op), `${op} kept for a screenshot/open request`);
  }
  assert.ok(!kept.includes('memory_list'), 'memory still withheld here');
});

test('3. memory prompt: memory_* kept', () => {
  const kept = names(narrowToolSchemas(OFFER, { message: 'remember that we chose Postgres' }));
  for (const m of MEMORY_NAMES) assert.ok(kept.includes(m), `${m} kept on a memory keyword`);
  assert.ok(!kept.includes('screenshot'), 'operator still withheld here');
});

test('4. gate-conflict guard: a skill line that NAMES a tool unlocks it with <2 keyword overlap', () => {
  const skillIndex =
    '- warehouse \u2014 Queries the analytics warehouse via mcp__db__query (read path to invoke: /x/SKILL.md)';
  const direct = relevantSkillToolNames({
    skillIndex,
    message: 'warehouse round trip',
    available: [...NARROW_CORE_TOOLS, 'mcp__db__query', 'mcp__web__fetch'],
  });
  assert.deepEqual(direct, ['mcp__db__query'], 'naming alone earns the match');

  const offer = [...OFFER, { name: 'mcp__db__query', description: 'q', input_schema: { type: 'object' } }];
  const kept = names(narrowToolSchemas(offer, { message: 'warehouse round trip', relevantSkillTools: skillIndex }));
  assert.ok(kept.includes('mcp__db__query'), 'named mcp tool survives narrowing');
});

test('5. cliff guard: a sub-50-token cut is refused, the offer ships unchanged', () => {
  // 13 tools (past NARROW_THRESHOLD) whose four droppable tools are worth <50
  // tokens together: a cut here buys nothing and costs capability.
  const core = names(OFFER).filter((n) => NARROW_CORE_TOOLS.includes(n));
  const offer = [...core, 'mcp__a', 'mcp__b', 'mcp__c', 'mcp__d'].map((name) => ({ name }));
  assert.equal(offer.length, 13);
  const wouldDrop = offer.filter((s) => !core.includes(s.name));
  const saved = estimateTokens(JSON.stringify(offer)) - estimateTokens(JSON.stringify(core));
  assert.ok(saved < NARROW_MIN_SAVING, `fixture must sit under the floor, would save ${saved}`);
  assert.equal(narrowToolSchemas(offer, { message: 'fix the failing test' }), offer, 'no lossy cut for no gain');
  assert.deepEqual(wouldDrop.length, 4);
});

test('6. the coding-prompt offer is strictly smaller than the old static 1924-tok behaviour', () => {
  const out = narrowToolSchemas(OFFER, { message: 'fix the failing test' });
  const tok = estimateTokens(JSON.stringify(out));
  assert.ok(tok < 1924, `expected under the old static 1924 tok, got ${tok}`);
  assert.ok(out.length < 13, `expected fewer than the old 13-tool static offer, got ${out.length}`);
});

test('7. withheld inventory: names appear in the system prompt, descriptions do not', async () => {
  const out = narrowToolSchemas(OFFER, { message: 'fix the failing test' });
  const withheld = OFFER.filter((s) => !out.includes(s)).map((s) => s.name);
  const prompt = await buildSystemPrompt({ cwd: process.cwd(), contextParts: {}, withheldTools: withheld });
  const line = prompt.split('\n').find((l) => l.startsWith('- Not offered this turn'));
  assert.ok(line, 'withheld line present');
  // The line is a capped name list; past the cap the tail is summarised as a
  // count rather than silently dropped (same contract test 12 asserts).
  if (withheld.length > WITHHELD_LIST_CAP) {
    assert.ok(
      line.includes(`+${withheld.length - WITHHELD_LIST_CAP} more`),
      `withheld overflow counted: ${line}`
    );
  } else {
    for (const n of withheld) assert.ok(line.includes(n), `withheld line names ${n}`);
  }
  const sample = OFFER.find((s) => s.name === 'memory_add');
  assert.ok(!line.includes(sample.description), 'no full description re-added');
  assert.ok(!prompt.includes(sample.description), 'schema description stays out of the prompt');
  assert.ok(line.length < 200, `line must stay cheap, got ${line.length} chars`);

  const clean = await buildSystemPrompt({ cwd: process.cwd(), contextParts: {}, withheldTools: [] });
  assert.ok(!clean.includes('Not offered this turn'), 'clean turn renders no withheld line');
});

test('8. no message drops a tool the message is obviously about', () => {
  const offers = {
    desktop: OFFER,
    mcp: [...OFFER, ...['mcp__db__query', 'mcp__web__fetch', 'mcp__ops__alert'].map((name) => ({
      name,
      description: `${name} tool`,
      input_schema: { type: 'object', properties: {} },
    }))],
  };
  const messages = [
    'fix the failing test',
    'find where this function is called',
    'update the README',
    'add a new API endpoint',
    'why is the build failing',
    'take a screenshot of the window and open it in a browser',
    'open the folder in finder',
    'click the button and type the command',
    'notify me when the build finishes',
    'remember that we chose Postgres',
    'recall the note about the retry budget',
    'what did we discuss last time',
    'jot this down as a known fact',
    'remind me what we discussed previously',
    'save this to memory',
  ];
  const skillIndex = [
    '- warehouse \u2014 Queries the analytics warehouse via mcp__db__query (read path to invoke: /x/SKILL.md)',
    '- web \u2014 Fetches pages over http with mcp__web__fetch (read path to invoke: /y/SKILL.md)',
    '- ops \u2014 Pages the on-call rota with mcp__ops__alert (read path to invoke: /z/SKILL.md)',
  ].join('\n');
  for (const offerKey of Object.keys(offers)) {
    for (const message of messages) {
      const kept = names(narrowToolSchemas(offers[offerKey], { message, relevantSkillTools: skillIndex }));
      const text = message.toLowerCase();
      for (const [op, stem] of Object.entries(OPERATOR_STEMS)) {
        if (!offers[offerKey].some((s) => s.name === op)) continue;
        if (!new RegExp(`\\b${stem}\\b`).test(text)) continue;
        assert.ok(kept.includes(op), `[${offerKey}] "${message}" dropped ${op} it is about`);
      }
      if (MEMORY_KEYWORDS.some((k) => text.includes(k))) {
        for (const m of MEMORY_NAMES) {
          assert.ok(kept.includes(m), `[${offerKey}] "${message}" dropped ${m} on a memory keyword`);
        }
      }
    }
  }
  // distinct prompts must not collapse onto one byte-identical offer
  const offersSeen = new Set(
    messages.map((m) => JSON.stringify(names(narrowToolSchemas(offers.mcp, { message: m, relevantSkillTools: skillIndex }))))
  );
  assert.ok(offersSeen.size >= 3, `relevance must vary by message, got ${offersSeen.size} distinct offers`);
});

test('keyword lists are case-insensitive word-ish signals with no overlap holes', () => {
  for (const k of MEMORY_KEYWORDS) assert.ok(/^[a-z]+$/.test(k), `memory keyword ${k} is a plain word`);
  for (const k of OPERATOR_KEYWORDS) assert.ok(/^[a-z]+$/.test(k), `operator keyword ${k} is a plain word`);
  // morphology lands, but 'typescript' must not trigger type_text and 'append'
  // must not trigger open_app.
  const tsOffer = [...NARROW_CORE_TOOLS, 'type_text', 'open_app', 'memory_list'].map((n) => ({
    name: n,
    description: '',
    input_schema: { type: 'object', properties: {} },
  }));
  const tsKept = names(narrowToolSchemas(tsOffer, { message: 'convert the typescript file' }));
  assert.ok(!tsKept.includes('type_text'), "'typescript' must not read as 'type'");
  assert.ok(!tsKept.includes('open_app'), "'convert' must not read as 'app'");
  const morphKept = names(narrowToolSchemas(tsOffer, { message: 'we discussed this previously' }));
  assert.ok(morphKept.includes('memory_list'), 'inflected memory words still fire');
});

// The withheld line is a comma-separated name list with a trailing "+N more".
// Exact names only: a bare includes() on "mcp__db__a" is satisfied by
// "mcp__db__alert", which makes the assertion pass for the wrong reason.
function listedNames(line) {
  const body = line.split('available if asked: ')[1] ?? '';
  return body
    .split(', ')
    .map((n) => n.trim())
    .filter((n) => n && !/^\+\d+ more$/.test(n));
}

test('10. end-to-end: the withheld inventory reaches the wire system prompt', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-narrow-ws-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const mcpTools = ['query', 'fetch', 'alert', 'a', 'b'].map((name) => ({ server: 'db', name, description: `${name} tool` }));
  const { port, bodies } = await startCountingServer(t, () => textTurn('ok'));
  const target = { provider: 'custom', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'mock-model' };
  const events = [];
  for await (const ev of runAgent({
    target,
    messages: [{ role: 'user', content: 'fix the failing test' }],
    ctx: { cwd, mcpTools, memory: OFFER.length ? { schemas: () => memorySchemas(), dispatch: async () => ({}) } : null },
    config: {},
    auxTarget: null,
    verify: false,
  })) {
    events.push(ev);
  }
  const narrowing = events.filter((e) => e.type === 'tool-narrowing');
  assert.equal(narrowing.length, 1, 'one narrowing event');
  const wireNames = (bodies[0]?.tools ?? []).map((x) => x.function?.name);
  assert.equal(wireNames.length, narrowing[0].offered, 'wire offer matches the narrowed count');
  const systemLine = (bodies[0]?.messages ?? [])
    .find((m) => m.role === 'system')
    ?.content.split('\n')
    .find((l) => l.startsWith('- Not offered this turn'));
  assert.ok(systemLine, 'withheld inventory shipped on the wire');
  const withheld = (OFFER.map((s) => s.name).concat(mcpTools.map((m) => `mcp__db__${m.name}`)))
    .filter((n) => !wireNames.includes(n));
  // `screenshot` and `mcp__db__query` are inside the cap, so they must be named
  // verbatim. `mcp__db__fetch` and `mcp__db__a` are past WITHHELD_LIST_CAP here
  // (the operator/web_task/critique groups that ship first pushed them back) and
  // are only represented by the overflow count, so they are asserted through the
  // full `withheld` set rather than by name on the line. Substring matching is
  // deliberately avoided: "mcp__db__a" is a prefix of "mcp__db__alert", so an
  // includes() check on it passes for the wrong reason.
  assert.ok(systemLine.includes('screenshot'), 'wire prompt names withheld screenshot');
  assert.ok(!wireNames.includes('screenshot'), 'withheld screenshot is not in the offer');
  assert.ok(listedNames(systemLine).includes('mcp__db__query'), 'wire prompt names withheld mcp__db__query');
  assert.ok(!wireNames.includes('mcp__db__query'), 'withheld mcp__db__query is not in the offer');
  for (const n of ['mcp__db__fetch', 'mcp__db__a']) {
    assert.ok(withheld.includes(n), `withheld ${n} is in the full withheld set`);
    assert.ok(!wireNames.includes(n), `withheld ${n} is not in the offer`);
  }
  // the line is a bare name list, capped so it stays cheap on every turn; the
  // overflow is reported as a count rather than silently dropping the tail.
  const listed = systemLine.split('available if asked: ')[1];
  assert.ok(listed.length < 220, `line must stay cheap, got ${listed.length} chars`);
  if (withheld.length > WITHHELD_LIST_CAP) {
    assert.ok(listed.includes(`+${withheld.length - WITHHELD_LIST_CAP} more`), `overflow counted: ${listed}`);
  } else {
    for (const n of withheld) assert.ok(systemLine.includes(n), `names withheld ${n}`);
  }
});
