// The components and functions taken as ideas from open-intelligent-ui and
// written here from scratch: each parses, evaluates, binds its $var and draws
// in the terminal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Canvas, LIBRARY, renderTerminal } from '../src/ui-lang.js';

const run = (src) => { const c = new Canvas(); const ev = c.load(src); return { c, ev }; };
const find = (node, type) => {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) { for (const x of node) { const f = find(x, type); if (f) return f; } return null; }
  if (node.type === type) return node;
  for (const v of Object.values(node.props ?? {})) { const f = find(v, type); if (f) return f; }
  return null;
};

test('every new component is in the library the model is told about', () => {
  for (const n of ['TextArea', 'DatePicker', 'RadioGroup', 'Timer', 'Flashcard', 'Carousel', 'Quote', 'Link', 'Image', 'Math', 'Popover', 'Celebration', 'Ellipse', 'Polyline', 'Path']) assert.ok(LIBRARY[n], n);
});

test('form controls bind their $var', () => {
  const { ev } = run(['$notes = "hi"', '$when = "2026-11-02"', '$size = "M"',
    'root = Card("Order", [TextArea("Notes", $notes), DatePicker("Delivery", $when), RadioGroup($size, ["S", "M", "L"], "Size")])'].join('\n'));
  assert.deepEqual(ev.errors ?? [], []);
  assert.equal(find(ev.root, 'TextArea').props.bind, 'notes');
  assert.equal(find(ev.root, 'DatePicker').props.bind, 'when');
  assert.equal(find(ev.root, 'RadioGroup').props.bind, 'size');
  assert.equal(find(ev.root, 'RadioGroup').props.value, 'M');
});

test('study and page pieces evaluate and draw in the terminal', () => {
  const { ev } = run(['root = Stack([Timer(1.5, "Focus"), Flashcard("2 + 2", "4"), Carousel([Text("one"), Text("two")]), Quote("Simple is better.", "Zen"), Math("x^2 + y^2 = r^2", true), Link("Docs", "https://example.com"), Popover("Hint", [Text("Try 4")]), Celebration("All done")])'].join('\n'));
  assert.deepEqual(ev.errors ?? [], []);
  const out = renderTerminal(ev.root, { colors: false }).text;
  for (const s of ['⏱ Focus 1:30', 'Q: 2 + 2', 'A: 4', '“Simple is better.”', 'x^2 + y^2 = r^2', 'Docs → https://example.com', '🎉 All done', 'one', 'two', '▸ Hint', 'Try 4']) assert.ok(out.includes(s), `${s}\n${out}`);
});

test('date functions work in UTC days', () => {
  const { ev } = run(['a = @AddDays("2026-02-27", 3)', 'b = @AddMonths("2026-01-31", 1)', 'c = @DaysBetween("2026-10-01", "2026-10-30")', 'd = @StartOf("2026-10-30", "week")', 'e = @FormatDate("2026-10-30", "long")', 'f = @MonthsBetween("2026-01-15", "2026-10-14")', 'g = @MonthsBetween("2026-10-14", "2026-01-15")', 'h = @MonthsBetween("2026-01-15", "2026-01-14")',
    'root = Text(a + " " + b + " " + c + " " + d + " " + e + " " + f + " " + g + " " + h)'].join('\n'));
  assert.equal(ev.root.props.text, '2026-03-02 2026-02-28 29 2026-10-26 Friday, October 30, 2026 8 -8 0');
});

test('list and data functions', () => {
  const { ev } = run(['l = [3, 1, 3, 5, 9]', 'rows = [{n: "a", v: 2}, {n: "b", v: 7}, {n: "c", v: 5}]', 's = @Stats(l)',
    'root = Text(@Join(@Take(@Unique(l), 3), ",") + "|" + @Join(@Reverse(l), ",") + "|" + @Join(@Cumulative(l), ",") + "|" + @Join(@MovingAvg(l, 2), ",") + "|" + s.median + "|" + @Join(@Pick(@Top(rows, "v", 2), "n"), ",") + "|" + @Change(80, 100) + "|" + @Count(@Chunk(l, 2)) + "|" + @MixColor("#000000", "#ffffff", 0.5) + "|" + @Find(rows, "n", "c").v)'].join('\n'));
  assert.equal(ev.root.props.text, '3,1,5|9,5,3,1,3|3,4,7,12,21|3,2,2,4,7|3|b,c|25|3|#808080|5');
});
