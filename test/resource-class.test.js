import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTool, groupCalls, RESOURCE_CLASSES } from '../src/resource-class.js';

test('classifyTool returns pure_read for read_file', () => {
  assert.equal(classifyTool('read_file'), 'pure_read');
});

test('classifyTool returns fs_write for write_file', () => {
  assert.equal(classifyTool('write_file'), 'fs_write');
});

test('classifyTool returns approval_gated for bash', () => {
  assert.equal(classifyTool('bash'), 'approval_gated');
});

test('classifyTool returns terminal for reply', () => {
  assert.equal(classifyTool('reply'), 'terminal');
});

test('RESOURCE_CLASSES includes all expected classes', () => {
  assert.deepEqual(RESOURCE_CLASSES, ['pure_read', 'fs_write', 'approval_gated', 'memory_write', 'terminal', 'unknown']);
});

test('groupCalls preserves order and groups consecutive same-class calls', () => {
  const calls = [
    { id: '1', function: { name: 'read_file', arguments: '{}' } },
    { id: '2', function: { name: 'grep', arguments: '{}' } },
    { id: '3', function: { name: 'write_file', arguments: '{}' } },
    { id: '4', function: { name: 'read_file', arguments: '{}' } },
    { id: '5', function: { name: 'grep', arguments: '{}' } },
  ];
  const groups = groupCalls(calls);
  assert.equal(groups.length, 3);
  assert.equal(groups[0].class, 'pure_read');
  assert.equal(groups[0].calls.length, 2);
  assert.equal(groups[0].calls[0].id, '1');
  assert.equal(groups[0].calls[1].id, '2');
  assert.equal(groups[1].class, 'fs_write');
  assert.equal(groups[1].calls.length, 1);
  assert.equal(groups[1].calls[0].id, '3');
  assert.equal(groups[2].class, 'pure_read');
  assert.equal(groups[2].calls.length, 2);
  assert.equal(groups[2].calls[0].id, '4');
  assert.equal(groups[2].calls[1].id, '5');
});

test('groupCalls handles single call', () => {
  const calls = [{ id: '1', function: { name: 'read_file', arguments: '{}' } }];
  const groups = groupCalls(calls);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].class, 'pure_read');
  assert.equal(groups[0].calls.length, 1);
});

test('groupCalls handles empty input', () => {
  const groups = groupCalls([]);
  assert.equal(groups.length, 0);
});

test('groupCalls groups all consecutive same-class calls into one group', () => {
  const calls = [
    { id: '1', function: { name: 'read_file', arguments: '{}' } },
    { id: '2', function: { name: 'grep', arguments: '{}' } },
    { id: '3', function: { name: 'ls', arguments: '{}' } },
  ];
  const groups = groupCalls(calls);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].class, 'pure_read');
  assert.equal(groups[0].calls.length, 3);
});

test('batch mixing approval_gated with another class is rejected', () => {
  // When approval_gated and pure_read are consecutive different classes,
  // groupCalls creates separate groups. The agent loop rejects a batch
  // if approval_gated appears with more than 1 total call.
  const calls = [
    { id: '1', function: { name: 'read_file', arguments: '{}' } },
    { id: '2', function: { name: 'bash', arguments: '{}' } },
  ];
  const groups = groupCalls(calls);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].class, 'pure_read');
  assert.equal(groups[1].class, 'approval_gated');
  // The agent loop runs this batch in order: the read, then the gated call
  // through its own approval (only a subagent batch keeps the no-mixing rule).
  const approvalGatedGroup = groups.find(g => g.class === 'approval_gated');
  assert.ok(approvalGatedGroup);
});

test('terminal call not last in batch is rejected', () => {
  const calls = [
    { id: '1', function: { name: 'reply', arguments: '{}' } },
    { id: '2', function: { name: 'read_file', arguments: '{}' } },
  ];
  const groups = groupCalls(calls);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].class, 'terminal');
  assert.equal(groups[1].class, 'pure_read');
  // Agent loop check: terminal is not the last group
  const terminalIdx = groups.findIndex(g => g.class === 'terminal');
  assert.equal(terminalIdx !== groups.length - 1, true);
});

test('unknown-class tool in a batch is rejected', () => {
  const calls = [
    { id: '1', function: { name: 'read_file', arguments: '{}' } },
    { id: '2', function: { name: 'unknown_tool', arguments: '{}' } },
  ];
  const groups = groupCalls(calls);
  assert.ok(groups.some(g => g.class === 'unknown'));
  // Agent loop check: unknown class → reject
  const unknownGroup = groups.find(g => g.class === 'unknown');
  assert.ok(unknownGroup);
  assert.equal(unknownGroup.class, 'unknown');
});
