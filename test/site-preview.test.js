// The live site in the build room: real files from the agents' copies, sandboxed, and cursors
// that go to what the lines just written name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hintsFrom, injectOverlay, resolveSiteFile, safeRel, siteEntry, SITE_CSP } from '../src/site-preview.js';

const hints = (file, text) => { const lines = text.split('\n'); return hintsFrom(file, lines, lines.map((_, i) => i)); };

test('an edit names what it touched: CSS selectors, HTML ids and words, the ids a script looks up', () => {
  const css = hints('css/hero.css', '.hero-title, #pricing > h2 {\n  color: red;\n}\nbutton:hover { x: y }\n@media (x) {');
  assert.deepEqual(css.ids, ['pricing']);
  assert.deepEqual(css.classes, ['hero-title']);
  assert.ok(css.tags.includes('button'));
  const html = hints('index.html', '<section id="plans" class="grid wide">\n<h2 class="t">Stay in the loop</h2>');
  assert.deepEqual(html.ids, ['plans']);
  assert.deepEqual(html.classes, ['grid', 'wide', 't']);
  assert.deepEqual(html.texts, ['Stay in the loop']);
  const js = hints('app.js', "document.getElementById('cart');\ndocument.querySelector('.buy #now');");
  assert.deepEqual(js.ids, ['cart', 'now']);
  assert.deepEqual(js.classes, ['buy']);
  // Nothing that could not be a name reaches the page's selector, and a file that names nothing points nowhere.
  assert.deepEqual(hints('a.html', '<div class="w-[10px] ok" id="a b">').classes, ['ok']);
  assert.deepEqual(hints('notes.txt', 'id="x"'), { ids: [], classes: [], tags: [], texts: [] });
});

test('only the lines just written count', () => {
  assert.deepEqual(hintsFrom('a.css', ['.old {', '}', '.new {'], [2]).classes, ['new']);
});

test('the newest copy of a file wins, across the agents and the project', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-site-'));
  const [a, b] = ['a', 'b'].map((x) => { const d = path.join(dir, x); fs.mkdirSync(d); return d; });
  fs.writeFileSync(path.join(a, 'index.html'), 'old');
  fs.writeFileSync(path.join(b, 'index.html'), 'new');
  fs.utimesSync(path.join(a, 'index.html'), new Date(1000), new Date(1000));
  assert.equal(resolveSiteFile([a, b], 'index.html'), path.join(b, 'index.html'));
  assert.equal(siteEntry([a, b]), 'index.html');
  assert.equal(siteEntry([path.join(dir, 'none')]), null);
});

test('nothing outside the copies is served: no climbing out, no .git, no links', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-site-'));
  const secret = path.join(os.tmpdir(), `ox-secret-${process.pid}.txt`);
  fs.writeFileSync(secret, 'x');
  fs.symlinkSync(secret, path.join(dir, 'link.txt'));
  for (const bad of ['../x', 'a/../../x', '.git/config', 'node_modules/a.js', '/etc/hosts'.slice(0, 0) + 'a\0b']) assert.equal(safeRel(bad), null, bad);
  assert.equal(resolveSiteFile([dir], '../x'), null);
  assert.equal(resolveSiteFile([dir], 'link.txt'), null, 'a link can point anywhere');
  fs.rmSync(secret);
});

test('the page runs sandboxed, and the overlay goes in last', () => {
  assert.equal(SITE_CSP, 'sandbox allow-scripts');
  assert.doesNotMatch(SITE_CSP, /allow-same-origin/);
  assert.equal(injectOverlay('<body>hi</body></html>', 'go()'), '<body>hi<script>go()</script></body></html>');
  assert.equal(injectOverlay('<p>no body', 'go()'), '<p>no body\n<script>go()</script>');
  assert.match(injectOverlay('', 'a="</script>"'), /<\\\/script>/);
});

test('ox keeps its backups out of your commits', async () => {
  const { spawnSync } = await import('node:child_process');
  const { dispatchTool } = await import('../src/tools/index.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-backup-git-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  await dispatchTool('edit_file', { path: 'a.txt', old_string: 'one', new_string: 'two' }, { cwd: dir, yolo: true, approval: 'yolo', mode: 'code' });
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'two\n');
  assert.ok(fs.existsSync(path.join(dir, '.ox-backups')), 'the backup was made');
  spawnSync('git', ['add', '-A'], { cwd: dir });
  assert.equal(spawnSync('git', ['diff', '--cached', '--name-only'], { cwd: dir, encoding: 'utf8' }).stdout.trim(), 'a.txt');
});

test('in every sandbox a command can still write to /dev/null, and still cannot write outside its folders', { skip: process.platform !== 'darwin' || !fs.existsSync('/usr/bin/sandbox-exec') }, async () => {
  const { spawnSync } = await import('node:child_process');
  const { resolveSandbox, compileSbpl } = await import('../src/sandbox.js');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-sb-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-sb-home-'));
  const outside = path.join(home, 'outside.txt');
  for (const flag of ['workspace', 'read-only', 'strict']) {
    const sbpl = compileSbpl(resolveSandbox({ flag, config: {}, cwd, home }));
    const run = (cmd) => spawnSync('/usr/bin/sandbox-exec', ['-p', sbpl, '/bin/sh', '-c', cmd], { cwd, encoding: 'utf8' });
    assert.equal(run('echo hi > /dev/null && echo ok 2>&1').stdout.trim(), 'ok', `${flag}: /dev/null`);
    assert.notEqual(run(`echo x > "${outside}"`).status, 0, `${flag}: outside stays shut`);
  }
});
