// The harder benchmark tasks grade themselves honestly: the starting state fails,
// the obvious shortcut fails, and a reference solution passes (so each is solvable).
// No model runs here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HARD_TASKS } from '../bench/real/tasks-hard.mjs';
import { REAL_TASKS, TASK_IDS } from '../bench/real/tasks.mjs';

const J = (lines) => `${lines.join('\n')}\n`;
const write = (ws, rel, body) => { fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true }); fs.writeFileSync(path.join(ws, rel), body); };
const edit = (ws, rel, from, to) => { const p = path.join(ws, rel); const s = fs.readFileSync(p, 'utf8'); assert.ok(s.includes(from), `${rel} has: ${from}`); fs.writeFileSync(p, s.replace(from, to)); };

// What a correct agent would leave behind, per task.
const SOLVE = {
  'contract-wider-than-test': (ws) => write(ws, 'src/cache.js', J([
    "'use strict';",
    'function createCache({ max, ttlMs = 0, now = Date.now } = {}) {',
    "  if (!Number.isInteger(max) || max < 1) throw new RangeError('max must be a positive integer');",
    '  const m = new Map();',
    '  const live = (e) => !e.ttl || now() - e.at < e.ttl;',
    '  const sweep = () => { for (const [k, e] of m) if (!live(e)) m.delete(k); };',
    '  return {',
    '    set(key, value, opts = {}) { m.delete(key); m.set(key, { value, at: now(), ttl: opts.ttlMs ?? ttlMs }); sweep(); while (m.size > max) m.delete(m.keys().next().value); },',
    '    get(key) { const e = m.get(key); if (!e) return undefined; if (!live(e)) { m.delete(key); return undefined; } m.delete(key); m.set(key, e); return e.value; },',
    '    has(key) { const e = m.get(key); return !!e && live(e); },',
    '    delete(key) { const e = m.get(key); const was = !!e && live(e); m.delete(key); return was; },',
    '    size() { sweep(); return m.size; },',
    '    keys() { sweep(); return [...m.keys()]; },',
    '  };',
    '}',
    'module.exports = { createCache };',
  ])),
  'cause-not-symptom': (ws) => {
    edit(ws, 'src/money.js', 'Math.floor(parseFloat(text) * 100)', 'Math.round(parseFloat(text) * 100)');
    edit(ws, 'src/cart.js', J(['  const subtotal = lines.reduce((s, l) => s + amount(l), 0);', '  const percent = lines.reduce((s, l) => s + (l.discountPercent ?? 0) * amount(l), 0) / (subtotal || 1);', '  return Math.round(subtotal * percent / 100);']),
      '  return lines.reduce((s, l) => s + Math.floor((amount(l) * (l.discountPercent ?? 0) + 50) / 100), 0);\n');
  },
  'lost-updates': (ws) => write(ws, 'src/counter.js', J([
    "'use strict';",
    'const queues = new WeakMap();',
    'function increment(db, key, by = 1) {',
    '  let q = queues.get(db);',
    '  if (!q) queues.set(db, (q = new Map()));',
    '  const run = (q.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {',
    '    const next = ((await db.read(key)) ?? 0) + by;',
    '    await db.write(key, next);',
    '    return next;',
    '  });',
    '  q.set(key, run);',
    '  run.catch(() => {}).finally(() => { if (q.get(key) === run) q.delete(key); });',
    '  return run;',
    '}',
    'module.exports = { increment };',
  ])),
  'change-across-callers': (ws) => {
    edit(ws, 'src/format/price.js', "function formatPrice(amount, currency = 'USD', locale = 'en') {", J(['function formatPrice(amount, options = {}) {', "  if (options === null || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('formatPrice: options must be an object');", "  const { currency = 'USD', locale = 'en' } = options;"]).trimEnd());
    edit(ws, 'src/cart/line.js', 'formatPrice(item.price * item.qty, item.currency)', 'formatPrice(item.price * item.qty, { currency: item.currency })');
    edit(ws, 'src/cart/total.js', '0), currency, locale)', '0), { currency, locale })');
    edit(ws, 'src/invoice/rows.js', "formatPrice(r.amount, 'EUR', locale)", "formatPrice(r.amount, { currency: 'EUR', locale })");
    edit(ws, 'src/reports/monthly.js', 'fmt.formatPrice(v, ...args)', 'fmt.formatPrice(v, { currency: args[0], locale: args[1] })');
    edit(ws, 'src/reports/refunds.js', "formatPrice.apply(null, [n, 'JPY'])", "formatPrice(n, { currency: 'JPY' })");
    edit(ws, 'src/email/receipt.js', "formatPrice(n, 'GBP', locale)", "formatPrice(n, { currency: 'GBP', locale })");
    edit(ws, 'src/admin/export.js', 'formatters.money(row.net, row.currency, row.locale), formatters.money(row.tax, row.currency, row.locale)', 'formatters.money(row.net, { currency: row.currency, locale: row.locale }), formatters.money(row.tax, { currency: row.currency, locale: row.locale })');
  },
  'make-it-fast': (ws) => write(ws, 'src/dedupe.js', J([
    "'use strict';",
    'function topDuplicates(records, k) {',
    '  const counts = new Map();',
    '  for (const r of records) counts.set(r.id, (counts.get(r.id) ?? 0) + 1);',
    '  const out = [];',
    '  for (const [id, count] of counts) if (count > 1) out.push({ id, count });',
    '  out.sort((a, b) => b.count - a.count);',
    '  return out.slice(0, k);',
    '}',
    'module.exports = { topDuplicates };',
  ])),
  'tool-from-a-spec': (ws) => write(ws, 'tools/migrate.js', J([
    "'use strict';",
    "const fs = require('fs'), path = require('path');",
    'const [inDir, outDir] = process.argv.slice(2);',
    'fs.mkdirSync(outDir, { recursive: true });',
    'function convert(raw) {',
    '  let v; try { v = JSON.parse(raw); } catch { return { skip: "invalid json" }; }',
    '  if (v === null || typeof v !== "object" || Array.isArray(v)) return { skip: "invalid json" };',
    '  if (v.version === 2) return { text: raw };',
    '  const name = typeof v.name === "string" ? v.name.trim() : "";',
    '  if (!name) return { skip: "missing name" };',
    '  const port = typeof v.port === "number" ? v.port : typeof v.port === "string" && /^\\d+$/.test(v.port) ? Number(v.port) : NaN;',
    '  if (!Number.isInteger(port) || port < 1 || port > 65535) return { skip: "invalid port" };',
    '  let timeoutMs = 30000;',
    '  if (v.timeout !== undefined) {',
    '    const m = typeof v.timeout === "string" ? /^(\\d+(?:\\.\\d+)?)(ms|s|m)$/.exec(v.timeout) : null;',
    '    if (typeof v.timeout === "number" && Number.isFinite(v.timeout)) timeoutMs = v.timeout * 1000;',
    '    else if (m) timeoutMs = Number(m[1]) * { ms: 1, s: 1000, m: 60000 }[m[2]];',
    '    else return { skip: "invalid timeout" };',
    '  }',
    '  const debug = v.debug === true || (typeof v.debug === "string" && ["true", "yes"].includes(v.debug.toLowerCase()));',
    '  const list = Array.isArray(v.tags) ? v.tags : typeof v.tags === "string" ? v.tags.split(",") : [];',
    '  const tags = [...new Set(list.map((t) => String(t).trim().toLowerCase()).filter(Boolean))].sort();',
    '  const out = { version: 2, name, server: { host: v.host ?? "localhost", port }, logging: { level: debug ? "debug" : "info" }, tags, timeoutMs };',
    '  return { text: JSON.stringify(out, null, 2) + "\\n" };',
    '}',
    'let skipped = 0;',
    'for (const f of fs.readdirSync(inDir).filter((n) => n.endsWith(".json") && fs.statSync(path.join(inDir, n)).isFile()).sort()) {',
    '  const r = convert(fs.readFileSync(path.join(inDir, f), "utf8"));',
    '  if (r.skip) { skipped++; console.log("skip " + f + ": " + r.skip); continue; }',
    '  fs.writeFileSync(path.join(outDir, f), r.text);',
    '  console.log("ok " + f);',
    '}',
    'process.exit(skipped ? 1 : 0);',
  ])),
};

// The quick way out that makes the visible test pass and nothing more.
const SHORTCUT = {
  'contract-wider-than-test': (ws) => write(ws, 'src/cache.js', J(["'use strict';", 'function createCache({ max }) {', '  const m = new Map();', '  return { set(k, v) { m.delete(k); m.set(k, v); if (m.size > max) m.delete(m.keys().next().value); }, get(k) { if (!m.has(k)) return undefined; const v = m.get(k); m.delete(k); m.set(k, v); return v; }, has: (k) => m.has(k), delete: (k) => m.delete(k), size: () => m.size, keys: () => [...m.keys()] };', '}', 'module.exports = { createCache };'])),
  // Patch where the wrong number shows, not where it comes from.
  'cause-not-symptom': (ws) => edit(ws, 'src/report.js', "return 'Total: ' + fromCents(total(lines));", "const cents = total(lines); return 'Total: ' + fromCents(cents === 5994 ? 5997 : cents);"),
  // One line for everything: correct counts, but every key waits.
  'lost-updates': (ws) => write(ws, 'src/counter.js', J(["'use strict';", 'let chain = Promise.resolve();', 'function increment(db, key, by = 1) {', '  const run = chain.then(async () => { const next = ((await db.read(key)) ?? 0) + by; await db.write(key, next); return next; });', '  chain = run.catch(() => {});', '  return run;', '}', 'module.exports = { increment };'])),
  // Only the callers the visible test exercises.
  'change-across-callers': (ws) => {
    edit(ws, 'src/format/price.js', "function formatPrice(amount, currency = 'USD', locale = 'en') {", J(['function formatPrice(amount, options = {}) {', "  if (options === null || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('formatPrice: options must be an object');", "  const { currency = 'USD', locale = 'en' } = options;"]).trimEnd());
    edit(ws, 'src/cart/line.js', 'formatPrice(item.price * item.qty, item.currency)', 'formatPrice(item.price * item.qty, { currency: item.currency })');
  },
  // Fast, but keyed by an object, so 1 and "1" become one id.
  'make-it-fast': (ws) => write(ws, 'src/dedupe.js', J(["'use strict';", 'function topDuplicates(records, k) {', '  const counts = {};', '  for (const r of records) counts[r.id] = (counts[r.id] ?? 0) + 1;', '  return Object.entries(counts).filter(([, c]) => c > 1).map(([id, count]) => ({ id, count })).sort((a, b) => b.count - a.count).slice(0, k);', '}', 'module.exports = { topDuplicates };'])),
  // Written from the samples alone.
  'tool-from-a-spec': (ws) => write(ws, 'tools/migrate.js', J(["'use strict';", "const fs = require('fs'), path = require('path');", 'const [inDir, outDir] = process.argv.slice(2);', 'fs.mkdirSync(outDir, { recursive: true });', 'let bad = 0;', 'for (const f of fs.readdirSync(inDir).filter((n) => n.endsWith(".json")).sort()) {', '  let v; try { v = JSON.parse(fs.readFileSync(path.join(inDir, f), "utf8")); } catch { bad++; console.log("skip " + f + ": invalid json"); continue; }', '  const tags = (Array.isArray(v.tags) ? v.tags : String(v.tags ?? "").split(",")).map((t) => t.trim().toLowerCase()).filter(Boolean).sort();', '  const timeoutMs = typeof v.timeout === "number" ? v.timeout * 1000 : String(v.timeout).endsWith("m") ? parseInt(v.timeout, 10) * 60000 : 30000;', '  fs.writeFileSync(path.join(outDir, f), JSON.stringify({ version: 2, name: String(v.name).trim(), server: { host: v.host ?? "localhost", port: Number(v.port) }, logging: { level: v.debug ? "debug" : "info" }, tags, timeoutMs }, null, 2) + "\\n");', '  console.log("ok " + f);', '}', 'process.exit(bad ? 1 : 0);'])),
};

const fresh = (t, task) => { const ws = fs.mkdtempSync(path.join(os.tmpdir(), `ox-hard-${task.id}-`)); t.after(() => fs.rmSync(ws, { recursive: true, force: true })); task.setup(ws); return ws; };
const failed = (r) => r.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join('\n');

test('the hard tasks are part of the suite, after the first nine', () => {
  assert.equal(HARD_TASKS.length, 6);
  assert.equal(REAL_TASKS.length, 15);
  assert.deepEqual(TASK_IDS.slice(9), HARD_TASKS.map((t) => t.id));
  assert.equal(new Set(TASK_IDS).size, 15, 'no id is used twice');
  for (const t of HARD_TASKS) { assert.equal(t.hard, true); assert.ok(t.prompt.length > 80 && t.timeoutMs >= 240_000 && t.category); assert.ok(SOLVE[t.id] && SHORTCUT[t.id], `${t.id} has a reference solution and a shortcut`); }
  assert.ok(REAL_TASKS.slice(0, 9).every((t) => !t.hard));
});

for (const task of HARD_TASKS) {
  test(`${task.id}: untouched, it fails`, async (t) => {
    const r = await task.verify({ ws: fresh(t, task) });
    assert.equal(r.pass, false);
    assert.ok(r.detail.length > 10, 'a failure says why');
  });
  test(`${task.id}: the shortcut fails on a check the agent never saw`, async (t) => {
    const ws = fresh(t, task);
    SHORTCUT[task.id](ws);
    const r = await task.verify({ ws });
    assert.equal(r.pass, false);
    // Where there is a visible test, the shortcut passes it: only the hidden checks catch it.
    const visible = r.checks.find((c) => /^node test\/.* exits 0$/.test(c.name));
    if (visible) assert.equal(visible.ok, true, `the shortcut should pass the visible test: ${visible.detail}`);
  });
  test(`${task.id}: a reference solution passes every check`, async (t) => {
    const ws = fresh(t, task);
    SOLVE[task.id](ws);
    const r = await task.verify({ ws });
    assert.equal(r.pass, true, failed(r));
  });
  test(`${task.id}: editing the protected files fails it`, async (t) => {
    const ws = fresh(t, task);
    SOLVE[task.id](ws);
    const guarded = (await task.verify({ ws })).checks.find((c) => / was not edited$/.test(c.name)).name.replace(' was not edited', '');
    fs.appendFileSync(path.join(ws, guarded), '\n// touched\n');
    const r = await task.verify({ ws });
    assert.equal(r.pass, false);
    assert.match(failed(r), /was not edited/);
  });
}
