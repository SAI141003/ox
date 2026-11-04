// Updating a copy installed from a GitHub release (no .git folder). A fake
// release stands in for GitHub: a copy is installed only when its checksum
// matches, GitHub's attestation (when gh is there) passes, and the bundle
// reports the release's version. Nothing is replaced when a check fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyDownload, assetFor, attest, checkDownload, compareVersions, isDownloadCopy, appBundleOf, latestRelease,
} from '../src/download-update.js';

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// An installed copy: …/OX.app/Contents/Resources/ox with its package.json.
function installedCopy(version = '0.1.7') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-dl-test-'));
  const app = path.join(dir, 'OX.app');
  const root = path.join(app, 'Contents', 'Resources', 'ox');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), '<plist/>');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version }));
  return { dir, app, root };
}

// The release as GitHub would describe it, with the zip bytes and their checksum file.
function fakeRelease({ tag = 'v0.1.8', zip = Buffer.from('zip-bytes'), sum = null, names } = {}) {
  const zipName = names?.zip ?? 'ox-mac-arm64.zip';
  const assets = [
    { name: zipName, browser_download_url: `https://dl/${zipName}` },
    { name: `${zipName}.sha256`, browser_download_url: `https://dl/${zipName}.sha256` },
  ];
  const files = { [`https://dl/${zipName}`]: zip, [`https://dl/${zipName}.sha256`]: Buffer.from(`${sum ?? sha(zip)}  ${zipName}\n`) };
  const fetchImpl = async (url) => {
    if (url.includes('api.github.com')) {
      return { ok: true, status: 200, json: async () => ({ tag_name: tag, assets }) };
    }
    if (!(url in files)) return { ok: false, status: 404 };
    return { ok: true, status: 200, arrayBuffer: async () => files[url].buffer.slice(files[url].byteOffset, files[url].byteOffset + files[url].byteLength) };
  };
  return { fetchImpl, assets };
}

// Unpacking stands in for `ditto`: the zip becomes …/OX.app with the new version inside.
function unpackTo(version) {
  return (_archive, dest) => {
    const root = path.join(dest, 'OX.app', 'Contents', 'Resources', 'ox');
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(path.join(dest, 'OX.app', 'Contents'), { recursive: true });
    fs.writeFileSync(path.join(dest, 'OX.app', 'Contents', 'Info.plist'), '<plist/>');
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version }));
  };
}

test('a copy with no .git folder is a release download', () => {
  const { root } = installedCopy();
  assert.equal(isDownloadCopy(root), true);
  fs.mkdirSync(path.join(root, '.git'));
  assert.equal(isDownloadCopy(root), false);
});

test('the release file for each system matches what the installers fetch', () => {
  assert.equal(assetFor({ platform: 'darwin', arch: 'arm64' }).name, 'ox-mac-arm64.zip');
  assert.equal(assetFor({ platform: 'darwin', arch: 'x64' }).name, 'ox-mac-x64.zip');
  assert.equal(assetFor({ platform: 'linux', arch: 'x64' }).name, 'ox-linux-x64.tar.gz');
  assert.equal(assetFor({ platform: 'win32', arch: 'x64' }).name, 'ox-windows-x64.zip');
  assert.equal(assetFor({ platform: 'linux', arch: 'arm64' }), null);
});

test('versions compare by number, not by text', () => {
  assert.equal(compareVersions('0.1.10', '0.1.9'), 1);
  assert.equal(compareVersions('0.1.8', '0.1.8'), 0);
  assert.equal(compareVersions('0.1.7', '0.1.8'), -1);
  assert.equal(compareVersions('0.1.7', null), 1);
});

test('the bundle that contains this copy is found from its folder', () => {
  const { app, root } = installedCopy();
  assert.equal(appBundleOf(root), app);
  assert.equal(appBundleOf(path.join(app, '..', 'elsewhere')), null);
});

test('latest release: a bad tag is refused plainly', async () => {
  const { fetchImpl } = fakeRelease({ tag: 'latest' });
  await assert.rejects(latestRelease(fetchImpl), /unexpected tag: latest/);
  const ok = await latestRelease(fakeRelease().fetchImpl);
  assert.equal(ok.version, '0.1.8');
});

test('check: a newer release is offered, the same version is up to date', async () => {
  const { root } = installedCopy('0.1.7');
  const mac = { platform: 'darwin', arch: 'arm64' };
  const newer = await checkDownload({ root, fetchImpl: fakeRelease().fetchImpl, ...mac });
  assert.equal(newer.upToDate, false);
  assert.equal(newer.version, '0.1.8');
  const { root: same } = installedCopy('0.1.8');
  const current = await checkDownload({ root: same, fetchImpl: fakeRelease().fetchImpl, ...mac });
  assert.equal(current.upToDate, true);
});

test('check: a release still uploading is not offered until this machine\'s file is there', async () => {
  const { root } = installedCopy('0.1.7');
  // Published with the Linux file only, as v0.1.8 was for a few minutes.
  const { fetchImpl } = fakeRelease({ names: { zip: 'ox-linux-x64.tar.gz' } });
  const r = await checkDownload({ root, fetchImpl, platform: 'darwin', arch: 'arm64' });
  assert.equal(r.upToDate, true);
});

test('apply: a verified download replaces the bundle and reopens OX', async () => {
  const { root, app } = installedCopy('0.1.7');
  const { fetchImpl } = fakeRelease();
  const installed = [];
  const relaunched = [];
  const r = await applyDownload({
    root, fetchImpl, platform: 'darwin', arch: 'arm64',
    verify: () => ({ checked: true }), unpack: unpackTo('0.1.8'),
    install: (appPath, newApp) => installed.push([appPath, newApp]),
    relaunch: (appPath) => relaunched.push(appPath),
  });
  assert.equal(r.ok, true, r.why);
  assert.equal(r.to, '0.1.8');
  assert.equal(r.attested, true);
  assert.equal(installed.length, 1);
  assert.equal(installed[0][0], app);
  assert.deepEqual(relaunched, [app]);
  assert.match(r.steps.at(-1), /Updated to 0\.1\.8, restarting OX/);
});

test('apply: a checksum mismatch installs nothing', async () => {
  const { root } = installedCopy('0.1.7');
  const { fetchImpl } = fakeRelease({ sum: '0'.repeat(64) });
  let touched = false;
  const r = await applyDownload({
    root, fetchImpl, platform: 'darwin', arch: 'arm64',
    unpack: () => { touched = true; }, install: () => { touched = true; }, relaunch: () => { touched = true; },
  });
  assert.equal(r.ok, false);
  assert.match(r.why, /does not match its checksum/);
  assert.equal(touched, false);
});

test('apply: a build GitHub cannot verify installs nothing', async () => {
  const { root } = installedCopy('0.1.7');
  const { fetchImpl } = fakeRelease();
  let installed = false;
  const r = await applyDownload({
    root, fetchImpl, platform: 'darwin', arch: 'arm64',
    verify: () => { throw new Error('GitHub could not verify who built this file: no attestation'); },
    unpack: unpackTo('0.1.8'), install: () => { installed = true; }, relaunch: () => {},
  });
  assert.equal(r.ok, false);
  assert.match(r.why, /could not verify who built/);
  assert.equal(installed, false);
});

test('apply: a release with no checksum file is refused before any download', async () => {
  const { root } = installedCopy('0.1.7');
  const { fetchImpl } = fakeRelease();
  const noSums = async (url, opts) => (url.endsWith('.sha256') ? { ok: false, status: 404 } : fetchImpl(url, opts));
  const fakeList = async (url, opts) => {
    if (url.includes('api.github.com')) {
      const r = await fetchImpl(url, opts);
      const j = await r.json();
      return { ok: true, status: 200, json: async () => ({ tag_name: j.tag_name, assets: j.assets.filter((a) => !a.name.endsWith('.sha256')) }) };
    }
    return noSums(url, opts);
  };
  const r = await applyDownload({ root, fetchImpl: fakeList, platform: 'darwin', arch: 'arm64', install: () => assert.fail('must not install') });
  assert.equal(r.ok, false);
  assert.match(r.why, /publishes no checksum/);
});

test('apply: already on the newest version does nothing', async () => {
  const { root } = installedCopy('0.1.8');
  const r = await applyDownload({ root, fetchImpl: fakeRelease().fetchImpl, platform: 'darwin', arch: 'arm64', install: () => assert.fail('must not install') });
  assert.equal(r.ok, true);
  assert.equal(r.upToDate, true);
});

test('apply: other systems are told to run the installer, not handed a half update', async () => {
  const { root } = installedCopy('0.1.7');
  const r = await applyDownload({ root, fetchImpl: fakeRelease().fetchImpl, platform: 'win32', arch: 'x64' });
  assert.equal(r.ok, false);
  assert.match(r.why, /run the installer again/);
});

test('who built it: no gh, or gh not signed in, is no verdict; signed in, a failure refuses', () => {
  const runner = (answers) => (_cmd, args) => ({ status: answers[args[0]] ?? 0, stdout: '', stderr: 'no attestation found' });
  assert.deepEqual(attest('f', runner({ '--version': 1 })), { checked: false });
  assert.deepEqual(attest('f', runner({ auth: 1 })), { checked: false, why: 'gh is not signed in' });
  assert.deepEqual(attest('f', runner({})), { checked: true });
  assert.throws(() => attest('f', runner({ attestation: 1 })), /could not verify who built/);
});

test('apply: a download is signed for this Mac before it replaces the app, so permissions carry over', async () => {
  const { root, app } = installedCopy('0.1.7');
  const order = [];
  const r = await applyDownload({
    root, fetchImpl: fakeRelease().fetchImpl, platform: 'darwin', arch: 'arm64', verify: () => ({ checked: true }), unpack: unpackTo('0.1.8'),
    sign: (newApp, oldApp) => order.push(['sign', path.basename(newApp), oldApp]),
    install: () => order.push(['install']),
    relaunch: () => {},
  });
  assert.equal(r.ok, true, r.why);
  assert.deepEqual(order, [['sign', 'OX.app', app], ['install']]);
});

test('apply: signing failing does not stop an update that passed its checks', async () => {
  const { root } = installedCopy('0.1.7');
  let installed = false;
  const r = await applyDownload({ root, fetchImpl: fakeRelease().fetchImpl, platform: 'darwin', arch: 'arm64', verify: () => ({ checked: true }), unpack: unpackTo('0.1.8'), sign: () => { throw new Error('no keychain'); }, install: () => { installed = true; }, relaunch: () => {} });
  assert.equal(r.ok, true);
  assert.equal(installed, true);
});
