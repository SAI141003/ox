// The rules around ox working on your screen, in one place, for every desktop tool.
//
//   - Each app is yours to allow: once, or always (~/.ox/computer-apps.json; ox computer).
//   - Apps that are as good as a shell or as your settings (terminals, IDEs, Finder, System
//     Settings) say so when ox asks, and can never be always-allowed.
//   - Controls that send or delete ask every time, even with -y. With nobody there to answer
//     they are refused. Paying is never done.
//   - A run with nobody at the screen (a schedule, the daemon) does not touch it at all.
//   - One run at a time holds the screen, and you can stop it from anywhere: Esc in the island,
//     or `ox computer stop`. Every action checks that before it happens.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const home = () => process.env.OX_HOME || path.join(os.homedir(), '.ox');
const APPS = () => path.join(home(), 'computer-apps.json');
export const LOCK = () => path.join(home(), 'computer.lock');
export const STOP = () => path.join(home(), 'computer.stop');
const STARTED = Date.now();
// A server stays up for days: a hold nobody has used for this long is not a hold. Two minutes:
// longer and one click from the app shut the island and the terminal out of the screen for ten.
const LOCK_IDLE_MS = 2 * 60_000;

const PAYS = /\b(pay|pay now|payment|buy|buy now|purchase|place order|order now|checkout|check out|transfer|subscribe|wire)\b/i;
/** A control that spends money: ox never presses these, whoever says so. */
export function isPayment(el) {
  return !!el && [el.name, el.description, el.help].some((s) => s && PAYS.test(String(s)));
}

const SHELL = /^(terminal|iterm2?|warp|ghostty|alacritty|kitty|wezterm|hyper|tabby|visual studio code|code|vs ?code|cursor|windsurf|devin desktop|zed|xcode|android studio|intellij idea|pycharm|webstorm|goland|rubymine|sublime text|powershell|windows terminal|cmd|command prompt|gnome-terminal|konsole)$/i;
const FILES = /^(finder|file explorer|explorer|nautilus|dolphin)$/i;
const SETTINGS = /^(system settings|system preferences|settings|control panel|keychain access|passwords|activity monitor|task manager)$/i;
const MESSAGES = /^(messages|whatsapp|mail|outlook|microsoft outlook|gmail|spark|slack|telegram|discord|signal|microsoft teams|teams|wechat|messenger|superhuman)$/i;

const clean = (app) => String(app ?? '').trim().replace(/\.app$/i, '');

/** What allowing this app really hands over, or null for an ordinary app. */
export function appWarning(app) {
  const a = clean(app);
  if (SHELL.test(a)) return `${a} is as good as a shell: it can run any command`;
  if (FILES.test(a)) return `${a} can read, move or delete any of your files`;
  if (SETTINGS.test(a)) return `${a} can change your system settings or see saved passwords`;
  return null;
}
/** An app where Return usually sends. */
export const isMessagingApp = (app) => MESSAGES.test(clean(app));

function readApps() {
  try { const l = JSON.parse(fs.readFileSync(APPS(), 'utf8')).always; return Array.isArray(l) ? l.map(String) : []; } catch { return []; }
}
function writeApps(always) {
  fs.mkdirSync(path.dirname(APPS()), { recursive: true });
  fs.writeFileSync(APPS(), `${JSON.stringify({ always }, null, 2)}\n`, { mode: 0o600 });
}
export const allowedApps = () => readApps();
export function isAppAllowed(app) {
  const a = clean(app).toLowerCase();
  return !!a && !appWarning(a) && readApps().some((x) => x.toLowerCase() === a);
}
export function allowApp(app) {
  const a = clean(app);
  if (!a) throw new Error('which app?');
  const warn = appWarning(a);
  if (warn) throw new Error(`${warn}, so ox asks every session. It cannot be always-allowed.`);
  const list = readApps();
  if (!list.some((x) => x.toLowerCase() === a.toLowerCase())) writeApps([...list, a].sort());
  return readApps();
}
export function denyApp(app) {
  const a = clean(app).toLowerCase();
  const list = readApps();
  const left = list.filter((x) => x.toLowerCase() !== a);
  if (left.length !== list.length) writeApps(left);
  return left.length !== list.length;
}

/** Stop whatever is using the screen now. A run started afterwards is not stopped. */
export function requestStop() {
  fs.mkdirSync(path.dirname(STOP()), { recursive: true });
  fs.writeFileSync(STOP(), String(Date.now()));
}
export function stopRequested() {
  try { return Number(fs.readFileSync(STOP(), 'utf8')) >= STARTED; } catch { return false; }
}

function readLock() {
  try { return JSON.parse(fs.readFileSync(LOCK(), 'utf8')); } catch { return null; }
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const heldBy = (l, now = Date.now()) => !!l?.pid && l.pid !== process.pid && alive(l.pid) && now - (l.at ?? 0) < LOCK_IDLE_MS;

let releaseHooked = false;
/** Take or keep the screen. → null, or why another run has it. */
export function holdScreen({ now = Date.now(), who = process.env.OX_RUN_ID || 'an ox run' } = {}) {
  if (process.env.NODE_TEST_CONTEXT && !process.env.OX_HOME) return null;   // a test never takes your real screen lock
  const l = readLock();
  if (heldBy(l, now)) return `${l.who ?? 'another ox run'} (process ${l.pid}) is using your computer. It has to finish first, or stop it: ox computer stop`;
  fs.mkdirSync(path.dirname(LOCK()), { recursive: true });
  fs.writeFileSync(LOCK(), JSON.stringify({ pid: process.pid, who, at: now }));
  if (!releaseHooked) {
    releaseHooked = true;
    process.once('exit', () => { try { if (readLock()?.pid === process.pid) fs.unlinkSync(LOCK()); } catch {} });
  }
  return null;
}

/** Let go of the screen now (a run that finished). */
export function releaseScreen() {
  try { if (readLock()?.pid === process.pid) fs.unlinkSync(LOCK()); } catch {}
}

export function computerStatus({ now = Date.now() } = {}) {
  const l = readLock();
  return { inUse: !!l?.pid && alive(l.pid) && now - (l.at ?? 0) < LOCK_IDLE_MS, holder: l?.who ?? null, pid: l?.pid ?? null, always: readApps() };
}

let told = false;
function tellOnce(env = process.env) {
  if (told) return;
  told = true;
  if (env.NODE_TEST_CONTEXT || env.OX_OPERATOR_DRY === '1' || process.platform !== 'darwin') return;
  try {
    const c = spawn('osascript', ['-e', 'display notification "Press Esc to stop, or run: ox computer stop" with title "ox is using your computer"'], { stdio: 'ignore', detached: true });
    c.on('error', () => {});
    c.unref();
  } catch {}
}

const refuse = (content) => ({ ok: false, content, isError: true });

/**
 * May this action happen on the screen? Every desktop tool asks here, just before acting.
 * force: send, delete, unusual shortcuts. These ask each time, whatever -y or an "always" says.
 * → { ok: true } or { ok: false, content, isError }
 */
export async function gate(ctx = {}, { tool, app = null, what, force = false, args = {} } = {}) {
  const env = ctx.env ?? process.env;
  if (stopRequested()) return refuse('You stopped ox using your computer. Touch nothing more on the screen: tell the user where you got to and end your turn.');
  if (env.OX_UNATTENDED === '1' || env.OX_DAEMON_WORKER_ID) return refuse(`Nobody is at the screen for this run, so ox does not use the computer (${what}). Do it from a run you are watching.`);
  const held = holdScreen();
  if (held) return refuse(held);
  tellOnce(env);
  const warn = appWarning(app);
  const saved = !force && !warn && isAppAllowed(app);
  if (saved) return { ok: true };
  if (!force && ctx.yolo) return { ok: true };
  if (!ctx.requestApproval) return refuse(force ? `${what}: this needs you to approve it, and nobody can be asked here. It is left for you.` : `${tool} requires approval`);
  // yolo with an approver that cannot be made to ask would say yes unread.
  if (force && ctx.yolo && !ctx.requestApproval.honorsForce) return refuse(`${what}: this needs you to approve it, and nobody can be asked here. It is left for you.`);
  const detail = `${what}${warn ? `\nWarning: ${warn}.` : ''}`;
  const opts = { force, ...(app && !warn && !force ? { onAlways: () => allowApp(app) } : {}) };
  const yes = await ctx.requestApproval(tool, { ...args, ...(app ? { app } : {}) }, detail, opts);
  return yes ? { ok: true } : refuse(`declined: ${what}`);
}
