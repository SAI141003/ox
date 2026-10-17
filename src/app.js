// `ox app`: ox in its own window, as well as the terminal. The window shows
// the local ox server's chat, so it is the same ox: the same agents, modes,
// approvals and sessions, and its runs appear in the island.
//
//   macOS          OX.app, a native window (WKWebView), with a Dock icon and menus
//   Windows/Linux  an Edge/Chrome app window (no browser tabs or address bar)
//
//   ox app                open it (starts the server in this folder if needed)
//   ox app install        macOS: put OX.app in ~/Applications (Spotlight, Launchpad)
//   ox app stop           stop the app's server
//   ox app --print-url    start the server if needed and print its address
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OX_CLI = path.join(HERE, '..', 'bin', 'ox.js');
const PKG = path.join(HERE, '..', 'desktop', 'island');
const STATE = () => path.join(os.homedir(), '.ox', 'app.json');

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE(), 'utf8')); } catch { return {}; }
}
function writeState(st) {
  // A throwaway copy (a release being tested in a temp folder) must not become
  // the ox the installed app opens: that path is gone minutes later.
  const tmp = fs.realpathSync(os.tmpdir());
  if ([st?.node, st?.cli].some((p) => p && (p.startsWith(tmp) || p.startsWith(os.tmpdir()) || p.startsWith('/private/var/folders/')))) return;
  fs.mkdirSync(path.dirname(STATE()), { recursive: true });
  fs.writeFileSync(STATE(), JSON.stringify(st));
}
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function freePort(start = 47800) {
  return new Promise((resolve) => {
    const tryPort = (p) => {
      const s = net.createServer();
      s.once('error', () => tryPort(p + 1));
      s.listen(p, '127.0.0.1', () => s.close(() => resolve(p)));
    };
    tryPort(start);
  });
}

async function answers(url, ms = 1500) {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), ms);
    const r = await fetch(url, { signal: ac.signal }).finally(() => clearTimeout(t));
    return r.ok;
  } catch { return false; }
}

// The app's server: reused when it is up and serving this folder, else started.
export async function ensureServer({ cwd = process.cwd(), log = () => {} } = {}) {
  const st = readState();
  if (st.pid && alive(st.pid) && st.cwd === cwd && st.url && (await answers(st.url))) return st;
  if (st.pid && alive(st.pid)) { try { process.kill(st.pid); } catch {} }
  const port = await freePort();
  const child = spawn(process.execPath, [OX_CLI, 'serve', '--port', String(port)], {
    cwd, detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, OX_APP: '1' },
  });
  child.unref();
  const url = `http://127.0.0.1:${port}/`;
  for (let i = 0; i < 100 && !(await answers(url, 500)); i++) await new Promise((r) => setTimeout(r, 150));
  if (!(await answers(url))) throw new Error('the ox server did not start');
  const next = { pid: child.pid, port, url, cwd, node: process.execPath, cli: OX_CLI, startedAt: new Date().toISOString() };
  writeState(next);
  log(`ox is serving ${path.basename(cwd)} at ${url}`);
  return next;
}

export function stopServer() {
  const st = readState();
  if (st.pid && alive(st.pid)) { try { process.kill(st.pid); } catch {} return true; }
  return false;
}

// OX.app from the build: the binary, an Info.plist, an icon made from the ox art.
export function buildMacApp({ home = os.homedir() } = {}) {
  let bin = path.join(PKG, '.build', 'release', 'OxApp');
  if (!fs.existsSync(bin)) {
    const r = spawnSync('swift', ['build', '-c', 'release', '--product', 'OxApp'], { cwd: PKG, stdio: 'ignore' });
    if (r.status !== 0 || !fs.existsSync(bin)) return null;
  }
  const app = path.join(home, '.ox', 'app', 'OX.app');
  const c = path.join(app, 'Contents');
  fs.rmSync(app, { recursive: true, force: true });
  fs.mkdirSync(path.join(c, 'MacOS'), { recursive: true });
  fs.mkdirSync(path.join(c, 'Resources'), { recursive: true });
  fs.copyFileSync(bin, path.join(c, 'MacOS', 'OxApp'));
  fs.chmodSync(path.join(c, 'MacOS', 'OxApp'), 0o755);
  const icon = makeIcon(path.join(c, 'Resources'));
  fs.writeFileSync(path.join(c, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>CFBundleIdentifier</key><string>dev.ox.app</string>
\t<key>CFBundleName</key><string>ox</string>
\t<key>CFBundleDisplayName</key><string>ox</string>
\t<key>CFBundleExecutable</key><string>OxApp</string>
\t<key>CFBundlePackageType</key><string>APPL</string>
\t<key>CFBundleShortVersionString</key><string>0.1.0</string>
\t<key>CFBundleVersion</key><string>1</string>
\t<key>LSMinimumSystemVersion</key><string>14.0</string>
\t<key>NSHighResolutionCapable</key><true/>
${icon ? '\t<key>CFBundleIconFile</key><string>AppIcon</string>\n' : ''}</dict>
</plist>
`);
  spawnSync('codesign', ['--force', '--deep', '-s', '-', app], { stdio: 'ignore' });
  return app;
}

// The ox mark on its gold tile (assets/logo-ox.svg, rendered to every size
// macOS asks for); the older standing-ox sprite only if that file is missing.
function makeIcon(resDir) {
  const icns = path.join(PKG, 'AppIcon.icns');
  if (fs.existsSync(icns)) { fs.copyFileSync(icns, path.join(resDir, 'AppIcon.icns')); return true; }
  const src = path.join(PKG, 'Sources', 'OxIsland', 'Resources', 'ox', 'idle', 'idle_0001.png');
  if (!fs.existsSync(src) || spawnSync('which', ['iconutil']).status !== 0) return false;
  const set = path.join(os.tmpdir(), `ox-icon-${process.pid}.iconset`);
  fs.rmSync(set, { recursive: true, force: true });
  fs.mkdirSync(set);
  for (const s of [16, 32, 128, 256, 512]) {
    for (const [scale, suffix] of [[1, ''], [2, '@2x']]) {
      const px = s * scale;
      spawnSync('sips', ['-z', String(Math.round(px * 0.75)), String(px), '--padToHeightWidth', String(px), String(px), '--padColor', '0E0F12', src, '--out', path.join(set, `icon_${s}x${s}${suffix}.png`)], { stdio: 'ignore' });
    }
  }
  const ok = spawnSync('iconutil', ['-c', 'icns', set, '-o', path.join(resDir, 'AppIcon.icns')], { stdio: 'ignore' }).status === 0;
  fs.rmSync(set, { recursive: true, force: true });
  return ok;
}

export async function openApp({ cwd = process.cwd(), log = console.log } = {}) {
  const st = await ensureServer({ cwd, log });
  if (process.platform === 'darwin') {
    const app = buildMacApp();
    if (app) {
      spawnSync('open', ['-n', app, '--env', `OX_APP_URL=${st.url}`, '--env', `OX_NODE=${process.execPath}`, '--env', `OX_CLI=${OX_CLI}`], { stdio: 'ignore' });
      log(`ox is open in its own window — working in ${cwd}`);
      return { how: 'mac-app', url: st.url };
    }
  }
  const { findAppBrowser } = await import('./island-web.js');
  const browser = findAppBrowser();
  const profile = path.join(os.homedir(), '.ox', 'app', 'browser-profile');
  if (browser) {
    const child = spawn(browser, [`--app=${st.url}`, '--window-size=1120,760', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check'], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
    log(`ox is open in its own window — working in ${cwd}`);
    return { how: 'app-window', url: st.url };
  }
  const opener = process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', st.url]] : ['xdg-open', [st.url]];
  const child = spawn(opener[0], opener[1], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
  log(`ox is open in your browser (no Edge/Chrome for an app window) — ${st.url}`);
  return { how: 'browser', url: st.url };
}

export function installMacApp() {
  const app = buildMacApp();
  if (!app) return null;
  const dest = path.join(os.homedir(), 'Applications', 'OX.app');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(app, dest, { recursive: true });
  // Which ox this app opens: this Node and this ox, written into the app
  // itself, so it starts from the Dock or Spotlight with no terminal, and
  // follows this checkout as it is updated.
  const cli = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'bin', 'ox.js');
  fs.writeFileSync(path.join(dest, 'Contents', 'Resources', 'ox-paths.json'), JSON.stringify({ node: process.execPath, cli }, null, 2));
  return dest;
}
