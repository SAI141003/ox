// current_page: the page open in your browser right now (title and address),
// so "what is this video about?" or "summarise this article" knows what "this"
// is — Pixie / Clicky style. Read-only. macOS: Safari, Chrome, Arc, Brave, Edge,
// Chromium, Vivaldi, Opera; the browser in front wins, else the first one open.
// Asking a browser for its tab needs your OK once (macOS Automation).
import { execFile } from 'node:child_process';

const CHROMIUMS = ['Google Chrome', 'Arc', 'Brave Browser', 'Microsoft Edge', 'Chromium', 'Vivaldi', 'Opera'];
const BROWSERS = ['Safari', ...CHROMIUMS];

export const CURRENT_PAGE_SCHEMAS = Object.freeze([{
  name: 'current_page',
  description: "The page open in the user's browser right now: its title, address and which browser. Use it when they say \"this video\", \"this page\", \"this article\" or \"what I'm watching\"; then read it (youtube_transcript for a YouTube video, web_fetch for a page).",
  parameters: { type: 'object', properties: {} },
}]);
export const CURRENT_PAGE_TOOLS = Object.freeze(['current_page']);
export const CURRENT_PAGE_SIGNAL = /\b(this|the|current)\s+(video|page|tab|article|site|post|thread|website)\b|\bwhat (am i|i'?m) (watching|reading|looking at)\b|\bon my screen\b/i;

// Two small AppleScripts: which browser (the one in front, else the first one
// running; none is launched), then that browser's tab. Two steps because a
// browser's own words ("active tab") only compile when that browser is there.
export function pickScript() {
  const q = (s) => `"${s}"`;
  return [
    'set front to ""',
    'tell application "System Events" to set front to name of first application process whose frontmost is true',
    `set browsers to {${BROWSERS.map(q).join(', ')}}`,
    'if browsers contains front then return front',
    'repeat with b in browsers',
    '  if application (b as text) is running then return (b as text)',
    'end repeat',
    'return ""',
  ].join('\n');
}

export function tabScript(browser) {
  if (!BROWSERS.includes(browser)) return null;
  return browser === 'Safari'
    ? 'tell application "Safari" to return (name of current tab of front window) & linefeed & (URL of current tab of front window)'
    : `tell application "${browser}" to return (title of active tab of front window) & linefeed & (URL of active tab of front window)`;
}

export function parsePage(out) {
  const [browser, title, url] = String(out ?? '').trim().split('\n');
  if (!browser || !url) return null;
  return { browser: browser.trim(), title: (title ?? '').trim(), url: url.trim() };
}

export async function currentPageTool(_args = {}, { run = null, platform = process.platform } = {}) {
  if (platform !== 'darwin') return { content: 'current_page: reading the browser tab works on macOS only.', isError: true };
  const exec = run ?? ((script) => new Promise((resolve, reject) => execFile('osascript', ['-e', script], { timeout: 8000 }, (e, so, se) => (e ? reject(new Error(String(se || e.message).trim())) : resolve(so)))));
  let out;
  try {
    const browser = String(await exec(pickScript())).trim();
    if (!browser) return { content: 'current_page: no browser is open (Safari, Chrome, Arc, Brave, Edge…).', isError: true };
    out = `${browser}\n${await exec(tabScript(browser))}`;
  } catch (e) {
    const m = String(e.message);
    if (/not allowed|-1743|not authorized/i.test(m)) return { content: 'current_page: macOS has not let ox read your browser yet. Allow it once in System Settings › Privacy & Security › Automation (for your terminal or OX Island, under your browser).', isError: true };
    if (/-1728|-1719|front window|Can.t get/i.test(m)) return { content: 'current_page: your browser has no window open.', isError: true };
    return { content: `current_page: ${m.slice(0, 200)}`, isError: true };
  }
  const p = parsePage(out);
  if (!p) return { content: 'current_page: no browser is open (Safari, Chrome, Arc, Brave, Edge…).', isError: true };
  const yt = /(?:youtube\.com\/(?:watch|shorts|live)|youtu\.be\/)/.test(p.url);
  return { content: `${p.title || '(no title)'}\n${p.url}\nin ${p.browser}${yt ? '\nThis is a YouTube video: youtube_transcript reads what it says.' : ''}` };
}
