// Local rendering for web_fetch: a page that only exists after its JavaScript
// runs (a React/Next/Vue shell) comes back from a plain GET as an empty
// <div id="root">. Instead of sending such a page to a third-party reader,
// render it HERE with a Chrome-family browser the user already has, headless,
// with a throwaway profile and no extensions, and read the resulting DOM.
//
// Zero dependencies: it is the browser's own `--dump-dom`. No browser
// installed -> null, and web_fetch behaves exactly as before.
//
//   findBrowser(env)             path of a usable browser, or null
//   looksClientRendered(html, text)  should this page be rendered?
//   renderPage(url, opts)        the same document record fetchDocument returns

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const MAC_BROWSERS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
];
const UNIX_NAMES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser'];
const WIN_BROWSERS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];

const isExec = (p) => {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

/** OX_BROWSER (a path, or "off"), else the first Chrome-family browser found. */
export function findBrowser(env = process.env, platform = process.platform) {
  const pinned = String(env?.OX_BROWSER ?? '').trim();
  if (pinned === 'off' || pinned === '0') return null;
  if (pinned) return isExec(pinned) ? pinned : null;
  if (platform === 'darwin') return MAC_BROWSERS.find(isExec) ?? null;
  if (platform === 'win32') return WIN_BROWSERS.find((p) => fs.existsSync(p)) ?? null;
  for (const dir of String(env?.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    for (const name of UNIX_NAMES) if (isExec(path.join(dir, name))) return path.join(dir, name);
  }
  return null;
}

// Signs that the served HTML is a shell that JavaScript fills in.
const SHELL_MARKERS = [
  /<div[^>]+id=["'](root|app|__next|__nuxt|svelte)["'][^>]*>\s*<\/div>/i,
  /__NEXT_DATA__|__NUXT__|window\.__INITIAL_STATE__/,
  /<noscript>[^<]*(enable|requires?)[^<]*javascript/i,
  /\bng-version=|data-reactroot|data-server-rendered/i,
];

/** True when a page's readable text is thin and its HTML looks client-rendered. */
export function looksClientRendered(html, text) {
  const t = String(text ?? '').trim();
  if (t.length >= 800) return false;
  const h = String(html ?? '');
  if (!/<script\b/i.test(h)) return false;
  return t.length < 200 || SHELL_MARKERS.some((re) => re.test(h));
}

/**
 * Render `url` headless and return { ok, url, status, contentType, body,
 * bytes, truncated, via } like fetchDocument, or { ok: false, kind, message }.
 */
export function renderPage(url, { browser, timeoutMs = 20_000, maxBytes = 512 * 1024, budgetMs = 6_000, signal = null } = {}) {
  if (!browser) return Promise.resolve({ ok: false, kind: 'unsupported', message: 'no Chrome-family browser found (set OX_BROWSER to its path)' });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-render-'));
  const args = [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    // A throwaway profile must not ask macOS's keychain for "Chrome Safe Storage"
    // (the "A keychain cannot be found to store Chrome" dialog).
    '--use-mock-keychain', '--password-store=basic',
    '--disable-extensions', '--disable-sync', '--disable-background-networking',
    '--disable-component-update', '--mute-audio', '--hide-scrollbars',
    `--user-data-dir=${profile}`,
    // Let the page's scripts and their requests settle on a virtual clock.
    `--virtual-time-budget=${Math.max(500, Math.min(budgetMs, timeoutMs - 1000))}`,
    '--dump-dom', String(url),
  ];
  return new Promise((resolve) => {
    let out = Buffer.alloc(0);
    let truncated = false;
    let done = false;
    // Its own process group: Chrome's updater and crash-handler helpers inherit
    // stdout and outlive the page, so the pipe never closes on its own. The
    // whole group is killed once the document has arrived.
    const child = spawn(browser, args, { stdio: ['ignore', 'pipe', 'ignore'], detached: process.platform !== 'win32' });
    const killAll = () => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {}
    };
    const finish = (rec) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      killAll();
      fs.rm(profile, { recursive: true, force: true }, () => {});
      resolve(rec);
    };
    const onAbort = () => finish({ ok: false, kind: 'timeout', message: 'render aborted' });
    signal?.addEventListener?.('abort', onAbort, { once: true });
    const timer = setTimeout(() => finish({ ok: false, kind: 'timeout', message: `render timed out after ${timeoutMs} ms` }), timeoutMs);
    child.stdout.on('data', (d) => {
      if (out.length + d.length > maxBytes) {
        out = Buffer.concat([out, d.subarray(0, maxBytes - out.length)]);
        truncated = true;
        finish(record());
        return;
      }
      out = Buffer.concat([out, d]);
      // --dump-dom prints the serialized document once; its end is the answer.
      if (/<\/html>\s*$/i.test(out.subarray(-64).toString('utf8'))) finish(record());
    });
    const record = () => ({
      ok: true, url: String(url), status: 200, contentType: 'text/html', body: out.toString('utf8'),
      bytes: out.length, truncated, capBytes: maxBytes, via: `rendered locally (${path.basename(browser)})`,
    });
    child.on('error', (e) => finish({ ok: false, kind: 'network', message: `could not start ${path.basename(browser)}: ${e.message}` }));
    child.on('close', (code) => finish(out.length ? record() : { ok: false, kind: 'network', message: `${path.basename(browser)} exited ${code} with no page` }));
  });
}
