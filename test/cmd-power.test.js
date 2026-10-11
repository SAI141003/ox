import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { handlePowerCommand, listPowerCommands } from '../src/cmd-power.js';

// ---------------------------------------------------------------------------
// listPowerCommands: the 9 playbook power-user commands
// ---------------------------------------------------------------------------

test('listPowerCommands: contains the 9 expected power commands', () => {
  const cmds = listPowerCommands().sort();
  assert.deepEqual(cmds, ['commit', 'doc', 'explain', 'fix', 'init', 'migrate', 'refactor', 'review', 'test']);
});

// ---------------------------------------------------------------------------
// handlePowerCommand: returns proper result shape
// ---------------------------------------------------------------------------

test('handlePowerCommand: returns error for unknown command', async () => {
  const r = await handlePowerCommand('nonexistent', '', { cwd: process.cwd() });
  assert.equal(r.type, 'error');
  assert.match(r.payload, /unknown power command/);
});

test('handlePowerCommand: /init returns an injected prompt in any cwd', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'power-'));
  const r = await handlePowerCommand('init', '', { cwd: tmp });
  assert.equal(r.type, 'injected');
  assert.match(r.payload, /Analyze this project/);
  fs.rmSync(tmp, { recursive: true });
});

test('handlePowerCommand: /commit errors outside a git repo', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'power-'));
  const r = await handlePowerCommand('commit', '', { cwd: tmp });
  assert.equal(r.type, 'error');
  assert.match(r.payload, /not in a git repository/);
  fs.rmSync(tmp, { recursive: true });
});

test('handlePowerCommand: /review errors outside a git repo', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'power-'));
  const r = await handlePowerCommand('review', '', { cwd: tmp });
  assert.equal(r.type, 'error');
  assert.match(r.payload, /not in a git repository/);
  fs.rmSync(tmp, { recursive: true });
});

test('handlePowerCommand: /test with no path asks which file', async () => {
  const r = await handlePowerCommand('test', '', { cwd: process.cwd() });
  assert.equal(r.type, 'injected');
  assert.match(r.payload, /which file/);
});

test('handlePowerCommand: /test with a non-existent path returns error', async () => {
  const r = await handlePowerCommand('test', '/this/does/not/exist.js', { cwd: process.cwd() });
  assert.equal(r.type, 'error');
  assert.match(r.payload, /not found/);
});

test('handlePowerCommand: /test with a real file returns an injected prompt containing the file content', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'power-'));
  const file = path.join(tmp, 'sample.js');
  fs.writeFileSync(file, 'export function add(a, b) { return a + b; }');
  const r = await handlePowerCommand('test', file, { cwd: tmp });
  assert.equal(r.type, 'injected');
  assert.match(r.payload, /Generate tests/);
  assert.match(r.payload, /sample\.js/);
  assert.match(r.payload, /export function add/);
  fs.rmSync(tmp, { recursive: true });
});

test('handlePowerCommand: /explain with a real file works', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'power-'));
  const file = path.join(tmp, 'thing.ts');
  fs.writeFileSync(file, 'export const x: number = 42;');
  const r = await handlePowerCommand('explain', file, { cwd: tmp });
  assert.equal(r.type, 'injected');
  assert.match(r.payload, /Explain this code/);
  assert.match(r.payload, /thing\.ts/);
  fs.rmSync(tmp, { recursive: true });
});

test('handlePowerCommand: /refactor with a real file works', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'power-'));
  const file = path.join(tmp, 'messy.js');
  fs.writeFileSync(file, 'function f(x){if(x>0){return x}else{return -x}}');
  const r = await handlePowerCommand('refactor', file, { cwd: tmp });
  assert.equal(r.type, 'injected');
  assert.match(r.payload, /Suggest refactorings/);
  assert.match(r.payload, /messy\.js/);
  fs.rmSync(tmp, { recursive: true });
});

test('handlePowerCommand: /doc with a real file works', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'power-'));
  const file = path.join(tmp, 'lib.js');
  fs.writeFileSync(file, 'export function hello() { return "hi"; }');
  const r = await handlePowerCommand('doc', file, { cwd: tmp });
  assert.equal(r.type, 'injected');
  assert.match(r.payload, /JSDoc|docstrings/);
  assert.match(r.payload, /lib\.js/);
  fs.rmSync(tmp, { recursive: true });
});

test('handlePowerCommand: /fix with no linter detected returns error', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'power-'));
  const r = await handlePowerCommand('fix', '', { cwd: tmp });
  assert.equal(r.type, 'error');
  assert.match(r.payload, /no supported linter/);
  fs.rmSync(tmp, { recursive: true });
});

test('handlePowerCommand: /migrate with no description asks for one', async () => {
  const r = await handlePowerCommand('migrate', '', { cwd: process.cwd() });
  assert.equal(r.type, 'injected');
  assert.match(r.payload, /Describe the migration/);
});

test('handlePowerCommand: /migrate with a description returns an injected plan prompt', async () => {
  const r = await handlePowerCommand('migrate', 'convert require() to import', { cwd: process.cwd() });
  assert.equal(r.type, 'injected');
  assert.match(r.payload, /convert require\(\) to import/);
  assert.match(r.payload, /Plan and execute/);
});
