// How well does Buddy point? Screens with known controls are rendered, Buddy is asked where each one
// is, and the point it gives is scored against the control's real rectangle: a hit is inside it.
// Run as `ox bench point`. Nothing here is a claim until this has printed it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const OX_BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ox.js');
const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'];
const WIDTH = 1470;
const HEIGHT = 956;

const ICONS = {
  gear: '<circle cx="12" cy="12" r="3.2" fill="none" stroke="#333" stroke-width="2"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4M5 5l3 3M16 16l3 3M5 19l3-3M16 8l3-3" stroke="#333" stroke-width="2"/>',
  trash: '<path d="M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13" fill="none" stroke="#333" stroke-width="2"/>',
  bell: '<path d="M6 17V11a6 6 0 0 1 12 0v6l2 2H4zM10 21h4" fill="none" stroke="#333" stroke-width="2"/>',
  star: '<path d="M12 3l3 6 6 1-4.500 4 1 7-5.500-3-5.500 3 1-7L3 10l6-1z" fill="none" stroke="#333" stroke-width="2"/>',
  search: '<circle cx="10" cy="10" r="6" fill="none" stroke="#333" stroke-width="2"/><path d="M15 15l6 6" stroke="#333" stroke-width="2"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5M4 20h16" fill="none" stroke="#333" stroke-width="2"/>',
};

/** A little seeded random, so a scene is the same on every run and models can be compared. */
function seeded(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

const box = (x, y, w, h, inner, style = '') => `<div style="position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;display:flex;align-items:center;justify-content:center;box-sizing:border-box;${style}">${inner}</div>`;

// Light is the plain case. The others are where reading a picture gets hard.
export const THEMES = {
  light: { page: '#3b4a63', win: '#fff', bar: '#e8e8ec', text: '#222', muted: '#777', btn: '#f4f4f6', line: '#ccc', link: '#36c', font: 12, rowH: 30, sideH: 24, rows: 12 },
  dark: { page: '#0c0d10', win: '#1e1f24', bar: '#2a2b31', text: '#e6e6ea', muted: '#8a8a92', btn: '#2e2f36', line: '#44454d', link: '#6ea8ff', font: 12, rowH: 30, sideH: 24, rows: 12 },
  dense: { page: '#3b4a63', win: '#fff', bar: '#e8e8ec', text: '#222', muted: '#777', btn: '#f4f4f6', line: '#ccc', link: '#36c', font: 10, rowH: 19, sideH: 16, rows: 24 },
  faint: { page: '#d8d8dc', win: '#f4f4f5', bar: '#ececee', text: '#9a9aa0', muted: '#b4b4b8', btn: '#f0f0f1', line: '#e2e2e4', link: '#a8b4cc', font: 12, rowH: 30, sideH: 24, rows: 12 },
};

// About how wide words are at a size: the middle-of-the-word box a pointer should land in.
const textWidth = (word, font) => Math.ceil(word.length * font * 0.525) + 2;

/**
 * One screen: an app window at a random place, with a toolbar of words, a bar of icons with no words,
 * a sidebar, a table whose rows all have the same small buttons, and a dialog.
 * → { html, targets: [{ kind, ask, rect: {x,y,w,h} }] }
 */
export function makeScene(seed, themeName = 'light') {
  const T = THEMES[themeName];
  const r = seeded(seed * 7919 + 13);
  const pick = (list) => list.splice(Math.floor(r() * list.length), 1)[0];
  const ox = 40 + Math.floor(r() * 160);
  const oy = 40 + Math.floor(r() * 70);
  const parts = [];
  const targets = [];
  const words = ['Export', 'Import', 'Share', 'Publish', 'Archive', 'Duplicate', 'Rename', 'Filter', 'Sort', 'Compare', 'Preview', 'History'];
  const tool = `background:${T.btn};border:1px solid ${T.line};border-radius:5px;font-size:${T.font + 1}px;color:${T.text}`;
  parts.push(box(ox, oy, 1180, 780, '', `background:${T.win};border-radius:10px;box-shadow:0 8px 40px #0004`));
  parts.push(box(ox, oy, 1180, 34, `<span style="font-size:13px;color:${T.muted}">Acme Ledger</span>`, `background:${T.bar};border-radius:10px 10px 0 0`));
  let tx = ox + 14;
  const bar = [...words];
  const toolbar = Array.from({ length: 8 }, () => pick(bar));
  const askTool = toolbar[Math.floor(r() * toolbar.length)];
  for (const w of toolbar) {
    const wide = 22 + w.length * 8;
    parts.push(box(tx, oy + 44, wide, 26, w, tool));
    if (w === askTool) targets.push({ kind: 'word', ask: `Where do I click to ${w.toLowerCase()}? Point at the ${w} button.`, rect: { x: tx, y: oy + 44, w: wide, h: 26 } });
    tx += wide + 8;
  }
  // Icons with no words: nothing on screen says which is which but the picture.
  const names = Object.keys(ICONS);
  const icons = Array.from({ length: names.length }, () => pick(names));
  const askIcon = icons[Math.floor(r() * icons.length)];
  let ix = ox + 1180 - 14 - icons.length * 34;
  for (const n of icons) {
    parts.push(box(ix, oy + 44, 26, 26, `<svg width="18" height="18" viewBox="0 0 24 24">${ICONS[n].replaceAll('#333', T.text)}</svg>`));
    if (n === askIcon) targets.push({ kind: 'icon', ask: `Point at the ${n} icon in the top right of the window.`, rect: { x: ix, y: oy + 44, w: 26, h: 26 } });
    ix += 34;
  }
  // A sidebar of small words: the box is the word itself, not the empty space after it.
  const side = ['Overview', 'Invoices', 'Customers', 'Payments', 'Reports', 'Taxes', 'Payroll', 'Vendors', 'Budgets', 'Settings', 'Team', 'Audit log'];
  const askSide = side[Math.floor(r() * side.length)];
  side.forEach((w, i) => {
    const y = oy + 90 + i * T.sideH;
    parts.push(box(ox + 12, y, 150, T.sideH - 4, `<span style="width:100%;font-size:${T.font}px;color:${T.text}">${w}</span>`));
    if (w === askSide) targets.push({ kind: 'small', ask: `Point at ${w} in the sidebar.`, rect: { x: ox + 12, y, w: textWidth(w, T.font), h: T.sideH - 4 } });
  });
  // A table: every row has Edit and Delete, so the words alone do not say which one is meant.
  const firms = ['Globex', 'Initech', 'Umbrella', 'Hooli', 'Stark', 'Wayne', 'Wonka', 'Soylent', 'Tyrell', 'Cyberdyne', 'Massive', 'Pied Piper', 'Acorn', 'Bluth', 'Dunder', 'Gringotts', 'Krusty', 'Monarch', 'Oscorp', 'Prestige', 'Sterling', 'Vandelay', 'Weyland', 'Zorg'];
  const people = firms.slice(0, T.rows);
  const row = people[Math.floor(r() * people.length)];
  const which = r() < 0.5 ? 'Edit' : 'Delete';
  const small = T.font - 1;
  people.forEach((w, i) => {
    const y = oy + 90 + i * T.rowH;
    const h = T.rowH - 4;
    parts.push(box(ox + 190, y, 180, h, `<span style="width:100%;font-size:${T.font}px;color:${T.text}">${w} Holdings</span>`));
    parts.push(box(ox + 380, y, 90, h, `<span style="font-size:${small}px;color:${T.muted}">$${(r() * 9000 + 100).toFixed(2)}</span>`));
    parts.push(box(ox + 480, y, 40, h, `<span style="font-size:${small}px;color:${T.text}">Edit</span>`, `border:1px solid ${T.line};border-radius:4px`));
    parts.push(box(ox + 526, y, 48, h, `<span style="font-size:${small}px;color:${T.text}">Delete</span>`, `border:1px solid ${T.line};border-radius:4px`));
    if (w === row) targets.push({ kind: 'row', ask: `Point at the ${which} button in the ${w} row.`, rect: which === 'Edit' ? { x: ox + 480, y, w: 40, h } : { x: ox + 526, y, w: 48, h } });
  });
  // A dialog at a random place, with a tiny link in its small print.
  const dx = ox + 620 + Math.floor(r() * 180);
  const dy = oy + 130 + Math.floor(r() * 260);
  parts.push(box(dx, dy, 330, 190, '', `background:${T.btn};border:1px solid ${T.line};border-radius:8px;box-shadow:0 4px 18px #0003`));
  parts.push(box(dx + 16, dy + 12, 298, 24, `<b style="width:100%;font-size:14px;color:${T.text}">Close the books for April?</b>`));
  parts.push(box(dx + 16, dy + 62, 150, 16, `<span style="width:100%;font-size:10px;color:${T.link};text-decoration:underline">terms of closing</span>`));
  targets.push({ kind: 'tiny', ask: 'Point at the terms of closing link.', rect: { x: dx + 16, y: dy + 62, w: 72, h: 16 } });
  parts.push(box(dx + 150, dy + 146, 74, 28, 'Cancel', tool));
  parts.push(box(dx + 234, dy + 146, 80, 28, 'Close', 'background:#2d6cdf;color:#fff;border-radius:5px;font-size:13px'));
  targets.push({ kind: 'word', ask: 'Point at the button that cancels this dialog.', rect: { x: dx + 150, y: dy + 146, w: 74, h: 28 } });
  const html = `<!doctype html><html><body style="margin:0;width:${WIDTH}px;height:${HEIGHT}px;overflow:hidden;background:${T.page};font-family:-apple-system,Helvetica,sans-serif">${parts.join('')}</body></html>`;
  return { html, targets };
}

/** The scene as a Retina screenshot and as the screen-sized copy the model is sent. */
export function renderScene(scene, dir, name, { chrome = CHROME.find((c) => fs.existsSync(c)) } = {}) {
  if (!chrome) throw new Error('the point bench needs Chrome');
  const page = path.join(dir, `${name}.html`);
  const full = path.join(dir, `${name}.full.png`);
  const small = path.join(dir, `${name}.png`);
  fs.writeFileSync(page, scene.html);
  spawnSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--window-size=${WIDTH},${HEIGHT}`, '--force-device-scale-factor=2', `--user-data-dir=${path.join(dir, 'chrome')}`, `--screenshot=${full}`, `file://${page}`], { stdio: 'ignore', timeout: 60_000 });
  if (!fs.existsSync(full)) throw new Error('Chrome made no screenshot');
  spawnSync('sips', ['--resampleWidth', String(WIDTH), full, '--out', small], { stdio: 'ignore' });
  return { full, small };
}

function askBuddy({ ask, args, bot, cwd, env = process.env }) {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [OX_BIN, '--mode', 'ask', '--buddy', '--json', ...args, '-p', ask, ...(bot ? ['--bot', bot] : [])], { cwd, env: { ...env, OX_ISLAND: '0', OX_LEARN: '0', OX_MEMORY: '0', OX_MCP: '0', NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err = (err + d).slice(-800); });
    const kill = setTimeout(() => child.kill(), 180_000);
    child.on('close', () => {
      clearTimeout(kill);
      let reply = '';
      let tokens = 0;
      for (const line of out.split('\n')) {
        try {
          const e = JSON.parse(line);
          if (e.t === 'final' && typeof e.message?.content === 'string') reply = e.message.content;
          if (e.t === 'usage') tokens += Number(e.inputTokens) || 0;
        } catch {}
      }
      resolve({ out: reply || out, tokens, err, ms: Date.now() - started });
    });
  });
}

/** How far a point is from a rectangle's middle, and whether it is inside. */
export function scorePoint(point, rect) {
  if (!point) return { hit: false, error: null };
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  return {
    hit: point.x >= rect.x && point.x <= rect.x + rect.w && point.y >= rect.y && point.y <= rect.y + rect.h,
    error: Math.round(Math.hypot(point.x - cx, point.y - cy)),
  };
}

const pct = (list, p) => { const s = [...list].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : null; };

/** The rows of a run as totals, overall and by kind of target. */
export function summarize(rows) {
  const part = (list) => {
    const errs = list.map((r) => r.error).filter((e) => e != null);
    return {
      n: list.length,
      hit: list.filter((r) => r.hit).length,
      hitRate: list.length ? Math.round((list.filter((r) => r.hit).length / list.length) * 100) : 0,
      noPoint: list.filter((r) => r.error == null).length,
      medianError: pct(errs, 0.5),
      p90Error: pct(errs, 0.9),
      medianMs: pct(list.map((r) => r.ms), 0.5),
      medianTokens: pct(list.map((r) => r.tokens ?? 0), 0.5),
    };
  };
  const by = (f) => Object.fromEntries([...new Set(rows.map(f))].map((k) => [k, part(rows.filter((r) => f(r) === k))]));
  return { all: part(rows), byKind: by((r) => r.kind), byTheme: by((r) => r.theme) };
}

async function runJobs(jobs, { concurrency, bot, env, say, before = null }) {
  const { parsePoint } = await import('./buddy.js');
  const rows = [];
  let next = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      await before?.(job);
      const r = await askBuddy({ ask: job.ask, args: ['--image', job.image], bot, cwd: job.dir, env });
      const { point } = parsePoint(r.out);
      // A number left over means it was never turned into a place.
      const placed = point && point.id == null ? point : null;
      const row = { theme: job.theme, kind: job.kind, ask: job.ask, point: placed, ms: r.ms, tokens: r.tokens, ...scorePoint(placed, job.rect), rect: job.rect, said: r.out.trim().slice(-160), err: placed ? '' : r.err.slice(-200) };
      rows.push(row);
      say(row);
    }
  }));
  return { rows, ...summarize(rows) };
}

/**
 * Rendered screens. `see: true` is what Buddy does now (words and controls with real boxes);
 * `see: false` is the picture alone, the way it was, so the two can be compared.
 * The words are read once per screen beforehand, as the island does while you talk: `seeMs` is what that took.
 */
export async function runPointBench({ scenes = 2, themes = Object.keys(THEMES), bot = null, concurrency = 3, see = true, say = () => {}, env = process.env, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-point-')) } = {}) {
  const { hands } = await import('./mac-control.js');
  const jobs = [];
  const seeMs = [];
  for (const theme of themes) {
    for (let s = 0; s < scenes; s++) {
      const scene = makeScene(s + 1, theme);
      const name = `${theme}${s + 1}`;
      const shot = renderScene(scene, dir, name);
      if (see && !fs.existsSync(path.join(dir, `${name}.see.json`))) {
        // The sharp copy, as the island does while you talk.
        const r = await hands(['see', shot.full]);
        if (r?.ms) seeMs.push(r.ms);
        fs.writeFileSync(path.join(dir, `${name}.see.json`), JSON.stringify(r));
      }
      for (const t of scene.targets) jobs.push({ ...t, theme, image: shot.small, dir });
    }
  }
  const r = await runJobs(jobs, { concurrency, bot, say, env: { ...env, OX_BUDDY_SEE: see === true ? 'numbered' : see || '0' } });
  return { ...r, dir, seeMs: pct(seeMs, 0.5) };
}

/**
 * Real apps, one window at a time: Accessibility's frames are the truth, and only that window is
 * pictured and sent. Finder shows a folder of made-up files, not yours.
 */
export async function runRealBench({ bot = null, see = true, say = () => {}, env = process.env, count = 5 } = {}) {
  const { hands } = await import('./mac-control.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-point-real-'));
  const folder = path.join(dir, 'OX Bench Folder');
  fs.mkdirSync(folder);
  for (const f of ['alpha report.txt', 'budget notes.txt', 'client list.txt', 'draft plan.txt', 'expenses.txt', 'final slides.txt']) fs.writeFileSync(path.join(folder, f), 'bench');
  spawnSync('open', ['-a', 'Calculator'], { stdio: 'ignore' });
  spawnSync('open', [folder], { stdio: 'ignore' });
  await new Promise((r) => { setTimeout(r, 1500); });
  const jobs = [];
  for (const [app, wanted, phrase] of [
    ['Calculator', (e) => e.role === 'AXButton' && (e.description || e.name), (t) => `Point at the ${t} button in Calculator.`],
    ['Finder', (e) => /\.txt$/.test(e.name || e.value || ''), (t) => `Point at the file ${t}.`],
  ]) {
    await hands(['activate', app]);
    await new Promise((r) => { setTimeout(r, 500); });
    const ctx = await hands(['context']);
    const listed = await hands(['list', '--app', app, '--max', '300']);
    const win = ctx.windowFrame;
    if (!win || ctx.app !== app || !listed.elements) { say({ theme: app, kind: 'real', ask: `could not read ${app}`, ms: 0, error: null, hit: false, point: null, said: '', err: listed.error ?? `front app is ${ctx.app}` }); continue; }
    const name = app.toLowerCase();
    const full = path.join(dir, `${name}.full.png`);
    const small = path.join(dir, `${name}.png`);
    spawnSync('screencapture', ['-x', '-R', win.map(Math.round).join(','), full], { stdio: 'ignore' });
    spawnSync('sips', ['--resampleWidth', String(Math.round(win[2])), full, '--out', small], { stdio: 'ignore' });
    fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify({ x: win[0], y: win[1], w: win[2], h: win[3] }));
    if (see) fs.writeFileSync(path.join(dir, `${name}.see.json`), JSON.stringify(await hands(['see', full])));
    const found = listed.elements.filter(wanted).filter((e) => e.frame);
    const step = Math.max(1, Math.floor(found.length / count));
    for (const e of found.filter((_, i) => i % step === 0).slice(0, count)) {
      const text = e.description || e.name || e.value;
      jobs.push({ theme: app, kind: 'real', ask: phrase(text), image: small, dir, app, rect: { x: e.frame[0] - win[0], y: e.frame[1] - win[1], w: e.frame[2], h: e.frame[3] } });
    }
  }
  const r = await runJobs(jobs, { concurrency: 1, bot, say, env: { ...env, OX_BUDDY_SEE: see === true ? 'numbered' : see || '0' }, before: async (job) => { await hands(['activate', job.app]); await new Promise((res) => { setTimeout(res, 300); }); } });
  return { ...r, dir, folder };
}
