// A small shop project for `ox build` to work on (a real one, with a test).
import fs from 'node:fs';
import path from 'node:path';
const D = process.argv[2];
fs.rmSync(D, { recursive: true, force: true });
fs.mkdirSync(path.join(D, 'src'), { recursive: true });
fs.mkdirSync(path.join(D, 'test'), { recursive: true });
fs.writeFileSync(path.join(D, 'package.json'), JSON.stringify({ name: 'shop', type: 'module', scripts: { test: 'node --test' } }, null, 2));
fs.writeFileSync(path.join(D, 'src/orders.js'), `// Orders: lines of { sku, qty, unitCents }, a customer id, an optional coupon.
export function subtotal(order) {
  return order.lines.reduce((sum, l) => sum + l.qty * l.unitCents, 0);
}

// Coupons: percentage off the subtotal.
export const COUPONS = { WELCOME10: 10, SPRING15: 15 };

export function total(order) {
  const sub = subtotal(order);
  const pct = order.coupon ? COUPONS[order.coupon] ?? 0 : 0;
  return Math.round(sub * (100 - pct) / 100);
}
`);
fs.writeFileSync(path.join(D, 'src/history.js'), `// Past purchases and refunds of a customer: { customerId, at (ISO date), cents, kind: 'purchase' | 'refund' }.
export const LEDGER = [];
export function entriesFor(customerId) {
  return LEDGER.filter((e) => e.customerId === customerId);
}
`);
fs.writeFileSync(path.join(D, 'test/orders.test.js'), `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { total } from '../src/orders.js';
test('a coupon takes its percentage off', () => {
  assert.equal(total({ customerId: 'c1', coupon: 'WELCOME10', lines: [{ sku: 'a', qty: 2, unitCents: 5000 }] }), 9000);
});
`);
console.log('ready', D);
