// Live wallpapers: every scene in the list has a file, the app's picker offers
// the same ones, and each page runs its own script and nothing else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { WALLPAPERS, wallpaperPage } from '../src/wallpapers.js';

test('every wallpaper has a scene, the app offers the same list, and the engine keeps its MIT notice', () => {
  const html = fs.readFileSync(new URL('../src/web/chat.html', import.meta.url), 'utf8');
  const inApp = [...html.match(/const WALLPAPERS = \[(.*?)\];/)[1].matchAll(/\['([a-z-]+)'/g)].map((m) => m[1]);
  assert.deepEqual(inApp, WALLPAPERS.map((w) => w.id));
  for (const w of WALLPAPERS) {
    const page = wallpaperPage(w.id);
    assert.ok(page.includes('Wall.run('), w.id);
    // Each script compiles.
    for (const [, js] of page.matchAll(/<script>([\s\S]*?)<\/script>/g)) new vm.Script(js, { filename: `${w.id}.html` });
  }
  assert.equal(wallpaperPage('../../etc/passwd'), null);
  assert.equal(wallpaperPage('claude-code'), null, 'not shipped: it draws another company\'s mascot');
  assert.match(fs.readFileSync(new URL('../src/web/wallpapers/engine.js', import.meta.url), 'utf8'), /Copyright \(c\) 2026 Zeus-Deus/);
});
