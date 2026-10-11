// Competitive gap #2: a LITERAL path in a sandbox profile's `read_only` list was
// silently unenforced, and it failed OPEN.
//
// compileSbpl() skipped literal read_only entries on the theory that the blanket
// `(deny file-write*)` already covered them. That holds only OUTSIDE every
// writable root. Seatbelt takes the LAST matching rule, and
// `(allow file-write* (subpath "<cwd>"))` is emitted after the blanket deny, so
// INSIDE cwd the allow won and the read_only path stayed writable:
//
//   mentions read_only literal: false
//   control write to cwd:       exit=0  ok (valid control)
//   write into read_only:       exit=0  pwned
//
// Nothing surfaced it: gaps.unapplied == [] and profile.warnings == [].
//
// Every test here is pinned at the layer that can actually fail: the write
// attempts below are REAL sandbox-exec runs, not string assertions on the
// compiled SBPL. The compiled text is asserted too, but only alongside the
// runtime proof — a policy that reads correctly and does not enforce is still
// the bug.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  resolveSandbox,
  compileSbpl,
  buildBwrapArgv,
  prepareSandbox,
  bwrapGaps,
  resetSandboxCompileCacheForTest,
} from '../src/sandbox.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OX_BIN = path.join(ROOT, 'bin', 'ox.js');
const SANDBOX_EXEC = process.platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec') ? '/usr/bin/sandbox-exec' : null;

const temps = [];
after(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

function tempRoot(tag) {
  // fs.mkdtemp under os.tmpdir() returns /var/folders/... on macOS, which is a
  // symlink to /private/var/folders/.... Seatbelt matches subpath filters on the
  // CANONICAL path, so a profile compiled with the /var/folders spelling denies
  // writes to /private/var/folders and the "control" write fails too — which
  // would make a test pass for the wrong reason. Realpath it so the profile and
  // the command agree.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `ox-ro-${tag}-`)));
  temps.push(dir);
  return dir;
}

// A sandbox whose cwd is <root>/ws and whose HOME is <root>/home, so the
// writable set is exactly {ws, home/.ox, tmp}.
function workspace(root, readOnly, extra = {}) {
  const cwd = path.join(root, 'ws');
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.ox'), { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  const profile = resolveSandbox({ flag: 'workspace', config: {}, cwd, home });
  return { profile: { ...profile, read_only: readOnly, ...extra }, cwd, home };
}

// Compile a profile to a real .sb file and run a shell command under it.
// Returns the spawn result; status 0 means the write landed.
function runUnderProfile(profile, shellCommand) {
  const file = path.join(tempRoot('sb'), 'profile.sb');
  const text = compileSbpl(profile);
  fs.writeFileSync(file, text, { mode: 0o600 });
  return {
    text,
    result: spawnSync(SANDBOX_EXEC, ['-f', file, '/bin/sh', '-c', shellCommand], { encoding: 'utf8', timeout: 60_000 }),
  };
}

// ---------- the bug, end to end ---------------------------------------------

test('BUG: a LITERAL read_only path INSIDE cwd is denied by the kernel, and a sibling path in the same cwd is still writable', { skip: !SANDBOX_EXEC }, (t) => {
  const root = tempRoot('bug');
  const inside = path.join(root, 'ws', 'inside');
  const sibling = path.join(root, 'ws', 'sibling');
  fs.mkdirSync(inside, { recursive: true });
  fs.mkdirSync(sibling, { recursive: true });

  const { profile } = workspace(root, [inside]);

  // The compiled policy must name the path at all — this is what it did not do.
  assert.ok(profile.read_only.includes(inside));
  const sbpl = compileSbpl(profile);
  assert.ok(sbpl.includes(`(deny file-write* (subpath "${inside}"))`), `no literal read_only deny compiled:\n${sbpl}`);
  assert.ok(sbpl.includes('(deny file-write*)'), 'the blanket deny is still there');
  assert.ok(sbpl.includes(`(allow file-write* (subpath "${profile.cwd}")`), 'the cwd write root is still there');

  const pwned = path.join(inside, 'pwned.txt');
  const okFile = path.join(sibling, 'ok.txt');

  // THE control first. If this does not succeed the test proves nothing.
  const control = runUnderProfile(profile, `echo ok > ${JSON.stringify(okFile)}`);
  t.diagnostic(`control write to ${okFile}: exit=${control.result.status} stderr=${control.result.stderr.trim()}`);
  assert.equal(control.result.status, 0, `control write must succeed, or this test is vacuous:\n${control.result.stderr}`);
  assert.equal(fs.readFileSync(okFile, 'utf8').trim(), 'ok');

  // The bug: this used to exit 0 and write the file.
  const attack = runUnderProfile(profile, `echo pwned > ${JSON.stringify(pwned)}`);
  t.diagnostic(`write into read_only ${inside}: exit=${attack.result.status} stderr=${attack.result.stderr.trim()}`);
  assert.notEqual(attack.result.status, 0, 'a write into a literal read_only path must be REFUSED');
  assert.match(`${attack.result.stderr}`, /Operation not permitted|denied|Read-only/i, 'and refused by the kernel, not by luck');
  assert.equal(fs.existsSync(pwned), false, 'the file must not exist at all');

  // A control from the SAME run shape still works, so the deny is the only
  // thing standing between the two writes.
  const after = runUnderProfile(profile, `echo still-ok > ${JSON.stringify(okFile)}`);
  assert.equal(after.result.status, 0, 'the sibling path must still be writable under the same profile');
});

// The control above proves a plain file create. Also prove the deny is a
// subtree deny, not a single-name deny, and that creating the directory is
// refused too.
test('BUG: the literal read_only deny covers the whole subtree, including mkdir', { skip: !SANDBOX_EXEC }, () => {
  const root = tempRoot('subtree');
  const inside = path.join(root, 'ws', 'inside');
  fs.mkdirSync(inside, { recursive: true });
  const { profile } = workspace(root, [inside]);

  const deep = path.join(inside, 'a', 'b', 'deep.txt');
  fs.mkdirSync(path.dirname(deep), { recursive: true }); // pre-create so only the WRITE is measured
  const write = runUnderProfile(profile, `echo deep > ${JSON.stringify(deep)}`);
  assert.notEqual(write.result.status, 0, 'a nested write inside read_only must be refused');

  const mkdir = runUnderProfile(profile, `mkdir -p ${JSON.stringify(path.join(inside, 'newdir'))}`);
  assert.notEqual(mkdir.result.status, 0, 'creating a directory inside read_only must be refused');
  assert.equal(fs.existsSync(path.join(inside, 'newdir')), false);
});

// ---------- the form that already worked stays working ----------------------

test('a GLOB read_only path inside cwd is still denied (regression guard for the form that worked)', { skip: !SANDBOX_EXEC }, (t) => {
  const root = tempRoot('glob');
  const globbed = path.join(root, 'ws', 'secrets');
  const keep = path.join(root, 'ws', 'keep');
  fs.mkdirSync(globbed, { recursive: true });
  fs.mkdirSync(keep, { recursive: true });

  // `**` is what covers a subtree in an anchored glob; a bare trailing `*`
  // matches the entry itself only. Pinned below so the difference is documented
  // rather than discovered the hard way.
  const { profile } = workspace(root, [path.join(root, 'ws', 'secrets', '**')]);

  const sbpl = compileSbpl(profile);
  assert.match(sbpl, /\(deny file-write\* \(regex "\^\/.*\/secrets\/\.\*\$"\)\)/, `glob read_only lost its regex deny:\n${sbpl}`);

  const hit = runUnderProfile(profile, `echo leak > ${JSON.stringify(path.join(globbed, 'x.txt'))}`);
  t.diagnostic(`write into glob-matched read_only ${globbed}: exit=${hit.result.status} stderr=${hit.result.stderr.trim()}`);
  assert.notEqual(hit.result.status, 0, 'a glob-matched read_only path must be refused');
  assert.equal(fs.existsSync(path.join(globbed, 'x.txt')), false);

  const miss = runUnderProfile(profile, `echo fine > ${JSON.stringify(path.join(keep, 'x.txt'))}`);
  assert.equal(miss.result.status, 0, 'a non-matching path must stay writable');
});

// DOCUMENTED ASYMMETRY, now that both spellings are enforced: a LITERAL is a
// subtree deny, because (subpath "…") covers everything beneath it. A GLOB is
// an anchored full-path regex, so `dir*` matches the entry `dir` and NOT
// `dir/inside`. Use `dir/**` to cover a subtree. The literal form was silently
// unenforced before, which hid this entirely.
test('documented: literal read_only is a subtree deny; a glob needs ** for a subtree', () => {
  const root = tempRoot('asym');
  const { profile } = workspace(root, [path.join(root, 'lit'), path.join(root, 'globdir', '*')]);
  const sbpl = compileSbpl(profile);

  assert.ok(sbpl.includes(`(deny file-write* (subpath "${path.join(root, 'lit')}"))`), 'literal -> (subpath …), a subtree deny');
  assert.ok(sbpl.includes(`(deny file-write* (regex "^${root}/globdir/[^/]*$"))`), `glob -> anchored regex, entry-only:\n${sbpl}`);
  assert.ok(!sbpl.includes('/globdir/[^/]*/'), 'a single * must NOT silently become a subtree deny');
});

// ---------- literal and glob are the same kind of rule ---------------------

test('literal and glob read_only entries compile to the same KIND of deny (subpath vs anchored regex), in both list positions', () => {
  const root = tempRoot('shapes');
  const { profile } = workspace(root, ['/abs/literal/path', '/abs/glob/**/*.pem']);

  const sbpl = compileSbpl(profile);
  assert.ok(sbpl.includes('(deny file-write* (subpath "/abs/literal/path"))'), `literal:\n${sbpl}`);
  assert.ok(sbpl.includes('(deny file-write* (regex "^/abs/glob/.*/[^/]*\\.pem$"))'), `glob:\n${sbpl}`);

  // Both forms must be emitted AFTER the cwd write root, or Seatbelt's
  // last-rule-wins makes them decorative.
  const rootAllow = sbpl.indexOf(`(allow file-write* (subpath "${profile.cwd}")`);
  assert.ok(rootAllow !== -1, 'the cwd write root must be present');
  assert.ok(sbpl.indexOf('(deny file-write* (subpath "/abs/literal/path"))') > rootAllow, 'literal deny must come after the cwd allow');
  assert.ok(sbpl.indexOf('(deny file-write* (regex "^/abs/glob/') > rootAllow, 'glob deny must come after the cwd allow');

  // read_only is a WRITE deny only — it must not turn into a read deny.
  assert.ok(!sbpl.includes('(deny file-read* (subpath "/abs/literal/path")'), 'read_only must not deny reads');
});

// read_only must also beat an overlapping read_write: two user statements, the
// more restrictive one wins (the fail-closed reading).
test('read_only wins over an overlapping read_write', { skip: !SANDBOX_EXEC }, () => {
  const root = tempRoot('overlap');
  const inside = path.join(root, 'ws', 'inside');
  fs.mkdirSync(inside, { recursive: true });
  const { profile } = workspace(root, [inside], { read_write: [inside] });

  const sbpl = compileSbpl(profile);
  assert.ok(sbpl.indexOf('(deny file-write* (subpath') > sbpl.lastIndexOf('(allow file-write*'), 'the deny must be emitted last');

  const attack = runUnderProfile(profile, `echo nope > ${JSON.stringify(path.join(inside, 'x.txt'))}`);
  assert.notEqual(attack.result.status, 0, 'read_only must win the overlap');
});

// ---------- outside every writable root -------------------------------------

test('a read_only path OUTSIDE every writable root is still denied (both spellings)', { skip: !SANDBOX_EXEC }, () => {
  const root = tempRoot('outside');
  const outsideLit = path.join(root, 'outside', 'lit');
  const outsideGlob = path.join(root, 'outside', 'globbed');
  fs.mkdirSync(outsideLit, { recursive: true });
  fs.mkdirSync(outsideGlob, { recursive: true });

  const { profile, cwd, home } = workspace(root, [outsideLit, path.join(root, 'outside', 'glob*')]);
  for (const outside of [outsideLit, outsideGlob]) {
    assert.ok(!outside.startsWith(cwd + path.sep), 'the control: these really are outside the write roots');
    assert.ok(!outside.startsWith(home + path.sep));
  }

  const sbpl = compileSbpl(profile);
  assert.ok(sbpl.includes(`(deny file-write* (subpath "${outsideLit}"))`), `literal outside:\n${sbpl}`);

  const lit = runUnderProfile(profile, `echo nope > ${JSON.stringify(path.join(outsideLit, 'x.txt'))}`);
  assert.notEqual(lit.result.status, 0, 'the blanket deny must still cover a literal path outside cwd');
  const gl = runUnderProfile(profile, `echo nope > ${JSON.stringify(path.join(outsideGlob, 'x.txt'))}`);
  assert.notEqual(gl.result.status, 0, 'and a glob path outside cwd');
});

// ---------- the redundant-skip case: no behaviour change -------------------

test('a profile with NO read_only compiles byte-identically to the pre-fix output', () => {
  // Pinned literally, not reconstructed from the current code, so any future
  // edit to the deny/widen ordering shows up here as a diff. Before the fix a
  // literal read_only emitted nothing; with an empty list the fix is a no-op.
  const bare = {
    kind: 'preset',
    name: 'workspace',
    cwd: '/w',
    oxDir: '/home/u/.ox',
    tmpDir: '/tmp',
    read_only: [],
    read_write: [],
    deny: [],
    restrict_network: false,
    network_allow: [],
  };
  const expected = [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    '(allow file-write* (subpath "/w") (subpath "/home/u/.ox") (regex "^/tmp/.*"))',
    '',
  ].join('\n');
  assert.equal(compileSbpl(bare), expected);
  assert.equal(compileSbpl({ ...bare, read_only: [] }), expected, 'an explicitly empty read_only is the same');

  // read_write-only and deny-only profiles are also untouched by the fix.
  assert.equal(
    compileSbpl({ ...bare, read_write: ['/tmp/scratch'] }),
    expected.replace('(regex "^/tmp/.*"))', '(regex "^/tmp/.*"))\n(allow file-write* (subpath "/tmp/scratch"))')
  );
  assert.equal(
    compileSbpl({ ...bare, deny: ['/etc/master.key'] }),
    expected.replace('(regex "^/tmp/.*"))', '(regex "^/tmp/.*"))\n(deny file-read* (subpath "/etc/master.key"))\n(deny file-write* (subpath "/etc/master.key"))')
  );

  // The same holds through the real resolver, including the read-only preset.
  const root = tempRoot('bare');
  const { cwd, home } = workspace(root, []);
  assert.equal(
    compileSbpl(resolveSandbox({ flag: 'workspace', config: {}, cwd, home })),
    expected.replace(/\/w/g, cwd).replace(/\/home\/u\/\.ox/g, path.join(home, '.ox')).replace(/\^\/tmp\/\.\*/, `^${os.tmpdir().replace(/[\\^$.]/g, (c) => `\\${c}`)}/.*`)
  );
});

// ---------- the deny list: literal/glob consistency ------------------------

test('`deny` is already consistent: literal -> subpath, glob -> anchored regex, for BOTH read and write', () => {
  const bare = {
    kind: 'custom',
    name: 'mine',
    extends: 'workspace',
    cwd: '/w',
    oxDir: '/home/u/.ox',
    tmpDir: '/tmp',
    read_only: [],
    read_write: [],
    deny: ['/etc/master.key', '/home/u/**/*.pem'],
    restrict_network: false,
    network_allow: [],
  };
  const sbpl = compileSbpl(bare);
  assert.ok(sbpl.includes('(deny file-read* (subpath "/etc/master.key"))'), `literal read deny:\n${sbpl}`);
  assert.ok(sbpl.includes('(deny file-write* (subpath "/etc/master.key"))'), 'literal write deny');
  assert.ok(sbpl.includes('(deny file-read* (regex "^/home/u/.*/[^/]*\\.pem$"))'), 'glob read deny');
  assert.ok(sbpl.includes('(deny file-write* (regex "^/home/u/.*/[^/]*\\.pem$"))'), 'glob write deny');

  // Both spellings, both verbs: four rules for four (entry x verb) pairs. If a
  // literal ever comes back skipped, this count drops.
  assert.equal(sbpl.split('(deny file-read*').length - 1, 2, 'one read deny per deny entry');
  assert.equal(sbpl.split('(deny file-write* (subpath "/etc/master.key")').length - 1, 1);

  // Last in the profile, so it beats every allow above it.
  const lastAllow = sbpl.lastIndexOf('(allow file-write*');
  assert.ok(sbpl.indexOf('(deny file-read* (subpath "/etc/master.key")') > lastAllow, 'explicit denies come after the write roots');
});

// ---------- compile cache -------------------------------------------------

test('cacheKey covers read_only, so a read_only-only change is not served from a stale compile', () => {
  resetSandboxCompileCacheForTest();
  const root = tempRoot('cache');
  const base = resolveSandbox({ flag: 'workspace', config: {}, cwd: path.join(root, 'ws'), home: path.join(root, 'home') });
  const withLiteral = { ...base, read_only: ['/x/lit'] };
  const withGlob = { ...base, read_only: ['/x/*.pem'] };

  // A literal read_only now genuinely changes the compiled text, so the SBPL
  // FILE the cache points at must differ too.
  const a = prepareSandbox(withLiteral);
  const b = prepareSandbox(withGlob);
  const none = prepareSandbox({ ...base, read_only: [] });
  assert.notEqual(compileSbpl(withLiteral), compileSbpl({ ...base, read_only: [] }), 'a literal read_only changes the policy');

  if (a.backend !== 'none' && b.backend !== 'none') {
    assert.notEqual(a.argvPrefix[a.argvPrefix.length - 1], b.argvPrefix[b.argvPrefix.length - 1], 'literal vs glob must not share a compiled file');
    assert.notEqual(none.argvPrefix[none.argvPrefix.length - 1], a.argvPrefix[a.argvPrefix.length - 1], 'empty vs literal must not share a compiled file');
  }
  // And the compiled files on disk really are distinct policies.
  if (a.backend === 'sandbox-exec' && b.backend === 'sandbox-exec') {
    const fa = fs.readFileSync(a.argvPrefix[2], 'utf8');
    const fb = fs.readFileSync(b.argvPrefix[2], 'utf8');
    assert.ok(fa.includes('(subpath "/x/lit")'));
    assert.ok(fb.includes('(regex "^/x/[^/]*\\.pem$")'));
  }
  resetSandboxCompileCacheForTest();
});

// ---------- Linux: bwrap cannot express it, so it must say so ---------------

test('bwrap: read_only (and deny) are reported as UNAPPLIED, never silently ignored', () => {
  const root = tempRoot('bwrap');
  const base = resolveSandbox({ flag: 'workspace', config: {}, cwd: path.join(root, 'ws'), home: path.join(root, 'home') });

  const withReadOnly = { ...base, read_only: [path.join(root, 'ws', 'secrets')] };
  const gaps = bwrapGaps(withReadOnly);
  assert.ok(gaps.unapplied.includes('read_only'), `read_only must be named: ${JSON.stringify(gaps.unapplied)}`);
  assert.match(gaps.notes.join(' '), /read_only \(1 entry\) is NOT applied on Linux/);
  assert.match(gaps.notes.join(' '), /cannot remove a path from the writable set/);

  // The gap report must not over-claim the macOS form it names.
  assert.match(gaps.notes.join(' '), /\(deny file-write\* \(subpath …\)\)/, 'the note names the literal SBPL form');

  // bwrap argv carries no read_only rule at all — which is exactly why the gap
  // has to exist.
  const argv = buildBwrapArgv(withReadOnly, 'echo hi');
  assert.ok(!argv.includes(withReadOnly.read_only[0]), 'bwrap argv must not pretend to apply read_only');

  // `deny` was silently dropped from the bwrap argv too, in the fail-OPEN
  // direction. It is now reported.
  const withDeny = { ...base, deny: ['/etc/master.key'] };
  const denyGaps = bwrapGaps(withDeny);
  assert.ok(denyGaps.unapplied.includes('deny'), `deny must be named: ${JSON.stringify(denyGaps.unapplied)}`);
  assert.match(denyGaps.notes.join(' '), /fail-OPEN direction/);

  // A glob read_write has no --bind form; reported rather than dropped.
  const rwGlob = bwrapGaps({ ...base, read_write: [path.join(root, 'scratch', '*')] });
  assert.ok(rwGlob.unapplied.includes('read_write(glob)'), JSON.stringify(rwGlob.unapplied));
  assert.match(rwGlob.notes.join(' '), /Fail-closed/);

  // Nothing to report when there is nothing to report.
  assert.deepEqual(bwrapGaps(base).unapplied, [], 'a bare workspace profile has no bwrap gaps');
});

// ---------- the gap reaches the user ---------------------------------------

test('/sandbox displays the loaded read_only entries', (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ox-ro-cli-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ox-ro-ws-')));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  const secret = path.join(ws, 'secrets');
  fs.mkdirSync(secret, { recursive: true });
  fs.writeFileSync(path.join(ws, '.ox-sandbox.json'), JSON.stringify({ extends: 'workspace', read_only: [secret] }));

  const env = { ...process.env, HOME: home, NO_COLOR: '1' };
  delete env.OX_API_KEY;
  const proc = spawnSync(process.execPath, [OX_BIN, '--sandbox', 'mine'], {
    cwd: ws,
    env,
    input: '/sandbox\n/exit\n',
    encoding: 'utf8',
    timeout: 60_000,
  });
  const out = `${proc.stdout ?? ''}${proc.stderr ?? ''}`;
  assert.match(out, /sandbox: mine/, `/sandbox did not report the profile:\n${out}`);
  assert.ok(out.includes(secret), `/sandbox must list the loaded read_only entry (${secret}):\n${out}`);
});
