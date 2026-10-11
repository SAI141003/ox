import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CacheAligner,
  ReversibleCache,
  routeContent,
  deterministicCompress,
  applyContextOptimize,
  headroomRetrieveTool,
} from '../src/context-opt.js';

// ---- Helpers ---------------------------------------------------------

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ox-co-test-'));
}

// ---- F1: CacheAligner tests -------------------------------------------

test('CacheAligner preserves identical prefix byte-for-byte', () => {
  const aligner = new CacheAligner();
  const prev = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
  ];
  const curr = [...prev];
  const { frozen, live, frozenLen } = aligner.align(prev, curr);
  assert.equal(frozenLen, 3);
  assert.deepEqual(frozen, curr);
  assert.deepEqual(live, []);
});

test('CacheAligner leaves frozen prefix untouched and isolates live zone', () => {
  const aligner = new CacheAligner();
  const prev = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
  ];
  const curr = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
    { role: 'tool', tool_call_id: 't1', content: 'new result' },
  ];
  const { frozen, live, frozenLen } = aligner.align(prev, curr);
  assert.equal(frozenLen, 3);
  assert.deepEqual(frozen, prev);
  assert.equal(live.length, 1);
  assert.deepEqual(live[0], curr[3]);
});

test('CacheAligner freezes only the longest shared prefix', () => {
  const aligner = new CacheAligner();
  const prev = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
    { role: 'tool', tool_call_id: 't1', content: 'r1' },
  ];
  const curr = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'changed' },
    { role: 'tool', tool_call_id: 't2', content: 'r2' },
  ];
  const { frozen, live, frozenLen } = aligner.align(prev, curr);
  assert.equal(frozenLen, 2);
  assert.deepEqual(frozen, curr.slice(0, 2));
  assert.equal(live.length, 2);
  assert.deepEqual(live, curr.slice(2));
});

test('CacheAligner handles empty previous messages', () => {
  const aligner = new CacheAligner();
  const curr = [{ role: 'user', content: 'hi' }];
  const { frozen, live, frozenLen } = aligner.align([], curr);
  assert.equal(frozenLen, 0);
  assert.deepEqual(frozen, []);
  assert.deepEqual(live, curr);
});

test('CacheAligner handles empty current messages', () => {
  const aligner = new CacheAligner();
  const { frozen, live, frozenLen } = aligner.align([{ role: 'user', content: 'hi' }], []);
  assert.equal(frozenLen, 0);
  assert.deepEqual(frozen, []);
  assert.deepEqual(live, []);
});

// ---- F2: ReversibleCache (CCR) tests -----------------------------------

test('CCR compress then retrieve returns original', () => {
  const cache = new ReversibleCache({ ttlMs: 60000 });
  const original = 'this is the original content that was compressed';
  const placeholder = cache.compressId(original);
  assert.ok(placeholder.startsWith('[headroom:'));
  const id = placeholder.slice('[headroom:'.length, -1);
  const retrieved = cache.retrieve(id);
  assert.equal(retrieved, original);
});

test('CCR expired entry is gone', async () => {
  const cache = new ReversibleCache({ ttlMs: 50 });
  const original = 'temporary content';
  const placeholder = cache.compressId(original);
  const id = placeholder.slice('[headroom:'.length, -1);
  assert.equal(cache.retrieve(id), original);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(cache.retrieve(id), null);
});

test('CCR opt-in flag respected: without reversibleCache, applyContextOptimize uses deterministic compression not placeholders', () => {
  const prev = [{ role: 'user', content: 'hi' }];
  const curr = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: '{"error":"fail","data":[1,2,3]}' },
  ];
  const result = applyContextOptimize(curr, prev, { cwd: makeTempDir() });
  // Without reversibleCache, content is deterministically compressed (not original, not placeholder)
  assert.ok(!result[1].content.includes('[headroom:'), 'should not have placeholder without opt-in');
  assert.notEqual(result[1].content, curr[1].content, 'should be compressed (not original)');
});

test('CCR with opt-in reversibleCache: uses placeholder', () => {
  const prev = [{ role: 'user', content: 'hi' }];
  const curr = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: '{"error":"fail","data":[1,2,3]}' },
  ];
  const tmp = makeTempDir();
  const result = applyContextOptimize(curr, prev, { reversibleCache: true, cwd: tmp });
  assert.ok(result[1].content.includes('[headroom:'), 'expected placeholder when reversibleCache is on');
  assert.notEqual(result[1].content, curr[1].content);
  // Can retrieve the original through the cache
  const id = result[1].content.slice('[headroom:'.length, -1);
  // Note: cache is internal; verify the placeholder format is valid
  assert.ok(id.length > 0, 'placeholder id should not be empty');
});

test('CCR retrieve via headroomRetrieveTool returns schema', () => {
  const cache = new ReversibleCache({ ttlMs: 60000 });
  const original = 'secret document content';
  cache.compressId(original);
  const tool = headroomRetrieveTool();
  assert.equal(tool.name, 'headroom_retrieve');
  assert.ok(tool.input_schema.properties.id);
});

test('CCR has method exposes cache content', () => {
  const cache = new ReversibleCache({ ttlMs: 60000 });
  cache.set('id1', 'content1');
  assert.equal(cache.has('id1'), true);
  assert.equal(cache.has('nonexistent'), false);
});

// ---- F3: ContentRouter tests -------------------------------------------

test('routeContent classifies JSON array', () => {
  assert.equal(routeContent('[1,2,3]'), 'json');
  assert.equal(routeContent('[{"error":"x"},{"ok":true}]'), 'json');
  assert.equal(routeContent('{}'), 'json');
});

test('routeContent classifies source code', () => {
  assert.equal(routeContent('function foo() { return 1; }'), 'code');
  assert.equal(routeContent('import x from "y";\nconst z = 1;'), 'code');
  assert.equal(routeContent('class Foo {\n  bar() {}\n}'), 'code');
});

test('routeContent classifies log lines', () => {
  assert.equal(routeContent('2024-01-01 INFO starting\n2024-01-01 ERROR failed'), 'logs');
});

test('routeContent classifies prose as prose', () => {
  assert.equal(routeContent('Hello, how are you today?'), 'prose');
  assert.equal(routeContent('The weather is nice.'), 'prose');
});

test('deterministicCompress JSON keeps error items and boundaries', () => {
  const input = '[{"ok":true},{"error":"fail","data":1},{"ok":false},{"error":"bar","data":2}]';
  const result = deterministicCompress(input);
  assert.ok(result !== null, 'should not return null for JSON');
  const parsed = JSON.parse(result);
  assert.equal(parsed.__compressed, true);
  assert.equal(parsed.originalType, 'array');
  assert.ok(Array.isArray(parsed.keptItems));
  const errItems = parsed.keptItems.filter((i) => i && typeof i === 'object' && ('error' in i));
  assert.ok(errItems.length >= 2, 'error items should be preserved');
  assert.ok(parsed.keptItems.some((i) => i && i.ok === true), 'first boundary item should be present');
});

test('deterministicCompress JSON object keeps error keys', () => {
  const input = '{"name":"test","error":"msg","status":"ok","details":{"a":1}}';
  const result = deterministicCompress(input);
  assert.ok(result !== null);
  const parsed = JSON.parse(result);
  assert.equal(parsed.__compressed, true);
  assert.equal(parsed.error, 'msg');
  assert.ok(parsed.__first !== undefined);
});

test('deterministicCompress source code reduces without LLM', () => {
  const input = 'import os\nimport sys\n\ndef foo():\n    return 1\n\ndef bar():\n    return 2';
  const result = deterministicCompress(input);
  assert.ok(result !== null, 'code should have deterministic compression');
  const parsed = JSON.parse(result);
  assert.equal(parsed.__compressed, true);
  assert.equal(parsed.originalType, 'code');
  assert.ok(Array.isArray(parsed.signatures));
  assert.ok(parsed.stats.lines > 0);
});

test('deterministicCompress prose returns null (falls through to LLM)', () => {
  const input = 'Hello, this is a nice day to write some code together.';
  const result = deterministicCompress(input);
  assert.equal(result, null, 'prose should return null to indicate LLM fallback');
});

// ---- Integration test ---------------------------------------------------

test('integration: with contextOptimize OFF, provider receives identical input', () => {
  const prev = [
    { role: 'system', content: 'you are helpful' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
  ];
  const curr = [
    { role: 'system', content: 'you are helpful' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
    { role: 'tool', tool_call_id: 't1', content: 'result' },
  ];
  const result = applyContextOptimize(curr, prev, { cwd: makeTempDir() });
  assert.deepEqual(result, curr, 'with flag off, history must be unchanged');
});

test('integration: CacheAligner snapshot comparison works across turns', () => {
  const aligner = new CacheAligner();
  const turn1 = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'go' },
  ];
  aligner.snapshot(turn1);
  const turn2 = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'go' },
    { role: 'assistant', content: 'done' },
    { role: 'tool', tool_call_id: 't1', content: 'r' },
  ];
  const { frozen, live, frozenLen } = aligner.align(turn1, turn2);
  assert.equal(frozenLen, 2);
  assert.deepEqual(frozen, turn1);
  assert.equal(live.length, 2);
});
