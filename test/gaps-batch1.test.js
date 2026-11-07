// Rewind that resends or forks, seeing a built page, and scripted read-only tool calls.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-b1-'));
process.env.OX_HOME = home;
process.env.HOME = home;
const S = await import('../src/session.js');
after(() => fs.rmSync(home, { recursive: true, force: true }));

test('a fork holds the history up to that turn; the original is untouched', () => {
  const a = S.createSession(home, { bot: 'm', provider: 'p' });
  const turn = (id, label, reply) => {
    S.appendEvent(a, { t: 'rewind-point', id, label });
    S.appendEvent(a, { t: 'msg', role: 'user', content: label });
    S.appendEvent(a, { t: 'msg', role: 'assistant', content: reply });
  };
  turn(1, 'first', 'one');
  turn(2, 'second', 'two');
  turn(3, 'third', 'three');
  const before = fs.readFileSync(a.file, 'utf8');
  const { session: f, label } = S.forkSessionAt(a.file, 2, home);
  assert.equal(label, 'second');
  const text = fs.readFileSync(f.file, 'utf8');
  assert.match(text, /"first"/);
  assert.doesNotMatch(text, /"second"/);
  assert.match(text, /"forkedFrom"/);
  assert.match(text, /"bot":"m"/);
  assert.equal(fs.readFileSync(a.file, 'utf8'), before);
  assert.deepEqual(S.rewindPoints(f.file).map((p) => p.id), [1]);
  const all = S.forkSessionAt(a.file, null, home).session;
  assert.deepEqual(S.rewindPoints(all.file).map((p) => p.id), [1, 2, 3]);
  assert.throws(() => S.forkSessionAt(a.file, 9, home), /no rewind point 9/);
});

test('see_page turns what the page gave into problems a person would hit', async () => {
  const { describePage } = await import('../src/tools/see-page.js');
  const ok = { title: 'Todos', text: 'Hello', controls: ['button: Add'], wide: false, nodes: 5, scrollWidth: 1280 };
  assert.match(describePage({ url: 'http://x', page: ok }), /No problems found/);
  const bad = describePage({ url: 'http://x', page: { ...ok, text: '', nodes: 1, wide: true, scrollWidth: 1500, brokenImages: ['http://x/a.png'] }, errors: ['TypeError: x is not a function'], failed: ['404 http://x/app.js'], width: 390, clicked: false });
  for (const re of [/The page is blank/, /1 script error/, /1 failed request/, /scrolls sideways at 390 px/, /1 broken image/, /Nothing with that text to click/, /TypeError/, /404 http:\/\/x\/app\.js/]) assert.match(bad, re);
});

test('see_page asks before another site, not before your own machine, and refuses other schemes', async () => {
  const { seePageTool } = await import('../src/tools/see-page.js');
  let asked = 0;
  const r = await seePageTool({ url: 'https://example.com' }, { requestApproval: async () => { asked++; return false; } });
  assert.equal(asked, 1);
  assert.match(r.content, /declined/);
  assert.match((await seePageTool({ url: 'file:///etc/hosts' }, { yolo: true })).content, /only http/);
  assert.match((await seePageTool({ url: 'not a url' }, { yolo: true })).content, /full address/);
});

test('see_page in a real browser finds a script error, a missing file and sideways scrolling', async (t) => {
  const { chromePath } = await import('../src/dev-flow.js');
  if (!chromePath()) { t.skip('no Chrome here'); return; }
  const { seePageTool } = await import('../src/tools/see-page.js');
  const srv = http.createServer((q, r) => {
    if (q.url === '/') { r.writeHead(200, { 'content-type': 'text/html' }); r.end('<title>Shop</title><h1>Hello shop</h1><button onclick="document.body.append(\'clicked ok\')">Buy nothing</button><div style="width:3000px">wide</div><script src="/missing.js"></script><script>nope()</script>'); return; }
    r.writeHead(404); r.end();
  });
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  t.after(() => srv.close());
  const r = await seePageTool({ url: `http://127.0.0.1:${srv.address().port}/`, click: 'Buy nothing' }, { yolo: true });
  assert.equal(r.isError, undefined, r.content);
  assert.match(r.content, /"Shop"/);
  assert.match(r.content, /script error/);
  assert.match(r.content, /missing\.js/);
  assert.match(r.content, /scrolls sideways/);
  assert.match(r.content, /clicked ok/);
  assert.match(r.content, /button: Buy nothing/);
});

test('run_script: many reads, only the printed result comes back; it cannot write or spawn', async () => {
  const { runScriptTool } = await import('../src/tools/run-script.js');
  const cwd = fs.mkdtempSync(path.join(home, 'proj-'));
  for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(cwd, `f${i}.txt`), `line ${i}\n${'x'.repeat(5000)}\n`);
  const ctx = { yolo: true, cwd };
  const r = await runScriptTool({ code: `let n = 0; for (let i = 0; i < 5; i++) { const t = await tools.read_file({ path: 'f' + i + '.txt' }); if (t.includes('line ' + i)) n++; } console.log('matched', n);` }, ctx);
  assert.equal(r.isError, undefined, r.content);
  assert.match(r.content, /matched 5/);
  assert.match(r.content, /\[5 tool calls\]/);
  assert.ok(r.content.length < 200, 'the 25 KB read stays out');
  const w = await runScriptTool({ code: `const fs = process.getBuiltinModule('fs'); fs.writeFileSync(${JSON.stringify(path.join(cwd, 'evil.txt'))}, 'x');` }, ctx);
  assert.equal(w.isError, true);
  assert.equal(fs.existsSync(path.join(cwd, 'evil.txt')), false);
  const c = await runScriptTool({ code: `process.getBuiltinModule('child_process').execSync('echo hi');` }, ctx);
  assert.equal(c.isError, true, c.content);
  const b = await runScriptTool({ code: `try { await tools.bash({ command: 'echo hi' }); } catch (e) { console.log(e.message); }` }, ctx);
  assert.match(b.content, /bash is not available in a script/);
  assert.match((await runScriptTool({ code: 'console.log(1)' }, { cwd })).content, /requires approval/);
  const slow = await runScriptTool({ code: 'await new Promise(() => setTimeout(() => {}, 99999));', timeoutSeconds: 1 }, ctx);
  assert.match(slow.content, /stopped after 1 s/);
});
