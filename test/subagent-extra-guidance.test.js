// extraGuidance must actually reach a SUBAGENT's system prompt.
//
// runAgentLoop reads `extraGuidance` as a TOP-LEVEL option, while runSubagent
// only ever set `subCtx.extraGuidance`, so the whole '# EXTRA GUIDANCE' section
// was silently dropped on every subagent call: the parent goal, the prior-lessons
// block, the files-touched block and the subagent instructions never reached the
// model. That also made the GAP-1 read-side screen of lessonsContextBlock()
// inert -- there was nowhere for its output to go.
//
// Proved end to end against a scripted provider, so the assertion is about the
// bytes a real subagent request actually carried.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OX_BIN = path.join(ROOT, 'bin', 'ox.js');

const SECRET = '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';

const SCRUB = [
  'OX_BASE_URL', 'OX_API_KEY', 'OX_MODEL', 'OX_YOLO', 'OX_MAX_COST',
  'XAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY',
  'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'DEEPSEEK_API_KEY', 'NODE_OPTIONS',
];

function sse(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

// One scripted model turn as OpenAI-style SSE.
function turn({ text = '', calls = [], usage = { prompt_tokens: 21, completion_tokens: 13 } }) {
  const out = [];
  if (text) out.push(sse({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }));
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
                  function: { name: call.name, arguments: JSON.stringify(call.args) },
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

async function startMock(t, decide) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      let parsed = {};
      try {
        parsed = JSON.parse(body) ?? {};
      } catch {}
      const rec = { messages: parsed.messages ?? [], tools: parsed.tools ?? [], raw: body };
      requests.push(rec);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(turn(decide(rec)));
    });
  });
  t.after(() => {
    server.closeAllConnections?.();
    server.close();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, requests };
}

async function runOx(t, { home, port, args, timeout = 45000 }) {
  const env = { ...process.env };
  for (const k of SCRUB) delete env[k];
  const child = spawn(process.execPath, [OX_BIN, ...args], {
    cwd: home,
    env: { ...env, HOME: home, NO_COLOR: '1', OX_BASE_URL: `http://127.0.0.1:${port}/v1`, OX_API_KEY: 'test' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  child.stdin.end();
  const code = await new Promise((resolve, reject) => {
    const killer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`ox did not exit within ${timeout}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, timeout);
    child.on('error', (e) => {
      clearTimeout(killer);
      reject(e);
    });
    child.on('close', (c) => {
      clearTimeout(killer);
      resolve(c);
    });
  });
  return { code, stdout, stderr };
}

function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-subguid-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* a throwing hook skips later cleanup: see e2e.test.js */ } });
  return dir;
}

// The subagent request is the one that was offered report_result.
function subagentRequest(requests) {
  const r = requests.find((q) => q.tools.some((s) => s?.function?.name === 'report_result' || s?.name === 'report_result'));
  assert.ok(r, `no subagent request among ${requests.length} requests`);
  return r;
}

function systemTextOf(request) {
  const sys = request.messages.find((m) => m.role === 'system');
  assert.ok(sys, 'the subagent request must carry a system prompt');
  return sys.content;
}

function guidanceSection(system) {
  const start = system.indexOf('# EXTRA GUIDANCE');
  if (start === -1) return null;
  const rest = system.slice(start + '# EXTRA GUIDANCE'.length);
  const next = rest.search(/\n# /);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
}

test('a subagent receives its # EXTRA GUIDANCE (the section was absent before)', async (t) => {
  const home = sandbox(t);
  let spawned = 0;
  const { port, requests } = await startMock(t, (rec) => {
    const isSubagent = rec.tools.some((s) => s?.function?.name === 'report_result' || s?.name === 'report_result');
    if (isSubagent) return { calls: [{ id: 'call_rep_1', name: 'report_result', args: { output: 'subagent done' } }] };
    spawned += 1;
    if (spawned === 1) {
      return {
        text: 'Delegating.',
        calls: [{ id: 'call_sub_1', name: 'subagent', args: { task: 'summarise the server module', id: 'sub-alpha' } }],
      };
    }
    return { text: 'parent final' };
  });

  const { code, stdout, stderr } = await runOx(t, { home, port, args: ['-p', 'delegate this'] });
  assert.equal(code, 0, `exit ${code}\nstdout: ${stdout}\nstderr: ${stderr}`);

  const req = subagentRequest(requests);
  const system = systemTextOf(req);
  const guidance = guidanceSection(system);

  assert.ok(guidance !== null, `no '# EXTRA GUIDANCE' in the subagent system prompt:\n${system}`);
  assert.match(guidance, /## Subagent instructions/);
  assert.match(guidance, /You are a SUBAGENT spawned to complete a focused task/);
  assert.match(system, /## GOAL CONTRACT/, 'the subagent still carries its goal contract');
});

test('the parent goal and the files-touched block ride along in the guidance', async (t) => {
  const home = sandbox(t);
  // A resumed subagent with a files-touched history: both blocks are built from
  // the descriptor, so both must appear in the injected guidance.
  const dir = path.join(home, '.agent', '_sub', 'sub-beta');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'state.json'),
    JSON.stringify(
      {
        version: 1,
        id: 'sub-beta',
        parentSession: null,
        task: 'earlier task',
        description: 'earlier task',
        status: 'done',
        depth: 0,
        maxDepth: 2,
        persona: null,
        tools: null,
        cwd: home,
        createdAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        error: null,
        filesTouched: ['src/server.js', 'src/db.js'],
        lessons: [],
        result: 'earlier result',
      },
      null,
      2
    )
  );

  let spawned = 0;
  const { port, requests } = await startMock(t, (rec) => {
    const isSubagent = rec.tools.some((s) => s?.function?.name === 'report_result' || s?.name === 'report_result');
    if (isSubagent) return { calls: [{ id: 'call_rep_2', name: 'report_result', args: { output: 'resumed done' } }] };
    spawned += 1;
    if (spawned === 1) {
      return {
        calls: [{ id: 'call_sub_2', name: 'subagent', args: { task: 'continue the server work', resume: 'sub-beta' } }],
      };
    }
    return { text: 'parent final' };
  });

  const { code, stderr } = await runOx(t, { home, port, args: ['-p', 'keep going'] });
  assert.equal(code, 0, stderr);

  const guidance = guidanceSection(systemTextOf(subagentRequest(requests)));
  assert.match(guidance, /## Files touched so far/);
  assert.match(guidance, /src\/server\.js/);
  assert.match(guidance, /src\/db\.js/);
});

test('lessonsContextBlock output reaches the prompt, and a credential in it is withheld', async (t) => {
  const home = sandbox(t);
  // Hand-plant a lesson log that predates (or bypasses) the write screen: one
  // safe lesson, one credential. This is the GAP-1 case -- before the
  // extraGuidance fix the whole block was dropped, so the screen was inert.
  const dir = path.join(home, '.agent', '_sub', 'sub-gamma');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'state.json'),
    JSON.stringify(
      {
        version: 1,
        id: 'sub-gamma',
        parentSession: null,
        task: 'earlier task',
        description: 'earlier task',
        status: 'done',
        depth: 0,
        maxDepth: 2,
        persona: null,
        tools: null,
        cwd: home,
        createdAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        error: null,
        filesTouched: [],
        lessons: [
          { ts: new Date().toISOString(), text: 'always run node --check after editing src/cli.js' },
          { ts: new Date().toISOString(), text: `the deploy key is ${SECRET}` },
        ],
        result: 'earlier result',
      },
      null,
      2
    )
  );

  let spawned = 0;
  const { port, requests } = await startMock(t, (rec) => {
    const isSubagent = rec.tools.some((s) => s?.function?.name === 'report_result' || s?.name === 'report_result');
    if (isSubagent) return { calls: [{ id: 'call_rep_3', name: 'report_result', args: { output: 'done' } }] };
    spawned += 1;
    if (spawned === 1) {
      return {
        calls: [{ id: 'call_sub_3', name: 'subagent', args: { task: 'keep going', resume: 'sub-gamma' } }],
      };
    }
    return { text: 'parent final' };
  });

  const { code, stderr } = await runOx(t, { home, port, args: ['-p', 'keep going'] });
  assert.equal(code, 0, stderr);

  const req = subagentRequest(requests);
  const system = systemTextOf(req);
  const guidance = guidanceSection(system);

  // the screened lessons block actually arrives
  assert.match(guidance, /## Subagent memory — lessons from prior runs/);
  assert.match(guidance, /always run node --check after editing src\/cli\.js/);
  // and the credential in it does not
  assert.equal(req.raw.includes(SECRET), false, 'a credential in a subagent lesson leaked into the subagent prompt');
  assert.equal(req.raw.includes('9edd82d6dd'), false);
  assert.match(guidance, /\[memory-screen\] withheld 1 line/);
});

test('prompt-size cost: measure the added EXTRA GUIDANCE bytes per subagent call', async (t) => {
  const home = sandbox(t);
  const sizes = [];
  let spawned = 0;
  const { port, requests } = await startMock(t, (rec) => {
    const isSubagent = rec.tools.some((s) => s?.function?.name === 'report_result' || s?.name === 'report_result');
    if (isSubagent) {
      const system = systemTextOf(rec);
      sizes.push({ system: system.length, guidance: guidanceSection(system) });
      return { calls: [{ id: 'call_rep_4', name: 'report_result', args: { output: 'done' } }] };
    }
    spawned += 1;
    if (spawned === 1) {
      return {
        calls: [{ id: 'call_sub_4', name: 'subagent', args: { task: 'count the lines in src/cli.js', id: 'sub-delta' } }],
      };
    }
    return { text: 'parent final' };
  });

  const { code, stderr } = await runOx(t, { home, port, args: ['-p', 'delegate'] });
  assert.equal(code, 0, stderr);

  const measured = sizes[0];
  assert.ok(measured && measured.guidance !== null, 'guidance section missing');
  const section = measured.guidance;
  const overhead = section.length + '# EXTRA GUIDANCE'.length + 2; // header + the blank line before it
  // Before the fix the section did not exist at all, so the whole thing is the
  // delta. Reported, not asserted to a magic number.
  console.log(
    `[guidance-cost] subagent system prompt ${measured.system} chars; '# EXTRA GUIDANCE' section ` +
      `${section.length} chars; per-call delta ~${overhead} chars (~${Math.round(overhead / 4)} tokens)`
  );
  assert.ok(section.length > 100, `suspiciously small guidance section: ${JSON.stringify(section)}`);
  assert.match(section, /## Subagent instructions/);
});
