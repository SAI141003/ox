// Tool calls from any model, repaired before they run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repairJson, resolveToolName, coerceArgs, extractTextToolCalls, parseToolArgs } from '../src/tool-repair.js';

const names = ['read_file', 'bash', 'mcp__github__search_issues'];
const schema = { type: 'object', properties: { path: { type: 'string' }, limit: { type: 'integer' }, all: { type: 'boolean' }, tags: { type: 'array' } }, required: ['path'] };

test('almost-JSON is repaired', () => {
  assert.deepEqual(repairJson('{"path": "a.js",}'), { path: 'a.js' });
  assert.deepEqual(repairJson("{'path': 'a.js'}"), { path: 'a.js' });
  assert.deepEqual(repairJson('{path: "a.js", all: True}'), { path: 'a.js', all: true });
  assert.deepEqual(repairJson('```json\n{"path":"a.js"}\n```'), { path: 'a.js' });
  assert.deepEqual(repairJson('{"path":"a.js","tags":["x"'), { path: 'a.js', tags: ['x'] });
  assert.deepEqual(repairJson('"{\\"path\\":\\"a.js\\"}"'), { path: 'a.js' }, 'a JSON string holding JSON');
  assert.equal(repairJson('not json at all'), null);
});

test('tool names are matched to what was offered', () => {
  assert.equal(resolveToolName('functions.read_file', names), 'read_file');
  assert.equal(resolveToolName('Read_File', names), 'read_file');
  assert.equal(resolveToolName('read_file_0', names), 'read_file');
  assert.equal(resolveToolName('github::search_issues', names), 'mcp__github__search_issues');
  assert.equal(resolveToolName('delete_everything', names), null);
});

test('types follow the schema; strings that should stay strings do', () => {
  assert.deepEqual(coerceArgs({ path: 7, limit: '20', all: 'false', tags: '["a","b"]' }, schema), { path: '7', limit: 20, all: false, tags: ['a', 'b'] });
  assert.deepEqual(coerceArgs({ path: '007', tags: 'one' }, schema), { path: '007', tags: 'one' });
});

test('bad arguments come back as a precise error, never run on guesses', () => {
  assert.match(parseToolArgs('{oops', schema, 'read_file').error, /not a JSON object.*"path"/);
  assert.match(parseToolArgs('{"limit": 3}', schema, 'read_file').error, /needs "path"/);
  assert.deepEqual(parseToolArgs('{"path":"a.js","limit":"5"}', schema, 'read_file').args, { path: 'a.js', limit: 5 });
});

test('tool calls written into the reply are found and taken out', () => {
  const hermes = extractTextToolCalls('Let me look.\n<tool_call>\n{"name": "read_file", "arguments": {"path": "a.js"}}\n</tool_call>', names);
  assert.equal(hermes.calls[0].function.name, 'read_file');
  assert.deepEqual(JSON.parse(hermes.calls[0].function.arguments), { path: 'a.js' });
  assert.equal(hermes.text, 'Let me look.');
  const llama = extractTextToolCalls('<function=bash>{"command": "ls"}</function>', names);
  assert.equal(llama.calls[0].function.name, 'bash');
  const bare = extractTextToolCalls('{"name": "bash", "parameters": {"command": "ls"}}', names);
  assert.equal(bare.calls.length, 1);
  const mistral = extractTextToolCalls('[TOOL_CALLS] [{"name": "bash", "arguments": {"command": "pwd"}}]', names);
  assert.equal(mistral.calls[0].function.name, 'bash');
  assert.equal(extractTextToolCalls('Use {"name": "x"} in your config', names).calls.length, 0, 'unknown tools are not invented');
  assert.equal(extractTextToolCalls('Plain answer.', names).text, 'Plain answer.');
});

test('XML-style tool calls are read; a cut one is recognised as broken', async () => {
  const { looksLikeBrokenToolCall } = await import('../src/tool-repair.js');
  const xml = extractTextToolCalls('<function_calls><invoke name="read_file"><parameter name="path">a.js</parameter></invoke></function_calls>', names);
  assert.equal(xml.calls[0].function.name, 'read_file');
  assert.deepEqual(JSON.parse(xml.calls[0].function.arguments), { path: 'a.js' });
  const cut = '">\n<atem:parameter name="path">.</atem:parameter>\n</atem:invoke>\n</atem:function_calls>';
  assert.equal(extractTextToolCalls(cut, names).calls.length, 0);
  assert.equal(looksLikeBrokenToolCall(cut), true, 'seen in an eval run: the whole reply was this');
  assert.equal(looksLikeBrokenToolCall('Use <parameter> tags in XML config files when you describe the invoke step of a long and detailed pipeline for your team.'), false);
});

test('arguments under another name are renamed to the schema', async () => {
  const { renameToSchema } = await import('../src/tool-repair.js');
  const edit = { type: 'object', properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } }, required: ['path', 'old_string', 'new_string'] };
  assert.deepEqual(renameToSchema({ file_path: 'a.js', old_str: 'x', new_str: 'y' }, edit), { path: 'a.js', old_string: 'x', new_string: 'y' });
  assert.deepEqual(parseToolArgs('{"filePath":"a.js","oldString":"x","newString":"y"}', edit, 'edit_file').args, { path: 'a.js', old_string: 'x', new_string: 'y' });
});
