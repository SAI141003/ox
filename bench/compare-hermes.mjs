// Head-to-head, no model cost: ox vs Hermes against the same local mock
// OpenAI endpoint. Measures what does not need a smart model:
//   - time from launch to the first model request (startup)
//   - wall time for a one-turn answer
//   - what each agent sends per request: system prompt, tool schemas, bytes,
//     estimated tokens (bytes/4) -- the overhead paid on EVERY turn.
// Each agent runs in a throwaway HOME so neither touches real sessions.
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const OX = path.resolve(process.argv[2]);
const RUNS = Number(process.argv[3] ?? 3);
const PROMPT = 'Reply with the single word: ready';

let requests = [];
const homes = {};
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    if (req.method === 'GET') { // model listings
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock', object: 'model', owned_by: 'me' }] }));
      return;
    }
    let j = {};
    try { j = JSON.parse(body); } catch {}
    requests.push({ at: Date.now(), url: req.url, bytes: Buffer.byteLength(body), json: j });
    const stream = j.stream === true;
    if (stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: 'mock', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      res.end(chunk({ role: 'assistant', content: 'ready' }) + chunk({}, 'stop')
        + `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: 'mock', choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n` + 'data: [DONE]\n\n');
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'x', object: 'chat.completion', created: 0, model: 'mock', choices: [{ index: 0, message: { role: 'assistant', content: 'ready' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    }
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/v1`;

function clean(extra) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/_API_KEY$|^OX_|^HERMES_|^OPENAI_|^OPENROUTER_/.test(k)));
  return { ...env, NO_COLOR: '1', ...extra };
}

const agents = {
  ox: (home, ws) => ({
    cmd: process.execPath, args: [OX, '-p', PROMPT], cwd: ws,
    env: clean({ HOME: home, OX_ISLAND: '0', OX_NO_PLUGINS: '1', OX_BOT: 'custom', OX_MODEL: 'mock', OX_BASE_URL: base, OX_API_KEY: 'x' }),
  }),
  hermes: (home, ws) => ({
    cmd: 'hermes', args: ['-z', PROMPT, '--provider', 'openai', '-m', 'mock', '--ignore-user-config', '--ignore-rules'], cwd: ws,
    env: clean({ HOME: home, HERMES_HOME: path.join(home, '.hermes'), OPENAI_BASE_URL: base, OPENAI_API_KEY: 'x' }),
  }),
};

function runOnce(name) {
  // WARM=1 reuses one home per agent, so first-run setup is paid once (run 1)
  // and runs 2..N measure the steady state.
  homes[name] ??= fs.mkdtempSync(path.join(os.tmpdir(), `cmp-${name}-`));
  const home = process.env.WARM ? homes[name] : fs.mkdtempSync(path.join(os.tmpdir(), `cmp-${name}-`));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), `cmp-ws-${name}-`));
  fs.writeFileSync(path.join(ws, 'README.md'), '# demo project\n');
  const spec = agents[name](home, ws);
  requests = [];
  const t0 = Date.now();
  return new Promise((resolve) => {
    const p = spawn(spec.cmd, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    const kill = setTimeout(() => p.kill('SIGKILL'), 180_000);
    p.on('close', (code) => {
      clearTimeout(kill);
      const first = [...requests].sort((a, b) => b.bytes - a.bytes)[0];
      const startup = requests.find((q) => q.json?.messages);
      const sys = (first?.json?.messages ?? []).filter((m) => m.role === 'system').map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
      const tools = first?.json?.tools ?? [];
      resolve({
        name, code, wallMs: Date.now() - t0, firstRequestMs: startup ? startup.at - t0 : null, totalBytes: requests.reduce((n, q) => n + q.bytes, 0),
        requests: requests.length, firstBytes: first?.bytes ?? 0,
        systemChars: sys.length, tools: tools.length, toolBytes: Buffer.byteLength(JSON.stringify(tools)),
        answered: /ready/i.test(out), tail: out.trim().split('\n').slice(-2).join(' | ').slice(0, 160),
      });
    });
  });
}

const rows = [];
for (let i = 0; i < RUNS; i++) for (const name of Object.keys(agents)) rows.push(await runOnce(name));
server.close();
const med = (xs) => { const s = xs.filter((x) => x != null).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
for (const name of Object.keys(agents)) {
  const r = rows.filter((x) => x.name === name);
  const last = r.at(-1);
  console.log(JSON.stringify({
    agent: name,
    runs: r.length,
    exitCodes: r.map((x) => x.code),
    answeredAll: r.every((x) => x.answered),
    medianStartupToFirstRequestMs: med(r.map((x) => x.firstRequestMs)),
    medianWallMs: med(r.map((x) => x.wallMs)),
    requestsPerAnswer: last.requests,
    largestRequestBytes: last.firstBytes,
    bytesAllRequests: last.totalBytes,
    estTokensPerRequest: Math.round(last.firstBytes / 4),
    systemPromptChars: last.systemChars,
    toolsOffered: last.tools,
    toolSchemaBytes: last.toolBytes,
    tail: last.tail,
  }));
}
