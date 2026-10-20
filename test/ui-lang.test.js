// OX Canvas: the compact UI language (src/ui-lang.js) and the show_ui tool.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Canvas, parseProgram, evaluate, mergePrograms, renderTerminal, visibleWidth } from '../src/ui-lang.js';
import { showUiTool, getCanvas } from '../src/tools/canvas.js';
import { narrowToolSchemas, listToolSchemas } from '../src/tools/index.js';
import { estimateTokens } from '../src/context.js';

const here = dirname(fileURLToPath(import.meta.url));
const demo = readFileSync(join(here, 'fixtures/canvas-demo.oxui'), 'utf8');
const plain = (root, width = 78) => renderTerminal(root, { width, colors: false });

test('a dashboard renders KPIs, a bar chart, a table and numbered buttons', () => {
  const c = new Canvas();
  const ev = c.load(demo);
  const { text, actions } = c.render({ width: 78, colors: false });
  assert.match(text, /Repo health/);
  assert.match(text, /1,840 ▲ 12/);
  assert.match(text, /╭─ Slowest suites ─/);
  assert.match(text, /agent\s+█+ 41\.2/);
  assert.match(text, /island\s+9\.1\s+✓ pass/, 'numbers right-aligned, status coloured by meaning');
  assert.deepEqual(actions.map((a) => a.label), ['Fix the failing test', 'Re-scan', 'Clean build']);
  for (const line of text.split('\n')) assert.ok(visibleWidth(line) <= 78, `line fits: ${line}`);
  // The one bad line is reported with a fix, and everything else still renders.
  assert.deepEqual(ev.errors.map((e) => e.msg), ['unknown component Crad (use Card)']);
});

test('errors name the line and suggest the fix the model needs', () => {
  const p = parseProgram(['root = Stack([hdr, tabel])', 'hdr = Header("x"', 'q = Query("bash", {command: "ls"})'].join('\n'));
  const ev = evaluate(p);
  const all = [...p.errors, ...ev.errors].map((e) => `${e.line}:${e.msg}`);
  // An unclosed Header("x" is mended (closed), not dropped.
  assert.ok(!all.some((m) => /^2:/.test(m)), all.join(' | '));
  assert.ok(all.some((m) => /`tabel` is never defined/.test(m)), all.join(' | '));
  assert.ok(all.some((m) => /Query can only call read-only tools/.test(m)), 'bash cannot be a Query');
});

test('streaming: an unfinished last line is skipped silently, finished lines render', () => {
  const partial = 'root = Stack([a, b])\na = Text("hello")\nb = Table([Col("x", [1, 2';
  const p = parseProgram(partial, { streaming: true });
  assert.equal(p.errors.length, 0);
  const ev = evaluate(p);
  assert.match(plain(ev.root).text, /hello/);
});

test('patch merges by name: changed lines replace, new lines append, the rest is kept', () => {
  const base = 'root = Stack([a])\na = Text("one")\nb = Text("unused")';
  const merged = mergePrograms(base, 'root = Stack([a, c])\nc = Badge("new", "success")');
  const ev = evaluate(parseProgram(merged));
  assert.equal(ev.errors.length, 0);
  const t = plain(ev.root).text;
  assert.match(t, /one/);
  assert.match(t, /\[new\]/);
  assert.match(merged, /b = Text\("unused"\)/);
});

test('buttons: state changes redraw locally; mutations are handed back, never run', async () => {
  const c = new Canvas();
  c.load([
    'root = Stack([pick, msg, Buttons([Button("Deploy", Action([@Run(ship)]))])])',
    '$env = "staging"',
    'pick = Select("env", $env, [Option("staging"), Option("prod", "Production")])',
    'msg = Text("target: " + $env)',
    'ship = Mutation("bash", {command: "deploy " + $env})',
  ].join('\n'));
  let r = c.render({ colors: false });
  assert.match(r.text, /target: staging/);
  const prod = r.actions.find((a) => a.label === 'Production');
  const out = await c.act(prod);
  assert.equal(out.rerender, true);
  r = c.render({ colors: false });
  assert.match(r.text, /target: prod/);
  assert.match(r.text, /● Production/);
  const deploy = await c.act(r.actions.find((a) => a.label === 'Deploy'));
  assert.deepEqual(deploy.mutation, { id: 'ship', tool: 'bash', args: { command: 'deploy prod' } });
});

test('show_ui: live Query data, a tiny result for the model, the view in meta', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ox-canvas-'));
  writeFileSync(join(dir, 'a.js'), '// TODO(ox): one\n// TODO(ox): two\n');
  const res = await showUiTool({
    ui: 'root = Card("TODOs: " + @Count(t.lines), [List(t.lines)])\nt = Query("grep", {pattern: "TODO\\\\(ox\\\\)", path: "."}, {lines: []})',
  }, { cwd: dir, sessionId: 'canvas-test' });
  assert.ok(!res.isError, res.content);
  assert.match(res.meta.canvas.text, /TODOs: 2/);
  assert.match(res.content, /^Shown to the user: Card, List\./);
  assert.ok(estimateTokens(res.content) < 40, 'the model is not re-billed for the canvas content');
  // A follow-up patch fixes one statement without resending the rest.
  const fixed = await showUiTool({ ui: 'root = Card("Open TODOs", [List(t.lines)])', patch: true }, { cwd: dir, sessionId: 'canvas-test' });
  assert.match(fixed.meta.canvas.text, /Open TODOs/);
  assert.match(getCanvas('canvas-test').source, /Query\("grep"/);
});

test('show_ui reports dropped lines with the patch instruction', async () => {
  const res = await showUiTool({ ui: 'root = Stack([a, b])\na = Text("ok")\nb = BarChrt(["x"], [1])' }, { sessionId: 'canvas-err' });
  assert.match(res.content, /1 statement\(s\) were dropped/);
  assert.match(res.content, /unknown component BarChrt \(use BarChart\)/);
  assert.match(res.content, /patch: true/);
});

test('show_ui is offered on visual turns and withheld otherwise', () => {
  const all = listToolSchemas({});
  const names = (msg) => narrowToolSchemas(all, { message: msg }).map((s) => s.name);
  assert.ok(names('show me a table of the slowest tests').includes('show_ui'));
  assert.ok(!names('fix the null check in agent.js').includes('show_ui'));
});

test('benchmark: the same UI costs far fewer tokens than a JSON component tree', () => {
  const src = demo.replace(/^hits = Query.*$/m, 'hits = {lines: ["a.js:1: TODO(ox) one", "b.js:9: TODO(ox) two"]}');
  const ev = evaluate(parseProgram(src));
  const ox = estimateTokens(src);
  const compact = estimateTokens(JSON.stringify(ev.root));
  const pretty = estimateTokens(JSON.stringify(ev.root, null, 2)); // how models usually write JSON
  assert.ok(ox < compact * 0.8, `ox ${ox} tokens vs compact JSON ${compact}`);
  assert.ok(ox < pretty * 0.5, `ox ${ox} tokens vs pretty JSON ${pretty}`);
});

test('OpenUI Lang in the app: a single action needs no wrapper, Input and Slider bind $vars, @Pow does loan maths', async () => {
  const c = new Canvas();
  const ev = c.load([
    '$P = 300000', '$rate = 6', '$n = 360',
    'r = $rate / 1200',
    'pay = $P * r / (1 - @Pow(1 + r, 0 - $n))',
    'root = Stack([Input("Loan amount", $P, "number"), Slider("Interest %", $rate, 0, 20, 0.1), Button("15 years", @Set($n, 180)), Stat("Monthly", @Round(pay, 2))])',
  ].join('\n'));
  assert.deepEqual(ev.errors, []);
  const [input, slider, button, stat] = ev.root.props.children;
  assert.equal(input.props.bind, 'P');
  assert.equal(slider.props.bind, 'rate');
  assert.equal(stat.props.value, 1798.65);
  c.state.rate = 4;
  assert.equal(c.evaluate().root.props.children[3].props.value, 1432.25);
  await c.act(button.props.action);
  assert.equal(c.last.root.props.children[3].props.value, 2219.06);
});

// What a 3B local model really wrote for "a loan calculator with sliders":
// three lines were lost and both fields showed "3".
test('a computed $var, a card closed one bracket early and a streamed default all draw', () => {
  const src = [
    '$amount = 300000', '$rate = 6', '$months = 360',
    '$r = $rate / 1200',
    '$p = $amount * $r / (1 - @Pow(1 + $r, -$months))',
    'root = Card("Loan", [', 'Row([Input("Amount", $amount, "number"), Slider("Rate", $rate, 0, 20, 0.1)])', '],',
    'Row([Stat("Monthly", @Round($p, 2))])', ')',
  ].join('\n');
  const prog = parseProgram(src);
  assert.deepEqual(prog.errors, []);
  const ev = evaluate(prog);
  assert.deepEqual(ev.errors, []);
  assert.equal(ev.root.props.children.length, 2);
  assert.equal(ev.root.props.children[1].props.children[0].props.value, 1798.65);

  // Streaming: the first chunk says 3, the next 300000; the field follows it.
  const c = new Canvas();
  c.load('$amount = 3\nroot = Input("Amount", $amount, "number")');
  c.load('$amount = 300000\nroot = Input("Amount", $amount, "number")');
  assert.equal(c.state.amount, 300000);
  // ...but a value the user changed is theirs.
  c.state.amount = 5000;
  c.load('$amount = 300000\nroot = Input("Amount (USD)", $amount, "number")');
  assert.equal(c.state.amount, 5000);
});
