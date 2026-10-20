// Interactive answers that draw every time: the engine reads what small models
// actually write (named arguments, a ) for a ], a missing comma, extra
// arguments), the guide's own examples load, and a block that still fails gets
// one repair round with the engine's errors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Canvas, checkUi, uiBlocks, mendBrackets } from '../src/ui-lang.js';
import { LIVE_UI_GUIDE, repairLiveUi, mendUi } from '../src/serve.js';

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

test('a formula in quotes is worked out; text with $values fills them in; other text stays', () => {
  const c = checkUi('```openui\n$bill = 80\n$pct = 10\n$name = "Sai"\nroot = Stack([Stat("Tip", "$bill * $pct / 100"), Text("Hello $name"), Text("Total: $5"), Text("Hi there")])\n```');
  assert.equal(c.ok, true, c.why);
  assert.deepEqual(c.tree.props.children.map((x) => x.props.value ?? x.props.text), [8, 'Hello Sai', 'Total: $5', 'Hi there']);
});

test('a formula still showing as text fails the check, as a reader would see it', () => {
  const c = checkUi('```openui\nroot = Text("Missing $nope")\n```');
  assert.equal(c.ok, false);
  assert.match(c.why, /formula is shown as text/);
});

test('Select with plain choices gets Options; numeric ones are numbers', () => {
  const c = checkUi('```openui\n$n = 2\nroot = Select("People", $n, ["1", "2", "3"])\n```');
  assert.equal(c.ok, true, c.why);
  assert.deepEqual(c.tree.props.options.map((o) => o.props.value), [1, 2, 3]);
});

test('maths reads formatted money; no-result sums show "—"; Stat takes a format hint', () => {
  const c = checkUi('```openui\n$bill = 80\n$n = 4\nroot = Stack([Stat("Per", @Format($bill, "currency") / $n, "currency"), Stat("Bad", "abc" * 2)])\n```');
  assert.equal(c.ok, true, c.why);
  assert.deepEqual(c.tree.props.children.map((x) => x.props.value), ['$20.00', '—']);
});

test('Explainer and Flow: built from primitives every renderer draws; clicking a step changes the card', async () => {
  const U = await import('../src/ui-lang.js');
  const src = 'root = Explainer("How a jet engine works", ["Intake: the fan pulls air in", "Compress: blades squeeze it", {label: "Burn", text: "fuel ignites"}, "Exhaust: hot gas pushes the plane"])';
  const r = U.evaluate(U.parseProgram(src));
  assert.deepEqual(r.errors, []);
  const kids = r.root.props.children;
  assert.deepEqual(kids.map((k) => k.type), ['Title', 'Svg', 'Segmented', 'Card']);
  const seg = kids[2];
  assert.deepEqual(seg.props.options, ['Intake', 'Compress', 'Burn', 'Exhaust']);
  assert.equal(kids[3].props.title, '1. Intake');
  const r2 = U.evaluate(U.parseProgram(src), { state: { [seg.props.bind]: 'Burn' } });
  assert.equal(r2.root.props.children[3].props.title, '3. Burn');
  assert.equal(r2.root.props.children[3].props.children[0].props.text, 'fuel ignites');
  const lit = r2.root.props.children[1].props.children.filter((c) => c.type === 'Rect' && c.props.fill === 'info');
  assert.equal(lit.length, 1, 'the current step lights up in the diagram');
  const f = U.evaluate(U.parseProgram('root = Flow(["Visit", "Sign up", "Pay"], "column")'));
  assert.equal(f.root.type, 'Svg');
  assert.equal(f.root.props.children.filter((c) => c.type === 'Line').length, 2);
  assert.match(U.evaluate(U.parseProgram('root = Explainer("x", [])')).errors[0].msg, /Explainer needs steps/);
});

test('every time: a drawing the small model cannot mend goes to the strongest model connected', async () => {
  const broken = '```openui\nfor i in range(10):\n  x = 1\nroot = Card("T" Text(\n```';
  const seen = [];
  const run = async function* ({ target }) {
    seen.push(target.model);
    yield { type: 'text-delta', text: String(target.model).includes('big') ? '```openui\nroot = Card("Interest", [Chart("line", ["1", "2"], [100, 105])])\n```' : 'still no block' };
  };
  const out = await mendUi({ text: broken, target: { model: 'qwen2.5:3b' }, pickedName: 'qwen2.5:3b', messages: [{ role: 'user', content: 'a compound interest chart' }], ctx: {}, config: {}, run, pick: () => ({ id: 'ox-ollama:big-model:32b' }) });
  assert.deepEqual(seen, ['qwen2.5:3b', 'big-model:32b'], 'its own round first, then the stronger model');
  assert.equal(out.by, 'ox-ollama:big-model:32b');
  assert.equal(checkUi(out.text).ok, true);
  // The same model is never asked twice, and a drawing that loads is left alone.
  const same = await mendUi({ text: broken, target: { model: 'qwen2.5:3b' }, pickedName: 'qwen2.5:3b', messages: [], ctx: {}, config: {}, run, pick: () => ({ id: 'ox-ollama:qwen2.5:3b' }) });
  assert.equal(same, null);
  assert.equal(await mendUi({ text: '```openui\nroot = Text("hi")\n```', target: {}, pickedName: 'x', messages: [], ctx: {}, config: {}, run, pick: () => ({ id: 'ox-ollama:big-model:32b' }) }), null);
});

test('invented chart names draw as Chart with that type', () => {
  const c = checkUi('```openui\nroot = Card("B", [PieChart(["a", "b"], [1, 2], "t"), LineChart(["x", "y"], [3, 4]), DonutChart(["p"], [1])])\n```');
  assert.equal(c.ok, true);
  assert.deepEqual(c.tree.props.children.map((x) => x.props.type), ['pie', 'line', 'donut']);
});
