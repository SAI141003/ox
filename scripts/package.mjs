#!/usr/bin/env node
// Build the downloadable desktop release for the platform this runs on.
//
//   node scripts/package.mjs [--out dist]
//
//   macOS    dist/ox-mac-<arch>.zip      OX.app: its own Node, ox, and the island
//   Windows  dist/ox-windows-<arch>.zip  node.exe, ox, ox.cmd (terminal), OX.vbs (app)
//   Linux    dist/ox-linux-<arch>.tar.gz node, ox, ./ox (terminal), install.sh, ox.desktop
//
// The Node inside is the one running this script (CI sets it up per platform),
// so a download needs nothing installed. The release workflow runs this on each
// platform and attaches the results to the GitHub release.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const OUT = path.resolve(argv[argv.indexOf('--out') + 1] && argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : path.join(ROOT, 'dist'));
const ARCH = process.arch === 'arm64' ? 'arm64' : 'x64';
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status})`);
}

// The ox engine itself: the same files `npm pack` ships.
function copyOx(dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const item of ['bin', 'src', 'skills', 'docs', 'README.md', 'LICENSE', 'package.json']) {
    const from = path.join(ROOT, item);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(dest, item), { recursive: true });
  }
}

function packageMac() {
  const pkg = path.join(ROOT, 'desktop', 'island');
  run('swift', ['build', '-c', 'release'], { cwd: pkg });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-pkg-'));
  const { buildMacApp } = awaitImport(path.join(ROOT, 'src', 'app.js'));
  const built = buildMacApp({ home });
  if (!built) throw new Error('could not assemble OX.app');
  const app = path.join(OUT, 'OX.app');
  fs.rmSync(app, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  fs.cpSync(built, app, { recursive: true });
  const res = path.join(app, 'Contents', 'Resources');
  fs.copyFileSync(process.execPath, path.join(res, 'node'));
  fs.chmodSync(path.join(res, 'node'), 0o755);
  const ox = path.join(res, 'ox');
  copyOx(ox);
  // The island ships prebuilt inside, where `ox island` looks for it.
  const islandDest = path.join(ox, 'desktop', 'island');
  fs.mkdirSync(path.join(islandDest, '.build', 'release'), { recursive: true });
  fs.copyFileSync(path.join(pkg, 'Info.plist'), path.join(islandDest, 'Info.plist'));
  if (fs.existsSync(path.join(pkg, 'AppIcon.icns'))) fs.copyFileSync(path.join(pkg, 'AppIcon.icns'), path.join(islandDest, 'AppIcon.icns'));
  fs.copyFileSync(path.join(pkg, '.build', 'release', 'OxIsland'), path.join(islandDest, '.build', 'release', 'OxIsland'));
  fs.cpSync(path.join(pkg, '.build', 'release', 'OxIsland_OxIsland.bundle'), path.join(islandDest, '.build', 'release', 'OxIsland_OxIsland.bundle'), { recursive: true });
  spawnSync('codesign', ['--force', '--deep', '-s', '-', app], { stdio: 'ignore' });
  const zip = path.join(OUT, `ox-mac-${ARCH}.zip`);
  fs.rmSync(zip, { force: true });
  run('ditto', ['-c', '-k', '--keepParent', app, zip]);
  return zip;
}

function packageWindows() {
  const dir = path.join(OUT, `ox-windows-${ARCH}`);
  fs.rmSync(dir, { recursive: true, force: true });
  copyOx(path.join(dir, 'ox'));
  fs.copyFileSync(process.execPath, path.join(dir, 'node.exe'));
  fs.writeFileSync(path.join(dir, 'ox.cmd'), '@echo off\r\n"%~dp0node.exe" "%~dp0ox\\bin\\ox.js" %*\r\n');
  // Double-click to open the app window, with no console flashing up.
  fs.writeFileSync(path.join(dir, 'OX.vbs'), 'Set sh = CreateObject("WScript.Shell")\r\nd = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)\r\nsh.CurrentDirectory = sh.ExpandEnvironmentStrings("%USERPROFILE%")\r\nsh.Run """" & d & "\\node.exe"" """ & d & "\\ox\\bin\\ox.js"" app", 0, False\r\nsh.Run """" & d & "\\node.exe"" """ & d & "\\ox\\bin\\ox.js"" island start", 0, False\r\n');
  fs.writeFileSync(path.join(dir, 'README.txt'), `ox ${VERSION}\r\n\r\nDouble-click OX.vbs to open ox (and its island bar).\r\nFor the terminal: add this folder to PATH, then type  ox\r\n`);
  const zip = path.join(OUT, `ox-windows-${ARCH}.zip`);
  fs.rmSync(zip, { force: true });
  run('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${dir}\\*' -DestinationPath '${zip}'`]);
  return zip;
}

function packageLinux() {
  const name = `ox-linux-${ARCH}`;
  const dir = path.join(OUT, name);
  fs.rmSync(dir, { recursive: true, force: true });
  copyOx(path.join(dir, 'ox'));
  fs.copyFileSync(process.execPath, path.join(dir, 'node'));
  fs.chmodSync(path.join(dir, 'node'), 0o755);
  fs.writeFileSync(path.join(dir, 'ox-cli'), '#!/bin/sh\nd="$(cd "$(dirname "$0")" && pwd)"\nexec "$d/node" "$d/ox/bin/ox.js" "$@"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'install.sh'), [
    '#!/bin/sh',
    '# Installs ox for this user: ~/.local/share/ox, the `ox` command, and a menu entry.',
    'set -e',
    'src="$(cd "$(dirname "$0")" && pwd)"',
    'dest="$HOME/.local/share/ox"',
    'rm -rf "$dest" && mkdir -p "$dest" "$HOME/.local/bin" "$HOME/.local/share/applications"',
    'cp -R "$src/node" "$src/ox" "$src/ox-cli" "$dest/"',
    'ln -sf "$dest/ox-cli" "$HOME/.local/bin/ox"',
    'sed "s#@DEST@#$dest#g" "$src/ox.desktop" > "$HOME/.local/share/applications/ox.desktop"',
    'echo "ox installed. Type  ox  in a terminal, or open ox from your app menu."',
    '',
  ].join('\n'), { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'ox.desktop'), '[Desktop Entry]\nType=Application\nName=ox\nComment=The featherweight coding agent\nExec=@DEST@/ox-cli app\nTerminal=false\nCategories=Development;\n');
  const tgz = path.join(OUT, `${name}.tar.gz`);
  run('tar', ['-czf', tgz, '-C', OUT, name]);
  return tgz;
}

// Top-level await keeps this a plain script; app.js is an ES module.
function awaitImport(p) {
  return globalThis.__oxImports[p];
}
globalThis.__oxImports = { [path.join(ROOT, 'src', 'app.js')]: await import(path.join(ROOT, 'src', 'app.js')) };

const built = process.platform === 'darwin' ? packageMac() : process.platform === 'win32' ? packageWindows() : packageLinux();
const size = (fs.statSync(built).size / 1e6).toFixed(1);
console.log(`built ${path.relative(ROOT, built)} (${size} MB) — ox ${VERSION}, Node ${process.version}`);
