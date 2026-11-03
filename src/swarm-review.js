// Swarm review: a page checked by many agents at once, and you watch them.
//
//   ox swarm <url> [--agents 12] [--headless] [--pace 220]
//
// Every visible element of the page (a "layer") is shared out between N
// agents. Each agent has its own coloured cursor; it moves to each of its
// layers, outlines it with its size, and checks it: text too faint (WCAG
// contrast), text too small, a button too small to tap, an image with no
// description, a control with no name, a field with no label, text cut off by
// its box, something sticking out past the screen. A bar at the bottom shows
// "N agents · done / total layers". At the end: a report and a screenshot.
//
// The checks are rules, run in the page itself: fast, free, the same every
// time. The agents are the presentation and the split of the work.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Browser } from './fast-browser.js';

export const SWARM_COLORS = ['#ff5a5f', '#ffb020', '#3fb950', '#3b82f6', '#a855f7', '#ec4899', '#14b8a6', '#f97316', '#84cc16', '#06b6d4', '#eab308', '#6366f1'];

// Runs inside the page: collects layers, animates the agents, checks each layer.
// window.__oxSwarm = { total, done, findings, finished } is read back by ox.
export const SWARM_SCRIPT = String.raw`(async (AGENTS, PACE, COLORS, MAX) => {
  if (window.__oxSwarm) return true;
  const S = window.__oxSwarm = { total: 0, done: 0, findings: [], finished: false };
  const vw = document.documentElement.clientWidth, vh = window.innerHeight;
  const seen = new Set();
  const visible = (el) => {
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    return r.width >= 2 && r.height >= 2 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
  };
  const layers = [...document.body.querySelectorAll('*')]
    .filter((el) => !['SCRIPT', 'STYLE', 'NOSCRIPT', 'META', 'LINK', 'BR', 'svg', 'path', 'g'].includes(el.tagName) && !el.closest('#ox-swarm') && visible(el))
    .slice(0, MAX);
  S.total = layers.length;

  // ---- the overlay: cursors, boxes, the bar
  const root = document.createElement('div');
  root.id = 'ox-swarm';
  root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;font:600 11px ui-sans-serif,system-ui,sans-serif';
  document.documentElement.appendChild(root);
  const bar = document.createElement('div');
  bar.style.cssText = 'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);background:rgba(20,20,24,.92);color:#fff;border-radius:999px;padding:8px 16px;display:flex;gap:12px;align-items:center;box-shadow:0 6px 24px rgba(0,0,0,.35)';
  bar.innerHTML = '<span id="ox-sw-dots" style="display:flex;gap:2px"></span><b id="ox-sw-n"></b><span id="ox-sw-c"></span><span style="width:120px;height:4px;background:rgba(255,255,255,.18);border-radius:4px;overflow:hidden"><i id="ox-sw-p" style="display:block;height:100%;width:0;background:#7aa2ff"></i></span>';
  root.appendChild(bar);
  const dots = bar.querySelector('#ox-sw-dots');
  for (let i = 0; i < Math.min(AGENTS, 6); i++) dots.insertAdjacentHTML('beforeend', '<i style="width:10px;height:10px;border-radius:50%;background:' + COLORS[i % COLORS.length] + '"></i>');
  bar.querySelector('#ox-sw-n').textContent = AGENTS + ' agents';
  const tick = () => { bar.querySelector('#ox-sw-c').textContent = S.done + ' / ' + S.total + ' layers'; bar.querySelector('#ox-sw-p').style.width = (S.total ? (100 * S.done) / S.total : 100) + '%'; };
  tick();
  const cursor = (color) => {
    const c = document.createElement('div');
    c.style.cssText = 'position:fixed;left:0;top:0;transition:transform ' + Math.round(PACE * 0.8) + 'ms ease;will-change:transform';
    c.innerHTML = '<svg width="18" height="18" viewBox="0 0 18 18"><path d="M2 1l13 7-6 1.5L6.5 16z" fill="' + color + '" stroke="#fff" stroke-width="1.2"/></svg>';
    root.appendChild(c);
    return c;
  };
  const box = (r, color, label, bad) => {
    const b = document.createElement('div');
    b.style.cssText = 'position:fixed;left:' + r.left + 'px;top:' + r.top + 'px;width:' + r.width + 'px;height:' + r.height + 'px;border:1.5px solid ' + (bad ? '#ff3b3b' : color) + ';background:' + (bad ? 'rgba(255,59,59,.10)' : 'transparent') + ';transition:opacity .6s';
    const t = document.createElement('span');
    t.textContent = label;
    t.style.cssText = 'position:absolute;right:-1px;bottom:-17px;background:' + (bad ? '#ff3b3b' : color) + ';color:#fff;padding:1px 4px;border-radius:3px;white-space:nowrap';
    b.appendChild(t);
    root.appendChild(b);
    // A clean layer fades out; a problem keeps a thin red outline, and its label fades so the page stays readable.
    if (!bad) setTimeout(() => { b.style.opacity = '0'; setTimeout(() => b.remove(), 700); }, PACE * 3);
    else setTimeout(() => { t.style.transition = 'opacity .6s'; t.style.opacity = '0'; b.style.background = 'transparent'; }, PACE * 5);
  };

  // ---- the checks
  const rgb = (s) => { const m = String(s).match(/[\d.]+/g); return m ? m.map(Number) : null; };
  const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const bgOf = (el) => { for (let e = el; e; e = e.parentElement) { const c = rgb(getComputedStyle(e).backgroundColor); if (c && (c[3] === undefined || c[3] > 0.5)) return c; } return [255, 255, 255]; };
  const ownText = (el) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.nodeValue).join('').trim();
  const nameOf = (el) => (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || el.getAttribute('alt') || (el.querySelector && el.querySelector('img[alt]') && el.querySelector('img[alt]').alt) || '').trim();
  const where = (el) => {
    const t = el.tagName.toLowerCase(), id = el.id ? '#' + el.id : '', cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    const txt = (ownText(el) || el.getAttribute('aria-label') || '').slice(0, 40);
    return t + id + cls + (txt ? ' "' + txt + '"' : '');
  };
  function check(el) {
    const out = [], r = el.getBoundingClientRect(), cs = getComputedStyle(el), tag = el.tagName;
    const text = ownText(el);
    if (text) {
      const fg = rgb(cs.color), bg = bgOf(el);
      if (fg && bg) {
        const L1 = lum(fg), L2 = lum(bg), ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
        const size = parseFloat(cs.fontSize), bold = Number(cs.fontWeight) >= 700;
        const need = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5;
        if (ratio < need) out.push(['contrast', 'text too faint: contrast ' + ratio.toFixed(2) + ':1, needs ' + need + ':1']);
        if (size < 11) out.push(['small-text', 'text is ' + size + 'px; under 11px is hard to read']);
      }
      if ((cs.overflow === 'hidden' || cs.textOverflow === 'ellipsis' || cs.overflowX === 'hidden') && el.scrollWidth > el.clientWidth + 2) out.push(['clipped', 'text is cut off by its box']);
    }
    const clickable = tag === 'BUTTON' || (tag === 'A' && el.hasAttribute('href')) || el.getAttribute('role') === 'button';
    if (clickable) {
      if (!nameOf(el)) out.push(['no-name', 'a ' + (tag === 'A' ? 'link' : 'button') + ' with no name: screen readers say nothing']);
      if (r.width < 24 || r.height < 24) out.push(['tap-target', 'only ' + Math.round(r.width) + ' × ' + Math.round(r.height) + 'px to tap; 24 × 24 is the minimum']);
    }
    if (tag === 'IMG' && !el.hasAttribute('alt')) out.push(['img-alt', 'image with no description (alt)']);
    if ((tag === 'INPUT' && !['hidden', 'submit', 'button'].includes(el.type)) || tag === 'TEXTAREA' || tag === 'SELECT') {
      const labelled = el.labels && el.labels.length || el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('title');
      if (!labelled) out.push(['no-label', 'a field with no label' + (el.placeholder ? ' (the placeholder disappears once you type)' : '')]);
    }
    if (r.right > vw + 1 && cs.position !== 'fixed') out.push(['overflow', 'sticks out ' + Math.round(r.right - vw) + 'px past the right edge']);
    return out;
  }

  // ---- the agents: each takes every Nth layer and walks them
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const agents = Array.from({ length: AGENTS }, (_, i) => ({ i, color: COLORS[i % COLORS.length], el: cursor(COLORS[i % COLORS.length]) }));
  await Promise.all(agents.map(async (a) => {
    for (let k = a.i; k < layers.length; k += AGENTS) {
      const el = layers[k];
      if (!el.isConnected) { S.done++; tick(); continue; }
      const r0 = el.getBoundingClientRect();
      if (r0.top > vh || r0.bottom < 0) { el.scrollIntoView({ block: 'center', behavior: 'instant' }); }
      const r = el.getBoundingClientRect();
      a.el.style.transform = 'translate(' + (r.left + Math.min(r.width / 2, 40)) + 'px,' + (r.top + Math.min(r.height / 2, 20)) + 'px)';
      await sleep(PACE * (0.6 + Math.random() * 0.8));
      const found = check(el);
      for (const [kind, msg] of found) if (!seen.has(kind + where(el))) { seen.add(kind + where(el)); S.findings.push({ kind, msg, where: where(el), agent: a.i + 1, box: [Math.round(r.left + scrollX), Math.round(r.top + scrollY), Math.round(r.width), Math.round(r.height)] }); }
      const size = Math.round(r.width) + ' × ' + Math.round(r.height);
      box(r, a.color, found.length ? found.map(([k]) => (k === 'tap-target' ? 'tap ' + size : k)).join(' · ') : size, found.length > 0);
      S.done++; tick();
    }
    a.el.remove();
  }));
  window.scrollTo({ top: 0, behavior: 'instant' });
  S.finished = true;
  return true;
})`;

const KIND_TITLE = { contrast: 'Text too faint', 'small-text': 'Text too small', clipped: 'Text cut off', 'no-name': 'Buttons and links with no name', 'tap-target': 'Too small to tap', 'img-alt': 'Images with no description', 'no-label': 'Fields with no label', overflow: 'Sticks out past the screen' };

/** The report as Markdown, problems grouped by kind. */
export function swarmReport({ url, agents, total, findings, screenshot }) {
  const by = new Map();
  for (const f of findings) by.set(f.kind, [...(by.get(f.kind) ?? []), f]);
  const lines = [`# Swarm review: ${url}`, '', `${agents} agents checked ${total} layers and found ${findings.length} problem${findings.length === 1 ? '' : 's'}.`, ''];
  for (const [kind, list] of [...by.entries()].sort((a, b) => b[1].length - a[1].length)) {
    lines.push(`## ${KIND_TITLE[kind] ?? kind} (${list.length})`, '');
    for (const f of list.slice(0, 40)) lines.push(`- \`${f.where}\`: ${f.msg} (agent ${f.agent}, at ${f.box[0]},${f.box[1]} ${f.box[2]}×${f.box[3]})`);
    if (list.length > 40) lines.push(`- …and ${list.length - 40} more`);
    lines.push('');
  }
  if (!findings.length) lines.push('Nothing found by these checks. They cover what rules can see; a person still judges the layout and the words.', '');
  if (screenshot) lines.push(`Screenshot: ${screenshot}`, '');
  return lines.join('\n');
}

/**
 * Open the page, let the agents go, collect what they found.
 * → { url, agents, total, findings, report, reportFile, screenshot }
 */
export async function runSwarmReview(url, { agents = 12, headless = false, pace = 220, maxLayers = 400, out = null, env = process.env, onProgress = () => {} } = {}) {
  if (!/^https?:\/\//.test(url) && !/^file:\/\//.test(url)) url = `https://${url}`;
  agents = Math.max(1, Math.min(32, Math.round(agents)));
  const b = await Browser.open(url, { headless, env });
  try {
    await b.call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false }).catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));
    await b.evaluate(`(${SWARM_SCRIPT})(${agents}, ${Math.max(20, pace)}, ${JSON.stringify(SWARM_COLORS)}, ${maxLayers})`, { awaitPromise: false });
    let state = null;
    const deadline = Date.now() + 10 * 60_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 400));
      state = JSON.parse(await b.evaluate('JSON.stringify(window.__oxSwarm ? { total: __oxSwarm.total, done: __oxSwarm.done, n: __oxSwarm.findings.length, finished: __oxSwarm.finished } : null)') || 'null');
      if (state) onProgress(state);
      if (state?.finished) break;
    }
    const findings = JSON.parse(await b.evaluate('JSON.stringify(window.__oxSwarm ? __oxSwarm.findings : [])') || '[]');
    const dir = out ?? path.join(env.OX_HOME || path.join(os.homedir(), '.ox'), 'reviews');
    fs.mkdirSync(dir, { recursive: true });
    const stem = `${new URL(url).host.replace(/[^\w.-]/g, '-') || 'page'}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
    const screenshot = path.join(dir, `${stem}.jpg`);
    try { fs.writeFileSync(screenshot, Buffer.from(await b.screenshot(), 'base64')); } catch {}
    const result = { url, agents, total: state?.total ?? 0, findings };
    const report = swarmReport({ ...result, screenshot });
    const reportFile = path.join(dir, `${stem}.md`);
    fs.writeFileSync(reportFile, report);
    fs.writeFileSync(path.join(dir, `${stem}.json`), JSON.stringify(result, null, 2));
    return { ...result, report, reportFile, screenshot };
  } finally {
    await b.close().catch(() => {});
  }
}
