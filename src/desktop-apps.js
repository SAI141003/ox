// Which messaging and mail apps are on this Mac, found by bundle id (Spotlight,
// then the usual install folders) and whether each is running. Installed is
// not the same as connected: callers say "found" and still verify an account
// or a permission before claiming anything works.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DESKTOP_APPS = Object.freeze([
  { id: 'whatsapp', name: 'WhatsApp', bundles: ['net.whatsapp.WhatsApp', 'desktop.WhatsApp'], paths: ['/Applications/WhatsApp.app'] },
  { id: 'mail', name: 'Mail', bundles: ['com.apple.mail'], paths: ['/System/Applications/Mail.app', '/Applications/Mail.app'] },
  { id: 'outlook', name: 'Microsoft Outlook', bundles: ['com.microsoft.Outlook'], paths: ['/Applications/Microsoft Outlook.app'] },
  { id: 'messages', name: 'Messages', bundles: ['com.apple.MobileSMS'], paths: ['/System/Applications/Messages.app'] },
  { id: 'telegram', name: 'Telegram', bundles: ['ru.keepcoder.Telegram', 'org.telegram.desktop'], paths: ['/Applications/Telegram.app', '/Applications/Telegram Desktop.app'] },
  { id: 'slack', name: 'Slack', bundles: ['com.tinyspeck.slackmacgap'], paths: ['/Applications/Slack.app'] },
  { id: 'discord', name: 'Discord', bundles: ['com.hnc.Discord'], paths: ['/Applications/Discord.app'] },
]);

let cache = { at: 0, apps: null };

function defaultRun(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 4000 });
  return { status: r.status, stdout: r.stdout ?? '' };
}

function bundleOf(appPath, run) {
  const r = run('/usr/bin/defaults', ['read', path.join(appPath, 'Contents', 'Info'), 'CFBundleIdentifier']);
  return r.status === 0 ? r.stdout.trim() : null;
}

/** { id: { installed, name, path, bundle, version, running } } for every known app. */
export function detectDesktopApps({ platform = process.platform, run = defaultRun, exists = fs.existsSync, now = Date.now(), fresh = false } = {}) {
  if (platform !== 'darwin') return Object.fromEntries(DESKTOP_APPS.map((a) => [a.id, { installed: false, name: a.name }]));
  if (!fresh && cache.apps && now - cache.at < 60_000 && run === defaultRun) return cache.apps;
  const out = {};
  // One Spotlight query for every bundle id, then each hit's id read back.
  const all = DESKTOP_APPS.flatMap((a) => a.bundles);
  const q = run('/usr/bin/mdfind', [all.map((b) => `kMDItemCFBundleIdentifier == '${b}'`).join(' || ')]);
  const hits = new Map();
  if (q.status === 0) for (const p of q.stdout.split('\n').map((s) => s.trim())) {
    if (!p.endsWith('.app') || p.includes('/Library/Caches/') || p.includes('/.Trash/')) continue;
    const b = bundleOf(p, run);
    if (b && all.includes(b) && !hits.has(b)) hits.set(b, p);
  }
  for (const app of DESKTOP_APPS) {
    let found = null, bundle = null;
    for (const b of app.bundles) if (hits.has(b)) { found = hits.get(b); bundle = b; break; }
    if (!found) {
      for (const p of [...app.paths, ...app.paths.map((x) => path.join(os.homedir(), x))]) {
        if (!exists(p)) continue;
        const b = bundleOf(p, run);
        if (!b || app.bundles.includes(b)) { found = p; bundle = b ?? app.bundles[0]; break; }
      }
    }
    if (!found) { out[app.id] = { installed: false, name: app.name }; continue; }
    const v = run('/usr/bin/defaults', ['read', path.join(found, 'Contents', 'Info'), 'CFBundleShortVersionString']);
    const running = run('/usr/bin/pgrep', ['-f', `${found}/Contents/MacOS/`]).status === 0;
    out[app.id] = { installed: true, name: app.name, path: found, bundle, version: v.status === 0 ? v.stdout.trim() : null, running };
  }
  if (run === defaultRun) cache = { at: now, apps: out };
  return out;
}

/** A chat in WhatsApp for Mac with the message typed in; the person presses Enter. */
export function whatsappDesktopLink(to, text) {
  const phone = String(to ?? '').replace(/[^\d]/g, '');
  return `whatsapp://send?phone=${encodeURIComponent(phone)}&text=${encodeURIComponent(String(text ?? ''))}`;
}

/** A mailto: link (for Outlook or any mail app); attachments cannot travel this way. */
export function mailtoLink({ to = [], cc = [], subject = '', body = '' } = {}) {
  const q = [['cc', cc.join(',')], ['subject', subject], ['body', body]].filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  return `mailto:${to.map(encodeURIComponent).join(',')}${q ? `?${q}` : ''}`;
}
