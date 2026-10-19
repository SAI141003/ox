// OX Island presence. The notch app (desktop/island) writes ~/.ox/island.json
// with its pid while it runs; an ox run that sees a live island binds a
// per-run IPC socket so the island can show it and answer approvals, with no
// --ipc flag needed. OX_ISLAND=0 opts one run out; `ox island off` (config
// "island": false) turns it off everywhere until `ox island on`.

import { signApp } from './sign-local.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync as spawnSyncImported } from 'node:child_process';
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
// Assemble OX Island.app from the build: the binary, its resources and the
// Info.plist (with the executable name added), signed ad hoc so macOS keeps one
// permission record for it across launches.
export function buildIslandApp({ bin, pkg, home = os.homedir() }) {
  const app = path.join(home, '.ox', 'island', 'OX Island.app');
  const contents = path.join(app, 'Contents');
  fs.rmSync(app, { recursive: true, force: true });
  fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
  fs.mkdirSync(path.join(contents, 'Resources'), { recursive: true });
  fs.copyFileSync(bin, path.join(contents, 'MacOS', 'OxIsland'));
  fs.chmodSync(path.join(contents, 'MacOS', 'OxIsland'), 0o755);
  // ox-hands rides inside the island, so a click asked of the island is done
  // under the island's own Accessibility permission (src/mac-control.js).
  const hands = path.join(path.dirname(bin), 'OxHands');
  if (fs.existsSync(hands)) { fs.copyFileSync(hands, path.join(contents, 'MacOS', 'OxHands')); fs.chmodSync(path.join(contents, 'MacOS', 'OxHands'), 0o755); }
  const res = path.join(path.dirname(bin), 'OxIsland_OxIsland.bundle');
  if (fs.existsSync(res)) fs.cpSync(res, path.join(contents, 'Resources', 'OxIsland_OxIsland.bundle'), { recursive: true });
  const icns = path.join(pkg, 'AppIcon.icns');
  const hasIcon = fs.existsSync(icns);
  if (hasIcon) fs.copyFileSync(icns, path.join(contents, 'Resources', 'AppIcon.icns'));
  let plist = fs.readFileSync(path.join(pkg, 'Info.plist'), 'utf8');
  const extra = [
    ...(hasIcon ? [['CFBundleIconFile', 'AppIcon']] : []),
    ['CFBundleExecutable', 'OxIsland'],
    ['CFBundlePackageType', 'APPL'],
    ['CFBundleVersion', '1'],
    ['LSUIElement', null],
  ].filter(([k]) => !plist.includes(`<key>${k}</key>`))
    .map(([k, v]) => (v === null ? `\t<key>${k}</key>\n\t<true/>` : `\t<key>${k}</key>\n\t<string>${v}</string>`)).join('\n');
  plist = plist.replace(/<\/dict>\s*<\/plist>\s*$/, `${extra}\n</dict>\n</plist>\n`);
  fs.writeFileSync(path.join(contents, 'Info.plist'), plist);
  // A fixed local identity when there is one, so macOS keeps the island's permissions across updates.
  signApp(app, 'dev.ox.island', spawnSyncImported);
  return app;
}

export async function cmdIsland(args = [], { log = console.log, err = (s) => process.stderr.write(s) } = {}) {
  const { spawn, spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const action = String(args[0] ?? 'start').toLowerCase();
  const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'desktop', 'island');
  const bin = path.join(pkg, '.build', 'release', 'OxIsland');
  const live = () => islandRunning({ env: {} });

  // Your own sounds: ox island sound <event> <file> | ox island sound <event> reset | ox island sounds.
  if (action === 'sound' || action === 'sounds') {
    const EVENTS = ['pop', 'glass', 'capture', 'done', 'needs-you', 'error'];
    const dir = path.join(os.homedir(), '.ox', 'island', 'sounds');
    const [ev, file] = [args[1], args[2]];
    const mine = (e) => { try { return fs.readdirSync(dir).find((f) => f.replace(/\.[^.]+$/, '') === e) ?? null; } catch { return null; } };
    if (action === 'sounds' || !ev) { for (const e of EVENTS) log(`${e.padEnd(10)} ${mine(e) ? `your ${mine(e)}` : 'system sound'}`); return; }
    if (!EVENTS.includes(ev)) { err(`a sound is one of ${EVENTS.join(', ')}\n`); process.exitCode = 3; return; }
    for (const f of (() => { try { return fs.readdirSync(dir); } catch { return []; } })()) if (f.replace(/\.[^.]+$/, '') === ev) fs.rmSync(path.join(dir, f));
    if (file === 'reset' || !file) { log(`${ev}: back to the system sound`); return; }
    const ext = path.extname(file).toLowerCase();
    if (!['.aiff', '.aif', '.wav', '.mp3', '.m4a', '.caf'].includes(ext)) { err('a sound file is .aiff, .wav, .mp3, .m4a or .caf\n'); process.exitCode = 3; return; }
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(file, path.join(dir, `${ev}${ext === '.aif' ? '.aiff' : ext}`));
    log(`${ev}: now plays ${path.basename(file)}`);
    return;
  }
  // The island checks itself (src/island-evals.js) and learns from real use.
  if (action === 'evals' || action === 'learn' || action === 'evolve') {
    const E = await import('./island-evals.js');
    if (action === 'evals') {
      const r = E.runEvals();
      const fmt = (x) => `${x.pass}/${x.total}`;
      log(`offline errands   ${fmt(r.offline)}${r.offline.failing.length ? '' : '  ✓'}`);
      for (const f of r.offline.failing) log(`  ✗ "${f.text}": wanted ${f.want ?? 'an agent'}, got ${f.got ?? 'nothing'}`);
      log(r.commands.skipped ? `island commands   skipped: ${r.commands.skipped}` : `island commands   ${fmt(r.commands)}${r.commands.failing.length ? '' : '  ✓'}`);
      for (const f of r.commands.failing ?? []) log(`  ✗ ${f}`);
      const h = E.history();
      if (h.length > 1) { const p = h[h.length - 2]; log(`last time: offline ${p.offline.pass}/${p.offline.total}${p.commands ? `, commands ${p.commands.pass}/${p.commands.total}` : ''}`); }
      return r.offline.failing.length || (r.commands.failing ?? []).length ? 1 : 0;
    }
    if (action === 'learn') {
      const r = E.learn();
      if (r.note) { log(r.note); return 0; }
      if (!r.candidates.length) { log('nothing new to learn from the island log'); return 0; }
      log(`${r.candidates.length} request(s) that did not go well (saved to ${E.CANDIDATES()}):`);
      for (const c of r.candidates) log(`  "${c.text}" — ${c.saw}. ${c.ask}`);
      log('add the right answer for each to evals/island/offline.jsonl, then: ox island evolve');
      return 0;
    }
    const goal = E.evolveGoal();
    if (!goal) { log('every island eval passes: nothing to evolve'); return 0; }
    const { evolve } = await import('./evolve.js');
    const r = await evolve({ goal, log: (l) => err(`${l}\n`) });
    log(r.accepted ? `attempt ${r.id} measured better: ${r.why}\n  keep: ox evolve accept ${r.id}` : `attempt ${r.id ?? ''} not kept: ${r.why}`);
    return 0;
  }

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
    return cmdIsland(['start'], { log, err });
  }
  // A new version of the island (after an update): stop it, rebuild, start it.
  if (action === 'restart') {
    if (!islandEnabled()) { log('OX Island is turned off. Turn it on with: ox island on'); return 1; }
    if (live()) {
      try { process.kill(Number(JSON.parse(fs.readFileSync(islandFile(), 'utf8')).pid), 'SIGTERM'); } catch {}
      for (let i = 0; i < 30 && live(); i++) await new Promise((r) => setTimeout(r, 100));
    }
    if (process.platform === 'darwin') {
      const b = await cmdIsland(['build'], { log, err });
      if (b !== 0) return b;
    }
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
  // The web island: runs in the foreground until stopped (on any OS; it is
  // what `ox island start` launches in the background off macOS).
  if (action === 'web' || action === 'serve') {
    if (!islandEnabled()) {
      log('OX Island is turned off. Turn it on with: ox island on');
      return 1;
    }
    const { runWebIsland } = await import('./island-web.js');
    await runWebIsland({ log, open: !args.includes('--no-open') });
    await new Promise(() => {}); // until SIGINT/SIGTERM
  }
  if (action !== 'start' && action !== 'build') {
    err(`ox: unknown island action '${action}' (use start, stop, restart, on, off, status, build, web)\n`);
    return 3;
  }
  if (action === 'start' && !islandEnabled()) {
    log('OX Island is turned off. Turn it on with: ox island on');
    return 1;
  }
  if (process.platform !== 'darwin') {
    if (action === 'build') {
      log('nothing to build here: off macOS the island is the web island (ox island web)');
      return 0;
    }
    if (live()) {
      log('OX Island is already running');
      return 0;
    }
    // Windows/Linux: the web island, detached so this command returns.
    const oxCli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ox.js');
    const child = spawn(process.execPath, [oxCli, 'island', 'web'], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    for (let i = 0; i < 50 && !live(); i++) await new Promise((r) => setTimeout(r, 100));
    log(live() ? 'OX Island is live at the top of your screen — every ox run now shows up there' : 'OX Island is starting');
    return 0;
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
  // The island runs as a real app (~/.ox/island/OX Island.app), opened by
  // macOS rather than spawned by this process. Two crashes taught both halves:
  //  - spawned from a terminal, macOS charges the microphone and speech
  //    requests to the terminal (the "responsible" app), whose Info.plist has no
  //    speech description, and kills the island the moment you talk to it;
  //  - run from the build folder, a rebuild rewrites the file under it.
  // As its own bundle, launched with `open`, the island answers for itself with
  // its own Info.plist and its own permission record.
  let launched = false;
  try {
    const app = buildIslandApp({ bin, pkg });
    const r = spawnSync('open', ['-n', '-g', app, '--env', `OX_NODE=${process.execPath}`, '--env', `OX_CLI=${oxCli}`], { stdio: 'ignore' });
    launched = r.status === 0;
  } catch {}
  if (!launched) {
    const child = spawn(bin, [], { detached: true, stdio: 'ignore', env: { ...process.env, OX_NODE: process.execPath, OX_CLI: oxCli } });
    child.unref();
  }
  // Wait for the presence file so an `ox` started right after this connects.
  for (let i = 0; i < 30 && !live(); i++) await new Promise((r) => setTimeout(r, 100));
  log(live() ? 'OX Island is live in your notch — every ox run now shows up there' : 'OX Island launched');
  return 0;
}
