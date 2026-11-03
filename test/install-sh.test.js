// The installer checks what it downloads before installing anything: an exact
// release, its checksum (a mismatch installs nothing), GitHub's attestation when
// gh is there; and it never opens the app. Run against a fake release, with
// curl, pkill and gh replaced, in a temporary home (never /Applications).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';

const mac = process.platform === 'darwin';

function setup({ badSum = false, noSum = false, gh = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-inst-'));
  const home = path.join(root, 'home'), rel = path.join(root, 'release'), bin = path.join(root, 'bin');
  for (const d of [home, rel, bin, path.join(home, 'Applications', 'OX.app')]) fs.mkdirSync(d, { recursive: true });
  const arch = os.arch() === 'arm64' ? 'arm64' : 'x64';
  const app = path.join(root, 'build', 'OX.app', 'Contents');
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, 'marker'), 'new build');
  const zip = path.join(rel, `ox-mac-${arch}.zip`);
  spawnSync('ditto', ['-c', '-k', '--keepParent', path.join(root, 'build', 'OX.app'), zip]);
  const sum = crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex');
  if (!noSum) fs.writeFileSync(`${zip}.sha256`, `${badSum ? '0'.repeat(64) : sum}  ox-mac-${arch}.zip\n`);
  // curl: the latest-release redirect, and files from the fake release.
  fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/sh
out=""; url=""; head=0; prev=""
for a in "$@"; do
  [ "$prev" = "-o" ] && out="$a"
  case "$a" in -fsSLI|-I) head=1 ;; http*) url="$a" ;; esac
  prev="$a"
done
[ "$head" = 1 ] && { printf 'https://github.com/SAI141003/ox/releases/tag/v9.9.9'; exit 0; }
f="${rel}/$(basename "$url")"
[ -f "$f" ] || exit 22
if [ -n "$out" ] && [ "$out" != "/dev/null" ]; then cp "$f" "$out"; else cat "$f"; fi
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'pkill'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'open'), `#!/bin/sh\necho opened >> "${root}/opened"\n`, { mode: 0o755 });
  if (gh) fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nif [ "$1" = auth ]; then exit ${gh === 'signed-out' ? 1 : 0}; fi\nexit ${gh === 'ok' ? 0 : 1}\n`, { mode: 0o755 });
  return { root, home, bin, sum };
}
const run = ({ home, bin }) => spawnSync('sh', [path.resolve('install.sh')], { encoding: 'utf8', env: { HOME: home, PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin` } });
const installed = (home) => { try { return fs.readFileSync(path.join(home, 'Applications', 'OX.app', 'Contents', 'marker'), 'utf8'); } catch { return null; } };

test('a matching checksum installs that exact release, and the app is not opened', { skip: !mac }, () => {
  const s = setup();
  const r = run(s);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /ox v9\.9\.9/);
  assert.match(r.stdout, new RegExp(`checksum ${s.sum}`));
  assert.equal(installed(s.home), 'new build');
  assert.equal(fs.existsSync(path.join(s.root, 'opened')), false, 'never opened');
  fs.rmSync(s.root, { recursive: true, force: true });
});

test('a wrong checksum, or none, installs nothing', { skip: !mac }, () => {
  for (const opt of [{ badSum: true }, { noSum: true }]) {
    const s = setup(opt);
    const r = run(s);
    assert.notEqual(r.status, 0);
    assert.match(r.stdout, opt.badSum ? /checksum mismatch.*Nothing was installed/ : /no checksum/);
    assert.equal(installed(s.home), null, 'the old app is left as it was');
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

test('with gh, a release GitHub cannot attest is refused', { skip: !mac }, () => {
  const bad = setup({ gh: 'fail' });
  const r = run(bad);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /GitHub could not confirm/);
  assert.equal(installed(bad.home), null);
  const ok = setup({ gh: 'ok' });
  assert.match(run(ok).stdout, /built by SAI141003\/ox's release workflow/);
  for (const s of [bad, ok]) fs.rmSync(s.root, { recursive: true, force: true });
});

test('gh not signed in gives no verdict: the checksum decides, and it says so', { skip: !mac }, () => {
  const out = setup({ gh: 'signed-out' });
  const r = run(out);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /not signed in: checked the checksum only/);
  assert.ok(installed(out.home));
  fs.rmSync(out.root, { recursive: true, force: true });
});
