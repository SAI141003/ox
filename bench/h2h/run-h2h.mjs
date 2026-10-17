// Head-to-head: ox against other coding agents on the nine real tasks of
// bench/real, with THE SAME MODEL for every agent, so what differs is the
// harness and nothing else.
//
//   node bench/h2h/run-h2h.mjs --model qwen2.5:3b-32k [--agents ox,hermes,codex,claude]
//                              [--filter <regex>] [--repeats n] [--json out.json]
//
// - Every agent talks to Ollama through a counting proxy started here, so the
//   requests, bytes and tokens each one spends are measured the same way
//   (usage as Ollama reports it; bytes/4 where a stream carries none).
// - Every agent runs in a fresh sandbox with its own empty HOME / config dir:
//   nobody's real login, memory or settings are read or touched.
// - Pass/fail is bench/real's verify(): real processes in the workspace the
//   agent left behind. Transcripts are never graded.
// - An agent that is not installed is reported as such, never scored.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REAL_TASKS } from '../real/tasks.mjs';
import { createSandbox, destroySandbox } from '../real/lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OLLAMA = process.env.H2H_OLLAMA ?? 'http://127.0.0.1:11434';

function argOf(argv, name, dflt = null) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; }

function which(cmd) {
  const r = spawnSync('/bin/sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}
function firstExisting(list) { return list.find((p) => p && fs.existsSync(p)) ?? null; }
function vscodeBinary(prefix, rel) {
  const dir = path.join(os.homedir(), '.vscode', 'extensions');
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.startsWith(prefix)).sort().reverse(); } catch {}
  return firstExisting(names.map((n) => path.join(dir, n, rel)));
}

// ------------------------------------------------------------ counting proxy
function startProxy() {
  const stats = new Map(); // tag -> { requests, bytesOut, tokensIn, tokensOut, estIn }
  let tag = 'none';
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = Buffer.concat(chunks);
      const s = stats.get(tag) ?? { requests: 0, bytesOut: 0, tokensIn: 0, tokensOut: 0, estIn: 0, withUsage: 0 };
      stats.set(tag, s);
      const isModelCall = req.method === 'POST' && /\/(chat\/completions|responses|messages|api\/chat|api\/generate)\b/.test(req.url);
      if (isModelCall) {
        s.requests++; s.bytesOut += body.length; s.estIn += Math.round(body.length / 4);
        // Ask for usage in a chat stream, so tokens are counted, not guessed.
        if (/chat\/completions/.test(req.url)) {
          try { const j = JSON.parse(body); if (j.stream) { j.stream_options = { ...(j.stream_options ?? {}), include_usage: true }; body = Buffer.from(JSON.stringify(j)); } } catch {}
        }
      }
      const u = new URL(req.url, OLLAMA);
      const headers = { ...req.headers, host: u.host, 'content-length': String(body.length) };
      const up = http.request(u, { method: req.method, headers }, (ur) => {
        res.writeHead(ur.statusCode, ur.headers);
        let text = '';
        ur.on('data', (c) => { res.write(c); if (isModelCall && text.length < 4e6) text += c; });
        ur.on('end', () => {
          res.end();
          if (!isModelCall) return;
          const num = (re) => { let m, best = 0; const r = new RegExp(re, 'g'); while ((m = r.exec(text))) best = Math.max(best, Number(m[1])); return best; };
          const tin = Math.max(num('"prompt_tokens":\\s*(\\d+)'), num('"input_tokens":\\s*(\\d+)'), num('"prompt_eval_count":\\s*(\\d+)'));
          const tout = Math.max(num('"completion_tokens":\\s*(\\d+)'), num('"output_tokens":\\s*(\\d+)'), num('"eval_count":\\s*(\\d+)'));
          if (tin) { s.tokensIn += tin; s.withUsage++; } else s.tokensIn += Math.round(body.length / 4);
          s.tokensOut += tout;
        });
      });
      // An upstream error after the answer began (a client gone): end it, never rewrite headers.
      up.on('error', (e) => { if (!res.headersSent) res.writeHead(502); res.end(String(e)); });
      up.end(body);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    port: server.address().port, stats, setTag: (t) => { tag = t; }, close: () => server.close(),
  })));
}

// ------------------------------------------------------------ agents
const baseEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/_API_KEY$|^OX_|^HERMES_|^OPENAI_|^ANTHROPIC_|^CODEX_|^CLAUDE_|^OPENROUTER_/.test(k)));

const AGENTS = {
  ox: {
    bin: () => path.join(ROOT, 'bin', 'ox.js'),
    cmd: (bin, { prompt, model, port, home }) => ({
      cmd: process.execPath, args: [bin, '-p', prompt, '--model', `ox-ollama:${model}`, '-y'],
      env: { ...baseEnv(), HOME: home, OX_OLLAMA_BASE_URL: `http://127.0.0.1:${port}/v1`, OX_ISLAND: '0', OX_LEARN: '0', OX_USAGE_LOG: '0', OX_NO_KEYSTORE: '1', OX_NO_FALLBACK: '1' },
    }),
  },
  hermes: {
    bin: () => which('hermes'),
    cmd: (bin, { prompt, model, port, home }) => ({
      cmd: bin, args: ['-z', prompt, '--provider', 'openai', '-m', model, '--ignore-user-config', '--ignore-rules', '--yolo'],
      env: { ...baseEnv(), HOME: home, HERMES_HOME: path.join(home, '.hermes'), OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`, OPENAI_API_KEY: 'ollama' },
    }),
  },
  codex: {
    // The editor's copy: the Homebrew one on this Mac is missing its binary.
    bin: () => vscodeBinary('openai.chatgpt-', 'bin/macos-aarch64/codex') ?? which('codex'),
    cmd: (bin, { prompt, model, port, home }) => ({
      cmd: bin, args: ['exec', '--skip-git-repo-check', '-s', 'workspace-write', '-c', 'approval_policy="never"',
        '-c', 'model_provider="h2h"', '-c', 'model_providers.h2h.name="h2h"', '-c', `model_providers.h2h.base_url="http://127.0.0.1:${port}/v1"`,
        '-c', 'model_providers.h2h.wire_api="responses"', '-m', model, prompt],
      env: { ...baseEnv(), HOME: home, CODEX_HOME: path.join(home, '.codex') },
    }),
  },
  claude: {
    bin: () => vscodeBinary('anthropic.claude-code-', 'resources/native-binary/claude') ?? which('claude'),
    cmd: (bin, { prompt, model, port, home }) => ({
      cmd: bin, args: ['-p', prompt, '--model', model, '--dangerously-skip-permissions'],
      env: { ...baseEnv(), HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_AUTH_TOKEN: 'ollama', ANTHROPIC_API_KEY: '', DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
    }),
  },
};

function runAgent({ cmd, args, env }, cwd, timeoutMs) {
  // Config folders an agent expects to exist (Codex refuses a missing CODEX_HOME).
  for (const k of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'HERMES_HOME']) if (env[k]) fs.mkdirSync(env[k], { recursive: true });
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', timedOut = false;
    child.stdout.on('data', (c) => { if (out.length < 2e6) out += c; });
    child.stderr.on('data', (c) => { if (err.length < 2e5) err += c; });
    const t = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(t); resolve({ exitCode: null, out, err: String(e), timedOut, ms: Date.now() - started }); });
    child.on('close', (code) => { clearTimeout(t); resolve({ exitCode: code, out, err, timedOut, ms: Date.now() - started }); });
  });
}

export async function main(argv = process.argv.slice(2)) {
  const model = argOf(argv, '--model');
  if (!model) { console.error('--model is required (an Ollama model, e.g. qwen2.5:3b-32k)'); process.exit(2); }
  const names = (argOf(argv, '--agents', 'ox,hermes,codex,claude')).split(',');
  const filter = argOf(argv, '--filter');
  const repeats = Number(argOf(argv, '--repeats', '1'));
  const timeoutMs = Number(argOf(argv, '--timeout', '420000'));
  const tasks = REAL_TASKS.filter((t) => !filter || new RegExp(filter).test(t.id));
  const proxy = await startProxy();
  const rows = [];
  for (const name of names) {
    const a = AGENTS[name];
    const bin = a?.bin();
    if (!bin) { rows.push({ agent: name, status: 'NOT INSTALLED' }); console.log(`${name}: not installed, not scored`); continue; }
    for (const task of tasks) {
      for (let r = 0; r < repeats; r++) {
        const sb = createSandbox(`h2h-${name}-${task.id}`);
        const tag = `${name}|${task.id}|${r}`;
        proxy.setTag(tag);
        let verdict = { pass: false, detail: 'did not run' };
        let run = null;
        try {
          await task.setup(sb.ws);
          run = await runAgent(a.cmd(bin, { prompt: task.prompt, model, port: proxy.port, home: sb.home }), sb.ws, timeoutMs);
          verdict = await task.verify({ ws: sb.ws, sandbox: sb, task, events: [], summary: null, exitCode: run.exitCode, timedOut: run.timedOut, args: [] });
        } catch (e) { verdict = { pass: false, detail: `harness: ${e?.message ?? e}` }; }
        destroySandbox(sb);
        const s = proxy.stats.get(tag) ?? { requests: 0, bytesOut: 0, tokensIn: 0, tokensOut: 0, withUsage: 0 };
        const row = { agent: name, task: task.id, repeat: r, pass: !!verdict.pass, ms: run?.ms ?? 0, timedOut: !!run?.timedOut, exitCode: run?.exitCode ?? null,
          requests: s.requests, bytesOut: s.bytesOut, tokensIn: s.tokensIn, tokensOut: s.tokensOut, usageReported: s.withUsage,
          detail: String(verdict.detail ?? '').slice(0, 200), stderr: String(run?.err ?? '').trim().split('\n').slice(-2).join(' | ').slice(0, 200) };
        rows.push(row);
        console.log(`${name.padEnd(7)} ${task.id.padEnd(26)} ${row.pass ? 'PASS' : 'FAIL'} ${String(Math.round(row.ms / 1000)).padStart(4)}s  req ${String(row.requests).padStart(3)}  in ${String(row.tokensIn).padStart(7)}  out ${String(row.tokensOut).padStart(6)}${row.pass ? '' : `  ${row.timedOut ? 'TIMEOUT ' : ''}${row.detail.slice(0, 90)}`}${row.requests === 0 ? `\n        never reached the model (exit ${row.exitCode}): ${row.stderr || String(run?.out ?? '').trim().split('\n').slice(-2).join(' | ').slice(0, 200)}` : ''}`);
      }
    }
  }
  proxy.close();
  // Totals per agent.
  console.log('\nagent    pass        time    requests  tokens in  tokens out');
  for (const name of names) {
    const rs = rows.filter((r) => r.agent === name && r.task);
    if (!rs.length) { console.log(`${name.padEnd(8)} not installed`); continue; }
    const sum = (k) => rs.reduce((n, r) => n + (r[k] ?? 0), 0);
    console.log(`${name.padEnd(8)} ${`${rs.filter((r) => r.pass).length}/${rs.length}`.padEnd(10)} ${`${Math.round(sum('ms') / 1000)}s`.padStart(6)}  ${String(sum('requests')).padStart(8)}  ${String(sum('tokensIn')).padStart(9)}  ${String(sum('tokensOut')).padStart(10)}`);
  }
  const out = argOf(argv, '--json');
  if (out) fs.writeFileSync(out, JSON.stringify({ date: new Date().toISOString(), model, platform: `${process.platform}/${process.arch}`, rows }, null, 2));
  return rows;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
