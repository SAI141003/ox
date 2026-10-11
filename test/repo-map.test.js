import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  buildRepoMap,
  renderRepoMap,
  findRelevantFiles,
  getRelevantSnippets,
  ContextBudget,
} from '../src/repo-map.js';

function tmpCwd() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'repo-map-'));
}
function rm(cwd) { try { fs.rmSync(cwd, { recursive: true }); } catch {} }

function setupRepo() {
  const cwd = tmpCwd();
  fs.writeFileSync(path.join(cwd, 'index.js'), `
export function hello(name) { return 'hi ' + name; }
export const world = 42;
`);
  fs.writeFileSync(path.join(cwd, 'utils.js'), `
export class Calculator {
  add(a, b) { return a + b; }
}
function helper(x) { return x; }
`);
  fs.mkdirSync(path.join(cwd, 'lib'));
  fs.writeFileSync(path.join(cwd, 'lib', 'parser.js'), `
export function parse(str) { return JSON.parse(str); }
export const VERSION = '1.0';
`);
  fs.writeFileSync(path.join(cwd, 'README.md'), '# Test repo\nThis is a test.');
  return cwd;
}

test('buildRepoMap: finds files in a small repo', async () => {
  const cwd = setupRepo();
  const map = await buildRepoMap({ cwd });
  assert.ok(map.files.length >= 4);
  const names = map.files.map((f) => f.path);
  assert.ok(names.includes('index.js'));
  assert.ok(names.includes('lib/parser.js'));
  rm(cwd);
});

test('buildRepoMap: extracts exports from JS files', async () => {
  const cwd = setupRepo();
  const map = await buildRepoMap({ cwd });
  assert.ok(map.exports['index.js']);
  assert.ok(map.exports['index.js'].some((e) => e.includes('hello')));
  rm(cwd);
});

test('buildRepoMap: skips node_modules and .git', async () => {
  const cwd = setupRepo();
  fs.mkdirSync(path.join(cwd, 'node_modules'));
  fs.writeFileSync(path.join(cwd, 'node_modules', 'foo.js'), 'export const x = 1;');
  fs.mkdirSync(path.join(cwd, '.git'));
  fs.writeFileSync(path.join(cwd, '.git', 'config'), 'foo');
  const map = await buildRepoMap({ cwd });
  const names = map.files.map((f) => f.path);
  assert.ok(!names.some((n) => n.includes('node_modules')));
  assert.ok(!names.some((n) => n.includes('.git')));
  rm(cwd);
});

test('buildRepoMap: stats include file count and line count', async () => {
  const cwd = setupRepo();
  const map = await buildRepoMap({ cwd });
  assert.ok(map.stats.totalFiles >= 4);
  assert.ok(map.stats.totalLines > 0);
  assert.ok(map.stats.duration >= 0);
  rm(cwd);
});

test('buildRepoMap: respects maxDepth', async () => {
  const cwd = setupRepo();
  fs.mkdirSync(path.join(cwd, 'a', 'b', 'c', 'd'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'a', 'b', 'c', 'd', 'deep.js'), 'export const x = 1;');
  const map = await buildRepoMap({ cwd, maxDepth: 1 });
  const names = map.files.map((f) => f.path);
  assert.ok(!names.some((n) => n.includes('deep.js')));
  rm(cwd);
});

test('renderRepoMap: includes root and file count', async () => {
  const cwd = setupRepo();
  const map = await buildRepoMap({ cwd });
  const out = renderRepoMap(map);
  assert.match(out, new RegExp(cwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(out, /Files:/);
});

test('renderRepoMap: shows extension breakdown', async () => {
  const cwd = setupRepo();
  const map = await buildRepoMap({ cwd });
  const out = renderRepoMap(map);
  assert.match(out, /\.js/);
});

test('renderRepoMap: shows exports for JS files', async () => {
  const cwd = setupRepo();
  const map = await buildRepoMap({ cwd });
  const out = renderRepoMap(map);
  assert.match(out, /Exports:/);
  assert.match(out, /hello/);
});

test('renderRepoMap: respects maxLines', async () => {
  const cwd = setupRepo();
  const map = await buildRepoMap({ cwd });
  const out = renderRepoMap(map, { maxLines: 3 });
  const lines = out.split('\n');
  assert.ok(lines.length < 30);
});

test('findRelevantFiles: matches filename exactly', async () => {
  const cwd = setupRepo();
  const map = await buildRepoMap({ cwd });
  const r = findRelevantFiles(map, 'parser');
  assert.ok(r.length > 0);
  assert.equal(r[0].path, 'lib/parser.js');
  rm(cwd);
});

test('findRelevantFiles: matches filename partially', async () => {
  const cwd = setupRepo();
  const map = await buildRepoMap({ cwd });
  const r = findRelevantFiles(map, 'util');
  assert.ok(r.some((m) => m.path.includes('utils')));
  rm(cwd);
});

test('findRelevantFiles: returns empty for no matches', async () => {
  const cwd = setupRepo();
  const map = await buildRepoMap({ cwd });
  const r = findRelevantFiles(map, 'xyzzyqwerty');
  assert.equal(r.length, 0);
  rm(cwd);
});

test('findRelevantFiles: ranks by score', async () => {
  const cwd = setupRepo();
  const map = await buildRepoMap({ cwd });
  const r = findRelevantFiles(map, 'parser parse');
  assert.ok(r.length > 0);
  for (let i = 1; i < r.length; i++) {
    assert.ok(r[i - 1].score >= r[i].score);
  }
  rm(cwd);
});

test('findRelevantFiles: respects limit', async () => {
  const cwd = setupRepo();
  const map = await buildRepoMap({ cwd });
  const r = findRelevantFiles(map, 'a', { limit: 2 });
  assert.ok(r.length <= 2);
  rm(cwd);
});

test('getRelevantSnippets: returns snippets for matching files', async () => {
  const cwd = setupRepo();
  const map = await buildRepoMap({ cwd });
  const r = await getRelevantSnippets({ cwd, map, query: 'parse' });
  assert.ok(r.length > 0);
  assert.ok(r[0].path.includes('parser'));
  assert.ok(r[0].snippet.length > 0);
  rm(cwd);
});

test('getRelevantSnippets: returns empty for no matches', async () => {
  const cwd = setupRepo();
  const map = await buildRepoMap({ cwd });
  const r = await getRelevantSnippets({ cwd, map, query: 'xyzzyqwerty' });
  assert.equal(r.length, 0);
  rm(cwd);
});

test('getRelevantSnippets: respects maxFiles', async () => {
  const cwd = setupRepo();
  const map = await buildRepoMap({ cwd });
  const r = await getRelevantSnippets({ cwd, map, query: 'export', maxFiles: 1 });
  assert.ok(r.length <= 1);
  rm(cwd);
});

test('ContextBudget: starts empty', () => {
  const b = new ContextBudget({ maxTokens: 1000 });
  assert.equal(b.used(), 0);
  assert.equal(b.remaining(), 1000);
});

test('ContextBudget: add tracks usage', () => {
  const b = new ContextBudget({ maxTokens: 1000 });
  b.add('hello world');
  assert.ok(b.used() > 0);
  assert.ok(b.remaining() < 1000);
});

test('ContextBudget: fit checks available space', () => {
  const b = new ContextBudget({ maxTokens: 10, reserved: 0 });
  assert.ok(b.fit('hi'));
  assert.ok(!b.fit('x'.repeat(1000)));
});

test('ContextBudget: reset clears usage', () => {
  const b = new ContextBudget({ maxTokens: 100 });
  b.add('hello');
  b.reset();
  assert.equal(b.used(), 0);
});

test('ContextBudget: reserved reduces available', () => {
  const b = new ContextBudget({ maxTokens: 100, reserved: 50 });
  assert.equal(b.remaining(), 50);
});

test('ContextBudget: toString summarizes', () => {
  const b = new ContextBudget({ maxTokens: 100 });
  b.add('hi');
  assert.match(b.toString(), /ContextBudget/);
});
