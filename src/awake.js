// Keep the Mac awake while ox works. A long `ox auto`, a scheduled run or a
// chat turn dies quietly when the machine idles to sleep; macOS's own
// `caffeinate` prevents that, tied to ox's process so it ends when ox does.
//
// What this can and cannot do, plainly:
//   - idle sleep (and system sleep on power): held by caffeinate, no admin.
//   - closing the lid on battery: macOS sleeps anyway unless sleep is disabled
//     system-wide with `sudo pmset -a disablesleep 1`, which needs your
//     password. ox prints that command and its undo; it never runs sudo.
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
    child = spawn(cmd[0], cmd[1], { stdio: 'ignore', windowsHide: true });
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
