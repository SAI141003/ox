import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Sandbox HOME + workspace BEFORE importing src modules (config.js bakes
// CONFIG_DIR from os.homedir() at import time — same pattern as gaps1).
// ---------------------------------------------------------------------------

const realHome = process.env.HOME;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-gaps2-home-'));
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-gaps2-ws-'));
process.env.HOME = home;
fs.mkdirSync(path.join(home, '.ox'), { recursive: true });

const LINT_ENV_KEYS = ['OX_NO_LINT', 'OX_API_KEY', 'OX_MODEL_WINDOW', 'OX_AUX_BOT'];
const savedEnv = Object.fromEntries(LINT_ENV_KEYS.map((k) => [k, process.env[k]]));
for (const k of ['OX_NO_LINT', 'OX_MODEL_WINDOW', 'OX_AUX_BOT']) delete process.env[k];
process.env.OX_API_KEY = process.env.OX_API_KEY ?? 'test-gaps2-key';

after(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(ws, { recursive: true, force: true });
  process.env.HOME = realHome;
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const { runAgent } = await import('../src/agent.js');
const { writeFileTool, editFileTool } = await import('../src/tools/fs.js');

// ---------- shared mock-provider plumbing ----------

const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

function turn({ text = '', calls = [], usage = { prompt_tokens: 21, completion_tokens: 13 }, finish = null } = {}) {
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
  out.push(sse({ choices: [{ index: 0, delta: {}, finish_reason: finish ?? (calls.length ? 'tool_calls' : 'stop') }] }));
  out.push(sse({ choices: [], usage }));
  out.push('data: [DONE]\n\n');
  return out.join('');
}

// Handler receives (parsedBody, res) so tests can drop/hold connections.
function startServerRaw(t, handler) {
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
      handler(parsed, res);
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
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ===========================================================================
// G3 — transport resilience (Hermes-style continuation)
// ===========================================================================

test('network death mid-stream retries once and recovers with the right answer; no ghost tools', async (t) => {
  const cwd = tmpDir(t, 'ox-gaps2-drop-');
  let n = 0;
  const srv = await startServerRaw(t, (b, res) => {
    n++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (n === 1) {
      res.write(sse({ choices: [{ index: 0, delta: { content: 'GHOST' }, finish_reason: null }] }));
      setTimeout(() => res.socket.destroy(), 30);
      return;
    }
    res.end(turn({ text: 'RECOVERED_FINAL answer' }));
  });

  const events = await collectEvents({
    target: mkTarget(srv.port),
    messages: [{ role: 'user', content: 'hi' }],
    ctx: { cwd },
    auxTarget: null,
  });

  const retries = events.filter((e) => e.type === 'continuation-retry');
  assert.equal(retries.length, 1, `expected exactly one retry event: ${JSON.stringify(retries)}`);
  assert.equal(retries[0].attempt, 1);
  assert.ok(typeof retries[0].reason === 'string' && retries[0].reason.length > 0 && retries[0].reason.length <= 120);

  const final = events.find((e) => e.type === 'final');
  assert.ok(final, 'turn completed');
  assert.equal(final.message.content, 'RECOVERED_FINAL answer');

  assert.equal(events.filter((e) => e.type === 'tool-start').length, 0, 'no ghost tool execution');
  assert.equal(events.filter((e) => e.type === 'tool-end').length, 0);
  assert.equal(events.some((e) => e.type === 'error'), false, 'no error leaked on recovery');

  assert.equal(srv.bodies.length, 2, 'identical request re-sent once');
  assert.deepEqual(srv.bodies[1].messages, srv.bodies[0].messages, 'retry payload identical');
  const hist = events.find((e) => e.type === 'history');
  assert.equal(hist.messages.filter((m) => m.role === 'assistant').length, 1, 'history unpoisoned');
});

test('persistent network death stops the turn after 3 retries with a clean error and unpoisoned history', async (t) => {
  const cwd = tmpDir(t, 'ox-gaps2-dead-');
  const srv = await startServerRaw(t, (b, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    setTimeout(() => res.socket.destroy(), 10);
  });

  const events = await collectEvents({
    target: mkTarget(srv.port),
    messages: [{ role: 'user', content: 'hi' }],
    ctx: { cwd },
    auxTarget: null,
  });

  const retries = events.filter((e) => e.type === 'continuation-retry');
  assert.deepEqual(
    retries.map((e) => e.attempt),
    [1, 2, 3],
    'exactly three retry attempts'
  );
  const errs = events.filter((e) => e.type === 'error');
  assert.equal(errs.length, 1);
  assert.match(errs[0].error, /stream died after 3 retries:/);
  assert.equal(events.some((e) => e.type === 'final'), false, 'no final answer');
  assert.equal(events.some((e) => e.type === 'assistant-turn'), false);
  const hist = events.find((e) => e.type === 'history');
  assert.equal(hist.messages.filter((m) => m.role !== 'system').length, 1, 'only the original user msg remains');
  assert.equal(srv.bodies.length, 4, 'initial attempt + 3 retries');
  assert.ok(events.some((e) => e.type === 'usage-total'), 'usage totals still emitted');
});

test('finish_reason length triggers auto-continuation that completes coherently (<=3 rounds)', async (t) => {
  const cwd = tmpDir(t, 'ox-gaps2-len-');
  let n = 0;
  const srv = await startServerRaw(t, (b, res) => {
    n++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (n === 1) {
      res.end([
        sse({ choices: [{ index: 0, delta: { content: 'PART_ONE' }, finish_reason: null }] }),
        sse({ choices: [{ index: 0, delta: {}, finish_reason: 'length' }] }),
        sse({ choices: [], usage: { prompt_tokens: 21, completion_tokens: 13 } }),
        'data: [DONE]\n\n',
      ].join(''));
      return;
    }
    res.end(turn({ text: ' PART_TWO done' }));
  });

  const events = await collectEvents({
    target: mkTarget(srv.port),
    messages: [{ role: 'user', content: 'write it' }],
    ctx: { cwd },
    auxTarget: null,
  });

  const conts = events.filter((e) => e.type === 'continued');
  assert.equal(conts.length, 1, 'one continued round');
  assert.deepEqual(conts.map((e) => e.round), [1]);
  const final = events.find((e) => e.type === 'final');
  assert.equal(final.message.content, ' PART_TWO done', 'continuation completes the turn');
  const histMsgs = events.find((e) => e.type === 'history').messages;
  const parts = histMsgs.filter((m) => m.role === 'assistant').map((m) => m.content);
  assert.deepEqual(parts, ['PART_ONE', ' PART_TWO done'], 'partial text committed, answer coherent in history');
  assert.equal(srv.bodies.length, 2);
  const tail = srv.bodies[1].messages.slice(-2);
  assert.deepEqual(tail, [
    { role: 'assistant', content: 'PART_ONE' },
    { role: 'user', content: 'Continue exactly where you left off. Do not repeat completed text.' },
  ]);
});

test('continuation rounds use a separate budget and never consume maxIterations', async (t) => {
  const cwd = tmpDir(t, 'ox-gaps2-budget-');
  let n = 0;
  const srv = await startServerRaw(t, (b, res) => {
    n++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (n <= 2) {
      res.end([
        sse({ choices: [{ index: 0, delta: { content: `chunk${n} ` }, finish_reason: null }] }),
        sse({ choices: [{ index: 0, delta: {}, finish_reason: 'length' }] }),
        sse({ choices: [] }),
        'data: [DONE]\n\n',
      ].join(''));
      return;
    }
    res.end(turn({ text: 'done finally' }));
  });

  const events = await collectEvents({
    target: mkTarget(srv.port),
    messages: [{ role: 'user', content: 'go' }],
    ctx: { cwd },
    auxTarget: null,
    maxIterations: 1,
  });

  const conts = events.filter((e) => e.type === 'continued');
  assert.deepEqual(conts.map((e) => e.round), [1, 2], 'two continuation rounds under maxIterations=1');
  assert.equal(conts.length <= 3, true, 'continued rounds capped at 3');
  const final = events.find((e) => e.type === 'final');
  assert.ok(final, 'completed despite maxIterations=1');
  assert.match(final.message.content, /done finally/);
  assert.equal(
    events.some((e) => e.type === 'error' && /iteration budget/.test(e.error)),
    false,
    'no iteration-budget exhaustion'
  );
});

test('user abort is never retried (no continuation-retry events)', async (t) => {
  const cwd = tmpDir(t, 'ox-gaps2-abort-');
  const srv = await startServerRaw(t, () => {
    // hold the response open forever
  });

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 150);
  const events = [];
  for await (const ev of runAgent({
    target: mkTarget(srv.port),
    messages: [{ role: 'user', content: 'hi' }],
    ctx: { cwd },
    auxTarget: null,
    signal: controller.signal,
  })) {
    events.push(ev);
  }

  assert.equal(events.filter((e) => e.type === 'continuation-retry').length, 0, 'aborts are never retried');
  const errs = events.filter((e) => e.type === 'error');
  assert.equal(errs.length, 1);
  assert.equal(errs[0].error, 'aborted');
  assert.equal(events.some((e) => e.type === 'final'), false);
});

// ===========================================================================
// G4 — post-edit syntax advisory
// ===========================================================================

test('write_file appends syntax advisory + lintFail meta for broken JS; clean JS stays silent', async (t) => {
  const dir = tmpDir(t, 'ox-gaps2-lint-');
  const broken = await writeFileTool(
    { path: path.join(dir, 'bad.js'), content: 'function oops( {\n  return 1;\n}\n' },
    { cwd: dir }
  );
  assert.equal(broken.isError, undefined, 'advisory only — isError stays false');
  assert.match(broken.content, /\[syntax check FAILED: [^\]]+\]/);
  assert.equal(broken.meta?.lintFail, true);
  assert.ok(!broken.content.includes('[syntax check FAILED: [syntax check FAILED'), 'single advisory line');

  const clean = await writeFileTool({ path: path.join(dir, 'good.js'), content: 'const x = 1;\n' }, { cwd: dir });
  assert.equal(clean.isError, undefined);
  assert.ok(!clean.content.includes('syntax check FAILED'));
  assert.equal(clean.meta?.lintFail ?? false, false);
});

test('edit_file flags broken JS after a successful edit', async (t) => {
  const dir = tmpDir(t, 'ox-gaps2-editlint-');
  const p = path.join(dir, 'app.js');
  fs.writeFileSync(p, 'const a = 1;\n');
  const res = await editFileTool({ path: p, old_string: 'const a = 1;', new_string: 'const a = ((;\n' }, { cwd: dir });
  assert.equal(res.isError, undefined);
  assert.match(res.content, /\[syntax check FAILED:/);
  assert.equal(res.meta?.lintFail, true);
});

test('json variant: invalid JSON flagged, valid JSON silent', async (t) => {
  const dir = tmpDir(t, 'ox-gaps2-jsonlint-');
  const bad = await writeFileTool({ path: path.join(dir, 'bad.json'), content: '{oops' }, { cwd: dir });
  assert.match(bad.content, /\[syntax check FAILED:/);
  assert.equal(bad.meta?.lintFail, true);
  const good = await writeFileTool({ path: path.join(dir, 'good.json'), content: '{"a": 1}' }, { cwd: dir });
  assert.ok(!good.content.includes('syntax check FAILED'));
});

test('py and sh variants flagged when their checkers exist', async (t) => {
  const hasPy = spawnSync('python3', ['--version'], { stdio: 'ignore' }).status === 0;
  const hasBash = spawnSync('bash', ['--version'], { stdio: 'ignore' }).status === 0;
  if (!hasPy && !hasBash) return; // checkers unavailable in this environment

  const dir = tmpDir(t, 'ox-gaps2-shlint-');
  if (hasPy) {
    const badPy = await writeFileTool({ path: path.join(dir, 'bad.py'), content: 'def f(:\n  pass\n' }, { cwd: dir });
    assert.match(badPy.content, /\[syntax check FAILED:/);
    assert.equal(badPy.meta?.lintFail, true);
  }
  if (hasBash) {
    const badSh = await writeFileTool({ path: path.join(dir, 'bad.sh'), content: 'if then fi\n' }, { cwd: dir });
    assert.match(badSh.content, /\[syntax check FAILED:/);
    assert.equal(badSh.meta?.lintFail, true);
  }
});

test('OX_NO_LINT=1 suppresses the advisory entirely', async (t) => {
  const dir = tmpDir(t, 'ox-gaps2-nolint-');
  process.env.OX_NO_LINT = '1';
  try {
    const res = await writeFileTool({ path: path.join(dir, 'bad.js'), content: 'function oops( {\n' }, { cwd: dir });
    assert.ok(!res.content.includes('syntax check FAILED'));
    assert.equal(res.meta?.lintFail ?? false, false);
  } finally {
    delete process.env.OX_NO_LINT;
  }
});

test('advisory only applies to lintable extensions inside cwd', async (t) => {
  const dir = tmpDir(t, 'ox-gaps2-scope-');
  const outside = tmpDir(t, 'ox-gaps2-outside-');
  const txt = await writeFileTool({ path: path.join(dir, 'note.txt'), content: 'function oops( {\n' }, { cwd: dir });
  assert.ok(!txt.content.includes('syntax check FAILED'));

  const foreign = await writeFileTool(
    { path: path.join(outside, 'bad.js'), content: 'function oops( {\n' },
    { cwd: dir }
  );
  assert.ok(!foreign.content.includes('syntax check FAILED'));

  const noCtx = await writeFileTool({ path: path.join(dir, 'bad2.js'), content: 'function oops( {\n' }, {});
  assert.ok(!noCtx.content.includes('syntax check FAILED'));
});

test('agent treats lintFail as an external failure signal: tracker escalates but self-heal budget never trips', async (t) => {
  const dir = tmpDir(t, 'ox-gaps2-agentlint-');
  const badPath = path.join(dir, 'broken.js');
  // Wave5a doom-loop: identical (tool+args) calls are blocked from the 3rd
  // occurrence, so each scripted attempt varies its content slightly while
  // staying syntactically broken for the lint advisory.
  let attempt = 0;
  const srv = await startServerRaw(t, (b, res) => {
    attempt += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(
      turn({
        calls: [
          { id: `call_${attempt}`, name: 'write_file', args: { path: badPath, content: `function ({\n// attempt ${attempt}` } },
        ],
      })
    );
  });

  const events = await collectEvents({
    target: mkTarget(srv.port),
    messages: [{ role: 'user', content: 'write the file' }],
    ctx: { cwd: dir, yolo: true },
    auxTarget: null,
    maxIterations: 3,
  });

  const toolEnds = events.filter((e) => e.type === 'tool-end');
  assert.ok(toolEnds.length >= 2, `multiple write attempts (${toolEnds.length})`);
  for (const te of toolEnds) {
    assert.equal(te.isError, false, 'advisory keeps isError false');
    assert.equal(te.meta?.lintFail, true, 'tool-end carries lintFail meta');
  }
  const reflections = events.filter((e) => e.type === 'reflection' && /syntax check failed/.test(e.text));
  assert.ok(reflections.length >= 2, 'reflection fired per advisory');
  assert.equal(reflections[0].count, 1);
  assert.equal(reflections[1].count, 2, 'tracker escalates across offenses');
  assert.equal(
    events.some((e) => e.type === 'error' && /self-heal budget exhausted/.test(e.error)),
    false,
    'advisories never exhaust the self-heal budget'
  );
  // escalated guidance reached the next system prompt
  const sys = srv.bodies[1]?.messages?.find((m) => m.role === 'system')?.content ?? '';
  assert.match(sys, /invalid syntax/);
});

// ===========================================================================
// G7 — skill management commands (subprocess CLI)
// ===========================================================================

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OX_BIN = path.join(ROOT, 'bin', 'ox.js');

function skillEnv(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-gaps2-cli-'));
  const homeDir = path.join(root, 'home');
  const proj = path.join(root, 'proj');
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(proj, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const run = (args) =>
    spawnSync(process.execPath, [OX_BIN, ...args], {
      cwd: proj,
      env: { ...process.env, HOME: homeDir, NO_COLOR: '1' },
      encoding: 'utf8',
    });
  const writeSkill = (base, name, body) => {
    const d = path.join(base, name);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'SKILL.md'), body);
    return d;
  };
  return { root, homeDir, proj, run, writeSkill };
}

const VALID_SKILL = (name, desc) =>
  ['---', `name: ${name}`, `description: ${desc}`, '---', '', `${name} body.`].join('\n');

test('skill ls renders table rows with source + trigger and prints discovery warnings', (t) => {
  const { homeDir, proj, run, writeSkill } = skillEnv(t);
  writeSkill(proj, '.agents/skills/fixer', [
    '---',
    'name: fixer',
    'description: Fixes broken imports everywhere',
    'metadata:',
    '  trigger: command',
    '---',
    '',
    'Fixer body.',
  ].join('\n'));
  writeSkill(homeDir, '.agents/skills/brokenls', ['---', 'name: brokenls', '---'].join('\n'));

  const r = run(['skill', 'ls']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /NAME\s+SOURCE\s+TRIGGER\s+DESCRIPTION/);
  assert.match(r.stdout, /fixer\s+project\s+command\s+Fixes broken imports/);
  assert.match(r.stdout, /warning: .*brokenls/, 'warnings line present');
});

test('skill new scaffolds SKILL.md, refuses existing without --force, overwrites with --force', (t) => {
  const { homeDir, proj, run } = skillEnv(t);

  const r1 = run(['skill', 'new', 'my-thing']);
  assert.equal(r1.status, 0, r1.stderr);
  assert.match(r1.stdout, /~\/\.agents\/skills/);
  const scaffold = path.join(homeDir, '.agents', 'skills', 'my-thing', 'SKILL.md');
  assert.equal(fs.existsSync(scaffold), true);
  const body = fs.readFileSync(scaffold, 'utf8');
  assert.match(body, /^name: my-thing$/m);
  assert.match(body, /^description: TODO/m);
  assert.match(body, /metadata:\n  created: \d{4}-\d{2}-\d{2}/m);
  assert.match(body, /## Steps/);
  assert.match(body, /TODO/);

  const r2 = run(['skill', 'new', 'my-thing']);
  assert.equal(r2.status, 4, `refuse exit: ${r2.stderr}`);
  assert.match(r2.stderr, /already exists/);

  const r3 = run(['skill', 'new', 'my-thing', '--force']);
  assert.equal(r3.status, 0, r3.stderr);
  assert.equal(fs.existsSync(scaffold), true);

  const r4 = run(['skill', 'new', 'Bad_Name']);
  assert.equal(r4.status, 3);
  assert.match(r4.stderr, /invalid skill name/);

  const r5 = run(['skill', 'new', 'proj-one', '--project']);
  assert.equal(r5.status, 0, r5.stderr);
  assert.equal(fs.existsSync(path.join(proj, '.agents', 'skills', 'proj-one', 'SKILL.md')), true);
});

test('skill rm refuses ambiguity, needs --yes off-TTY, deletes with --yes', (t) => {
  const { homeDir, proj, run, writeSkill } = skillEnv(t);
  writeSkill(homeDir, '.agents/skills/dupx', VALID_SKILL('dupx', 'home copy'));
  const projCopy = writeSkill(proj, '.claude/skills/dupx', VALID_SKILL('dupx', 'project copy'));

  const amb = run(['skill', 'rm', 'dupx']);
  assert.equal(amb.status, 4, amb.stderr);
  assert.match(amb.stderr, /ambiguous/);
  assert.match(amb.stderr, /dupx/);
  assert.equal(fs.existsSync(projCopy), true, 'nothing deleted while ambiguous');

  fs.rmSync(projCopy, { recursive: true, force: true });
  const noYes = run(['skill', 'rm', 'dupx']);
  assert.equal(noYes.status, 4, noYes.stderr);
  assert.match(noYes.stderr, /--yes/);
  assert.equal(fs.existsSync(path.join(homeDir, '.agents', 'skills', 'dupx')), true, 'still present without --yes');

  const gone = run(['skill', 'rm', 'dupx', '--yes']);
  assert.equal(gone.status, 0, gone.stderr);
  assert.equal(fs.existsSync(path.join(homeDir, '.agents', 'skills', 'dupx')), false, 'directory deleted');

  const missing = run(['skill', 'rm', 'ghost']);
  assert.equal(missing.status, 3);
  assert.match(missing.stderr, /no skill 'ghost'/);
});

test('skill path prints absolute SKILL.md with project precedence; exits 1 on miss', (t) => {
  const { homeDir, proj, run, writeSkill } = skillEnv(t);
  writeSkill(homeDir, '.agents/skills/dupx2', VALID_SKILL('dupx2', 'home copy'));
  writeSkill(proj, '.claude/skills/dupx2', VALID_SKILL('dupx2', 'project copy'));

  const hit = run(['skill', 'path', 'dupx2']);
  assert.equal(hit.status, 0, hit.stderr);
  // child cwd() is realpath'd on macOS (/var -> /private/var)
  const realProj = fs.realpathSync(proj);
  assert.equal(hit.stdout.trim(), path.join(realProj, '.claude', 'skills', 'dupx2', 'SKILL.md'));

  const miss = run(['skill', 'path', 'nope-nope']);
  assert.equal(miss.status, 1);
  assert.match(miss.stderr, /no skill 'nope-nope'/);
});
