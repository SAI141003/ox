// Bring-your-own-subscription: `--bot <vendor>-plan` runs the vendor's own CLI
// in the project and turns its stream into ox output. Stand-in CLIs emit each
// vendor's real stream format and record the flags they were given.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { subscriptionTarget, foldPrompt, parseLine, checkCli, findOnPath, execPlan } from '../src/subscriptions.js';

const OX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ox.js');
const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-sub-bin-'));
const argsLog = path.join(bin, 'args.json');

function fakeCli(name, body) {
  const p = path.join(bin, name);
  fs.writeFileSync(p, `#!${process.execPath}\nconst a = process.argv.slice(2);\nif (a[0] === '--version') { console.log('${name} 9.9.9'); process.exit(0); }\nrequire('fs').writeFileSync(${JSON.stringify(argsLog)}, JSON.stringify({ name: '${name}', a, cwd: process.cwd() }));\n${body}\n`);
  fs.chmodSync(p, 0o755);
}
const out = (o) => `console.log(${JSON.stringify(JSON.stringify(o))});`;

fakeCli('claude', [
  out({ type: 'system', subtype: 'init', model: 'claude-opus' }),
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'notes.txt' } }] } }),
  out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'the secret word is pineapple' }] } }),
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'The word is pineapple.' }] } }),
  out({ type: 'result', subtype: 'success', is_error: false, result: 'The word is pineapple.', total_cost_usd: 0.004, usage: { input_tokens: 900, output_tokens: 12 } }),
].join('\n'));
fakeCli('codex', [
  out({ type: 'thread.started', thread_id: 'x' }),
  out({ type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'cat notes.txt', status: 'in_progress' } }),
  out({ type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: 'cat notes.txt', aggregated_output: 'pineapple', exit_code: 0 } }),
  out({ type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: 'Codex says pineapple.' } }),
  out({ type: 'turn.completed', usage: { input_tokens: 50, output_tokens: 5 } }),
].join('\n'));
fakeCli('qwen', `process.stdout.write('plain answer from qwen\\n');`);
fakeCli('kimi', `process.stderr.write('Error: not logged in, run /setup\\n'); process.exit(1);`);

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-sub-home-'));
const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ox-sub-proj-')));
fs.writeFileSync(path.join(cwd, 'notes.txt'), 'the secret word is pineapple\n');
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/_API_KEY$|^OX_/.test(k)));
Object.assign(env, { HOME: home, OX_ISLAND: '0', NO_COLOR: '1', OX_NO_PLUGINS: '1', PATH: `${bin}${path.delimiter}${process.env.PATH}` });
const ox = (...a) => {
  const r = spawnSync(process.execPath, [OX, ...a], { cwd, env, encoding: 'utf8', timeout: 60_000 });
  return { code: r.status, out: r.stdout + r.stderr };
};
const lastArgs = () => JSON.parse(fs.readFileSync(argsLog, 'utf8'));

test('plan bots resolve; unknown ones do not', () => {
  assert.equal(subscriptionTarget('claude-plan').subscription, 'claude');
  assert.equal(subscriptionTarget('chatgpt-plan:gpt-5').model, 'gpt-5');
  assert.equal(subscriptionTarget('nothing-plan'), null);
  assert.equal(subscriptionTarget('claude'), null);
  const custom = { subscriptions: { mine: { bin: 'mycli', args: ['ask', '{prompt}'] } } };
  assert.equal(subscriptionTarget('mine-plan', custom).subscription, 'mine');
});

test('earlier turns ride along in the folded prompt', () => {
  assert.equal(foldPrompt([{ role: 'user', content: 'hi' }]), 'hi');
  const f = foldPrompt([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }]);
  assert.match(f, /User: a\n\nAssistant: b/);
  assert.ok(f.endsWith('c'));
  assert.deepEqual(parseLine('claude-stream', 'not json', { text: '', tools: new Map() }), []);
});

test('claude-plan: Claude Code runs in the project, its tools and answer stream back', () => {
  const r = ox('--bot', 'claude-plan', '-p', 'what is the secret word?');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /The word is pineapple\./);
  assert.match(r.out, /Read/);
  const { a, cwd: ran } = lastArgs();
  assert.equal(ran, cwd);
  assert.deepEqual(a.slice(0, 4), ['-p', 'what is the secret word?', '--output-format', 'stream-json']);
  assert.equal(a[a.indexOf('--permission-mode') + 1], 'default', 'no -y: the CLI keeps its own approvals');
});

test('ox approvals map onto the vendor CLI: -y, and ask mode is read-only', () => {
  ox('--bot', 'claude-plan', '-y', '-p', 'go');
  let { a } = lastArgs();
  assert.equal(a[a.indexOf('--permission-mode') + 1], 'bypassPermissions');
  ox('--bot', 'claude-plan', '-y', '--mode', 'ask', '-p', 'go');
  ({ a } = lastArgs());
  assert.equal(a[a.indexOf('--permission-mode') + 1], 'plan', 'ask mode wins over -y');
  ox('--bot', 'chatgpt-plan:gpt-5', '--mode', 'ask', '-p', 'go');
  ({ a } = lastArgs());
  assert.equal(a[a.indexOf('--sandbox') + 1], 'read-only');
  assert.equal(a[a.indexOf('--model') + 1], 'gpt-5');
});

test('chatgpt-plan: Codex events become ox output', () => {
  const r = ox('--bot', 'chatgpt-plan', '-p', 'read notes');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Codex says pineapple\./);
  assert.match(r.out, /shell/);
});

test('a text CLI streams verbatim; a failing one says why, not "done"', () => {
  const ok = ox('--bot', 'qwen-plan', '-p', 'hi');
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /plain answer from qwen/);
  const bad = ox('--bot', 'kimi-plan', '-p', 'hi');
  assert.notEqual(bad.code, 0, bad.out);
  assert.match(bad.out, /kimi-plan \(kimi\): Error: not logged in, run \/setup/);
});

test('Windows: claude.cmd is found, and run through node, never through cmd.exe', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-win-'));
  // The shim npm writes for a global install (cmd-shim), trimmed to its last line.
  fs.writeFileSync(path.join(dir, 'claude.cmd'), '@ECHO off\r\nSETLOCAL\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n');
  fs.writeFileSync(path.join(dir, 'weird.bat'), '@echo off\r\nsomething.exe %*\r\n');
  const found = findOnPath('claude', { PATH: dir, PATHEXT: '.EXE;.CMD' }, 'win32');
  assert.equal(found, path.join(dir, 'claude.cmd'));
  const plan = execPlan(found, 'win32');
  assert.equal(plan.cmd, process.execPath);
  assert.ok(plan.pre[0].endsWith('node_modules\\@anthropic-ai\\claude-code\\cli.js'));
  assert.match(execPlan(path.join(dir, 'weird.bat'), 'win32').error, /cannot run safely/);
  assert.deepEqual(execPlan('/usr/local/bin/claude', 'darwin'), { cmd: '/usr/local/bin/claude', pre: [] });
});

test('ox connect reports what runs here, and a missing CLI explains how to get it', () => {
  const r = ox('connect');
  assert.match(r.out, /● claude-plan/);
  assert.match(r.out, /● chatgpt-plan/);
  const missing = checkCli('gemini', {}, { PATH: bin });
  assert.equal(missing.installed, false);
  assert.match(missing.fix, /@google\/gemini-cli/);
  const none = ox('--bot', 'gemini-plan', '-p', 'hi');
  assert.notEqual(none.code, 0);
});
