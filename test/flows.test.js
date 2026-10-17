// ox Flows (n8n-style automations): steps pass outputs along, a false
// condition stops the run, a failing step says which and why, and the unsafe
// things (shell, writing outside home) are refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.OX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-flows-'));
const F = await import('../src/flows.js');

const fakeFetch = async (url) => ({ ok: true, status: 200, text: async () => (String(url).includes('hn') ? JSON.stringify({ hits: [{ title: 'Ox ships flows', points: 321 }] }) : 'plain') });
const asked = [];
const io = { fetch: fakeFetch, ask: async (p) => { asked.push(p); return { text: `SUMMARY(${p.slice(-40)})`, usage: { inputTokens: 10, outputTokens: 5 }, model: 'stub' }; }, notify: async (t, x) => `notified ${t}: ${x}` };

const flow = {
  name: 'Morning news',
  trigger: { type: 'schedule', every: 'daily at 9am' },
  steps: [
    { name: 'fetch', type: 'http', url: 'https://hn.example/api?q={{input.topic}}' },
    { name: 'top', type: 'extract', from: 'fetch', path: 'hits.0.title' },
    { name: 'hot', type: 'if', value: '{{steps.fetch.output.hits.0.points}}', op: 'gt', to: '100' },
    { name: 'sum', type: 'ask', prompt: 'One line on: {{steps.top.output}}' },
    { name: 'tell', type: 'notify', title: 'News', text: '{{steps.sum.output}}' },
    { name: 'log', type: 'write', path: 'test-flows/{{input.topic}}.md', text: '- {{steps.top.output}}', append: true },
  ],
};

test('a flow runs step by step, each output feeding the next, and is recorded', async () => {
  const saved = F.saveFlow(flow);
  assert.equal(saved.id, 'morning-news');
  const run = await F.runFlow('morning-news', { input: { topic: 'ai' }, io });
  assert.equal(run.status, 'ok', JSON.stringify(run));
  assert.deepEqual(run.steps.map((s) => s.status), ['ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
  assert.equal(run.steps[1].out, 'Ox ships flows');
  assert.match(asked[0], /One line on: Ox ships flows/);
  assert.match(run.steps[4].out, /notified News: SUMMARY/);
  const file = path.join(os.homedir(), 'ox-flows', 'test-flows', 'ai.md');
  assert.match(fs.readFileSync(file, 'utf8'), /- Ox ships flows/);
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
  assert.equal(F.flowRuns({ id: 'morning-news' })[0].status, 'ok');
});

test('a false condition stops the run; a failing step says which and why', async () => {
  const quiet = { ...flow, name: 'quiet', steps: [flow.steps[0], { name: 'hot', type: 'if', value: '{{steps.fetch.output.hits.0.points}}', op: 'gt', to: '1000' }, { name: 'tell', type: 'notify', text: 'never' }] };
  const r = await F.runFlow(quiet, { input: { topic: 'ai' }, io, record: false });
  assert.equal(r.status, 'stopped');
  assert.equal(r.steps.length, 2);
  const broken = { name: 'broken', steps: [{ name: 'get', type: 'http', url: 'https://x.example/' }] };
  const bad = await F.runFlow(broken, { io: { ...io, fetch: async () => ({ ok: false, status: 503, text: async () => 'down' }) }, record: false });
  assert.equal(bad.status, 'failed');
  assert.match(bad.error, /^get: HTTP 503/);
});

test('unsafe things are refused, and bad flows are explained', async () => {
  assert.match(F.validateFlow({ name: 'x', steps: [{ name: 'a', type: 'shell', command: 'ls' }] }).join(), /allowShell/);
  assert.match(F.validateFlow({ name: 'x', steps: [{ name: 'Bad Name', type: 'notify', text: 'y' }] }).join(), /lowercase/);
  assert.match(F.validateFlow({ name: 'x', trigger: { type: 'schedule' }, steps: [{ name: 'a', type: 'notify', text: 'y' }] }).join(), /every/);
  const esc = await F.runFlow({ name: 'esc', steps: [{ name: 'w', type: 'write', path: '/etc/ox-test', text: 'x' }] }, { io, record: false });
  assert.match(esc.error, /outside your home/);
  const hidden = await F.runFlow({ name: 'hid', steps: [{ name: 'w', type: 'write', path: path.join(os.homedir(), '.ssh', 'x'), text: 'x' }] }, { io, record: false });
  assert.match(hidden.error, /hidden folder/);
  const hook = F.saveFlow({ name: 'hook', trigger: { type: 'webhook' }, steps: [{ name: 'a', type: 'notify', text: 'y' }] });
  assert.match(hook.trigger.secret, /^[0-9a-f]{32}$/);
});

test('describe it, ox drafts it: shell is stripped and the draft is checked', async () => {
  const draft = await F.draftFlow('tell me the top HN story every morning', { ask: async () => ({ text: 'Here you go:\n{"name":"HN top","trigger":{"type":"schedule","every":"every day at 8am"},"allowShell":true,"steps":[{"name":"get","type":"http","url":"https://hn.algolia.com/api/v1/search?tags=front_page"},{"name":"rm","type":"shell","command":"rm -rf ~"},{"name":"top","type":"extract","from":"get","path":"hits.0.title"},{"name":"tell","type":"notify","text":"{{steps.top.output}}"}]}' }) });
  assert.equal(draft.allowShell, undefined);
  assert.deepEqual(draft.steps.map((s) => s.type), ['http', 'extract', 'notify']);
  await assert.rejects(F.draftFlow('x', { ask: async () => ({ text: 'sorry' }) }), /did not return a flow/);
});

test('a scheduled flow runs when due, once, and not again until its time', async () => {
  F.saveFlow({ name: 'pulse', trigger: { type: 'schedule', every: 'every 1h' }, steps: [{ name: 'a', type: 'notify', text: 'tick' }] });
  const t0 = Date.parse('2026-10-16T10:00:00Z');
  assert.ok(F.dueFlows(t0).some((f) => f.id === 'pulse'));
  const first = await F.tickFlows({ now: t0, io });
  assert.ok(first.some((r) => r.flow === 'pulse' && r.status === 'ok'));
  assert.equal(F.dueFlows(t0 + 30 * 60_000).some((f) => f.id === 'pulse'), false);
  assert.ok(F.dueFlows(t0 + 61 * 60_000).some((f) => f.id === 'pulse'));
  assert.match(F.validateFlow({ name: 'x', trigger: { type: 'schedule', every: 'every weekday at 9am' }, steps: [{ name: 'a', type: 'notify', text: 'y' }] }).join(), /cannot read the schedule/);
});

test('an empty value or an empty answer fails the step, by name, instead of "succeeding"', async () => {
  const chatty = { ...io, ask: async () => ({ text: 'It appears you gave me a list of numbers.' }), fetch: async () => ({ ok: true, status: 200, text: async () => 'null' }) };
  const f = { name: 'ids', steps: [
    { name: 'ids', type: 'ask', prompt: 'first 3 ids as JSON' },
    { name: 'one', type: 'http', url: 'https://x.example/item/{{steps.ids.output.0}}.json' },
  ] };
  const r = await F.runFlow(f, { io: chatty, record: false });
  assert.equal(r.status, 'failed');
  assert.match(r.error, /^one: url: \{\{steps\.ids\.output\.0\}\} is empty/);
  const empty = await F.runFlow({ name: 'e', steps: [{ name: 'get', type: 'http', url: 'https://x.example/' }] }, { io: chatty, record: false });
  assert.match(empty.error, /answer was empty/);
});
