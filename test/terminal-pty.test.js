// The app's terminal: ox's own screen model (colours, cursor moves, clearing,
// the alternate screen vim and less use, wrapping, scroll regions) and a real
// pseudo-terminal behind it, so a program sees a terminal and its size.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Screen, keyToBytes, lineHtml } from '../src/web/term.js';

test('text, newlines, carriage returns and wrapping land where a terminal puts them', () => {
  const s = new Screen(10, 3);
  s.write('hello\r\nworld');
  assert.equal(s.text(), 'hello\nworld');
  s.write('\rW');
  assert.equal(s.text(), 'hello\nWorld');
  s.write('\r\n0123456789AB');
  assert.equal(s.text({ withBack: true }), 'hello\nWorld\n0123456789\nAB');
});

test('cursor addressing and erasing (what progress bars and prompts do)', () => {
  const s = new Screen(20, 4);
  s.write('progress 10%');
  s.write('\r\x1b[Kprogress 100%');
  assert.equal(s.text(), 'progress 100%');
  s.write('\x1b[3;5HX');
  assert.equal(s.lines[2].map((c) => c.ch).join('').trimEnd(), '    X');
  s.write('\x1b[2J\x1b[H');
  assert.equal(s.text(), '');
  s.write('abcdef\x1b[3D\x1b[2P');
  assert.equal(s.text(), 'abcf');
});

test('colours: 16, 256 and true colour, bold and reset', () => {
  const s = new Screen(20, 2);
  s.write('\x1b[1;31mred\x1b[0m \x1b[38;5;208mo\x1b[38;2;1;2;3mt\x1b[m');
  const l = s.lines[0];
  assert.equal(l[0].attr.fg, 1); assert.equal(l[0].attr.bold, true);
  assert.equal(l[3].attr.fg, null);
  assert.equal(l[4].attr.fg, 208);
  assert.equal(l[5].attr.fg, 'rgb(1,2,3)');
  assert.match(lineHtml(l), /<span style="color:#ff7b86;font-weight:700;">red<\/span>/);
  assert.doesNotMatch(lineHtml([{ ch: '<', attr: l[3].attr }]), /<</);
});

test('the alternate screen (vim, less, htop) leaves the shell screen as it was', () => {
  const s = new Screen(20, 3);
  s.write('$ ls\r\nfile.txt\r\n$ ');
  s.write('\x1b[?1049h\x1b[H\x1b[2J~ vim ~');
  assert.equal(s.text(), '~ vim ~');
  s.write('\x1b[?1049l');
  assert.equal(s.text(), '$ ls\nfile.txt\n$');
  assert.equal(s.x, 2);
});

test('scroll regions and reverse index keep the lines outside the region still', () => {
  const s = new Screen(10, 4);
  s.write('top\r\na\r\nb\r\nbottom');
  s.write('\x1b[2;3r\x1b[3;1H\nc');
  assert.equal(s.text(), 'top\nb\nc\nbottom');
});

test('the terminal answers cursor-position queries (shells and editors ask)', () => {
  const replies = [];
  const s = new Screen(10, 4, { reply: (r) => replies.push(r) });
  s.write('ab\x1b[6n');
  assert.deepEqual(replies, ['\x1b[1;3R']);
});

test('keys become the bytes a terminal sends; ⌘ shortcuts stay the app\'s', () => {
  const k = (key, mods = {}) => keyToBytes({ key, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...mods });
  assert.equal(k('Enter'), '\r');
  assert.equal(k('c', { ctrlKey: true }), '\x03');
  assert.equal(k('ArrowUp'), '\x1b[A');
  assert.equal(keyToBytes({ key: 'ArrowUp' }, { appCursor: true }), '\x1bOA');
  assert.equal(k('v', { metaKey: true }), null);
  assert.equal(k('é'), 'é');
  assert.equal(k('Shift'), null);
});

test('a real pseudo-terminal: the program sees a terminal, its size, and resizes', { skip: process.platform === 'win32' }, async () => {
  const { openTerm } = await import('../src/pty.js');
  const t = openTerm({ cwd: process.cwd(), cols: 77, rows: 22, shell: '/bin/sh' });
  let out = '';
  t.on('data', (d) => { out += d; });
  const until = async (re, ms = 8000) => { const end = Date.now() + ms; while (!re.test(out) && Date.now() < end) await new Promise((r) => setTimeout(r, 30)); return re.test(out); };
  t.write('[ -t 0 ] && echo IS-A-TTY; stty size\n');
  assert.ok(await until(/IS-A-TTY/), out);
  assert.ok(await until(/22 77/), out);
  t.resize(90, 30);
  await new Promise((r) => setTimeout(r, 100));
  t.write('stty size\n');
  assert.ok(await until(/30 90/), out);
  const exited = new Promise((r) => t.on('exit', r));
  t.write('exit\n');
  await exited;
});
