// Keep the Mac awake while ox works. A long `ox auto`, a scheduled run or a
// chat turn dies quietly when the machine idles to sleep; macOS's own
// `caffeinate` prevents that, tied to ox's process so it ends when ox does.
//
// What this can and cannot do, plainly:
//   - idle sleep (and system sleep on power): held by caffeinate, no admin.
//   - closing the lid on battery: macOS sleeps anyway unless sleep is disabled
//     system-wide with `pmset -a disablesleep 1`, which needs your password.
//     `ox awake --lid 2h` (and the island's "Lid closed" timer) asks macOS for it
//     in its own password window, for that one change, with the undo already
//     scheduled: sleep comes back on at the end of the time, when you stop it,
//     or when the battery is down to 10 %. ox never sees or keeps the password.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const STATE = () => path.join(os.homedir(), '.ox', 'awake.json');

export function awakeEnabled(config = {}, env = process.env) {
  if (env.OX_NO_AWAKE === '1' || config.awake === false) return false;
  return ['darwin', 'linux', 'win32'].includes(process.platform);
}

// The OS's own "do not sleep" for as long as `pid` lives, or for `secs`.
//   macOS    caffeinate
//   Linux    systemd-inhibit (where systemd runs; elsewhere nothing is held)
//   Windows  SetThreadExecutionState from a PowerShell that waits on the pid
export function inhibitCommand({ pid = null, secs = null, platform = process.platform } = {}) {
  if (platform === 'darwin') {
    return ['caffeinate', ['-i', '-s', ...(pid ? ['-w', String(pid)] : ['-t', String(secs)])]];
  }
  if (platform === 'linux') {
    const wait = pid ? `while kill -0 ${Number(pid)} 2>/dev/null; do sleep 5; done` : `sleep ${Number(secs)}`;
    return ['systemd-inhibit', ['--what=idle:sleep:handle-lid-switch', '--who=ox', '--why=ox is working', '--mode=block', 'sh', '-c', wait]];
  }
  if (platform === 'win32') {
    // ES_CONTINUOUS | ES_SYSTEM_REQUIRED, held by this PowerShell until it exits.
    const hold = "$s=Add-Type -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint f);' -Name P -Namespace Ox -PassThru; [void]$s::SetThreadExecutionState(0x80000001);";
    const wait = pid ? `try { Wait-Process -Id ${Number(pid)} } catch {}` : `Start-Sleep -Seconds ${Number(secs)}`;
    return ['powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', `${hold} ${wait}`]];
  }
  return null;
}

// Held while `pid` lives (default: this ox). Returns a release function.
export function holdAwake({ pid = process.pid, config = {}, env = process.env } = {}) {
  if (!awakeEnabled(config, env)) return () => {};
  const cmd = inhibitCommand({ pid });
  if (!cmd) return () => {};
  let child;
  try {
    // cwd: the temp dir, not ox's. On Windows a process's working directory
    // cannot be removed, so a hold started in a project pinned that folder.
    child = spawn(cmd[0], cmd[1], { stdio: 'ignore', windowsHide: true, cwd: os.tmpdir() });
    child.on('error', () => {});
    child.unref();
  } catch {
    return () => {};
  }
  return () => {
    try { child.kill(); } catch {}
  };
}

export function parseDuration(s) {
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)?$/i.exec(String(s ?? '').trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = { s: 1, m: 60, h: 3600, d: 86400 }[(m[2] ?? 'm').toLowerCase()];
  const secs = Math.round(n * unit);
  return secs > 0 && secs <= 7 * 86400 ? secs : null;
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE(), 'utf8')); } catch { return null; }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// A timed hold that outlives this command (`ox awake 2h`).
export function startTimed(secs) {
  stopTimed();
  const cmd = inhibitCommand({ secs });
  if (!cmd) throw new Error(`keeping awake is not supported on ${process.platform}`);
  const child = spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {});
  child.unref();
  fs.mkdirSync(path.dirname(STATE()), { recursive: true });
  fs.writeFileSync(STATE(), JSON.stringify({ pid: child.pid, until: Date.now() + secs * 1000 }));
  return { pid: child.pid, until: new Date(Date.now() + secs * 1000) };
}

export function stopTimed() {
  const s = readState();
  // Only a caffeinate ox started: the pid is checked against its command line
  // so a recycled pid belonging to something else is never killed.
  if (s?.pid && alive(s.pid)) {
    const cmd = process.platform === 'win32'
      ? (spawnSync('tasklist', ['/FI', `PID eq ${s.pid}`, '/NH'], { encoding: 'utf8' }).stdout ?? '')
      : (spawnSync('ps', ['-o', 'comm=', '-p', String(s.pid)], { encoding: 'utf8' }).stdout ?? '').trim();
    if (/caffeinate|systemd-inhibit|powershell/i.test(cmd)) { try { process.kill(s.pid); } catch {} }
  }
  try { fs.unlinkSync(STATE()); } catch {}
  return !!s;
}

export function status() {
  const s = readState();
  const timed = s?.pid && alive(s.pid) && s.until > Date.now() ? { until: new Date(s.until) } : null;
  const pm = process.platform === 'darwin' ? (spawnSync('pmset', ['-g'], { encoding: 'utf8' }).stdout ?? '') : '';
  const lidSleepDisabled = /SleepDisabled\s+1/.test(pm);
  return { timed, lidSleepDisabled };
}

export function lidHelp(platform = process.platform) {
  if (platform === 'darwin') {
    return [
      'Closing the lid on battery makes macOS sleep no matter what an app asks.',
      'To keep agents running with the lid closed, turn sleep off system-wide (asks for your password):',
      '  sudo pmset -a disablesleep 1',
      'and turn it back on when you are done (do not forget: the Mac will not sleep at all until you do):',
      '  sudo pmset -a disablesleep 0',
      'On power with an external display, the lid can close without this.',
    ];
  }
  if (platform === 'linux') {
    return ['While ox holds the machine awake it also holds the lid switch (systemd), so closing the lid does not suspend.',
      'Without systemd, set HandleLidSwitch=ignore in /etc/systemd/logind.conf or your desktop\'s power settings.'];
  }
  if (platform === 'win32') {
    return ['Windows applies its own lid action. To keep running with the lid closed:',
      '  Control Panel › Power Options › Choose what closing the lid does › Do nothing',
      'or, in a terminal: powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0 && powercfg /setdcvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0 && powercfg /setactive SCHEME_CURRENT'];
  }
  return ['Keeping awake is not supported on this system.'];
}

// ---- running with the lid closed (macOS) ------------------------------------------

const LID = () => path.join(os.homedir(), '.ox', 'lid.json');
// Its presence tells the watcher to put sleep back early. Only tested, never written or
// removed by the watcher (it runs as root; your files stay yours).
export const LID_STOP = () => path.join(os.homedir(), '.ox', 'lid.stop');
const LID_BATTERY_FLOOR = 10;

const shq = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;

/** The one script run with your password: sleep off now, and back on when the time is up. Pure. */
export function lidScript(secs, { stop = LID_STOP(), floor = LID_BATTERY_FLOOR } = {}) {
  const n = Math.round(Number(secs));
  if (!(n > 0 && n <= 7 * 86400)) throw new Error('a lid hold is from 1 second to 7 days');
  const watch = [
    `end=$(( $(date +%s) + ${n} ))`,
    `while [ "$(date +%s)" -lt "$end" ] && [ ! -e ${shq(stop)} ]; do`,
    `  b=$(pmset -g batt)`,
    `  p=$(printf '%s' "$b" | grep -Eo '[0-9]+%' | head -1 | tr -d '%')`,
    `  if printf '%s' "$b" | grep -q 'Battery Power' && [ -n "$p" ] && [ "$p" -le ${Number(floor)} ]; then break; fi`,
    '  sleep 15',
    'done',
    'pmset -a disablesleep 0',
  ].join('\n');
  return `pmset -a disablesleep 1 && (/bin/sh -c ${shq(watch)} >/dev/null 2>&1 &)`;
}

/** AppleScript that asks for your password in macOS's own window and runs the script. Pure. */
export function lidAppleScript(script) {
  return `do shell script "${String(script).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}" with administrator privileges`;
}

function readLid() {
  try { return JSON.parse(fs.readFileSync(LID(), 'utf8')); } catch { return null; }
}

/** Keep running with the lid closed for `secs`. Asks for your password (macOS's window). */
export function startLid(secs, { run = spawnSync } = {}) {
  if (process.platform !== 'darwin') throw new Error(lidHelp().join('\n'));
  try { fs.rmSync(LID_STOP(), { force: true }); } catch {}
  const r = run('osascript', ['-e', lidAppleScript(lidScript(secs))], { encoding: 'utf8', timeout: 120_000 });
  if (r.status !== 0) {
    const why = String(r.stderr ?? '').trim();
    throw new Error(/-128|cancel/i.test(why) ? 'cancelled: sleep is unchanged' : `macOS did not allow it: ${why.slice(0, 200) || 'no reason given'}`);
  }
  const until = Date.now() + secs * 1000;
  fs.mkdirSync(path.dirname(LID()), { recursive: true });
  fs.writeFileSync(LID(), JSON.stringify({ until }));
  // The lid is about the case; idle sleep with the lid open is held the ordinary way too.
  try { startTimed(secs); } catch {}
  return { until: new Date(until) };
}

/** Put sleep back now: the watcher sees the stop file within 15 s. No password. */
export function stopLid() {
  const had = readLid();
  fs.mkdirSync(path.dirname(LID_STOP()), { recursive: true });
  fs.writeFileSync(LID_STOP(), String(Date.now()));
  try { fs.unlinkSync(LID()); } catch {}
  stopTimed();
  return !!had;
}

/** { until, active, sleepDisabled, stale }: stale is sleep still off with no hold of ox's running. */
export function lidStatus({ pm = null } = {}) {
  const l = readLid();
  const out = pm ?? (process.platform === 'darwin' ? (spawnSync('pmset', ['-g'], { encoding: 'utf8' }).stdout ?? '') : '');
  const sleepDisabled = /SleepDisabled\s+1/.test(out);
  const active = !!(l?.until && l.until > Date.now() && sleepDisabled);
  return { until: active ? new Date(l.until) : null, active, sleepDisabled, stale: sleepDisabled && !active };
}
