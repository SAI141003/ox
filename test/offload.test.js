// Huge tool results are kept whole in a file; the model gets the start, the end
// and the path, and can read the rest. read_file is never offloaded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { offloadLarge, OFFLOAD_OVER } from '../src/tools/index.js';

test('a long result goes to a file; the model sees the ends and the path', () => {
  const big = `FIRST LINE\n${'x'.repeat(OFFLOAD_OVER * 2)}\nLAST LINE`;
  const r = offloadLarge('bash', { content: big }, {});
  assert.ok(r.content.length < 7000, `sent ${r.content.length} chars`);
  assert.match(r.content, /^FIRST LINE/);
  assert.match(r.content, /LAST LINE$/);
  const file = r.meta.offloaded.file;
  assert.ok(r.content.includes(file));
  assert.equal(fs.readFileSync(file, 'utf8'), big);
  fs.unlinkSync(file);
});

test('short results, read_file and a switched-off run are left alone', () => {
  const short = { content: 'ok' };
  assert.equal(offloadLarge('bash', short, {}), short);
  const big = { content: 'y'.repeat(OFFLOAD_OVER + 1) };
  assert.equal(offloadLarge('read_file', big, {}), big);
  assert.equal(offloadLarge('bash', big, { noOffload: true }), big);
});
