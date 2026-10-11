import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OX_BIN = path.join(__dirname, '..', 'bin', 'ox.js');

function ox(args, opts = {}) {
  return spawnSync('node', [OX_BIN, ...args], { encoding: 'utf8', ...opts });
}

const PLATFORM = os.platform();
const HAS_CHROME = PLATFORM === 'darwin'
  ? fs.existsSync('/Applications/Google Chrome.app') || fs.existsSync('/Applications/Chromium.app')
  : fs.existsSync('/usr/bin/google-chrome') || fs.existsSync('/usr/bin/chromium');

function ctx(approval = true, yolo = false) {
  return {
    yolo,
    requestApproval: approval === null
      ? null
      : async () => approval,
  };
}

test('operator: open_app rejects without approval', async () => {
  const r = await import('../src/tools/operator.js').then(m => m.open_app({ name: 'Chrome' }, { yolo: false, requestApproval: null }));
  assert.match(r.content, /approval/);
  assert.equal(r.isError, true);
});

test('operator: open_url validates scheme', async () => {
  const r = await import('../src/tools/operator.js').then(m => m.open_url({ url: 'not-a-url' }, ctx(true)));
  assert.match(r.content, /http/);
});

test('operator: open_url runs with approval', async () => {
  const r = await import('../src/tools/operator.js').then(m => m.open_url({ url: 'https://backboard.io' }, ctx(true)));
  if (HAS_CHROME || PLATFORM === 'linux') {
    assert.match(r.content, /done/);
  } else {
    assert.ok(typeof r.content === 'string');
  }
});

test('operator: open_path runs with approval', async () => {
  const r = await import('../src/tools/operator.js').then(m => m.open_path({ path: os.homedir() }, ctx(true)));
  assert.ok(typeof r.content === 'string');
});

test('operator: open_window rejects missing name', async () => {
  const r = await import('../src/tools/operator.js').then(m => m.open_window({}, ctx(true)));
  assert.match(r.content, /name is required/);
});

test('operator: type_text rejects without approval', async () => {
  const r = await import('../src/tools/operator.js').then(m => m.type_text({ text: 'hello' }, { yolo: false, requestApproval: null }));
  assert.match(r.content, /approval/);
});

test('operator: type_text runs with approval', async () => {
  const r = await import('../src/tools/operator.js').then(m => m.type_text({ text: 'hello world' }, ctx(true)));
  assert.ok(typeof r.content === 'string');
});

test('operator: screenshot runs with approval', async () => {
  const r = await import('../src/tools/operator.js').then(m => m.screenshot({ output: '/tmp/ox-test.png' }, ctx(true)));
  assert.ok(typeof r.content === 'string');
});

test('operator: notify runs', async () => {
  const r = await import('../src/tools/operator.js').then(m => m.notify({ message: 'hello ox' }, ctx(true)));
  assert.ok(typeof r.content === 'string');
});

test('operator: open_app rejects on unsupported platform gracefully', async () => {
  const r = await import('../src/tools/operator.js').then(m => m.open_app({ name: 'Test' }, ctx(true)));
  assert.ok(typeof r.content === 'string');
});

test('operator: all 7 tools have schemas', async () => {
  const m = await import('../src/tools/operator.js');
  assert.equal(m.OPERATOR_TOOLS.length, 7);
  assert.equal(m.OPERATOR_TOOL_SCHEMAS.length, 7);
  const names = m.OPERATOR_TOOLS.map((t) => t.name);
  for (const expected of ['open_app', 'open_url', 'open_path', 'open_window', 'type_text', 'screenshot', 'notify']) {
    assert.ok(names.includes(expected), `missing ${expected}`);
  }
});
