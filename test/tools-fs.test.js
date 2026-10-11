import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  readFileTool,
  writeFileTool,
  editFileTool,
  listDirTool,
  globTool,
  grepTool,
} from '../src/tools/fs.js';

function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-fs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('read_file reads an absolute path exactly as before', async (t) => {
  const dir = sandbox(t);
  const abs = path.join(dir, 'ok.txt');
  fs.writeFileSync(abs, 'hello ox');
  const good = await readFileTool({ path: abs });
  assert.equal(good.isError, undefined);
  assert.ok(good.content.startsWith(`${abs} · totalLines=1`));
  assert.ok(good.content.includes('hello ox'));
});

test('read_file caps oversized output at 100k chars with a marker', async (t) => {
  const dir = sandbox(t);
  const abs = path.join(dir, 'big.txt');
  fs.writeFileSync(abs, 'x'.repeat(120_000));
  const res = await readFileTool({ path: abs });
  assert.match(res.content, /\[truncated\] — output capped at 100,000 characters/);
  assert.ok(res.content.length < 101_000, `content too long: ${res.content.length}`);
});

test('write_file creates parent directories; brand-new files skip the approval gate', async (t) => {
  const dir = sandbox(t);
  const abs = path.join(dir, 'deep', 'nested', 'new.txt');
  const res = await writeFileTool({ path: abs, content: 'v1\n' }, {});
  assert.equal(res.isError, undefined);
  assert.match(res.content, /^Created /);
  assert.equal(fs.readFileSync(abs, 'utf8'), 'v1\n');
});

test('write_file returns a unified diff when overwriting in yolo mode', async (t) => {
  const dir = sandbox(t);
  const abs = path.join(dir, 'f.txt');
  fs.writeFileSync(abs, 'one\ntwo\n');
  const res = await writeFileTool({ path: abs, content: 'one\nTWO\n' }, { yolo: true });
  assert.equal(res.isError, undefined);
  assert.match(res.content, /--- a\//);
  assert.match(res.content, /^-two$/m);
  assert.match(res.content, /^\+TWO$/m);
  assert.equal(fs.readFileSync(abs, 'utf8'), 'one\nTWO\n');
});

test('write_file refuses /.git/ paths even in yolo mode', async (t) => {
  const dir = sandbox(t);
  const res = await writeFileTool(
    { path: path.join(dir, '.git', 'config'), content: 'x' },
    { yolo: true }
  );
  assert.equal(res.isError, true);
  assert.match(res.content, /\.git\//);
  assert.equal(fs.existsSync(path.join(dir, '.git')), false);
});

test('write_file approval gate: declined errors and leaves file untouched; approved writes', async (t) => {
  const dir = sandbox(t);
  const abs = path.join(dir, 'gated.txt');
  fs.writeFileSync(abs, 'original\n');

  let seenTool = null;
  const declined = await writeFileTool(
    { path: abs, content: 'changed\n' },
    {
      requestApproval: async (tool, args, detail) => {
        seenTool = tool;
        assert.match(detail, /overwrite/);
        return false;
      },
    }
  );
  assert.equal(seenTool, 'write_file');
  assert.equal(declined.isError, true);
  assert.match(declined.content, /declined/i);
  assert.equal(fs.readFileSync(abs, 'utf8'), 'original\n');

  const approved = await writeFileTool(
    { path: abs, content: 'changed\n' },
    { requestApproval: async () => true }
  );
  assert.equal(approved.isError, undefined);
  assert.equal(fs.readFileSync(abs, 'utf8'), 'changed\n');
  assert.match(approved.content, /--- a\//);
});

test('edit_file applies an exact unique match and returns a diff', async (t) => {
  const dir = sandbox(t);
  const abs = path.join(dir, 'code.txt');
  fs.writeFileSync(abs, 'alpha\nbeta\ngamma\n');
  const res = await editFileTool({ path: abs, old_string: 'beta', new_string: 'BETA!' });
  assert.equal(res.isError, undefined);
  assert.match(res.content, /replaced 1 occurrence\(s\) exactly/);
  assert.match(res.content, /^\+BETA!$/m);
  assert.equal(fs.readFileSync(abs, 'utf8'), 'alpha\nBETA!\ngamma\n');
});

test('edit_file fuzzy match tolerates CRLF, tab and space-run differences', async (t) => {
  const dir = sandbox(t);
  const abs = path.join(dir, 'messy.txt');
  fs.writeFileSync(abs, 'head\r\nkeep:\t\tone    two\r\ntail\r\n');
  const res = await editFileTool({ path: abs, old_string: 'keep: one two', new_string: 'SWAPPED' });
  assert.equal(res.isError, undefined);
  assert.match(res.content, /whitespace-fuzzy match/);
  assert.equal(fs.readFileSync(abs, 'utf8'), 'head\r\nSWAPPED\r\ntail\r\n');
});

test('edit_file errors on multi-match without replace_all, listing line numbers', async (t) => {
  const dir = sandbox(t);
  const abs = path.join(dir, 'dup.txt');
  fs.writeFileSync(abs, 'dup\nmid\ndup\n');
  const res = await editFileTool({ path: abs, old_string: 'dup', new_string: 'X' });
  assert.equal(res.isError, true);
  assert.match(res.content, /matches 2 times/);
  assert.match(res.content, /lines 1, 3/);
  assert.equal(fs.readFileSync(abs, 'utf8'), 'dup\nmid\ndup\n');
});

test('edit_file replace_all replaces every occurrence', async (t) => {
  const dir = sandbox(t);
  const abs = path.join(dir, 'dupall.txt');
  fs.writeFileSync(abs, 'dup\nmid\ndup\n');
  const res = await editFileTool({
    path: abs,
    old_string: 'dup',
    new_string: 'X',
    replace_all: true,
  });
  assert.equal(res.isError, undefined);
  assert.match(res.content, /replaced 2 occurrence\(s\) exactly/);
  assert.equal(fs.readFileSync(abs, 'utf8'), 'X\nmid\nX\n');
});

test('list_dir builds a tree, skips .git/node_modules, respects depth', async (t) => {
  const dir = sandbox(t);
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'sub', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref');
  fs.writeFileSync(path.join(dir, 'node_modules', 'pkg', 'i.js'), 'x');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
  fs.writeFileSync(path.join(dir, 'sub', 'b.txt'), 'x');
  fs.writeFileSync(path.join(dir, 'sub', 'deep', 'c.txt'), 'x');

  const d2 = await listDirTool({ path: dir, depth: 2 });
  assert.equal(d2.isError, undefined);
  assert.ok(d2.content.includes('a.txt'));
  assert.ok(d2.content.includes('sub/'));
  assert.ok(d2.content.includes('b.txt'));
  assert.ok(!d2.content.includes('c.txt'));
  assert.ok(!d2.content.includes('.git'));
  assert.ok(!d2.content.includes('node_modules'));

  const d1 = await listDirTool({ path: dir, depth: 1 });
  assert.ok(d1.content.includes('a.txt'));
  assert.ok(d1.content.includes('sub/'));
  assert.ok(!d1.content.includes('b.txt'));

  const d3 = await listDirTool({ path: dir, depth: 3 });
  assert.ok(d3.content.includes('c.txt'));
});

test("glob '**/*.js' finds nested matches and skips .git/node_modules", async (t) => {
  const dir = sandbox(t);
  fs.mkdirSync(path.join(dir, 'sub', 'deeper'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'root.js'), '');
  fs.writeFileSync(path.join(dir, 'note.md'), '');
  fs.writeFileSync(path.join(dir, 'sub', 'nested.js'), '');
  fs.writeFileSync(path.join(dir, 'sub', 'deeper', 'x.js'), '');
  fs.writeFileSync(path.join(dir, 'node_modules', 'dep.js'), '');
  fs.writeFileSync(path.join(dir, '.git', 'hook.js'), '');

  const res = await globTool({ pattern: '**/*.js', path: dir });
  assert.equal(res.isError, undefined);
  const lines = res.content.split('\n');
  assert.equal(lines.length, 3);
  assert.deepEqual(
    lines.map((l) => path.relative(dir, l)).sort(),
    ['root.js', 'sub/deeper/x.js', 'sub/nested.js']
  );
});

test('glob expands {a,b} brace alternation', async (t) => {
  const dir = sandbox(t);
  fs.writeFileSync(path.join(dir, 'alpha.txt'), '');
  fs.writeFileSync(path.join(dir, 'beta.txt'), '');
  fs.writeFileSync(path.join(dir, 'gamma.md'), '');
  const res = await globTool({ pattern: '{alpha,beta}.txt', path: dir });
  assert.equal(res.isError, undefined);
  const lines = res.content.split('\n');
  assert.equal(lines.length, 2);
  assert.deepEqual(
    lines.map((l) => path.basename(l)).sort(),
    ['alpha.txt', 'beta.txt']
  );
});

test('glob caps results at 1000 with a notice', async (t) => {
  const dir = sandbox(t);
  const many = path.join(dir, 'many');
  fs.mkdirSync(many);
  for (let i = 0; i < 1005; i++) {
    fs.writeFileSync(path.join(many, `f${String(i).padStart(4, '0')}.js`), '');
  }
  const res = await globTool({ pattern: 'many/*.js', path: dir });
  assert.equal(res.isError, undefined);
  const lines = res.content.split('\n');
  assert.equal(lines.length, 1001);
  assert.match(res.content, /\[capped at 1000 results\]/);
});

test('grep honors the include filter for *.md', async (t) => {
  const dir = sandbox(t);
  fs.writeFileSync(path.join(dir, 'notes.md'), 'grepkey-alpha here\n');
  fs.writeFileSync(path.join(dir, 'code.js'), '// grepkey-alpha there\n');
  const res = await grepTool({ pattern: 'grepkey-alpha', path: dir, include: '*.md' });
  assert.equal(res.isError, undefined);
  assert.match(res.content, /notes\.md:1:grepkey-alpha here/);
  assert.ok(!res.content.includes('code.js'));
});

test('grep ignoreCase finds otherwise-missed matches', async (t) => {
  const dir = sandbox(t);
  fs.writeFileSync(path.join(dir, 'case.md'), 'MiXeDcAsEtoken\n');
  const cs = await grepTool({ pattern: 'mixedcasetoken', path: dir });
  assert.match(cs.content, /No matches/);
  const ci = await grepTool({ pattern: 'MIXEDCASETOKEN', path: dir, ignoreCase: true });
  assert.match(ci.content, /case\.md:1:MiXeDcAsEtoken/);
});

test('grep skips binary files (NUL byte)', async (t) => {
  const dir = sandbox(t);
  fs.writeFileSync(path.join(dir, 'text.md'), 'needle-word here\n');
  fs.writeFileSync(path.join(dir, 'blob.dat'), Buffer.from('needle-word\x00binary'));
  const res = await grepTool({ pattern: 'needle-word', path: dir });
  assert.equal(res.isError, undefined);
  assert.match(res.content, /text\.md:1:/);
  assert.ok(!res.content.includes('blob.dat'));
});

test('grep caps at 200 matches with a truncation notice', async (t) => {
  const dir = sandbox(t);
  const lines = Array.from({ length: 250 }, (_, i) => `capline ${i + 1}`);
  fs.writeFileSync(path.join(dir, 'big.md'), `${lines.join('\n')}\n`);
  const res = await grepTool({ pattern: 'capline', path: dir });
  assert.equal(res.isError, undefined);
  const out = res.content.split('\n');
  assert.equal(out.length, 201);
  assert.match(res.content, /\[capped at 200 matches — results truncated\]/);
});

test('write_file refuses /.GIT/ paths case-insensitively (APFS)', async (t) => {
  const dir = sandbox(t);
  const res = await writeFileTool({ path: path.join(dir, '.GIT', 'config'), content: 'x' }, { yolo: true });
  assert.equal(res.isError, true);
  assert.match(res.content, /\.git\//);
  assert.equal(fs.existsSync(path.join(dir, '.GIT')), false);
});

test('sensitive-read guard: ~/.ssh ~/.aws ~/.ox/sessions refused with override escape hatch', async (t) => {
  const realHome = process.env.HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-fs-home-'));
  process.env.HOME = home;
  try {
    fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });
    fs.mkdirSync(path.join(home, '.aws'), { recursive: true });
    fs.mkdirSync(path.join(home, '.ox', 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(home, '.ssh', 'id_rsa'), 'SECRETKEY-material\n');
    fs.writeFileSync(path.join(home, '.aws', 'credentials'), 'SECRETKEY-aws\n');
    fs.writeFileSync(path.join(home, 'plain.txt'), 'SECRETKEY-nowhere\n');

    const read = await readFileTool({ path: path.join(home, '.ssh', 'id_rsa') });
    assert.equal(read.isError, true);
    assert.match(read.content, /sensitive directory/);
    assert.match(read.content, /OX_ALLOW_SENSITIVE_READS=1/);

    const awsRead = await readFileTool({ path: path.join(home, '.aws', 'credentials') });
    assert.equal(awsRead.isError, true);

    const sessList = await listDirTool({ path: path.join(home, '.ox', 'sessions') });
    assert.equal(sessList.isError, true);
    assert.match(sessList.content, /sensitive directory/);

    const sshList = await listDirTool({ path: home, depth: 3 });
    assert.equal(sshList.isError, undefined);
    assert.ok(!sshList.content.includes('.ssh'));

    const g = await globTool({ pattern: '**/*', path: home });
    assert.equal(g.isError, undefined);
    assert.ok(!g.content.includes('id_rsa'));

    const grepped = await grepTool({ pattern: 'SECRETKEY', path: home });
    assert.equal(grepped.isError, undefined);
    assert.ok(!grepped.content.includes('id_rsa'));
    assert.ok(!grepped.content.includes('credentials'));
    assert.match(grepped.content, /plain\.txt:1:/);

    process.env.OX_ALLOW_SENSITIVE_READS = '1';
    try {
      const overridden = await readFileTool({ path: path.join(home, '.ssh', 'id_rsa') });
      assert.equal(overridden.isError, undefined);
      assert.match(overridden.content, /SECRETKEY-material/);
      const listed = await listDirTool({ path: path.join(home, '.ssh') });
      assert.equal(listed.isError, undefined);
      assert.ok(listed.content.includes('id_rsa'));
    } finally {
      delete process.env.OX_ALLOW_SENSITIVE_READS;
    }
  } finally {
    process.env.HOME = realHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('outside-workspace creation is gated: declined errors and writes nothing; approved creates', async (t) => {
  const cwd = sandbox(t);
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-fs-outside-'));
  t.after(() => fs.rmSync(outsideRoot, { recursive: true, force: true }));
  const target = path.join(outsideRoot, 'escape.txt');

  let sawDetail = '';
  const declined = await writeFileTool(
    { path: target, content: 'nope\n' },
    {
      cwd,
      requestApproval: async (tool, args, detail) => {
        assert.equal(tool, 'write_file');
        sawDetail = detail;
        return false;
      },
    }
  );
  assert.equal(declined.isError, true);
  assert.match(declined.content, /declined/);
  assert.match(sawDetail, /OUTSIDE the workspace/);
  assert.equal(fs.existsSync(target), false);

  const approved = await writeFileTool(
    { path: target, content: 'granted\n' },
    { cwd, requestApproval: async () => true }
  );
  assert.equal(approved.isError, undefined);
  assert.equal(fs.readFileSync(target, 'utf8'), 'granted\n');
});

test('inside-cwd creation stays ungated even without an approver', async (t) => {
  const cwd = sandbox(t);
  const res = await writeFileTool({ path: path.join(cwd, 'fresh', 'ok.txt'), content: 'hi\n' }, { cwd });
  assert.equal(res.isError, undefined);
  assert.match(res.content, /^Created /);
});

test('pre-existing files outside the workspace remain writable via the own-location exception', async (t) => {
  const cwd = sandbox(t);
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-fs-outside2-'));
  t.after(() => fs.rmSync(outsideRoot, { recursive: true, force: true }));
  const target = path.join(outsideRoot, 'existing.txt');
  fs.writeFileSync(target, 'before\n');
  const res = await writeFileTool({ path: target, content: 'after\n' }, { cwd });
  assert.equal(res.isError, undefined);
  assert.match(res.content, /^Wrote /);
});

// ---------------------------------------------------------------------------
// Output path display.
//
// Tool RESULTS lead with a path on every call. Absolute, that path is re-sent on
// every later turn of the same run. Inside the workspace the relative form is
// the same information; outside it, the relative form is strictly worse. These
// tests pin both halves, plus the rule that a relative call in and a relative
// path out describe the same file.
// ---------------------------------------------------------------------------

test('tool output inside the cwd shows the path RELATIVE to the cwd', async (t) => {
  const dir = sandbox(t);
  const ctx = { cwd: dir };
  fs.mkdirSync(path.join(dir, 'src', 'deep'), { recursive: true });
  const rel = path.join('src', 'deep', 'a.js');
  const abs = path.join(dir, rel);
  fs.writeFileSync(abs, 'const x = 1;\n// calcTotal\n');

  const read = await readFileTool({ path: abs }, ctx);
  assert.equal(read.isError, undefined);
  assert.ok(read.content.startsWith(`${rel} · totalLines=`), `read_file header should be relative: ${read.content.slice(0, 80)}`);
  assert.ok(!read.content.includes(dir), `read_file leaked the absolute cwd: ${read.content.slice(0, 80)}`);

  const grepped = await grepTool({ pattern: 'calcTotal', path: dir }, ctx);
  assert.match(grepped.content, new RegExp(`^${rel}:2:`, 'm'));
  assert.ok(!grepped.content.includes(`${dir}/`), 'grep must not prefix the absolute cwd');

  const globbed = await globTool({ pattern: 'src/**/*.js', path: dir }, ctx);
  assert.deepEqual(globbed.content.split('\n'), [rel]);
  assert.ok(!globbed.content.includes(dir), 'glob emitted an absolute path');

  const listed = await listDirTool({ path: dir, depth: 2 }, ctx);
  assert.ok(listed.content.startsWith('./\n'), `list_dir root line: ${listed.content.slice(0, 20)}`);

  const wrote = await writeFileTool({ path: abs, content: 'const x = 2;\n// calcTotal\n' }, { cwd: dir, yolo: true });
  assert.match(wrote.content, /^Wrote /);
  assert.ok(!wrote.content.includes(dir), `write_file leaked the absolute cwd: ${wrote.content.slice(0, 120)}`);
  assert.match(wrote.content, new RegExp(`^--- a/${rel}$`, 'm'), 'the diff header is relativized, not stripped');
  assert.match(wrote.content, new RegExp(`^\\+\\+\\+ b/${rel}$`, 'm'));

  const edited = await editFileTool({ path: abs, old_string: 'const x = 2;', new_string: 'const x = 3;' }, ctx);
  assert.ok(edited.content.startsWith(`Edited ${rel}: `), `edit_file header: ${edited.content.slice(0, 80)}`);
  assert.ok(!edited.content.includes(dir), 'edit_file leaked the absolute cwd');
  assert.match(edited.content, new RegExp(`^--- a/${rel}$`, 'm'), 'edit_file diff header is relativized');
  assert.match(edited.content, new RegExp(`^\\+\\+\\+ b/${rel}$`, 'm'));
});

test('tool output for a path OUTSIDE the cwd stays absolute', async (t) => {
  const cwd = sandbox(t);
  const outside = sandbox(t);
  const abs = path.join(outside, 'far.js');
  fs.writeFileSync(abs, '// outsideMarker\n');
  const ctx = { cwd };

  const read = await readFileTool({ path: abs }, ctx);
  assert.ok(read.content.startsWith(`${abs} · totalLines=`), 'an outside path is genuinely different information');

  const grepped = await grepTool({ pattern: 'outsideMarker', path: outside }, ctx);
  assert.ok(grepped.content.includes(`${abs}:1:`), `grep kept the outside path absolute: ${grepped.content}`);

  const globbed = await globTool({ pattern: '*.js', path: outside }, ctx);
  assert.deepEqual(globbed.content.split('\n'), [abs]);

  const listed = await listDirTool({ path: outside, depth: 1 }, ctx);
  assert.ok(listed.content.startsWith(`${outside}/\n`), `list_dir kept the outside root absolute: ${listed.content.slice(0, 40)}`);
});

test('ERROR messages keep the absolute path even inside the cwd', async (t) => {
  const dir = sandbox(t);
  const ctx = { cwd: dir };
  const missing = path.join(dir, 'nope', 'gone.txt');

  const read = await readFileTool({ path: missing }, ctx);
  assert.equal(read.isError, true);
  assert.ok(read.content.includes(missing), `error keeps the absolute path: ${read.content}`);

  const tilde = await readFileTool({ path: '~/a.js' }, ctx);
  assert.equal(tilde.isError, true, "'~' is still refused on the way in");
  assert.ok(tilde.content.includes('~/a.js'), `the refusal names the path it refused: ${tilde.content}`);

  const git = await writeFileTool({ path: path.join(dir, '.git', 'config'), content: 'x' }, { ...ctx, yolo: true });
  assert.equal(git.isError, true);
  assert.ok(git.content.includes(path.join(dir, '.git', 'config')), 'refusal names the exact absolute path');

  const dirTarget = path.join(dir, 'a-directory');
  fs.mkdirSync(dirTarget);
  const ontoDir = await writeFileTool({ path: dirTarget, content: 'x' }, { ...ctx, yolo: true });
  assert.equal(ontoDir.isError, true);
  assert.ok(ontoDir.content.includes(dirTarget), `error keeps the absolute path: ${ontoDir.content}`);

  const badEdit = await editFileTool({ path: missing, old_string: 'a', new_string: 'b' }, ctx);
  assert.equal(badEdit.isError, true);
  assert.ok(badEdit.content.includes(missing), `edit_file error keeps the absolute path: ${badEdit.content}`);
});

test('relative display falls back to absolute when there is no cwd at all', async (t) => {
  const dir = sandbox(t);
  const abs = path.join(dir, 'x.txt');
  fs.writeFileSync(abs, 'hello\n');
  const res = await readFileTool({ path: abs });
  assert.ok(res.content.startsWith(`${abs} · totalLines=`), 'with no workspace there is nothing to be relative to');
});

// ---------------------------------------------------------------------------
// Tool INPUT accepts a path relative to the workspace cwd.
//
// The round trip that motivated this: displayPath() shows `src/cart.js` for a
// file inside the workspace, and the model then hands that exact string back —
// and absCheck() rejected it, burning a whole turn on a string the harness had
// itself produced.
//
// The fix resolves a relative argument against ctx.cwd FIRST and then runs
// every existing guard on the resolved absolute path. These tests pin both
// halves: relative input works, and it is not a new hole. The property that
// makes it safe is not "relative is allowed" — it is "a relative path and its
// absolute twin are indistinguishable to every guard".
// ---------------------------------------------------------------------------

// A workspace with a real tree, a .git dir, and one file outside it.
function workspace(t) {
  const cwd = sandbox(t);
  fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
  fs.mkdirSync(path.join(cwd, '.git'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'lib.js'), 'const k=()=>42;module.exports={k};\n');
  fs.writeFileSync(path.join(cwd, 'src', 'cart.js'), '// cartMarker\nexport const cart = 1;\n');
  fs.writeFileSync(path.join(cwd, '.git', 'config'), '[core]\n\tsecret = yes\n');
  return cwd;
}

test('1. a relative path inside the cwd works for read_file, write_file, edit_file, glob, grep, list_dir', async (t) => {
  const cwd = workspace(t);
  const ctx = { cwd, yolo: true };

  const read = await readFileTool({ path: 'lib.js' }, ctx);
  assert.equal(read.isError, undefined, `relative read rejected: ${read.content}`);
  assert.ok(read.content.includes('const k=()=>42;'), 'the relative read returned the real contents');
  assert.ok(read.content.startsWith('lib.js · totalLines='), `header: ${read.content.slice(0, 40)}`);

  const wrote = await writeFileTool({ path: 'src/created.js', content: 'export const made = true;\n' }, ctx);
  assert.equal(wrote.isError, undefined, `relative write rejected: ${wrote.content}`);
  assert.equal(fs.readFileSync(path.join(cwd, 'src', 'created.js'), 'utf8'), 'export const made = true;\n');
  assert.ok(wrote.content.startsWith('Created src/created.js'), `write header: ${wrote.content.slice(0, 40)}`);

  const edited = await editFileTool({ path: 'lib.js', old_string: 'k=()=>42', new_string: 'k=()=>43' }, ctx);
  assert.equal(edited.isError, undefined, `relative edit rejected: ${edited.content}`);
  assert.equal(fs.readFileSync(path.join(cwd, 'lib.js'), 'utf8'), 'const k=()=>43;module.exports={k};\n');

  const globbed = await globTool({ pattern: 'src/**/*.js', path: '.' }, ctx);
  assert.equal(globbed.isError, undefined, `relative glob rejected: ${globbed.content}`);
  assert.deepEqual(globbed.content.split('\n'), ['src/cart.js', 'src/created.js']);

  const greped = await grepTool({ pattern: 'cartMarker', path: 'src' }, ctx);
  assert.equal(greped.isError, undefined, `relative grep rejected: ${greped.content}`);
  assert.match(greped.content, /^src\/cart\.js:1:\/\/ cartMarker$/m);

  const listed = await listDirTool({ path: 'src', depth: 1 }, ctx);
  assert.equal(listed.isError, undefined, `relative list_dir rejected: ${listed.content}`);
  assert.ok(listed.content.startsWith('src/\n'), `list_dir root line: ${listed.content.slice(0, 20)}`);
  assert.ok(listed.content.includes('cart.js'));

  // and the default: no path at all still means the cwd
  const listedDefault = await listDirTool({ depth: 1 }, ctx);
  assert.equal(listedDefault.isError, undefined);
  assert.ok(listedDefault.content.startsWith('./\n'));
});

test('2. ../ traversal is not a new hole: it gets the same verdict as the absolute path', async (t) => {
  const cwd = workspace(t);
  const outside = sandbox(t);
  fs.writeFileSync(path.join(outside, 'far.txt'), 'farMarker\n');
  const ctx = { cwd };

  // (a) reads: identical result, byte for byte, to the absolute twin.
  const relRead = await readFileTool({ path: path.join('..', path.basename(outside), 'far.txt') }, ctx);
  const absRead = await readFileTool({ path: path.join(outside, 'far.txt') }, ctx);
  assert.equal(relRead.isError, absRead.isError, 'relative and absolute must not differ on isError');
  assert.equal(relRead.content, absRead.content, 'relative and absolute must return the same bytes');

  // (b) the case from the report: the relative spelling of a system file is
  //     exactly that system file, and gets its verdict.
  const etcAbs = '/etc/passwd';
  const etcSpelling = path.relative(cwd, etcAbs);
  const etcRel = await readFileTool({ path: etcSpelling }, ctx);
  const etcDirect = await readFileTool({ path: etcAbs }, ctx);
  assert.equal(etcRel.isError, etcDirect.isError, 'the relative spelling must get the absolute verdict');
  assert.equal(etcRel.content, etcDirect.content, 'a relative spelling of /etc/passwd IS /etc/passwd');

  // and the literal '../../etc/passwd' from the report, wherever it lands, is
  // judged as its own resolved absolute path and not as "a relative path"
  const literalRel = await readFileTool({ path: '../../etc/passwd' }, ctx);
  const literalAbs = await readFileTool({ path: path.resolve(cwd, '../../etc/passwd') }, ctx);
  assert.equal(literalRel.isError, literalAbs.isError);
  assert.equal(literalRel.content, literalAbs.content, 'no "it looked relative" branch exists');

  // (c) CREATING outside the workspace by traversal is refused without approval,
  //     exactly as the absolute form is — this is the guard that matters most,
  //     because creation is the one write with no prior file to vouch for it.
  const escape = await writeFileTool(
    { path: path.join('..', path.basename(outside), 'escaped.txt'), content: 'pwn\n' },
    { cwd }
  );
  assert.equal(escape.isError, true, 'traversal creation outside the workspace must be refused');
  assert.match(escape.content, /outside the workspace/i);
  assert.equal(fs.existsSync(path.join(outside, 'escaped.txt')), false, 'nothing was written');

  // (d) escaping via .. is not project-local for the trust gate either.
  const { checkTrust } = await import('../src/trust.js');
  const viaDots = checkTrust({
    name: 'write_file',
    args: { path: path.join('..', path.basename(outside), 'x.txt') },
    trustLevel: 'balanced',
    ctx,
  });
  const viaAbs = checkTrust({
    name: 'write_file',
    args: { path: path.join(outside, 'x.txt') },
    trustLevel: 'balanced',
    ctx,
  });
  assert.deepEqual(viaDots, viaAbs, 'a .. escape and its absolute twin must classify identically');
  assert.equal(viaDots.allowed, false, 'an escape is never project-local');
});

test('3. /.git/ is still refused when expressed RELATIVE — the critical guard', async (t) => {
  const cwd = workspace(t);
  const ctx = { cwd, yolo: true };

  for (const rel of ['.git/config', './.git/config', 'src/../.git/config', '.GIT/config']) {
    const w = await writeFileTool({ path: rel, content: 'clobbered\n' }, ctx);
    assert.equal(w.isError, true, `write_file accepted the relative .git path '${rel}'`);
    assert.match(w.content, /\.git\/|off-limits/i, `unclear refusal for '${rel}': ${w.content}`);
    assert.ok(w.content.includes(path.resolve(cwd, rel)), `the refusal names the resolved path: ${w.content}`);

    const e = await editFileTool({ path: rel, old_string: 'secret', new_string: 'pwn' }, ctx);
    assert.equal(e.isError, true, `edit_file accepted the relative .git path '${rel}'`);
    assert.match(e.content, /\.git\/|off-limits/i);
  }
  // the real files are untouched
  assert.equal(fs.readFileSync(path.join(cwd, '.git', 'config'), 'utf8'), '[core]\n\tsecret = yes\n');
  assert.equal(fs.readFileSync(path.join(cwd, 'lib.js'), 'utf8'), 'const k=()=>42;module.exports={k};\n');
  const gitEntries = fs.readdirSync(cwd).filter((n) => n.toLowerCase() === '.git');
  assert.deepEqual(gitEntries, ['.git'], 'the .GIT refusal created no second entry');

  // and a relative escape INTO a .git dir elsewhere is refused as well
  const other = sandbox(t);
  fs.mkdirSync(path.join(other, '.git'), { recursive: true });
  fs.writeFileSync(path.join(other, '.git', 'config'), 'other\n');
  const far = await writeFileTool(
    { path: path.join('..', path.basename(other), '.git', 'config'), content: 'x' },
    ctx
  );
  assert.equal(far.isError, true, 'traversal into another repo .git must be refused');

  // the trust gate also refuses to call a relative .git path project-local
  const { checkTrust } = await import('../src/trust.js');
  const v = checkTrust({ name: 'write_file', args: { path: 'src/../.git/config' }, trustLevel: 'balanced', ctx });
  assert.equal(v.allowed, false, 'a .git path is not project-local');
});

// ---------------------------------------------------------------------------
// .git/ is a WRITE-side guard, not a read-side one.
//
// gitCheck() is called from write_file and edit_file only; read_file never
// calls it. A `.git/config` inside the workspace reads fine, spelled relative
// or absolute, and gets byte-identical results either way. The read-side tools
// (read_file, list_dir, glob, grep) gate exactly one thing: the sensitive home
// directories ~/.ssh, ~/.aws and ~/.ox/sessions.
//
// This test pins that as-is. It is a record of CURRENT behaviour, NOT a claim
// that the behaviour is desirable — closing the read gap is a real policy
// change that needs its own risk analysis (refusing `.git` reads can break
// legitimate git tooling, and `.git/config` is not a credential store). If that
// change is ever made deliberately, this test is the tripwire that says so.
// Do not "fix" it by editing the assertions; change the policy and this
// together.
// ---------------------------------------------------------------------------
test('read_file on .git/config inside cwd SUCCEEDS while write_file on the same path is refused (pins current, not desired, behaviour)', async (t) => {
  const cwd = workspace(t);
  const ctx = { cwd, yolo: true };
  const abs = path.join(cwd, '.git', 'config');

  // Case-spelling variants are excluded on purpose: '.GIT/config' only resolves
  // to the same inode on a case-insensitive filesystem (APFS), and this suite
  // has to pass on case-sensitive ones too.
  for (const rel of ['.git/config', './.git/config', 'src/../.git/config']) {
    const relRead = await readFileTool({ path: rel }, ctx);
    const absRead = await readFileTool({ path: abs }, ctx);

    assert.equal(relRead.isError, undefined, `read_file refused the relative '.git' path '${rel}': ${relRead.content}`);
    assert.ok(relRead.content.includes('secret = yes'), `read_file returned no real contents for '${rel}': ${relRead.content}`);
    assert.equal(relRead.content, absRead.content, `relative and absolute reads of '${rel}' must return identical bytes`);
  }

  // The write side of the very same path is still refused, and nothing lands.
  const w = await writeFileTool({ path: '.git/config', content: 'clobbered\n' }, ctx);
  assert.equal(w.isError, true, 'write_file must still refuse .git/config');
  assert.match(w.content, /\.git\/|off-limits/i, `unclear refusal: ${w.content}`);

  const e = await editFileTool({ path: abs, old_string: 'secret', new_string: 'pwn' }, ctx);
  assert.equal(e.isError, true, 'edit_file must still refuse .git/config');

  assert.equal(fs.readFileSync(abs, 'utf8'), '[core]\n\tsecret = yes\n', '.git/config is untouched');
});

test("4. '~'-prefixed paths are still rejected, not expanded into a literal ~ dir", async (t) => {
  const cwd = workspace(t);
  const ctx = { cwd, yolo: true };

  for (const p of ['~/x', '~', '~root/x', '~a', './~/x']) {
    const r = await readFileTool({ path: p }, ctx);
    assert.equal(r.isError, true, `read_file expanded '${p}' instead of refusing it`);
    assert.ok(r.content.includes(p), `the refusal names the path: ${r.content}`);

    const w = await writeFileTool({ path: p, content: 'x' }, ctx);
    assert.equal(w.isError, true, `write_file expanded '${p}' instead of refusing it`);
  }
  // nothing was created — not at the home dir, not at <cwd>/~
  assert.ok(!fs.existsSync(path.join(cwd, '~')), 'no literal ~ directory was created');
  assert.ok(!fs.existsSync(path.join(cwd, 'x')), 'no ~-derived file was created');
  assert.ok(!fs.existsSync(path.join(cwd, '~a')), 'no ~user-derived file was created');
  assert.ok(!fs.existsSync(path.join(cwd, '~root')), 'no ~user-derived directory was created');

  // The guard is about the FIRST segment only. A '~' further along names a file
  // inside a directory the caller already spelled out, so it stays an ordinary
  // relative path — the guard is not a wildcard that eats a whole subtree.
  const inner = await writeFileTool({ path: 'src/~scratch.js', content: 'x\n' }, ctx);
  assert.equal(inner.isError, undefined, `unexpected refusal: ${inner.content}`);
  assert.equal(fs.readFileSync(path.join(cwd, 'src', '~scratch.js'), 'utf8'), 'x\n');
});

test('5. an absolute path behaves exactly as before, and a relative path never changes it', async (t) => {
  const cwd = workspace(t);
  const ctx = { cwd, yolo: true };

  // absolute read (inside the cwd, so the header relativizes either way)
  const abs = await readFileTool({ path: path.join(cwd, 'src', 'cart.js') }, ctx);
  assert.equal(abs.isError, undefined);
  assert.ok(abs.content.startsWith('src/cart.js · totalLines='), `header: ${abs.content.slice(0, 40)}`);
  assert.ok(abs.content.includes('// cartMarker'), 'the absolute read returned the real contents');

  // absolute read of a file OUTSIDE the cwd still prints absolute
  const far = sandbox(t);
  fs.writeFileSync(path.join(far, 'x.js'), '// farMarker\n');
  const outAbs = await readFileTool({ path: path.join(far, 'x.js') }, ctx);
  assert.ok(outAbs.content.startsWith(`${path.join(far, 'x.js')} · totalLines=`), 'outside stays absolute');

  // absolute write + edit, with the diff/backup path intact
  const wAbs = await writeFileTool({ path: path.join(cwd, 'src', 'cart.js'), content: '// cartMarker\nexport const cart = 2;\n' }, ctx);
  assert.match(wAbs.content, /^Wrote /);
  assert.match(wAbs.content, /^--- a\//m);
  const eAbs = await editFileTool({ path: path.join(cwd, 'src', 'cart.js'), old_string: 'cart = 2', new_string: 'cart = 3' }, ctx);
  assert.equal(eAbs.isError, undefined);
  assert.equal(fs.readFileSync(path.join(cwd, 'src', 'cart.js'), 'utf8'), '// cartMarker\nexport const cart = 3;\n');

  // absolute and relative are the same call
  const viaAbs = await readFileTool({ path: path.join(cwd, 'src', 'cart.js') }, ctx);
  const viaRel = await readFileTool({ path: 'src/cart.js' }, ctx);
  assert.equal(viaRel.content, viaAbs.content, 'one call, one result, whichever form the path took');
});

test('6. output relativization is unchanged: inside -> relative, outside -> absolute, either input form', async (t) => {
  const cwd = workspace(t);
  const outside = sandbox(t);
  fs.writeFileSync(path.join(outside, 'far.js'), '// outsideMarker\n');
  const ctx = { cwd, yolo: true };

  // inside, relative INPUT -> relative OUTPUT
  const inRel = await readFileTool({ path: 'src/cart.js' }, ctx);
  assert.ok(inRel.content.startsWith('src/cart.js · totalLines='), `expected relative: ${inRel.content.slice(0, 40)}`);
  assert.ok(!inRel.content.includes(cwd), 'no absolute cwd leaked into the output');

  // outside, relative INPUT (via ..) -> absolute OUTPUT
  const outRel = await readFileTool({ path: path.join('..', path.basename(outside), 'far.js') }, ctx);
  assert.ok(
    outRel.content.startsWith(`${path.join(outside, 'far.js')} · totalLines=`),
    `a path outside the cwd must print absolute, not ../..: ${outRel.content.slice(0, 60)}`
  );

  const gRel = await globTool({ pattern: '*.js', path: path.join('..', path.basename(outside)) }, ctx);
  assert.deepEqual(gRel.content.split('\n'), [path.join(outside, 'far.js')], 'outside glob results stay absolute');

  const lRel = await listDirTool({ path: path.join('..', path.basename(outside)) }, ctx);
  assert.ok(lRel.content.startsWith(`${outside}/\n`), `outside root printed relative: ${lRel.content.slice(0, 40)}`);

  // a nonexistent relative path keeps the existing error shape and names the
  // resolved path, so the model can retry without re-deriving it
  const missing = await readFileTool({ path: 'src/nope.txt' }, ctx);
  assert.equal(missing.isError, true);
  assert.match(missing.content, /read_file: cannot read .*nope\.txt — file not found/);
  assert.ok(missing.content.includes(path.join(cwd, 'src', 'nope.txt')), `error names the resolved path: ${missing.content}`);
  // and the same call in absolute form gives the identical error
  const missingAbs = await readFileTool({ path: path.join(cwd, 'src', 'nope.txt') }, ctx);
  assert.equal(missingAbs.content, missing.content, 'the error shape is the same for both forms');
});

test('7. the system prompt no longer tells the model to use absolute paths, and the new line is short', async () => {
  const { buildSystemPrompt } = await import('../src/system-prompt.js');
  const prompt = await buildSystemPrompt({ cwd: process.cwd(), contextParts: {} });
  const rules = prompt.slice(prompt.indexOf('# TOOL RULES'), prompt.indexOf('# MEMORY'));

  assert.doesNotMatch(rules, /ALWAYS use absolute paths/, 'the old instruction is gone');
  assert.doesNotMatch(rules, /relative paths are rejected/, 'the old instruction is gone');

  const line = '- File tool paths may be relative to cwd; ~ is not expanded.';
  assert.ok(rules.includes(line), `new instruction missing from TOOL RULES:\n${rules}`);
  assert.equal(line.length, 60, 'the instruction ships every turn: pinned at 60 chars (-11 from the old 71)');
  assert.ok(line.length / 3 <= 22, 'under ~22 tokens even at 3 chars/token');

  // the guards it used to imply are still stated
  assert.match(rules, /Stay inside the workspace; do not touch files under \/\.git\/\./);
  assert.ok(rules.includes('relative'), 'the model is told the new rule, not just left to find out');
});

test('8. with no ctx.cwd at all, a relative path still resolves against the process cwd', async () => {
  // Not a silent no-op: the headless/direct-call case must not fall back to
  // "relative is refused", and it must not resolve to the workspace either.
  const res = await readFileTool({ path: 'ox-abscheck-probe-does-not-exist.txt' });
  assert.equal(res.isError, true);
  assert.ok(
    res.content.includes(path.join(process.cwd(), 'ox-abscheck-probe-does-not-exist.txt')),
    `expected a resolved-against-process.cwd error, got: ${res.content}`
  );
  assert.doesNotMatch(res.content, /ABSOLUTE/, 'the removed contract is not reachable any more');
});
