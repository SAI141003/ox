// ox arena: two models on the same task in separate worktrees; the one whose
// change passes --test wins, and --apply lands only its change.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rankEntries, parseArenaArgs } from '../src/arena.js';

const OX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ox.js');

test('ranking: tests pass, then success, then the smaller change, then cost', () => {
  const r = rankEntries([
    { bot: 'big-pass', test: true, ok: true, changedLines: 90, costUsd: 0.01 },
    { bot: 'fail', test: false, ok: true, changedLines: 2, costUsd: 0.001 },
    { bot: 'small-pass', test: true, ok: true, changedLines: 4, costUsd: 0.05 },
    { bot: 'crashed', test: null, ok: false, changedLines: 0, costUsd: null },
  ]);
  assert.deepEqual(r.map((e) => e.bot), ['small-pass', 'big-pass', 'fail', 'crashed']);
  assert.deepEqual(parseArenaArgs(['fix', 'it', '--bots', 'a, b', '--test', 'npm test', '--apply']),
    { task: 'fix it', bots: ['a', 'b'], test: 'npm test', maxCost: null, apply: true, timeoutMs: 900000 });
});

// A provider that answers as two different models: m1 writes the right value, m2 a wrong one.
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    let j = {};
    try { j = JSON.parse(body); } catch {}
    const done = (j.messages ?? []).some((m) => m.role === 'tool');
    const value = j.model === 'm1' ? 'answer=42' : 'answer=7';
    const sse = (o) => `data: ${JSON.stringify(o)}\n\n`;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (done) {
      res.end(sse({ choices: [{ index: 0, delta: { content: 'done' }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n');
    } else {
      const call = { index: 0, id: 'c1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'result.txt', content: `${value}\n` }) } };
      res.end(sse({ choices: [{ index: 0, delta: { tool_calls: [call] }, finish_reason: 'tool_calls' }] }) + 'data: [DONE]\n\n');
    }
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
after(() => server.close());

test('two models race; the one that passes the test wins and --apply lands only its change', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-arena-home-'));
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ox-arena-repo-')));
  const g = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' });
  g('init', '-q');
  fs.writeFileSync(path.join(repo, 'README.md'), '# demo\n');
  g('add', '-A');
  g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/_API_KEY$|^OX_/.test(k)));
  Object.assign(env, { HOME: home, OX_ISLAND: '0', NO_COLOR: '1', OX_NO_PLUGINS: '1', OX_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`, OX_API_KEY: 'x' });
  // Async: the mock provider lives in this process, so a blocking spawn would deadlock it.
  const r = await new Promise((resolve) => {
    const p = spawn(process.execPath, [OX, 'arena', 'write the answer to result.txt', '--bots', 'custom:m2,custom:m1', '--test', 'grep -q "answer=42" result.txt', '--apply'], { cwd: repo, env });
    let stdout = '', stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('close', (status) => resolve({ status, stdout, stderr }));
  });
  const out = r.stdout + r.stderr;
  assert.equal(r.status, 0, out);
  assert.match(out, /★ 1\. custom:m1\s+ok tests pass/, out);
  assert.match(out, /2\. custom:m2\s+ok tests fail/, out);
  assert.match(out, /applied custom:m1's change/);
  assert.equal(fs.readFileSync(path.join(repo, 'result.txt'), 'utf8'), 'answer=42\n', 'only the winner landed');
  const worktrees = execFileSync('git', ['worktree', 'list'], { cwd: repo, encoding: 'utf8' }).trim().split('\n');
  assert.equal(worktrees.length, 1, 'arena worktrees are cleaned up');
});
