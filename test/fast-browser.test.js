// The fast browser agent (src/fast-browser.js): the action space, answer
// checks, the DONE check, the loop's guards, and a real headless-Chrome run on
// a local page with a scripted decider (no model, no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.OX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-fastb-'));
const F = await import('../src/fast-browser.js');
const D = await import('../src/dev-flow.js');
const here = path.dirname(fileURLToPath(import.meta.url));

const ACTIONS = [
  { id: 'e1', node: 1, kind: 'fill', role: 'combobox', label: 'Destination', value: '' },
  { id: 'e2', node: 1, kind: 'click', role: 'combobox', label: 'Open Destination', value: '' },
  { id: 'e3', node: 2, kind: 'click', role: 'checkbox', label: 'Design hotels', checked: 'false' },
  { id: 'e4', node: 3, kind: 'select', role: 'combobox', label: 'Sort → Lowest price', value: 'price', current_value: 'Best match' },
  { id: 'e5', node: 3, kind: 'select', role: 'combobox', label: 'Sort → Top rated', value: 'rating', current_value: 'Best match' },
  { id: 'e6', node: 4, kind: 'click', role: 'button', label: 'Place order' },
  { id: 'scroll_down', kind: 'scroll', label: 'Scroll down', delta: 560 },
  { id: 'wait', kind: 'wait', label: 'Wait for the page to update' },
];

test('action space: one index per element, per-operation targets, dropdown options as index:n', () => {
  const { elements, targets, controls } = F.actionSpace(ACTIONS);
  assert.equal(elements.length, 4);
  assert.deepEqual(elements[0].operations, ['TYPE_TEXT', 'CLICK']);
  assert.deepEqual(Object.keys(targets.SELECT), ['3:1', '3:2']);
  assert.equal(elements[2].value, 'Best match');
  assert.deepEqual(elements[2].options.map((o) => o.label), ['Lowest price', 'Top rated']);
  assert.deepEqual(Object.keys(controls), ['SCROLL_DOWN', 'WAIT']);
});

test('answers: only offered operations and targets; unambiguous shapes accepted; text required to type', () => {
  const p = F.stepPrompt('goal', { url: 'u', title: 't', text: 'x', actions: ACTIONS }, []);
  assert.match(p.user, /\[3\] combobox "Sort" value="Best match" ops=SELECT options: 3:1="Lowest price", 3:2="Top rated"/);
  assert.deepEqual(F.validate('{"operation":"CLICK","target":"2"}', p), { choice: 'e3', operation: 'CLICK', target: '2', text: null });
  assert.equal(F.validate('{"operation":"TYPE_TEXT","target":"1","text":"Lisbon"}', p).text, 'Lisbon');
  assert.throws(() => F.validate('{"operation":"TYPE_TEXT","target":"1","text":""}', p), /without a usable value/);
  assert.throws(() => F.validate('{"operation":"CLICK","target":"9"}', p), /not offered/);
  assert.throws(() => F.validate('{"operation":"NAVIGATE","target":"x"}', p), /not offered/);
  assert.throws(() => F.validate('nope', p), /did not answer with JSON/);
  assert.equal(F.validate('[{"operation":"WAIT"}]', p).choice, 'wait');
  assert.equal(F.validate('```json\n{"operation":"SCROLL_DOWN"}\n```', p).choice, 'scroll_down');
  assert.equal(F.validate('{"operation":"CLICK","target":"3:2"}', p).choice, 'e5', 'an option sent as CLICK is a SELECT');
  assert.equal(F.validate('{"operation":"SELECT","target":"3","text":"3:2"}', p).choice, 'e5');
  assert.equal(F.validate('{"operation":"CLICK","target":"3","text":"Top rated"}', p).choice, 'e5');
  assert.equal(F.validate('{"operation":"DONE"}', p).operation, 'DONE');
});

test('commits wait for the owner: buy, pay, send, delete', () => {
  for (const l of ['Place order', 'Buy now', 'Confirm and pay', 'Send', 'Delete account']) assert.ok(F.COMMITS.test(l), l);
  for (const l of ['Search', 'Design hotels', 'Next', 'Casa Flora']) assert.ok(!F.COMMITS.test(l), l);
});

test('the DONE check reads the answer strictly', async () => {
  const page = { url: 'u', title: 't', text: 'x', actions: ACTIONS };
  assert.deepEqual(await F.checkDone(async () => '{"met":true,"missing":null}', 'g', page), { met: true, missing: null });
  assert.deepEqual(await F.checkDone(async () => ({ text: '{"met":false,"missing":"open Casa Flora"}' }), 'g', page), { met: false, missing: 'open Casa Flora' });
  assert.equal((await F.checkDone(async () => 'yes', 'g', page)).met, false);
});

// A stand-in browser: pages in order, acts recorded.
function fakeBrowser(pages) {
  let i = 0;
  const acted = [];
  return { acted, cdp: { calls: 0 }, observe: async () => ({ ...pages[Math.min(i, pages.length - 1)], fingerprint: String(Math.min(i, pages.length - 1)) }), fresh: async () => true, act: async (a, _p, text) => { acted.push([a.id, text]); i++; }, close: async () => {} };
}
const page = (actions, text = '') => ({ url: 'https://x.test/', title: 'X', text, actions: [...actions, { id: 'wait', kind: 'wait', label: 'Wait' }] });

test('loop: acts, refuses a false DONE, accepts a checked one', async () => {
  const b = fakeBrowser([page([ACTIONS[0]]), page([ACTIONS[2]], 'results'), page([], 'Casa Flora')]);
  const answers = ['{"operation":"TYPE_TEXT","target":"1","text":"Lisbon"}', '{"operation":"DONE"}', '{"met":false,"missing":"design filter"}', '{"operation":"CLICK","target":"1"}', '{"operation":"DONE"}', '{"met":true}'];
  const seen = [];
  const r = await F.runGoal('g', { browser: b, decide: async (q) => { seen.push(q.user); return answers.shift(); } });
  assert.equal(r.status, 'done');
  assert.deepEqual(b.acted, [['e1', 'Lisbon'], ['e3', null]]);
  assert.match(seen[3], /DONE\? not yet: design filter/);
});

test('loop: a buy button stops without an OK; goes ahead with one', async () => {
  const mk = () => fakeBrowser([page([ACTIONS[5]]), page([], 'Thanks')]);
  const ans = () => ['{"operation":"CLICK","target":"1"}', '{"operation":"DONE"}', '{"met":true}'];
  let a = ans();
  const no = await F.runGoal('buy it', { browser: mk(), decide: async () => a.shift() });
  assert.equal(no.status, 'blocked');
  assert.match(no.reason, /waits for your OK/);
  a = ans();
  const b = mk();
  const yes = await F.runGoal('buy it', { browser: b, decide: async () => a.shift(), confirm: async ({ label }) => label === 'Place order' });
  assert.equal(yes.status, 'done');
  assert.deepEqual(b.acted, [['e6', null]]);
});

test('loop: three bad answers in a row stop it, and each refusal is shown to the model', async () => {
  const seen = [];
  const r = await F.runGoal('g', { browser: fakeBrowser([page([ACTIONS[0]])]), decide: async (q) => { seen.push(q.user); return '{"operation":"FLY"}'; } });
  assert.equal(r.status, 'blocked');
  assert.match(seen[1], /REFUSED\? the model chose "FLY"/);
  await assert.rejects(F.runGoal('  ', { decide: async () => '' }), /give the browser a goal/);
});

test('real Chrome: cookie dialog, autocomplete, filters, sort, search, open the result', { skip: !D.chromePath() && 'no Chrome here' }, async () => {
  const url = `file://${path.join(here, 'fixtures', 'fast-browser-hotels.html')}`;
  const row = (u, re) => u.split('\n').find((l) => l.startsWith('[') && re.test(l));
  const idx = (u, re) => /^\[(\d+)\]/.exec(row(u, re) ?? '')?.[1];
  const plan = [
    (u) => ({ operation: 'CLICK', target: idx(u, /"Only necessary"/) }),
    (u) => ({ operation: 'TYPE_TEXT', target: idx(u, /"Destination".*TYPE_TEXT/), text: 'Lis' }),
    (u) => ({ operation: 'CLICK', target: idx(u, /option "Lisbon, Portugal"/) }),
    (u) => ({ operation: 'CLICK', target: idx(u, /"Design hotels"/) }),
    (u) => ({ operation: 'CLICK', target: idx(u, /"Free cancellation"/) }),
    (u) => ({ operation: 'SELECT', target: /(\d+:\d+)="Top rated"/.exec(row(u, /"Sort"/))[1] }),
    (u) => ({ operation: 'CLICK', target: idx(u, /button "Search"/) }),
    (u) => (/stays in Lisbon/.test(u) ? { operation: 'CLICK', target: idx(u, /link "Casa Flora"/) } : { operation: 'WAIT' }),
    (u) => (/You are viewing Casa Flora/.test(u) ? { operation: 'DONE' } : { operation: 'WAIT' }),
  ];
  let i = 0;
  // Before the dialog is dismissed nothing under it is offered.
  const first = [];
  const r = await F.runGoal('Lisbon, design, free cancellation, top rated, open Casa Flora', {
    url,
    decide: async ({ system, user }) => {
      if (system === F.DONE_CHECK) return '{"met":true}';
      if (!first.length) first.push(user);
      const step = plan[Math.min(i, plan.length - 1)](user);
      if (step.operation !== 'WAIT') i++;
      return JSON.stringify(step);
    },
  });
  assert.equal(r.status, 'done', JSON.stringify(r.decisions.filter((d) => d.error)));
  assert.equal(r.title, 'Casa Flora · Stays');
  assert.doesNotMatch(first[0].split('ELEMENTS:')[1], /Destination|Search/, 'controls under the cookie dialog are not offered');
  assert.deepEqual(r.history.filter((h) => h.operation !== 'WAIT').map((h) => h.label), ['Only necessary', 'Destination', 'Lisbon, Portugal', 'Design hotels', 'Free cancellation', 'Sort → Top rated', 'Search', 'Casa Flora']);
  assert.ok(r.elapsedMs < 15_000, `took ${r.elapsedMs} ms`);
});
