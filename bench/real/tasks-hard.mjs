// bench/real/tasks-hard.mjs - six harder tasks.
//
// The first nine tasks are passed by every capable model, so they cannot show
// ox getting better. These ask for what an everyday coding job asks: a contract
// that is wider than its test, a cause that is not where the symptom is, a race,
// a change across many callers, a speed target, a tool written from a spec.
//
// Same rules as tasks.mjs: real files, real commands, and the verdict comes only
// from running code. Every task here is graded by checks the agent never sees
// (the grader's own inputs), so making the visible test pass is not enough.
// test/bench-real-hard.test.js proves each one is solvable (a reference solution
// passes) and that the starting state, and the obvious shortcut, fail.
import { check, existsWs, readWs, runIn, sha256, writeWs } from './lib.mjs';

function failedDetail(checks, fallback) {
  const bad = checks.filter((c) => !c.ok).map((c) => `${c.name} :: ${c.detail}`);
  return bad.length ? `${fallback} | ${bad.join(' || ')}` : fallback;
}
const verdict = (checks, ok, bad) => {
  const pass = checks.every((c) => c.ok);
  return { pass, detail: pass ? ok : failedDetail(checks, bad), checks };
};
// Run grader code inside the workspace. The code prints one JSON line of { name: true|"why" }.
function grade(ws, code, { timeoutMs = 60_000 } = {}) {
  const r = runIn(ws, 'node', ['-e', code], { timeoutMs });
  let rows = null;
  try { rows = JSON.parse(String(r.stdout).trim().split('\n').pop()); } catch {}
  if (!rows) return [check('the grader ran', false, `exit=${r.exit} timedOut=${r.timedOut} ${r.stderr || r.stdout}`)];
  return Object.entries(rows).map(([name, v]) => check(name, v === true, v === true ? '' : String(v)));
}
const unchanged = (ws, rel, body) => check(`${rel} was not edited`, existsWs(ws, rel) && sha256(readWs(ws, rel)) === sha256(body), `${rel} changed or is missing`);
const J = (lines) => `${lines.join('\n')}\n`;
// The grader's harness: each t(name, fn) records true, or why it failed.
const HARNESS = "const assert=require('node:assert');const R={};const t=(n,f)=>{try{f();R[n]=true}catch(e){R[n]=String(e&&e.message||e).split('\\n')[0]}};";
const HARNESS_ASYNC = "const assert=require('node:assert');const R={};const t=async(n,f)=>{try{await f();R[n]=true}catch(e){R[n]=String(e&&e.message||e).split('\\n')[0]}};";

// ---------------------------------------------------------------------------
// 1. contract-wider-than-test
// ---------------------------------------------------------------------------
const CACHE_SPEC = J([
  '# Cache contract',
  '',
  '`createCache({ max, ttlMs, now })` returns `{ get, set, has, delete, size, keys }`.',
  '',
  '- `max`: how many entries it holds. A positive integer; anything else throws `RangeError`.',
  '- `ttlMs`: how long an entry lives. `0` or missing means it never expires.',
  '- `now`: a function returning the time in milliseconds. Default `Date.now`. Every time comparison uses it.',
  '',
  '## Rules',
  '',
  '1. `set(key, value, { ttlMs })` adds or replaces an entry and makes it the most recently used.',
  '   A `ttlMs` given here is for this entry only. Replacing an entry restarts its life.',
  '2. When there are more than `max` live entries after a `set`, the least recently used one is removed.',
  '3. `get(key)` returns the value, or `undefined`. A hit makes the entry the most recently used.',
  '4. `has(key)` says whether a live entry exists. It does NOT change which entry is most recently used.',
  '5. An entry is expired when `now() - (time it was set) >= its ttl`. An expired entry is gone:',
  '   `get` returns `undefined`, `has` returns `false`, and it is not counted or listed.',
  '6. `delete(key)` removes an entry and returns `true` if a live one was there, else `false`.',
  '7. `size()` is the number of live entries.',
  '8. `keys()` lists live keys from least to most recently used.',
  '9. Expired entries never take a place away from a live one: they are dropped before rule 2 counts.',
]);
const CACHE_TEST = J([
  "'use strict';",
  "const assert = require('node:assert');",
  "const { createCache } = require('../src/cache.js');",
  '',
  'const c = createCache({ max: 2 });',
  "c.set('a', 1); c.set('b', 2);",
  "assert.strictEqual(c.get('a'), 1);",
  "c.set('c', 3);",
  "assert.strictEqual(c.get('b'), undefined, 'b was the least recently used');",
  "assert.strictEqual(c.size(), 2);",
  "console.log('ok - cache');",
]);
const CACHE_GRADER = `${HARNESS}
const { createCache } = require('./src/cache.js');
let clock = 0; const now = () => clock;
t('max must be a positive integer', () => { for (const m of [0, -1, 1.5, '2', undefined]) assert.throws(() => createCache({ max: m }), RangeError); });
t('least recently used is removed', () => { const c = createCache({ max: 2, now }); c.set('a', 1); c.set('b', 2); c.get('a'); c.set('c', 3); assert.deepStrictEqual(c.keys(), ['a', 'c']); });
t('has does not change recency', () => { const c = createCache({ max: 2, now }); c.set('a', 1); c.set('b', 2); assert.strictEqual(c.has('a'), true); c.set('c', 3); assert.strictEqual(c.has('a'), false); assert.deepStrictEqual(c.keys(), ['b', 'c']); });
t('replacing makes it most recent', () => { const c = createCache({ max: 2, now }); c.set('a', 1); c.set('b', 2); c.set('a', 9); c.set('c', 3); assert.deepStrictEqual(c.keys(), ['a', 'c']); assert.strictEqual(c.get('a'), 9); });
t('expires exactly at ttl', () => { clock = 0; const c = createCache({ max: 5, ttlMs: 100, now }); c.set('a', 1); clock = 99; assert.strictEqual(c.get('a'), 1); clock = 100; assert.strictEqual(c.get('a'), undefined); assert.strictEqual(c.has('a'), false); });
t('expired entries are not counted or listed', () => { clock = 0; const c = createCache({ max: 5, ttlMs: 50, now }); c.set('a', 1); clock = 30; c.set('b', 2); clock = 60; assert.strictEqual(c.size(), 1); assert.deepStrictEqual(c.keys(), ['b']); });
t('a ttl for one entry', () => { clock = 0; const c = createCache({ max: 5, ttlMs: 1000, now }); c.set('short', 1, { ttlMs: 10 }); c.set('long', 2); clock = 10; assert.strictEqual(c.has('short'), false); assert.strictEqual(c.get('long'), 2); });
t('replacing restarts its life', () => { clock = 0; const c = createCache({ max: 5, ttlMs: 100, now }); c.set('a', 1); clock = 90; c.set('a', 2); clock = 150; assert.strictEqual(c.get('a'), 2); clock = 190; assert.strictEqual(c.get('a'), undefined); });
t('no ttl never expires', () => { clock = 0; const c = createCache({ max: 5, now }); c.set('a', 1); clock = 1e12; assert.strictEqual(c.get('a'), 1); });
t('delete says whether a live entry was there', () => { clock = 0; const c = createCache({ max: 5, ttlMs: 10, now }); c.set('a', 1); assert.strictEqual(c.delete('a'), true); assert.strictEqual(c.delete('a'), false); c.set('b', 1); clock = 10; assert.strictEqual(c.delete('b'), false); });
t('an expired entry never pushes out a live one', () => { clock = 0; const c = createCache({ max: 2, now }); c.set('old', 1, { ttlMs: 10 }); c.set('keep', 2); clock = 20; c.set('new', 3); assert.deepStrictEqual(c.keys(), ['keep', 'new']); });
console.log(JSON.stringify(R));`;

// ---------------------------------------------------------------------------
// 2. cause-not-symptom
// ---------------------------------------------------------------------------
const PRICING_DOC = J([
  '# Pricing rules',
  '',
  '1. All money is held in whole cents. `toCents("19.99")` is `1999`, `toCents("-2.30")` is `-230`.',
  '2. A line is `{ price, qty, discountPercent }`. Its amount is `toCents(price) * qty`.',
  '3. A discount is taken per line, and rounded half up to the cent on that line',
  '   (a discount of 0.5 cent is 1 cent). Line discounts are then added up.',
  '   The discount is never worked out on the order total.',
  '4. The order total is the sum of line amounts minus the sum of line discounts.',
]);
const REPORT_TEST = J([
  "'use strict';",
  "const assert = require('node:assert');",
  "const { summary } = require('../src/report.js');",
  '',
  "assert.strictEqual(summary([{ price: '19.99', qty: 3 }]), 'Total: $59.97');",
  "assert.strictEqual(summary([{ price: '5', qty: 2 }]), 'Total: $10.00');",
  "console.log('ok - report');",
]);
const PRICING_GRADER = `${HARNESS}
const { toCents } = require('./src/money.js');
const { total, discounts } = require('./src/cart.js');
const { summary } = require('./src/report.js');
t('cents are exact', () => { const want = { '19.99': 1999, '0.07': 7, '1.15': 115, '4.35': 435, '5': 500, '5.5': 550, '0.29': 29, '-2.30': -230, '-0.07': -7, '8.20': 820, '1.10': 110 }; for (const [k, v] of Object.entries(want)) assert.strictEqual(toCents(k), v, k); });
t('the report shows the right total', () => { assert.strictEqual(summary([{ price: '19.99', qty: 3 }]), 'Total: $59.97'); assert.strictEqual(summary([{ price: '0.07', qty: 1 }, { price: '1.15', qty: 1 }]), 'Total: $1.22'); });
t('a discount is rounded on its own line', () => { const lines = [{ price: '0.15', qty: 1, discountPercent: 10 }, { price: '0.15', qty: 1, discountPercent: 10 }, { price: '0.15', qty: 1, discountPercent: 10 }]; assert.strictEqual(discounts(lines), 6); assert.strictEqual(total(lines), 39); });
t('half a cent rounds up', () => { assert.strictEqual(discounts([{ price: '0.25', qty: 1, discountPercent: 10 }]), 3); assert.strictEqual(discounts([{ price: '0.24', qty: 1, discountPercent: 10 }]), 2); });
t('no discount, no change', () => { assert.strictEqual(total([{ price: '8.20', qty: 2 }, { price: '1.10', qty: 1 }]), 1750); assert.strictEqual(discounts([{ price: '8.20', qty: 2 }]), 0); });
t('mixed lines', () => { const lines = [{ price: '19.99', qty: 1, discountPercent: 15 }, { price: '4.35', qty: 3, discountPercent: 5 }, { price: '1.10', qty: 7 }]; assert.strictEqual(discounts(lines), 300 + 65); assert.strictEqual(total(lines), 1999 + 1305 + 770 - 365); });
console.log(JSON.stringify(R));`;

// ---------------------------------------------------------------------------
// 3. lost-updates
// ---------------------------------------------------------------------------
const COUNTER_SRC = J([
  "'use strict';",
  '',
  '// Adds `by` to the number stored under `key` and returns the new value.',
  '// `db` is slow and asynchronous: { read(key) -> Promise<number|undefined>, write(key, n) -> Promise<void> }.',
  'async function increment(db, key, by = 1) {',
  '  const current = (await db.read(key)) ?? 0;',
  '  const next = current + by;',
  '  await db.write(key, next);',
  '  return next;',
  '}',
  '',
  'module.exports = { increment };',
]);
const RACE_TEST = J([
  "'use strict';",
  "const assert = require('node:assert');",
  "const { increment } = require('../src/counter.js');",
  '',
  'function slowDb() {',
  '  const data = new Map();',
  '  const wait = () => new Promise((r) => setTimeout(r, 2));',
  '  return { data, async read(k) { await wait(); return data.get(k); }, async write(k, n) { await wait(); data.set(k, n); } };',
  '}',
  '',
  '(async () => {',
  '  const db = slowDb();',
  "  await Promise.all(Array.from({ length: 25 }, () => increment(db, 'visits')));",
  "  assert.strictEqual(db.data.get('visits'), 25, 'every increment must be applied');",
  "  console.log('ok - race');",
  '})().catch((e) => { console.error(e.message); process.exit(1); });',
]);
const RACE_GRADER = `${HARNESS_ASYNC}
const { increment } = require('./src/counter.js');
function slowDb(ms = 2) {
  const data = new Map(); let open = 0, most = 0, failNext = 0;
  const wait = () => new Promise((r) => setTimeout(r, ms));
  const io = async (f) => { open++; most = Math.max(most, open); try { await wait(); return f(); } finally { open--; } };
  return { data, most: () => most, failWrites: (n) => { failNext = n; },
    read: (k) => io(() => data.get(k)),
    write: (k, n) => io(() => { if (failNext > 0) { failNext--; throw new Error('disk full'); } data.set(k, n); }) };
}
(async () => {
  await t('200 increments at once are all applied', async () => { const db = slowDb(1); const got = await Promise.all(Array.from({ length: 200 }, () => increment(db, 'k'))); assert.strictEqual(db.data.get('k'), 200); assert.deepStrictEqual([...got].sort((a, b) => a - b), Array.from({ length: 200 }, (_, i) => i + 1)); });
  await t('amounts other than 1', async () => { const db = slowDb(1); await Promise.all([increment(db, 'k', 5), increment(db, 'k', -2), increment(db, 'k', 10)]); assert.strictEqual(db.data.get('k'), 13); });
  await t('different keys still run at the same time', async () => { const db = slowDb(20); const t0 = Date.now(); await Promise.all(Array.from({ length: 20 }, (_, i) => increment(db, 'key' + i))); const ms = Date.now() - t0; assert.ok(db.most() > 1, 'only one database call was ever open at a time'); assert.ok(ms < 400, 'took ' + ms + 'ms: keys wait for each other'); for (let i = 0; i < 20; i++) assert.strictEqual(db.data.get('key' + i), 1); });
  await t('a failed write rejects that call only', async () => { const db = slowDb(1); await increment(db, 'k'); db.failWrites(1); const res = await Promise.allSettled([increment(db, 'k'), increment(db, 'k'), increment(db, 'k')]); assert.strictEqual(res.filter((r) => r.status === 'rejected').length, 1); assert.strictEqual(db.data.get('k'), 3); assert.strictEqual(await increment(db, 'k'), 4); });
  await t('two databases do not share state', async () => { const a = slowDb(1), b = slowDb(1); await Promise.all([increment(a, 'k'), increment(b, 'k'), increment(a, 'k')]); assert.strictEqual(a.data.get('k'), 2); assert.strictEqual(b.data.get('k'), 1); });
  console.log(JSON.stringify(R));
})();`;

// ---------------------------------------------------------------------------
// 4. change-across-callers
// ---------------------------------------------------------------------------
const FORMAT_SRC = J([
  "'use strict';",
  '',
  "const SYMBOL = { USD: '$', EUR: '€', GBP: '£', JPY: '¥' };",
  '',
  '// formatPrice(1234.5, "EUR", "de") -> "1.234,50 €"',
  "function formatPrice(amount, currency = 'USD', locale = 'en') {",
  "  if (typeof amount !== 'number' || !Number.isFinite(amount)) throw new TypeError('formatPrice: amount must be a finite number');",
  "  const digits = currency === 'JPY' ? 0 : 2;",
  "  const [whole, frac] = Math.abs(amount).toFixed(digits).split('.');",
  "  const sep = locale === 'de' ? '.' : ',';",
  "  const grouped = whole.replace(/\\B(?=(\\d{3})+(?!\\d))/g, sep);",
  "  const number = frac ? grouped + (locale === 'de' ? ',' : '.') + frac : grouped;",
  "  const sign = amount < 0 ? '-' : '';",
  "  const symbol = SYMBOL[currency] ?? currency + ' ';",
  "  return locale === 'de' ? sign + number + ' ' + symbol.trim() : sign + symbol + number;",
  '}',
  '',
  'module.exports = { formatPrice, SYMBOL };',
]);
const CALLERS = {
  'src/cart/line.js': ["const { formatPrice } = require('../format/price.js');", "function line(item) { return item.name + ': ' + formatPrice(item.price * item.qty, item.currency); }", 'module.exports = { line };'],
  'src/cart/total.js': ["const price = require('../format/price.js');", "function total(items, currency, locale) { return 'Total ' + price.formatPrice(items.reduce((s, i) => s + i.price * i.qty, 0), currency, locale); }", 'module.exports = { total };'],
  'src/invoice/header.js': ["const { formatPrice: fp } = require('../format/price.js');", "function due(amount) { return 'Amount due: ' + fp(amount); }", 'module.exports = { due };'],
  'src/invoice/rows.js': ["const { formatPrice } = require('../format/price.js');", "function rows(list, locale) { return list.map((r) => [r.label, formatPrice(r.amount, 'EUR', locale)].join(' | ')); }", 'module.exports = { rows };'],
  'src/reports/monthly.js': ["const fmt = require('../format/price.js');", 'function monthly(byMonth, args) {', "  // args is [currency, locale], as stored in the report settings", "  return Object.entries(byMonth).map(([m, v]) => m + ' ' + fmt.formatPrice(v, ...args)).join('; ');", '}', 'module.exports = { monthly };'],
  'src/reports/refunds.js': ["const { formatPrice } = require('../format/price.js');", "const yen = (n) => formatPrice.apply(null, [n, 'JPY']);", "function refunds(list) { return list.map((n) => yen(-Math.abs(n))); }", 'module.exports = { refunds };'],
  'src/email/receipt.js': ["const { formatPrice } = require('../format/price.js');", "const gbp = (n, locale) => formatPrice(n, 'GBP', locale);", "function receipt(order) { return 'Thanks! You paid ' + gbp(order.paid) + (order.tip ? ' plus ' + gbp(order.tip, order.locale) + ' tip' : '') + '.'; }", 'module.exports = { receipt };'],
  'src/admin/export.js': ["const formatters = { money: require('../format/price.js').formatPrice };", "function exportRow(row) { return [row.id, formatters.money(row.net, row.currency, row.locale), formatters.money(row.tax, row.currency, row.locale)].join(','); }", 'module.exports = { exportRow };'],
};
const CALLERS_TEST = J([
  "'use strict';",
  "const assert = require('node:assert');",
  "const { formatPrice } = require('../src/format/price.js');",
  "const { line } = require('../src/cart/line.js');",
  "const { due } = require('../src/invoice/header.js');",
  '',
  "assert.strictEqual(formatPrice(1234.5, { currency: 'EUR', locale: 'de' }), '1.234,50 €');",
  "assert.strictEqual(formatPrice(5), '$5.00');",
  "assert.strictEqual(line({ name: 'Pen', price: 1.5, qty: 4, currency: 'GBP' }), 'Pen: £6.00');",
  "assert.strictEqual(due(99), 'Amount due: $99.00');",
  "console.log('ok - callers');",
]);
const CALLERS_GRADER = `${HARNESS}
const { formatPrice } = require('./src/format/price.js');
t('the new form', () => { assert.strictEqual(formatPrice(1234.5, { currency: 'EUR', locale: 'de' }), '1.234,50 €'); assert.strictEqual(formatPrice(5), '$5.00'); assert.strictEqual(formatPrice(5, {}), '$5.00'); assert.strictEqual(formatPrice(-1200, { currency: 'JPY' }), '-¥1,200'); assert.strictEqual(formatPrice(7, { locale: 'de' }), '7,00 $'); });
t('the old form is refused', () => { for (const bad of [['EUR'], ['EUR', 'de'], [null], [42]]) assert.throws(() => formatPrice(1, ...bad), (e) => e instanceof TypeError && e.message === 'formatPrice: options must be an object', JSON.stringify(bad)); });
t('amount is still checked', () => { assert.throws(() => formatPrice('5'), TypeError); assert.throws(() => formatPrice(NaN, {}), TypeError); });
t('cart line', () => { const { line } = require('./src/cart/line.js'); assert.strictEqual(line({ name: 'Pen', price: 1.5, qty: 4, currency: 'GBP' }), 'Pen: £6.00'); assert.strictEqual(line({ name: 'Ink', price: 3, qty: 1 }), 'Ink: $3.00'); });
t('cart total', () => { const { total } = require('./src/cart/total.js'); assert.strictEqual(total([{ price: 1000, qty: 2 }], 'EUR', 'de'), 'Total 2.000,00 €'); assert.strictEqual(total([{ price: 2, qty: 2 }]), 'Total $4.00'); });
t('invoice header', () => { assert.strictEqual(require('./src/invoice/header.js').due(1234567.891), 'Amount due: $1,234,567.89'); });
t('invoice rows', () => { const { rows } = require('./src/invoice/rows.js'); assert.deepStrictEqual(rows([{ label: 'A', amount: 10 }, { label: 'B', amount: 2500.5 }], 'de'), ['A | 10,00 €', 'B | 2.500,50 €']); assert.deepStrictEqual(rows([{ label: 'A', amount: 10 }]), ['A | €10.00']); });
t('monthly report', () => { const { monthly } = require('./src/reports/monthly.js'); assert.strictEqual(monthly({ Jan: 10, Feb: 2000 }, ['EUR', 'de']), 'Jan 10,00 €; Feb 2.000,00 €'); assert.strictEqual(monthly({ Mar: 3 }, []), 'Mar $3.00'); assert.strictEqual(monthly({ Apr: 4 }, ['GBP']), 'Apr £4.00'); });
t('refunds', () => { assert.deepStrictEqual(require('./src/reports/refunds.js').refunds([1200, 50]), ['-¥1,200', '-¥50']); });
t('receipt', () => { const { receipt } = require('./src/email/receipt.js'); assert.strictEqual(receipt({ paid: 20 }), 'Thanks! You paid £20.00.'); assert.strictEqual(receipt({ paid: 20, tip: 2.5, locale: 'de' }), 'Thanks! You paid £20.00 plus 2,50 £ tip.'); });
t('admin export', () => { assert.strictEqual(require('./src/admin/export.js').exportRow({ id: 7, net: 100, tax: 19, currency: 'EUR', locale: 'de' }), '7,100,00 €,19,00 €'); });
console.log(JSON.stringify(R));`;

// ---------------------------------------------------------------------------
// 5. make-it-fast
// ---------------------------------------------------------------------------
const DEDUPE_SRC = J([
  "'use strict';",
  '',
  '// The k ids that appear most often in `records` (each record is { id, ... }).',
  '// Only ids seen more than once are returned. Most frequent first; ids with the',
  '// same count keep the order in which they first appeared. -> [{ id, count }]',
  'function topDuplicates(records, k) {',
  '  const out = [];',
  '  for (const r of records) {',
  '    if (out.some((o) => o.id === r.id)) continue;',
  '    const count = records.filter((x) => x.id === r.id).length;',
  '    if (count > 1) out.push({ id: r.id, count });',
  '  }',
  '  for (let i = 0; i < out.length; i++) {',
  '    for (let j = 0; j < out.length - 1 - i; j++) {',
  '      if (out[j].count < out[j + 1].count) { const t = out[j]; out[j] = out[j + 1]; out[j + 1] = t; }',
  '    }',
  '  }',
  '  return out.slice(0, k);',
  '}',
  '',
  'module.exports = { topDuplicates };',
]);
const DEDUPE_TEST = J([
  "'use strict';",
  "const assert = require('node:assert');",
  "const { topDuplicates } = require('../src/dedupe.js');",
  '',
  "const recs = ['a', 'b', 'a', 'c', 'b', 'a', 'd', 'c'].map((id) => ({ id }));",
  "assert.deepStrictEqual(topDuplicates(recs, 2), [{ id: 'a', count: 3 }, { id: 'b', count: 2 }]);",
  "assert.deepStrictEqual(topDuplicates(recs, 10), [{ id: 'a', count: 3 }, { id: 'b', count: 2 }, { id: 'c', count: 2 }]);",
  "assert.deepStrictEqual(topDuplicates([], 3), []);",
  "console.log('ok - dedupe');",
]);
const DEDUPE_BENCH = J([
  "'use strict';",
  "const { topDuplicates } = require('./src/dedupe.js');",
  '',
  'let seed = 42;',
  'const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;',
  "const records = Array.from({ length: 60000 }, (_, i) => ({ id: 'u' + Math.floor(rand() * 20000), n: i }));",
  'const t0 = Date.now();',
  'const top = topDuplicates(records, 5);',
  "console.log(JSON.stringify(top), (Date.now() - t0) + 'ms');",
]);
const DEDUPE_GRADER = `${HARNESS}
const { topDuplicates } = require('./src/dedupe.js');
function slow(records, k) { const out = []; for (const r of records) { if (out.some((o) => o.id === r.id)) continue; const count = records.filter((x) => x.id === r.id).length; if (count > 1) out.push({ id: r.id, count }); } out.sort((a, b) => b.count - a.count); return out.slice(0, k); }
let seed = 7; const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
t('same answers as before, order included', () => { for (let round = 0; round < 40; round++) { const n = Math.floor(rand() * 300), ids = 1 + Math.floor(rand() * 40); const recs = Array.from({ length: n }, (_, i) => ({ id: (rand() < 0.2 ? 7 : 'x') + Math.floor(rand() * ids), n: i })); for (const k of [0, 1, 3, 1000]) assert.deepStrictEqual(topDuplicates(recs, k), slow(recs, k), 'round ' + round + ' k=' + k); } });
t('ids are compared exactly (1 is not "1")', () => { const recs = [{ id: 1 }, { id: '1' }, { id: 1 }, { id: '1' }, { id: '1' }]; assert.deepStrictEqual(topDuplicates(recs, 5), [{ id: '1', count: 3 }, { id: 1, count: 2 }]); });
t('the input is not changed', () => { const recs = ['b', 'a', 'b', 'a'].map((id) => ({ id })); const copy = JSON.stringify(recs); topDuplicates(recs, 2); assert.strictEqual(JSON.stringify(recs), copy); });
console.log(JSON.stringify(R));`;
// On its own, with a short limit: the slow version would otherwise hold the grader for minutes.
const DEDUPE_SPEED = `${HARNESS}
const { topDuplicates } = require('./src/dedupe.js');
let seed = 7; const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
t('150,000 records in under 3 seconds', () => { const recs = Array.from({ length: 150000 }, (_, i) => ({ id: 'u' + Math.floor(rand() * 50000), n: i })); const t0 = Date.now(); const top = topDuplicates(recs, 5); const ms = Date.now() - t0; assert.strictEqual(top.length, 5); assert.ok(top[0].count >= top[4].count); assert.ok(ms < 3000, 'took ' + ms + 'ms'); });
console.log(JSON.stringify(R));`;

// ---------------------------------------------------------------------------
// 6. tool-from-a-spec
// ---------------------------------------------------------------------------
const MIGRATION_DOC = J([
  '# Config migration: version 1 to version 2',
  '',
  '    node tools/migrate.js <inDir> <outDir>',
  '',
  'Converts every `*.json` file directly inside `<inDir>` (not in subfolders) and writes the',
  'result to `<outDir>` under the same file name. `<outDir>` is created when missing.',
  'Files are handled in alphabetical order. For each file it prints one line:',
  '',
  '    ok <file name>',
  '    skip <file name>: <reason>',
  '',
  'It exits 0 when every file was converted and 1 when at least one was skipped.',
  'A skipped file gets NO output file.',
  '',
  '## Version 2 shape',
  '',
  'Keys in exactly this order, 2-space indent, a newline at the end of the file:',
  '',
  '    { "version": 2, "name", "server": { "host", "port" }, "logging": { "level" }, "tags", "timeoutMs" }',
  '',
  '## Rules',
  '',
  '| v1 field  | v2 field        | rule |',
  '|-----------|-----------------|------|',
  '| `name`    | `name`          | A non-empty string after trimming, stored trimmed. Otherwise skip: `missing name` |',
  '| `port`    | `server.port`   | A number or a string of digits, a whole number from 1 to 65535. Otherwise skip: `invalid port` |',
  '| `host`    | `server.host`   | Default `"localhost"` |',
  '| `debug`   | `logging.level` | `true`, `"true"` or `"yes"` (any letter case) gives `"debug"`; anything else, or missing, gives `"info"` |',
  '| `tags`    | `tags`          | An array, or one string with commas. Each tag trimmed and lowercased; empty ones dropped; no repeats; sorted A to Z. Default `[]` |',
  '| `timeout` | `timeoutMs`     | A number is seconds. `"30s"` is seconds, `"5m"` is minutes, `"250ms"` is milliseconds. Default 30000. Anything else skip: `invalid timeout` |',
  '',
  'Other cases:',
  '',
  '- A file that is not valid JSON, or whose JSON is not an object: skip, reason `invalid json`.',
  '- A file that already has `"version": 2` is copied byte for byte and reported `ok`.',
  '- Reasons are checked in this order: invalid json, missing name, invalid port, invalid timeout.',
  '',
  'There are samples in `examples/v1` with the expected results in `examples/expected`.',
]);
const MIG_EXAMPLES = {
  'examples/v1/api.json': `${JSON.stringify({ name: 'api', port: 8080, host: 'api.internal', debug: true, tags: ['Web', 'core'], timeout: 45 }, null, 2)}\n`,
  'examples/v1/worker.json': `${JSON.stringify({ name: ' worker ', port: '9000', tags: 'batch, Queue', timeout: '5m' }, null, 2)}\n`,
  'examples/v1/broken.json': '{ "name": "broken", "port": 80,\n',
  'examples/expected/api.json': `${JSON.stringify({ version: 2, name: 'api', server: { host: 'api.internal', port: 8080 }, logging: { level: 'debug' }, tags: ['core', 'web'], timeoutMs: 45000 }, null, 2)}\n`,
  'examples/expected/worker.json': `${JSON.stringify({ version: 2, name: 'worker', server: { host: 'localhost', port: 9000 }, logging: { level: 'info' }, tags: ['batch', 'queue'], timeoutMs: 300000 }, null, 2)}\n`,
};
const MIG_GRADER = `${HARNESS}
const fs = require('fs'), path = require('path'), os = require('os'), { spawnSync } = require('child_process');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-mig-'));
const run = (files) => { const dir = fs.mkdtempSync(path.join(base, 'case-')); const inD = path.join(dir, 'in'), outD = path.join(dir, 'made', 'out'); fs.mkdirSync(inD); for (const [n, v] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(inD, n)), { recursive: true }); fs.writeFileSync(path.join(inD, n), typeof v === 'string' ? v : JSON.stringify(v)); } const r = spawnSync('node', ['tools/migrate.js', inD, outD], { encoding: 'utf8', timeout: 20000 }); const out = {}; if (fs.existsSync(outD)) for (const n of fs.readdirSync(outD)) out[n] = fs.readFileSync(path.join(outD, n), 'utf8'); return { status: r.status, lines: String(r.stdout).trim().split('\\n').filter(Boolean), out, stderr: r.stderr }; };
const v2 = (name, host, port, level, tags, timeoutMs) => JSON.stringify({ version: 2, name, server: { host, port }, logging: { level }, tags, timeoutMs }, null, 2) + '\\n';
t('converts a full file', () => { const r = run({ 'svc.json': { name: 'svc', port: 3000, host: 'h', debug: 'YES', tags: [' B', 'a', 'A', ''], timeout: '250ms' } }); assert.strictEqual(r.status, 0, r.stderr); assert.deepStrictEqual(r.lines, ['ok svc.json']); assert.strictEqual(r.out['svc.json'], v2('svc', 'h', 3000, 'debug', ['a', 'b'], 250)); });
t('defaults', () => { const r = run({ 'd.json': { name: 'd', port: '65535' } }); assert.strictEqual(r.out['d.json'], v2('d', 'localhost', 65535, 'info', [], 30000)); });
t('tags from one string, timeouts in every unit', () => { const r = run({ 'a.json': { name: 'a', port: 1, tags: ' B, a ,,A, c', timeout: '2m' }, 'b.json': { name: 'b', port: 2, timeout: '90s', debug: 'no' }, 'c.json': { name: 'c', port: 3, timeout: 1.5, debug: 'True' } }); assert.strictEqual(r.out['a.json'], v2('a', 'localhost', 1, 'info', ['a', 'b', 'c'], 120000)); assert.strictEqual(r.out['b.json'], v2('b', 'localhost', 2, 'info', [], 90000)); assert.strictEqual(r.out['c.json'], v2('c', 'localhost', 3, 'debug', [], 1500)); assert.deepStrictEqual(r.lines, ['ok a.json', 'ok b.json', 'ok c.json']); });
t('skips with the right reason, in order, and exits 1', () => { const r = run({ 'a-bad.json': '{ nope', 'b-list.json': '[1,2]', 'c-noname.json': { port: 99999, name: '   ' }, 'd-port0.json': { name: 'x', port: 0, timeout: 'soon' }, 'e-port.json': { name: 'x', port: '80a' }, 'f-float.json': { name: 'x', port: 80.5 }, 'g-time.json': { name: 'x', port: 80, timeout: '5h' }, 'h-good.json': { name: 'ok', port: 80 } }); assert.strictEqual(r.status, 1); assert.deepStrictEqual(r.lines, ['skip a-bad.json: invalid json', 'skip b-list.json: invalid json', 'skip c-noname.json: missing name', 'skip d-port0.json: invalid port', 'skip e-port.json: invalid port', 'skip f-float.json: invalid port', 'skip g-time.json: invalid timeout', 'ok h-good.json']); assert.deepStrictEqual(Object.keys(r.out), ['h-good.json']); });
t('a version 2 file is copied byte for byte', () => { const raw = '{"version":2,   "name":"kept","server":{"host":"h","port":1}}'; const r = run({ 'k.json': raw }); assert.strictEqual(r.status, 0); assert.strictEqual(r.out['k.json'], raw); });
t('only .json files directly in the folder', () => { const r = run({ 'a.json': { name: 'a', port: 1 }, 'notes.txt': 'hello', 'sub/deep.json': { name: 'deep', port: 2 } }); assert.deepStrictEqual(r.lines, ['ok a.json']); assert.deepStrictEqual(Object.keys(r.out), ['a.json']); });
t('the samples give the expected files', () => { const dir = fs.mkdtempSync(path.join(base, 'ex-')); const r = spawnSync('node', ['tools/migrate.js', 'examples/v1', dir], { encoding: 'utf8', timeout: 20000 }); assert.strictEqual(r.status, 1); for (const n of ['api.json', 'worker.json']) assert.strictEqual(fs.readFileSync(path.join(dir, n), 'utf8'), fs.readFileSync(path.join('examples/expected', n), 'utf8'), n); assert.ok(!fs.existsSync(path.join(dir, 'broken.json'))); });
fs.rmSync(base, { recursive: true, force: true });
console.log(JSON.stringify(R));`;

export const HARD_TASKS = [
  {
    id: 'contract-wider-than-test',
    name: 'Build a cache to a written contract that its test only partly covers',
    category: 'implement',
    hard: true,
    prompt: [
      'Implement `src/cache.js` so it meets the contract in `docs/cache-spec.md`.',
      '',
      '`node test/cache.test.js` must exit 0, but that test covers only a small part of the contract.',
      'The contract is what counts: every rule in it will be checked.',
      '',
      'Do not edit anything under test/ or docs/.',
    ].join('\n'),
    setup(ws) {
      writeWs(ws, 'package.json', `${JSON.stringify({ name: 'edge-cache', version: '0.4.0', scripts: { test: 'node test/cache.test.js' } }, null, 2)}\n`);
      writeWs(ws, 'docs/cache-spec.md', CACHE_SPEC);
      writeWs(ws, 'src/cache.js', J(["'use strict';", '', '// See docs/cache-spec.md.', 'function createCache() {', "  throw new Error('not implemented');", '}', '', 'module.exports = { createCache };']));
      writeWs(ws, 'test/cache.test.js', CACHE_TEST);
    },
    async verify({ ws }) {
      const visible = runIn(ws, 'node', ['test/cache.test.js']);
      const checks = [check('node test/cache.test.js exits 0', visible.exit === 0, `exit=${visible.exit} ${visible.stderr}`), unchanged(ws, 'test/cache.test.js', CACHE_TEST), unchanged(ws, 'docs/cache-spec.md', CACHE_SPEC), ...grade(ws, CACHE_GRADER)];
      return verdict(checks, 'the cache meets every rule of its contract', 'the cache does not meet its contract');
    },
    timeoutMs: 420_000,
  },
  {
    id: 'cause-not-symptom',
    name: 'Fix a wrong total at its cause, and a second fault the test does not show',
    category: 'debug',
    hard: true,
    prompt: [
      '`node test/report.test.js` fails: an order total comes out wrong.',
      '',
      'Find where the wrong number really comes from and fix it there, not where it shows up.',
      'Then read `docs/pricing.md` and make sure the code under src/ follows every rule in it:',
      'the test covers one case only, and the rules are what will be checked.',
      '',
      'Do not edit anything under test/ or docs/.',
    ].join('\n'),
    setup(ws) {
      writeWs(ws, 'package.json', `${JSON.stringify({ name: 'till', version: '2.1.0', scripts: { test: 'node test/report.test.js' } }, null, 2)}\n`);
      writeWs(ws, 'docs/pricing.md', PRICING_DOC);
      writeWs(ws, 'src/money.js', J(["'use strict';", '', '// "19.99" -> 1999', 'function toCents(text) {', '  return Math.floor(parseFloat(text) * 100);', '}', '', "function fromCents(cents) {", "  const sign = cents < 0 ? '-' : '';", "  const abs = Math.abs(cents);", "  return sign + '$' + Math.floor(abs / 100) + '.' + String(abs % 100).padStart(2, '0');", '}', '', 'module.exports = { toCents, fromCents };']));
      writeWs(ws, 'src/cart.js', J(["'use strict';", '', "const { toCents } = require('./money.js');", '', 'const amount = (line) => toCents(line.price) * (line.qty ?? 1);', '', '// Sum of the discounts, in cents.', 'function discounts(lines) {', '  const subtotal = lines.reduce((s, l) => s + amount(l), 0);', '  const percent = lines.reduce((s, l) => s + (l.discountPercent ?? 0) * amount(l), 0) / (subtotal || 1);', '  return Math.round(subtotal * percent / 100);', '}', '', 'function total(lines) {', '  return lines.reduce((s, l) => s + amount(l), 0) - discounts(lines);', '}', '', 'module.exports = { total, discounts };']));
      writeWs(ws, 'src/report.js', J(["'use strict';", '', "const { total } = require('./cart.js');", "const { fromCents } = require('./money.js');", '', 'function summary(lines) {', "  return 'Total: ' + fromCents(total(lines));", '}', '', 'module.exports = { summary };']));
      writeWs(ws, 'test/report.test.js', REPORT_TEST);
    },
    async verify({ ws }) {
      const visible = runIn(ws, 'node', ['test/report.test.js']);
      const checks = [check('node test/report.test.js exits 0', visible.exit === 0, `exit=${visible.exit} ${visible.stderr}`), unchanged(ws, 'test/report.test.js', REPORT_TEST), unchanged(ws, 'docs/pricing.md', PRICING_DOC), ...grade(ws, PRICING_GRADER)];
      return verdict(checks, 'money is exact and discounts follow the pricing rules', 'the pricing rules are not all met');
    },
    timeoutMs: 420_000,
  },
  {
    id: 'lost-updates',
    name: 'Fix lost updates under concurrency without serialising everything',
    category: 'debug',
    hard: true,
    prompt: [
      'Calls to `increment` in `src/counter.js` that run at the same time lose updates:',
      '`node test/race.test.js` shows it.',
      '',
      'Fix `src/counter.js` so that:',
      '1. every increment on the same key is applied, however many run at once;',
      '2. increments on different keys still run at the same time (do not make everything wait in one line);',
      '3. when a database write fails, only that call rejects: later calls still work and the count stays right;',
      '4. two different `db` objects never affect each other.',
      '',
      'Keep the signature `increment(db, key, by = 1)` and its return value (the new number).',
      'Do not edit anything under test/.',
    ].join('\n'),
    setup(ws) {
      writeWs(ws, 'package.json', `${JSON.stringify({ name: 'visit-counter', version: '1.0.3', scripts: { test: 'node test/race.test.js' } }, null, 2)}\n`);
      writeWs(ws, 'src/counter.js', COUNTER_SRC);
      writeWs(ws, 'test/race.test.js', RACE_TEST);
    },
    async verify({ ws }) {
      const visible = runIn(ws, 'node', ['test/race.test.js']);
      const checks = [check('node test/race.test.js exits 0', visible.exit === 0, `exit=${visible.exit} ${visible.stderr}`), unchanged(ws, 'test/race.test.js', RACE_TEST), ...grade(ws, RACE_GRADER)];
      return verdict(checks, 'no update is lost and keys do not wait for each other', 'increments are still lost, serialised, or stuck after a failure');
    },
    timeoutMs: 420_000,
  },
  {
    id: 'change-across-callers',
    name: 'Change a function signature and update every caller, however it is called',
    category: 'refactor',
    hard: true,
    prompt: [
      'Change `formatPrice` in `src/format/price.js` from',
      '',
      '    formatPrice(amount, currency, locale)',
      'to',
      '    formatPrice(amount, { currency, locale })',
      '',
      'with the same defaults (USD, en) and the options argument optional.',
      'A call in the old form must throw `TypeError` with the message `formatPrice: options must be an object`',
      '(anything given as the second argument that is not a plain object).',
      '',
      'Then update EVERY caller in the repository so each one behaves exactly as it did before.',
      'They do not all call it the same way. `node test/callers.test.js` checks only two of them.',
      'Do not edit anything under test/.',
    ].join('\n'),
    setup(ws) {
      writeWs(ws, 'package.json', `${JSON.stringify({ name: 'storefront', version: '5.2.0', scripts: { test: 'node test/callers.test.js' } }, null, 2)}\n`);
      writeWs(ws, 'src/format/price.js', FORMAT_SRC);
      for (const [rel, lines] of Object.entries(CALLERS)) writeWs(ws, rel, J(["'use strict';", '', ...lines]));
      writeWs(ws, 'test/callers.test.js', CALLERS_TEST);
    },
    async verify({ ws }) {
      const visible = runIn(ws, 'node', ['test/callers.test.js']);
      const checks = [check('node test/callers.test.js exits 0', visible.exit === 0, `exit=${visible.exit} ${visible.stderr}`), unchanged(ws, 'test/callers.test.js', CALLERS_TEST), ...grade(ws, CALLERS_GRADER)];
      return verdict(checks, 'the new signature is in place and all eight callers behave as before', 'a caller was missed or the signature is not as asked');
    },
    timeoutMs: 420_000,
  },
  {
    id: 'make-it-fast',
    name: 'Make a slow function fast with exactly the same results',
    category: 'performance',
    hard: true,
    prompt: [
      '`node bench.js` runs `topDuplicates` from `src/dedupe.js` on 60,000 records and takes far too long.',
      '',
      'Make `src/dedupe.js` fast enough that 150,000 records take under 3 seconds,',
      'with exactly the same results as now: the same items, the same counts, the same order',
      '(the comment above the function says what the order is).',
      '',
      '`node test/dedupe.test.js` must still exit 0. Do not edit bench.js or anything under test/.',
    ].join('\n'),
    setup(ws) {
      writeWs(ws, 'package.json', `${JSON.stringify({ name: 'record-tools', version: '0.9.1', scripts: { test: 'node test/dedupe.test.js' } }, null, 2)}\n`);
      writeWs(ws, 'src/dedupe.js', DEDUPE_SRC);
      writeWs(ws, 'test/dedupe.test.js', DEDUPE_TEST);
      writeWs(ws, 'bench.js', DEDUPE_BENCH);
    },
    async verify({ ws }) {
      const visible = runIn(ws, 'node', ['test/dedupe.test.js']);
      const checks = [check('node test/dedupe.test.js exits 0', visible.exit === 0, `exit=${visible.exit} ${visible.stderr}`), unchanged(ws, 'test/dedupe.test.js', DEDUPE_TEST), ...grade(ws, DEDUPE_GRADER, { timeoutMs: 45_000 })];
      const speed = grade(ws, DEDUPE_SPEED, { timeoutMs: 10_000 });
      checks.push(...(speed.length === 1 && speed[0].name === 'the grader ran' ? [check('150,000 records in under 3 seconds', false, 'still running after 10 seconds')] : speed));
      return verdict(checks, 'the same results, fast', 'results changed or it is still too slow');
    },
    timeoutMs: 420_000,
  },
  {
    id: 'tool-from-a-spec',
    name: 'Write a command-line migration tool from its written rules',
    category: 'create',
    hard: true,
    prompt: [
      'Write `tools/migrate.js`, a Node script with no dependencies, that does what `docs/migration.md` describes.',
      '',
      'It will be run on folders of files you have not seen, so follow the rules in the document,',
      'not only the samples in `examples/`. Output files, printed lines and the exit code are all checked.',
      '',
      'Do not edit anything under docs/ or examples/.',
    ].join('\n'),
    setup(ws) {
      writeWs(ws, 'package.json', `${JSON.stringify({ name: 'config-tools', version: '1.0.0' }, null, 2)}\n`);
      writeWs(ws, 'docs/migration.md', MIGRATION_DOC);
      for (const [rel, body] of Object.entries(MIG_EXAMPLES)) writeWs(ws, rel, body);
    },
    async verify({ ws }) {
      const checks = [check('tools/migrate.js exists', existsWs(ws, 'tools/migrate.js'), 'the script was not written'), unchanged(ws, 'docs/migration.md', MIGRATION_DOC), ...Object.entries(MIG_EXAMPLES).map(([rel, body]) => unchanged(ws, rel, body))];
      if (checks[0].ok) checks.push(...grade(ws, MIG_GRADER, { timeoutMs: 90_000 }));
      return verdict(checks, 'the tool follows every migration rule on unseen files', 'the tool does not follow the migration rules');
    },
    timeoutMs: 480_000,
  },
];
