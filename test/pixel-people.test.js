// The island's pixel cast (desktop/island/Sources/OxIsland/Resources/pixel/people.json,
// written by desktop/island/art/pixel_people.py). Sprite mistakes are silent in
// Swift - a stray pixel just draws - so the data is checked here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const spec = JSON.parse(fs.readFileSync(path.join(here, '..', 'desktop', 'island', 'Sources', 'OxIsland', 'Resources', 'pixel', 'people.json'), 'utf8'));
const DIRS = ['front', 'side', 'back'];

function* layers(node, where) {
  if (Array.isArray(node) && typeof node[0] === 'string') yield [where, node];
  else if (Array.isArray(node)) for (const [i, n] of node.entries()) yield* layers(n, `${where}[${i}]`);
  else if (node && typeof node === 'object') for (const [k, n] of Object.entries(node)) yield* layers(n, `${where}.${k}`);
}

test('every layer is 24 rows of 16 art pixels', () => {
  for (const key of ['heads', 'eyes', 'mouths', 'hair', 'acc', 'bodies']) {
    for (const [where, rows] of layers(spec[key], key)) {
      assert.equal(rows.length, 24, `${where} has ${rows.length} rows`);
      for (const [i, r] of rows.entries()) assert.equal(r.length, 16, `${where} row ${i} is ${r.length} wide`);
    }
  }
});

test('mouths paint only on the lower face (no stray pixels)', () => {
  for (const [where, rows] of layers(spec.mouths, 'mouths')) {
    for (const [y, r] of rows.entries()) {
      for (const [x, ch] of [...r].entries()) {
        if (ch === '.') continue;
        assert.ok(y >= 9 && y <= 11 && x >= 4 && x <= 13, `${where} paints (${x},${y})`);
      }
    }
  }
});

test('every person has a hairstyle for every direction and valid colours', () => {
  for (const [name, p] of Object.entries(spec.people)) {
    for (const d of DIRS) assert.ok(spec.hair[p.style]?.[d], `${name}: hair '${p.style}' has no ${d} view`);
    for (const a of p.acc) assert.ok(spec.acc[a], `${name}: unknown accessory ${a}`);
    for (const [k, v] of Object.entries(p)) if (typeof v === 'string' && v.startsWith('#')) assert.match(v, /^#[0-9A-Fa-f]{6}$/, `${name}.${k}`);
  }
});

test('the poses the island uses all exist', () => {
  const used = { front: ['stand', 'walk', 'wave', 'point', 'open', 'think'], side: ['stand', 'walk'], back: ['stand', 'type', 'read'] };
  for (const [d, poses] of Object.entries(used)) for (const p of poses) assert.ok(spec.bodies[d]?.[p]?.length, `${d}.${p} missing`);
  for (const m of ['rest', 'closed', 'small', 'open', 'wide', 'round', 'smile']) {
    assert.ok(spec.mouths.front[m] && spec.mouths.side[m], `mouth ${m} missing`);
  }
  // The six helpers the office and notch hand out, plus the pasture farmer.
  for (const who of ['mira', 'theo', 'ade', 'lin', 'sol', 'rui', 'farmer']) assert.ok(spec.people[who], who);
});
