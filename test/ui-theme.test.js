// Restyle ox from a sentence (src/ui-theme.js): values checked, CSS kept to
// looks, presets, a model-made theme, the stylesheet the app loads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.OX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-theme-'));
const T = await import('../src/ui-theme.js');

test('tokens: colours, fonts and sizes are checked; unknown names dropped', () => {
  assert.equal(T.checkToken('--bg', '#E6E9EF'), '#E6E9EF');
  assert.equal(T.checkToken('--bg', 'rgb(10, 20, 30)'), 'rgb(10, 20, 30)');
  assert.equal(T.checkToken('--bg', 'url(https://x.test/a.png)'), null);
  assert.equal(T.checkToken('--bg', 'red; } body { display:none'), null);
  assert.equal(T.checkToken('--sans', '"Inter", system-ui, sans-serif'), '"Inter", system-ui, sans-serif');
  assert.equal(T.checkToken('--sans', 'x; src: url(evil)'), null);
  assert.equal(T.checkToken('--fs', '15px'), '15px');
  assert.equal(T.checkToken('--fs', '40px'), null);
  assert.equal(T.checkToken('--made-up', '#fff'), null);
  const t = T.normalize({ name: 'My Look!', tokens: { '--bg': '#111', '--x': '#222', '--text': 'nope' } });
  assert.equal(t.name, 'my-look');
  assert.deepEqual(t.tokens, { '--bg': '#111' });
  assert.deepEqual(t.dropped.sort(), ['--text', '--x']);
});

test('extra CSS keeps to looks: no remote loads, imports, scripts or tags', () => {
  const c = T.cleanCss('@import url(https://x.test/a.css); body{background:url(https://x.test/t.png)} </style><script>alert(1)</script> .a{color:red} .b{width:expression(alert(1))} @font-face{src:url(x)} .c{');
  assert.doesNotMatch(c, /@import|https:|<\/?style|<script|expression\(|@font-face/i);
  assert.match(c, /\.a\{color:red\}/);
  assert.doesNotMatch(c, /\.c\{$/, 'an unclosed rule is cut');
});

test('presets apply, list, switch and reset; the stylesheet beats light and dark', () => {
  assert.equal(T.current(), null);
  assert.match(T.css(), /no ox theme/);
  const t = T.use('neumorphic');
  assert.equal(t.tokens['--bg'], '#E6E9EF');
  assert.equal(T.current().name, 'neumorphic');
  assert.ok(T.list().find((x) => x.name === 'neumorphic').active);
  const sheet = T.css();
  assert.match(sheet, /:root\[data-ox-skin\], :root\[data-ox-skin\]\[data-theme\] \{/);
  assert.match(sheet, /--bg: #E6E9EF;/);
  assert.match(sheet, /\.nav button\{box-shadow:none!important/);
  assert.throws(() => T.use('nope'), /no theme 'nope'/);
  for (const p of Object.values(T.PRESETS)) {
    const n = T.normalize(p);
    assert.deepEqual(n.dropped, [], `${p.name} keeps all its tokens`);
    const r = T.contrast(n.tokens['--text'] ?? '#EDEDED', /^#/.test(n.tokens['--bg'] ?? '') ? n.tokens['--bg'] : '#000000');
    assert.ok(r >= 4.5, `${p.name} text contrast ${r}`);
  }
  T.reset();
  assert.equal(T.current(), null);
});

test('from a sentence: presets by name without a model; a model theme starts from the current one', async () => {
  assert.equal((await T.fromPrompt('give it a glass look')).name, 'glass');
  await assert.rejects(T.fromPrompt('a sunset palette'), /needs a model/);
  let sent = '';
  const t = await T.fromPrompt('make the accent warmer', { ask: async ({ system, user }) => { sent = `${system}\n${user}`; return '```json\n{"name":"Warm Glass","description":"glass, warmer","tokens":{"--btn":"#FFB46B","--bg":"#0B1020","--evil":"x"},"css":"body{background:url(https://x.test)}"}\n```'; } });
  assert.match(sent, /Start from this theme/);
  assert.match(sent, /"name":"glass"/);
  assert.equal(t.name, 'warm-glass');
  assert.equal(t.tokens['--btn'], '#FFB46B');
  assert.deepEqual(t.dropped, ['--evil']);
  assert.doesNotMatch(t.css, /https:/);
  await assert.rejects(T.fromPrompt('x', { ask: async () => 'no idea' }), /did not answer with a theme/);
  assert.equal(T.contrast('#000000', '#FFFFFF'), 21);
});
