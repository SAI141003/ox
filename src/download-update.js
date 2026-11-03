// Updating a copy installed from a GitHub release (OX.app from install.sh /
// install.ps1), which has no .git folder. Only SAI141003/ox's own releases are
// read. The download must match the .sha256 published with its release; when
// the GitHub CLI is installed, `gh attestation verify` must also pass. Then
// the OX.app bundle is replaced and OX is reopened. Nothing under ~/.ox is
// touched: settings, keys and chats stay where they are.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

export const REPO = 'SAI141003/ox';
const LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;

/** A copy with no .git folder came from a release download. */
export function isDownloadCopy(root) {
  return !fs.existsSync(path.join(root, '.git'));
}

/** The release file this machine uses, the same names install.sh and install.ps1 fetch. */
export function assetFor({ platform = process.platform, arch = process.arch } = {}) {
  if (platform === 'darwin') return { name: `ox-mac-${arch === 'arm64' ? 'arm64' : 'x64'}.zip` };
  if (platform === 'linux' && arch === 'x64') return { name: 'ox-linux-x64.tar.gz' };
  if (platform === 'win32' && arch === 'x64') return { name: 'ox-windows-x64.zip' };
  return null;
}

/** The OX.app that contains this copy (…/OX.app/Contents/Resources/ox), or null. */
export function appBundleOf(root) {
  const app = path.resolve(root, '..', '..', '..');
  return path.basename(app).endsWith('.app') && fs.existsSync(path.join(app, 'Contents', 'Info.plist')) ? app : null;
}

export function currentVersion(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version ?? null; } catch { return null; }
}

/** 1 when a is newer than b, -1 when older, 0 when the same. Unknown b counts as older. */
export function compareVersions(a, b) {
  if (!b) return 1;
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** The newest release of SAI141003/ox: { tag, version, assets: [{ name, url }] }. */
export async function latestRelease(fetchImpl = fetch) {
  const r = await fetchImpl(LATEST, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'ox-update' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`GitHub answered ${r.status} for the newest release`);
  const j = await r.json();
  const tag = String(j.tag_name ?? '');
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error(`the newest release has an unexpected tag: ${tag || '(none)'}`);
  return { tag, version: tag.slice(1), assets: (j.assets ?? []).map((a) => ({ name: a.name, url: a.browser_download_url })) };
}

/** Looks for a newer release. Changes nothing on disk. → { current, version, tag, upToDate } */
export async function checkDownload({ root, fetchImpl = fetch } = {}) {
  const current = currentVersion(root);
  const rel = await latestRelease(fetchImpl);
  const newer = compareVersions(rel.version, current) > 0;
  return { current, version: rel.version, tag: rel.tag, upToDate: !newer };
}

async function download(url, file, fetchImpl) {
  const r = await fetchImpl(url, { headers: { 'user-agent': 'ox-update' }, signal: AbortSignal.timeout(10 * 60_000) });
  if (!r.ok) throw new Error(`download failed (${r.status}) for ${path.basename(file)}`);
  fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function attest(file) {
  // The GitHub CLI is optional. When it is here, its check must pass.
  if (spawnSync('gh', ['--version'], { stdio: 'ignore' }).status !== 0) return { checked: false };
  const r = spawnSync('gh', ['attestation', 'verify', file, '--repo', REPO], { encoding: 'utf8', timeout: 60_000 });
  if (r.status !== 0) throw new Error(`GitHub could not verify who built this file: ${String(r.stderr || r.stdout).trim().split('\n').slice(-1)[0]}`);
  return { checked: true };
}

function extract(archive, dest) {
  const r = spawnSync('ditto', ['-x', '-k', archive, dest], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('could not unpack the download');
}

function bundleId(app) {
  const r = spawnSync('plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', path.join(app, 'Contents', 'Info.plist')], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** Swaps the bundle in place: the old one is kept until the new one is in place. */
function replaceApp(appPath, newApp) {
  const incoming = `${appPath}.incoming`;
  fs.rmSync(incoming, { recursive: true, force: true });
  const copy = spawnSync('ditto', [newApp, incoming], { encoding: 'utf8' });
  if (copy.status !== 0) throw new Error('could not copy the new OX.app into place');
  const old = `${appPath}.old`;
  fs.rmSync(old, { recursive: true, force: true });
  fs.renameSync(appPath, old);
  try {
    fs.renameSync(incoming, appPath);
  } catch (e) {
    fs.renameSync(old, appPath);
    throw e;
  }
  fs.rmSync(old, { recursive: true, force: true });
  spawnSync('xattr', ['-dr', 'com.apple.quarantine', appPath], { stdio: 'ignore' });
}

/** Quits OX and opens the new one, once this process is done. */
function relaunchApp(appPath) {
  const id = bundleId(appPath);
  const quit = id ? `osascript -e 'tell application id "${id}" to quit' >/dev/null 2>&1; sleep 3; ` : '';
  const child = spawn('sh', ['-c', `sleep 1; ${quit}open "${appPath}"`], { detached: true, stdio: 'ignore' });
  child.unref();
}

/**
 * Downloads, checks and installs the newest release. Returns { ok, why?, steps, from, to }.
 * Every check runs before anything is replaced; a failed check leaves OX.app as it was.
 */
export async function applyDownload({
  root,
  fetchImpl = fetch,
  platform = process.platform,
  arch = process.arch,
  say = () => {},
  verify = attest,
  unpack = extract,
  install = replaceApp,
  relaunch = relaunchApp,
} = {}) {
  const steps = [];
  const step = (t) => { steps.push(t); say(t); };
  const asset = assetFor({ platform, arch });
  if (!asset) return { ok: false, why: 'updates from inside OX are only for the Mac app; on this system run the installer again', steps };
  if (platform !== 'darwin') return { ok: false, why: 'updates from inside OX are only for the Mac app for now; run the installer again to update', steps };
  const appPath = appBundleOf(root);
  if (!appPath) return { ok: false, why: 'this copy is not inside OX.app, so there is nothing to replace', steps };

  step('Checking GitHub for the newest version');
  const rel = await latestRelease(fetchImpl);
  const current = currentVersion(root);
  if (compareVersions(rel.version, current) <= 0) return { ok: true, upToDate: true, steps, from: current, to: current };

  const zipAsset = rel.assets.find((a) => a.name === asset.name);
  const sumAsset = rel.assets.find((a) => a.name === `${asset.name}.sha256`);
  if (!zipAsset) return { ok: false, why: `${rel.tag} has no ${asset.name} download yet`, steps };
  if (!sumAsset) return { ok: false, why: `${rel.tag} publishes no checksum for ${asset.name}; nothing was installed`, steps };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-update-'));
  try {
    step(`Downloading ${rel.version}`);
    const file = path.join(tmp, asset.name);
    await download(zipAsset.url, file, fetchImpl);
    await download(sumAsset.url, `${file}.sha256`, fetchImpl);

    step('Checking the checksum');
    const want = fs.readFileSync(`${file}.sha256`, 'utf8').trim().split(/\s+/)[0];
    if (!want || want.toLowerCase() !== sha256(file)) return { ok: false, why: 'the download does not match its checksum; nothing was installed', steps };

    step('Checking who built it');
    const attested = verify(file);

    step('Unpacking');
    const stage = path.join(tmp, 'stage');
    fs.mkdirSync(stage);
    unpack(file, stage);
    const newApp = path.join(stage, 'OX.app');
    const newPkg = path.join(newApp, 'Contents', 'Resources', 'ox', 'package.json');
    if (!fs.existsSync(newPkg) || currentVersion(path.dirname(newPkg)) !== rel.version) {
      return { ok: false, why: `the download is not OX ${rel.version}; nothing was installed`, steps };
    }

    step(`Installing ${rel.version}`);
    install(appPath, newApp);
    step(`Updated to ${rel.version}, restarting OX`);
    relaunch(appPath);
    return { ok: true, steps, from: current, to: rel.version, attested: attested.checked };
  } catch (e) {
    return { ok: false, why: e.message, steps };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
