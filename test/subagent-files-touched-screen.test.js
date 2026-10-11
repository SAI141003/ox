// Persistence screening for the subagent descriptor's `filesTouched` field --
// the one replayed field that was NOT screened while its three neighbours
// (`lessons`, `result`, `error`) were.
//
// .agent/_sub/<id>/state.json is a store like any other: `filesTouched` is
// persisted by the run loop and replayed into the resumed subagent's prompt via
// filesTouchedBlock, and into the parent's tool result via buildSubagentOutput.
// It is fed by PATHS REPORTED BY TOOL EVENTS, so it is no more trustworthy than
// the tool-error text that produced it.
//
// The other half of the job is the FALSE POSITIVE. These values are real paths
// for a living, and a screen that refuses `src/tokenizer.js` because the word
// "token" appears in it is worse than no screen at all. Both directions are
// pinned here.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';

const HOME_SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-home-subft-'));
process.env.HOME = HOME_SANDBOX;
// config.js bakes CONFIG_DIR from os.homedir() at import time, the OX_AUDIT
// ledger lives there, and the mock provider below refuses to start without a key
// (which would make every "the run reached the model" assertion vacuous).
process.env.OX_API_KEY = process.env.OX_API_KEY ?? 'test-subft-screen-key';

const {
  buildSubagentOutput,
  filesTouchedBlock,
  initDescriptor,
  makeSubagentToolHandler,
  readDescriptor,
  screenFilePaths,
} = await import('../src/subagent.js');
const { memoryScreenStats, resetMemoryScreenStats, screenPersistText, shortWithheldNotice } = await import('../src/memory.js');
const { auditFilePath } = await import('../src/audit.js');

after(() => fs.rmSync(HOME_SANDBOX, { recursive: true, force: true }));

const KEY = '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';
const KEY_TAIL = '9edd82d6dd091443677912990515b590955d3c53f309cddf7db07a6c1e43d796';
const GH = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

function sandbox(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function statePath(dir, id) {
  return path.join(dir, '.agent', '_sub', id, 'state.json');
}

function auditRows() {
  try {
    return fs
      .readFileSync(auditFilePath(), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((r) => r.t === 'memory-screen' && r.event === 'read-withheld');
  } catch {
    return [];
  }
}

// ---- WRITE side ------------------------------------------------------------

test('WRITE: a normal path list is stored verbatim, nothing refused', () => {
  resetMemoryScreenStats();
  const out = screenFilePaths(['src/cli.js', 'src/memory.js', 'README.md'], 'sa_w1');
  assert.deepEqual(out, { kept: ['src/cli.js', 'src/memory.js', 'README.md'], refused: 0 });
});

// ---- FALSE POSITIVES: the whole point of a path-shaped field ---------------
//
// Every one of these is a file that could plausibly exist in this repo or any
// other. A screen that drops them is a broken screen.
test('FALSE POSITIVE: paths that merely CONTAIN a secret-looking substring are kept', () => {
  const legit = [
    'src/tokenizer.js',
    'src/token-store.ts',
    'src/api-keys.js',
    'src/apikeys.js',
    'config/passwords.example.json',
    'src/secret-handler.go',
    'src/client_secret.pem.example',
    'docs/auth-token.md',
    'src/sk-learn-the-library.js',
    'packages/api/src/skills.ts',
    'src/bearer-tokens.json',
    'src/private-keys.md',
    'test/v4a.test.js',
    'a.ts',
  ];
  resetMemoryScreenStats();
  const out = screenFilePaths(legit, 'sa_fp');
  assert.deepEqual(out.kept, legit, `false positives dropped: ${JSON.stringify(legit.filter((p) => !out.kept.includes(p)))}`);
  assert.equal(out.refused, 0);
  assert.equal(memoryScreenStats().withheld, 0, 'a write refusal is not a read withholding');
});

test('FALSE POSITIVE: those same paths also replay into the prompt block', () => {
  const legit = ['src/tokenizer.js', 'src/api-keys.js', 'config/passwords.example.json', 'src/sk-learn-the-library.js'];
  resetMemoryScreenStats();
  fs.rmSync(auditFilePath(), { force: true });
  const block = filesTouchedBlock(legit, 'sa_fp2');
  assert.equal(
    block,
    ['## Files touched so far', '', ...legit.map((p) => `- ${p}`), ''].join('\n'),
    'a clean block is byte-identical to the pre-screen render'
  );
  assert.equal(/memory-screen/.test(block), false, block);
  assert.equal(memoryScreenStats().withheld, 0);
  assert.equal(auditRows().length, 0, 'a clean read must not write a ledger row');
});

// ---- WRITE side: real credentials are refused -------------------------------

test('WRITE: a path that IS a credential match is refused and its neighbours kept', () => {
  resetMemoryScreenStats();
  const out = screenFilePaths(['src/a.ts', `src/sk-or-v1-${KEY_TAIL}.txt`, 'src/b.ts'], 'sa_w2');
  assert.deepEqual(out.kept, ['src/a.ts', 'src/b.ts']);
  assert.equal(out.refused, 1);
  assert.equal(out.kept.some((p) => p.includes(KEY_TAIL)), false);
});

test('WRITE: a GitHub PAT path is refused', () => {
  const out = screenFilePaths([`src/${GH}.env`, 'src/ok.ts'], 'sa_w3');
  assert.deepEqual(out.kept, ['src/ok.ts']);
  assert.equal(out.refused, 1);
});

test('WRITE: the refusal names the descriptor and no key material', () => {
  // screenFilePaths reports a COUNT; the wording comes from the shared screen, so
  // this asserts the shared sentence is being handed the right field and store.
  const reason = screenPersistText(`src/${KEY}`, 'file path', `the subagent descriptor (.agent/_sub/sa_w4/state.json)`);
  assert.match(reason, /refusing to store/);
  assert.match(reason, /file path/, reason);
  assert.match(reason, /\.agent\/_sub\/sa_w4\/state\.json/, reason);
  assert.equal(reason.includes(KEY_TAIL), false, 'the refusal echoed the key');
});

// ---- READ side -------------------------------------------------------------

test('READ: a hand-planted credential path is withheld from the prompt block', (t) => {
  const dir = sandbox(t, 'ox-ft-read-');
  const id = 'sa_r1';
  initDescriptor({ id, task: 't', cwd: dir });
  const file = statePath(dir, id);
  // written by an older build, or by a hand: bypass the write screen entirely.
  const desc = JSON.parse(fs.readFileSync(file, 'utf8'));
  desc.filesTouched = ['src/cli.js', `src/${KEY}.txt`, 'src/skills.js'];
  fs.writeFileSync(file, JSON.stringify(desc, null, 2));
  const before = sha(file);

  resetMemoryScreenStats();
  fs.rmSync(auditFilePath(), { force: true });
  const block = filesTouchedBlock(readDescriptor(dir, id).filesTouched, id);

  assert.equal(block.includes(KEY), false, `credential reached the prompt block:\n${block}`);
  assert.equal(block.includes('9edd82d6dd'), false);
  assert.match(block, /^- src\/cli\.js$/m, 'the clean paths survive');
  assert.match(block, /^- src\/skills\.js$/m);
  assert.match(block, /\[memory-screen\] withheld 1 path\b/, block);
  assert.ok(block.includes(shortWithheldNotice(1, 'path')), 'the shared short notice is used verbatim');

  assert.deepEqual(memoryScreenStats(), { withheld: 1, reads: 1 });
  const rows = auditRows();
  assert.equal(rows.length, 1, JSON.stringify(rows));
  assert.equal(rows[0].where, 'subagent files touched block');
  assert.equal(rows[0].count, 1);
  assert.equal(JSON.stringify(rows).includes(KEY_TAIL), false, 'the ledger carried the key');

  assert.equal(sha(file), before, 'reading the descriptor for the prompt rewrote it');
});

test('READ: an ALL-bad list still yields a heading + a notice, never an empty block', () => {
  resetMemoryScreenStats();
  const block = filesTouchedBlock([`src/${KEY}.txt`, `src/${GH}.env`], 'sa_r2');
  const lines = block.split('\n');
  assert.equal(lines[0], '## Files touched so far');
  assert.equal(lines[2], shortWithheldNotice(2, 'path'), lines[2]);
  assert.equal(block.includes('sk-or-v1'), false, block);
  assert.equal(block.includes('ghp_'), false, block);
  assert.equal(memoryScreenStats().withheld, 2);
});

test('READ: an empty / missing list behaves exactly as before', () => {
  resetMemoryScreenStats();
  assert.equal(filesTouchedBlock([], 'sa_r3'), '');
  assert.equal(filesTouchedBlock(null, 'sa_r3'), '');
  assert.equal(filesTouchedBlock(['', null], 'sa_r3'), '');
  // an id-less call still works (the id is an optional addition, not a requirement)
  assert.equal(filesTouchedBlock(['a.ts']), '## Files touched so far\n\n- a.ts\n');
  assert.equal(memoryScreenStats().withheld, 0);
});

// ---- the tool-result channel ----------------------------------------------

test('TOOL RESULT: buildSubagentOutput withholds a credential path and counts it', () => {
  resetMemoryScreenStats();
  fs.rmSync(auditFilePath(), { force: true });
  const out = buildSubagentOutput({
    desc: { id: 'sa_o1', filesTouched: [`src/${KEY}.js`], lessons: [], result: 'done' },
    filesTouched: ['src/live.ts'],
    lessons: [],
    finalText: 'the answer',
    isError: false,
  });
  assert.deepEqual(out.filesTouched, ['src/live.ts'], JSON.stringify(out));
  assert.equal(JSON.stringify(out).includes(KEY_TAIL), false, JSON.stringify(out));
  assert.equal(out.withheld, 1, 'the withheld count rides back on the structured result');
  assert.equal(out.summary, 'the answer', 'an unrelated withheld field must not blank the summary');
});

test('TOOL RESULT: a clean file list keeps the output byte-identical', () => {
  resetMemoryScreenStats();
  fs.rmSync(auditFilePath(), { force: true });
  const out = buildSubagentOutput({
    desc: { id: 'sa_o2', filesTouched: ['src/tokenizer.js'], lessons: [{ text: 'l1' }], result: 'refactored the client' },
    filesTouched: ['src/skills.js'],
    lessons: [{ text: 'l2' }],
    finalText: '',
    isError: true,
  });
  assert.deepEqual(out.filesTouched, ['src/tokenizer.js', 'src/skills.js']);
  assert.equal(out.summary, 'refactored the client');
  assert.equal(out.withheld, undefined, 'no `withheld` key on a clean result -- shape unchanged');
  assert.equal(out.lessonsLearned, 2);
  assert.equal(memoryScreenStats().withheld, 0);
  assert.equal(auditRows().length, 0);
});

const sse = (obj) => `data: ${JSON.stringify(obj)}\n`;

function startMockServer(t, answer) {
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
      res.end(answer(bodies.length, parsed));
    });
  });
  t.after(() => {
    server.closeAllConnections?.();
    server.close();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, bodies })));
}

function reportResultTurn(id) {
  return [
    sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name: 'report_result', arguments: JSON.stringify({ output: 'resumed and finished' }) } }] }, finish_reason: null }] }),
    sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
    sse({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 5 } }),
    'data: [DONE]\n\n',
  ].join('');
}

function reportTurns(badPath, goodPath) {
  return (n) => {
    if (n === 1) {
      return [
        sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: badPath, content: 'x' }) } }] }, finish_reason: null }] }),
        sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
        sse({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 5 } }),
        'data: [DONE]\n\n',
      ].join('');
    }
    return [
      sse({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: 'c2', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: goodPath, content: 'y' }) } },
                { index: 1, id: 'c3', type: 'function', function: { name: 'report_result', arguments: JSON.stringify({ output: 'wrote both files' }) } },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
      sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
      sse({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 5 } }),
      'data: [DONE]\n\n',
    ].join('');
  };
}

// ---- FIXED: the accumulator is populated, and the write screen still guards it
//
// `runSubagent` fills `filesTouched` from TWO places: `ev.filesTouched` on the
// tool-end events, and `desc.filesTouched` from the descriptor it is resuming.
//
// The first was DEAD. Nothing in src/ ever set that field on any event --
// agent.js emitted tool-end as id/name/ok/isError/ms/bytes/meta and tools/index.js
// dropped whatever a tool implementation returned beyond content/isError/meta --
// so on a FRESH subagent the accumulator was empty no matter what the subagent
// did, and the write-side screen guarded an empty list. That made `filesTouched`
// a field the subagent machinery read, persisted, replayed into every resume
// prompt, and reported to the parent as work done -- that was never done.
//
// The fix is at the CAUSE, not at the reader: `write_file` / `edit_file` now
// return the path they resolved and actually wrote (`filesTouched` on the tool
// result), `dispatchTool` forwards it, and agent.js puts it on the tool-end
// event. The accumulator downstream is unchanged, which is the point: the reader
// was always correct and was being starved.
//
// The screen's role is UNCHANGED by the fix and is pinned by the tests below it:
// a real path is now flowing through the gate for the first time, so this is
// where a credential-shaped path in a subagent's real writes has to be caught.
// That is the stronger version of the same assertion, and it can only be made
// because the accumulator is no longer empty.
test('a FRESH subagent that writes two files persists BOTH paths in filesTouched', async (t) => {
  const cwd = sandbox(t, 'ox-ft-populated-');
  const id = 'sa_ft_populated';
  const { port } = await startMockServer(t, reportTurns('src/tokenizer.js', 'src/api.js'));
  const target = { provider: 'custom', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'mock-model' };
  const handler = makeSubagentToolHandler({
    config: { subagent: { maxDepth: 2, maxIterations: 10 } },
    target,
    auxTarget: null,
  });
  const res = await handler({ task: 'Add a helper module.', id }, {
    cwd,
    approval: 'yolo',
    depth: 0,
    maxDepth: 2,
    allTools: [
      { name: 'write_file', description: 'write', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
    ],
  });

  const desc = readDescriptor(cwd, id);
  // The paths are relative to the subagent's cwd, and both writes are recorded.
  assert.deepEqual(
    [...desc.filesTouched].sort(),
    ['src/api.js', 'src/tokenizer.js'],
    'the tool-end events must carry the paths write_file actually wrote'
  );
  // The same list reaches the parent in the tool result, so the operator sees
  // the same two paths the descriptor recorded.
  assert.match(res.content, /Files: src\/tokenizer\.js, src\/api\.js/);
  // And the files really exist -- this is a claim about what happened, not
  // about what a tool said it did.
  assert.ok(fs.existsSync(path.join(cwd, 'src/tokenizer.js')));
  assert.ok(fs.existsSync(path.join(cwd, 'src/api.js')));
});

// ---- end to end: the REAL handler, the REAL resume prompt ------------------
//
// The mock server records every request body, and a chat-completions request
// body IS the assembled prompt, so this inspects what the model would really
// receive on a resumed run.

function seedDescriptor(dir, id, files) {
  initDescriptor({ id, task: 'Add a helper module.', cwd: dir });
  const file = statePath(dir, id);
  const desc = JSON.parse(fs.readFileSync(file, 'utf8'));
  desc.filesTouched = files;
  desc.status = 'failed';
  fs.writeFileSync(file, JSON.stringify(desc, null, 2));
  return file;
}

function toolCtxFor(cwd) {
  return {
    cwd,
    approval: 'yolo',
    depth: 0,
    maxDepth: 2,
    allTools: [
      { name: 'write_file', description: 'write', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
    ],
  };
}

test('E2E: a planted credential path never reaches the tool result or the resumed prompt', async (t) => {
  const cwd = sandbox(t, 'ox-ft-e2e-');
  const id = 'sa_ft_e2e';
  // As if written by an older build, or by a hand: two clean paths and one that
  // is a credential match.
  const file = seedDescriptor(cwd, id, ['src/tokenizer.js', `src/${KEY}.ts`, `src/${GH}.env`]);

  const { port, bodies } = await startMockServer(t, (n) =>
    n === 1
      ? [
          sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'report_result', arguments: JSON.stringify({ output: 'finished the helper module' }) } }] }, finish_reason: null }] }),
          sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
          sse({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 5 } }),
          'data: [DONE]\n\n',
        ].join('')
      : [
          sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c2', type: 'function', function: { name: 'report_result', arguments: JSON.stringify({ output: 'resumed and finished' }) } }] }, finish_reason: null }] }),
          sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
          sse({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 5 } }),
          'data: [DONE]\n\n',
        ].join('')
  );

  const target = { provider: 'custom', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'mock-model' };
  const handler = makeSubagentToolHandler({
    config: { subagent: { maxDepth: 2, maxIterations: 10 } },
    target,
    auxTarget: null,
  });

  resetMemoryScreenStats();
  fs.rmSync(auditFilePath(), { force: true });
  const res = await handler({ task: 'Add a helper module.', resume: id }, toolCtxFor(cwd));

  // the tool result the parent reads
  assert.equal(res.content.includes(KEY_TAIL), false, `credential reached the tool result:\n${res.content}`);
  assert.equal(res.content.includes('ghp_ABCDEF'), false, `planted PAT path reached the tool result:\n${res.content}`);
  assert.match(res.content, /refused 2 file paths this run/, res.content);
  assert.match(res.content, /src\/tokenizer\.js/, 'the legitimate path is still reported');

  // THE PROMPT. runSubagent hoists its assembled block into runAgentLoop's
  // top-level `extraGuidance` option (subagent.js), so `## Files touched so far`
  // really is in the resumed subagent's system prompt in this build, and the
  // request bodies recorded here are that prompt.
  assert.ok(bodies.length >= 1, 'the resumed run reached the model');
  for (const body of bodies) {
    const system = (body.messages || []).find((m) => m.role === 'system');
    assert.ok(system, 'the resumed subagent was sent a system prompt');
    assert.equal(system.content.includes(KEY_TAIL), false, `credential reached the system prompt:\n${system.content}`);
    assert.equal(system.content.includes('ghp_ABCDEF'), false, `planted path reached the system prompt:\n${system.content}`);
    assert.match(system.content, /## Files touched so far/, 'the files-touched block IS in the prompt');
    assert.match(system.content, /^- src\/tokenizer\.js$/m, 'the legitimate path is still in the prompt');
    assert.match(system.content, /\[memory-screen\] withheld 2 paths\b/, `the withholding rides the prompt:\n${system.content}`);
  }

  // the READ screen withheld from the prompt; the WRITE screen then scrubbed the
  // descriptor, so the next resume starts from the clean list.
  assert.deepEqual(readDescriptor(cwd, id).filesTouched, ['src/tokenizer.js'], 'state.json still holds a credential path');

  // and with the descriptor clean, a second resume carries no notice at all
  const from2 = bodies.length;
  const res2 = await handler({ task: 'Add a helper module.', resume: id }, toolCtxFor(cwd));
  assert.equal(res2.content.includes('memory-screen'), false, `a notice fired on the now-clean resume:\n${res2.content}`);
  for (const body of bodies.slice(from2)) {
    const system = (body.messages || []).find((m) => m.role === 'system');
    assert.equal(system.content.includes('memory-screen'), false, `a notice rode the now-clean prompt:\n${system.content}`);
    assert.match(system.content, /^- src\/tokenizer\.js$/m);
  }
});

test('E2E CONTROL: clean paths replay with no notice and a byte-identical block', async (t) => {
  const cwd = sandbox(t, 'ox-ft-e2e-clean-');
  const id = 'sa_ft_e2e_clean';
  seedDescriptor(cwd, id, ['src/tokenizer.js', 'src/api-keys.js', 'config/passwords.example.json']);

  const { port, bodies } = await startMockServer(t, () =>
    [
      sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'report_result', arguments: JSON.stringify({ output: 'resumed and finished' }) } }] }, finish_reason: null }] }),
      sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
      sse({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 5 } }),
      'data: [DONE]\n\n',
    ].join('')
  );

  const target = { provider: 'custom', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'mock-model' };
  const handler = makeSubagentToolHandler({
    config: { subagent: { maxDepth: 2, maxIterations: 10 } },
    target,
    auxTarget: null,
  });

  resetMemoryScreenStats();
  fs.rmSync(auditFilePath(), { force: true });
  const res = await handler({ task: 'Add a helper module.', resume: id }, toolCtxFor(cwd));

  assert.equal(res.content.includes('memory-screen'), false, `a notice fired on a clean run:\n${res.content}`);
  assert.match(res.content, /src\/api-keys\.js/, 'legitimate secret-sounding paths are reported normally');
  for (const body of bodies) {
    assert.equal(JSON.stringify(body).includes('memory-screen'), false, 'a notice fired inside the prompt');
  }

  resetMemoryScreenStats();
  const block = filesTouchedBlock(readDescriptor(cwd, id).filesTouched, id);
  assert.equal(
    block,
    [
      '## Files touched so far',
      '',
      '- src/tokenizer.js',
      '- src/api-keys.js',
      '- config/passwords.example.json',
      '',
    ].join('\n'),
    'a clean block is byte-identical to the pre-screen render'
  );
  assert.equal(memoryScreenStats().withheld, 0);
  assert.equal(auditRows().length, 0);
});
