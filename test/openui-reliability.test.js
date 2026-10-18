// Interactive answers that draw every time: the engine reads what small models
// actually write (named arguments, a ) for a ], a missing comma, extra
// arguments), the guide's own examples load, and a block that still fails gets
// one repair round with the engine's errors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Canvas, checkUi, uiBlocks, mendBrackets } from '../src/ui-lang.js';
import { LIVE_UI_GUIDE, repairLiveUi } from '../src/serve.js';

const load = (src) => {
  const ev = new Canvas().load(src);
  return { ev, errs: [...(ev.parseErrors ?? []), ...(ev.errors ?? [])].filter((e) => e.code !== 'ignored') };
};

test('named arguments land where the signature puts them', () => {
  const { ev, errs } = load('$amt = 1000\nroot = Card(title="Loan", children=[Slider(label="Amount", value=$amt, min=0, max=5000, step=100), Stat(label: "Pay", value: $amt / 10)])');
  assert.deepEqual(errs, []);
  const [slider, stat] = ev.root.props.children;
  assert.equal(ev.root.props.title, 'Loan');
  assert.deepEqual([slider.props.min, slider.props.max, slider.props.step, slider.props.bind], [0, 5000, 100, 'amt']);
  assert.equal(stat.props.value, 100);
});

test('a name the component does not have is left out, not shifted into another place', () => {
  const { ev, errs } = load('root = Row([Text("a"), Text("b")], gap="medium")');
  assert.deepEqual(errs, []);
  assert.equal(ev.root.props.children.length, 2);
});

test('brackets are mended: ) for ], a spare closer, an unclosed list', () => {
  for (const src of [
    'root = Card("T", [Text("a"), Text("b")))',
    'root = Card("T", [Text("a"), Text("b"))',
    'root = Card("T", [Text("a"), Text("b")',
  ]) {
    const { ev, errs } = load(src);
    assert.deepEqual(errs, [], src);
    assert.equal(ev.root.props.children.length, 2, src);
  }
  const toks = mendBrackets([{ t: 'p', v: '(' }, { t: 'p', v: '[' }, { t: 'p', v: ')' }]);
  assert.deepEqual(toks.map((t) => t.v), ['(', '[', ']', ')']);
});

test('a missing comma between two items still gives both', () => {
  const { ev, errs } = load('root = Card("T", [Text("a")\n Text("b")])');
  assert.deepEqual(errs, []);
  assert.equal(ev.root.props.children.length, 2);
});

test('extra arguments are left out and the component draws', () => {
  const { ev, errs } = load('root = Input("Amount", 5, "number", "extra", 3)');
  assert.deepEqual(errs, []);
  assert.equal(ev.root.type, 'Input');
});

test('True/False, None and @Divide-style builtins, as models write them', () => {
  const { ev, errs } = load('root = Stack([Checkbox("x", True), Stat("q", @Divide(10, 4)), Stat("p", @Multiply(2, 3))])');
  assert.deepEqual(errs, []);
  const [cb, q, p] = ev.root.props.children;
  assert.equal(cb.props.value, true);
  assert.equal(q.props.value, 2.5);
  assert.equal(p.props.value, 6);
});

test('Format never throws: bad digits are clamped, an unknown currency falls back', () => {
  const { ev, errs } = load('root = Stack([Stat("a", @Format(1234.5, "currency", 99)), Stat("b", @Format(10, "currency", 2, "ZZZZ"))])');
  assert.deepEqual(errs, []);
  assert.equal(ev.root.props.children.length, 2);
});

test('every example in the interactive guide loads cleanly', () => {
  const blocks = uiBlocks(LIVE_UI_GUIDE);
  assert.ok(blocks.length >= 3);
  for (const b of blocks) assert.equal(checkUi('```openui\n' + b + '\n```').ok, true, b);
});

test('checkUi: no block, nothing to draw, lines dropped, fine', () => {
  assert.equal(checkUi('just prose').why, 'no openui block');
  assert.equal(checkUi('```openui\nroot = \n```').root, false);
  assert.equal(checkUi('```openui\nroot = Text("hi")\n```').ok, true);
});

const fakeRun = (reply) => async function* () { yield { type: 'text-delta', text: reply }; };

test('repair: a broken block is redrawn once from the engine errors, prose kept', async () => {
  const broken = 'Here it is.\n```openui\nroot = Card("T" Text(\n```\nEnjoy.';
  let asked = null;
  const run = async function* ({ messages }) { asked = messages.at(-1).content; yield { type: 'text-delta', text: '```openui\nroot = Card("T", [Text("ok")])\n```' }; };
  const out = await repairLiveUi({ text: broken, target: {}, messages: [{ role: 'user', content: 'x' }], ctx: {}, config: {}, run });
  assert.match(asked, /did not load/);
  assert.match(out, /^Here it is\./);
  assert.match(out, /Enjoy\.$/);
  assert.equal(checkUi(out).ok, true);
});

test('repair: a fine answer is left alone; a worse retry is not used', async () => {
  assert.equal(await repairLiveUi({ text: '```openui\nroot = Text("hi")\n```', target: {}, messages: [], ctx: {}, config: {}, run: fakeRun('x') }), null);
  const partial = '```openui\nroot = Stack([Text("a"), Bogus(1)])\n```';
  assert.equal(await repairLiveUi({ text: partial, target: {}, messages: [], ctx: {}, config: {}, run: fakeRun('no block here') }), null);
});

test('repair: an answer with no block gets one appended', async () => {
  const out = await repairLiveUi({ text: 'A table of phones.', target: {}, messages: [], ctx: {}, config: {}, run: fakeRun('```openui\nroot = Text("t")\n```') });
  assert.match(out, /^A table of phones\.\n\n```openui/);
  assert.equal(checkUi(out).ok, true);
});
