// OX Island presence. The notch app (desktop/island) writes ~/.ox/island.json
// with its pid while it runs; an ox run that sees a live island binds a
// per-run IPC socket so the island can show it and answer approvals, with no
// --ipc flag needed. OX_ISLAND=0 opts one run out; `ox island off` (config
// "island": false) turns it off everywhere until `ox island on`.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfigDoc, saveConfigDoc } from './config.js';

export const islandFile = (home = os.homedir()) => path.join(home, '.ox', 'island.json');

const configDir = (home) => path.join(home, '.ox');

/** The persistent switch: ~/.ox/config.json "island" (true unless set to false). */
export function islandEnabled({ home = os.homedir() } = {}) {
  let doc = {};
  try {
    doc = readConfigDoc({ dir: configDir(home) });
  } catch {}
  const v = doc.island;
  return !(v === false || v?.enabled === false);
}

export function setIslandEnabled(on, { home = os.homedir() } = {}) {
  saveConfigDoc((doc) => {
    doc.island = Boolean(on);
  }, { dir: configDir(home) });
}

export function islandRunning({ home = os.homedir(), env = process.env } = {}) {
  if (env.OX_ISLAND === '0') return false;
  if (!islandEnabled({ home })) return false;
  let rec;
  try {
    rec = JSON.parse(fs.readFileSync(islandFile(home), 'utf8'));
  } catch {
    return false;
  }
  const pid = Number(rec?.pid);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0); // signal 0: existence check only
    return true;
  } catch (err) {
    return err?.code === 'EPERM'; // alive but owned by someone else
  }
}

// `ox island [start|stop|status|build]` -- build (first run) and launch the
// notch app. macOS only; the app lives in desktop/island and needs the Swift
// toolchain (Xcode or the Command Line Tools). Building is a one-time ~10s step.
export async function cmdIsland(args = [], { log = console.log, err = (s) => process.stderr.write(s) } = {}) {
  const { spawn, spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const action = String(args[0] ?? 'start').toLowerCase();
  const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'desktop', 'island');
  const bin = path.join(pkg, '.build', 'release', 'OxIsland');
  const live = () => islandRunning({ env: {} });

  if (action === 'status') {
    if (!islandEnabled()) {
      log('OX Island is turned off (turn it on: ox island on)');
      return 1;
    }
    log(live() ? 'OX Island is running — new ox runs appear in the notch' : 'OX Island is not running (start it: ox island)');
    return live() ? 0 : 1;
  }
  if (action === 'off') {
    const wasLive = live();
    setIslandEnabled(false);
    if (wasLive) {
      try {
        process.kill(Number(JSON.parse(fs.readFileSync(islandFile(), 'utf8')).pid), 'SIGTERM');
      } catch {}
    }
    log('OX Island is off: runs stay in the terminal and approvals are asked there. Turn it back on with: ox island on');
    return 0;
  }
  if (action === 'on') {
    setIslandEnabled(true);
    log('OX Island is on');
    if (process.platform !== 'darwin') return 0;
    return cmdIsland(['start'], { log, err });
  }
  if (action === 'stop') {
    try {
      process.kill(Number(JSON.parse(fs.readFileSync(islandFile(), 'utf8')).pid), 'SIGTERM');
      log('OX Island stopped');
      return 0;
    } catch {
      log('OX Island is not running');
      return 1;
    }
  }
  if (action !== 'start' && action !== 'build') {
    err(`ox: unknown island action '${action}' (use start, stop, on, off, status, build)\n`);
    return 3;
  }
  if (process.platform !== 'darwin') {
    err('ox: OX Island is a macOS notch app; elsewhere use `ox ipc watch` for the same live view\n');
    return 3;
  }
  if (action === 'start' && !islandEnabled()) {
    log('OX Island is turned off. Turn it on with: ox island on');
    return 1;
  }
  if (action === 'start' && live()) {
    log('OX Island is already running');
    return 0;
  }
  if (!fs.existsSync(bin) || action === 'build') {
    log('building OX Island (one time, ~10s)…');
    const r = spawnSync('swift', ['build', '-c', 'release'], { cwd: pkg, stdio: 'inherit' });
    if (r.error || r.status !== 0) {
      err('ox: swift build failed — install Xcode or the Command Line Tools (xcode-select --install)\n');
      return 1;
    }
    if (action === 'build') return 0;
  }
  // The island runs ox itself for its shelf (ask about a dropped file, email
  // it), so it is told exactly which node and which ox started it.
  const oxCli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ox.js');
  const child = spawn(bin, [], { detached: true, stdio: 'ignore', env: { ...process.env, OX_NODE: process.execPath, OX_CLI: oxCli } });
  child.unref();
  // Wait for the presence file so an `ox` started right after this connects.
  for (let i = 0; i < 30 && !live(); i++) await new Promise((r) => setTimeout(r, 100));
  log(live() ? 'OX Island is live in your notch — every ox run now shows up there' : 'OX Island launched');
  return 0;
}
