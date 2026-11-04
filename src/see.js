// What Buddy knows about the screen beyond the picture: every word Vision can read and every control
// Accessibility names, each with its real box. The model chooses by number ([POINT:#12:label]) and ox
// gives the place, so a position comes from the screen and not from the model's estimate. A point it
// cannot tie to the screen is dropped, never drawn: pointing at the wrong thing is worse than not pointing.
import fs from 'node:fs';
import path from 'node:path';
import { hands } from './mac-control.js';

const MAX_ITEMS = 150;
const SNAP_PX = 120;
// Words a model adds to a label that are not on the control.
const FILLER = /\b(?:the|a|an|button|icon|link|menu|item|tab|field|box|label|text|option|row|column|in|on|at|of|to|this|that)\b/g;

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').replace(FILLER, ' ').replace(/\s+/g, ' ').trim();

/** Does this item's text say what the label says? */
export function textMatches(itemText, label) {
  const a = norm(itemText);
  const b = norm(label);
  if (!a || !b) return false;
  return a === b || ` ${a} `.includes(` ${b} `) || ` ${b} `.includes(` ${a} `);
}

/** Where this picture's screen is, if the capture said. */
function companions(file) {
  try { return { meta: JSON.parse(fs.readFileSync(`${file.replace(/\.[a-z]+$/i, '')}.json`, 'utf8')) }; } catch { return { meta: null }; }
}

function sizeOf(file) {
  try {
    const b = fs.readFileSync(file);
    return b.readUInt32BE(0) === 0x89504e47 ? { width: b.readUInt32BE(16), height: b.readUInt32BE(20) } : null;
  } catch { return null; }
}

function readDone(file) {
  try { return JSON.parse(fs.readFileSync(`${file.replace(/\.[a-z]+$/i, '')}.see.json`, 'utf8')); } catch { return null; }
}

/** Vision's lines → items in the sent picture's pixels. Pure. */
export function ocrItems(see, { sentWidth = see.width, screen = 1 } = {}) {
  const k = sentWidth / (see.width || sentWidth || 1);
  const scaled = (b) => ({ x: b.x * k, y: b.y * k, w: b.w * k, h: b.h * k });
  return (see.lines ?? []).map((l) => ({
    source: 'text',
    screen,
    text: l.text,
    ...scaled(l),
    words: (l.words ?? []).map((w) => ({ text: w.text, ...scaled(w) })),
  }));
}

/** Accessibility's controls (screen points, from the top left of all displays) → items in the sent picture's pixels. Pure. */
export function controlItems(elements, { display, sentWidth, screen = 1 } = {}) {
  if (!display || !elements?.length) return [];
  const k = (sentWidth || display.w) / display.w;
  const out = [];
  for (const e of elements) {
    const text = e.name || e.description || e.help || e.value || e.identifier;
    if (!text || !e.frame || e.role === 'AXSecureTextField') continue;
    const [fx, fy, fw, fh] = e.frame;
    if (fw <= 0 || fh <= 0 || fw * fh > display.w * display.h * 0.5) continue;
    const cx = fx + fw / 2;
    const cy = fy + fh / 2;
    if (cx < display.x || cy < display.y || cx > display.x + display.w || cy > display.y + display.h) continue;
    out.push({ source: 'control', screen, text: String(text).slice(0, 60), role: String(e.role ?? '').replace(/^AX/, ''), x: (fx - display.x) * k, y: (fy - display.y) * k, w: fw * k, h: fh * k });
  }
  return out;
}

const centre = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

/** Controls first, words that are not already a control's, nearest the cursor kept, numbered in reading order. Pure. */
export function mergeItems(lists, { cursor = null, cursorScreen = 1, max = MAX_ITEMS } = {}) {
  const controls = lists.flat().filter((i) => i.source === 'control');
  const words = lists.flat().filter((i) => i.source !== 'control').filter((w) => {
    const c = centre(w);
    return !controls.some((b) => b.screen === w.screen && c.x >= b.x && c.x <= b.x + b.w && c.y >= b.y && c.y <= b.y + b.h && textMatches(b.text, w.text));
  });
  const dist = (i) => {
    const off = i.screen === cursorScreen ? 0 : 1e6;
    if (!cursor) return off + i.y * 10000 + i.x;
    const c = centre(i);
    return off + Math.hypot(c.x - cursor.x, c.y - cursor.y);
  };
  const kept = [...controls, ...words].sort((a, b) => dist(a) - dist(b)).slice(0, max);
  kept.sort((a, b) => a.screen - b.screen || Math.round(a.y / 8) - Math.round(b.y / 8) || a.x - b.x);
  return kept.map((i, n) => ({ ...i, id: n + 1 }));
}

/** The list the model reads. A place is given so equal words can be told apart. */
export function itemsText(items) {
  return items.map((i) => {
    const c = centre(i);
    return `#${i.id} ${i.role ? `${i.role} ` : ''}"${i.text.replace(/\s+/g, ' ')}" ${Math.round(c.x)},${Math.round(c.y)}${i.screen > 1 ? ` screen${i.screen}` : ''}`;
  }).join('\n');
}

/** Where a tag should land: { x, y, label, screen, how }, or null when it cannot be tied to the screen. Pure. */
export function resolvePoint(point, seen) {
  if (!point) return null;
  const items = seen?.items ?? [];
  const sized = (n) => seen?.screens?.find((s) => s.n === n) ?? seen?.screens?.[0] ?? null;
  const at = (i, how) => {
    // Inside a longer line, the words the label names.
    const words = (i.words ?? []).filter((w) => textMatches(w.text, point.label) || textMatches(point.label, w.text));
    const label = norm(point.label).split(' ');
    const named = words.filter((w) => label.includes(norm(w.text)));
    const box = named.length && named.length < (i.words?.length ?? 0) ? {
      x: Math.min(...named.map((w) => w.x)),
      y: Math.min(...named.map((w) => w.y)),
      w: Math.max(...named.map((w) => w.x + w.w)) - Math.min(...named.map((w) => w.x)),
      h: Math.max(...named.map((w) => w.y + w.h)) - Math.min(...named.map((w) => w.y)),
    } : i;
    const c = centre(box);
    return { x: Math.round(c.x), y: Math.round(c.y), label: point.label || i.text, screen: i.screen, how };
  };
  if (point.id != null) {
    const hit = items.find((i) => i.id === point.id);
    return hit ? at(hit, 'item') : null;
  }
  const screen = point.screen ?? seen?.screens?.[0]?.n ?? 1;
  const size = sized(screen);
  if (size && (point.x < 0 || point.y < 0 || point.x > size.width || point.y > size.height)) return null;
  // A place with a name: the nearest real thing of that name, if one is close. Without one the place stands.
  const inside = (i) => point.x >= i.x && point.x <= i.x + i.w && point.y >= i.y && point.y <= i.y + i.h;
  const near = items
    .filter((i) => i.screen === screen && textMatches(i.text, point.label))
    .map((i) => ({ i, d: inside(i) ? 0 : Math.hypot(centre(i).x - point.x, centre(i).y - point.y) }))
    .filter((x) => x.d <= SNAP_PX)
    .sort((a, b) => a.d - b.d)[0];
  if (near) return at(near.i, 'snapped');
  return { x: Math.round(point.x), y: Math.round(point.y), label: point.label, screen, how: 'pixels' };
}

const TAG = /\[POINT:[^\]]*\]/gi;
export const CANNOT_PLACE = 'I can\'t find that on your screen.';

/** A reply with every POINT tag replaced by real coordinates, or removed. `parse` is buddy.js parsePoint. Pure. */
export function rewritePoints(text, seen, parse, { log = null } = {}) {
  const original = String(text ?? '');
  const out = original.replace(TAG, (tag) => {
    const { point } = parse(tag);
    const r = resolvePoint(point, seen);
    log?.({ tag, resolved: r });
    if (!r) return '';
    return `[POINT:${r.x},${r.y}:${r.label.replace(/[\]:]/g, ' ').trim()}${r.screen > 1 ? `:screen${r.screen}` : ''}]`;
  });
  // The whole answer was a place that does not exist: said, not silent.
  return original.trim() && !out.trim() ? CANNOT_PLACE : out;
}

/** Rewrites tags in a stream: text passes straight on, a tag is held until it closes. */
export function tagStream(write, rewrite) {
  let held = '';
  return {
    write(text) {
      let s = held + text;
      held = '';
      const open = s.lastIndexOf('[');
      const tail = open >= 0 ? s.slice(open) : '';
      if (open >= 0 && !tail.includes(']') && ('[POINT:'.startsWith(tail.toUpperCase()) || /^\[POINT:/i.test(tail))) {
        held = s.slice(open);
        s = s.slice(0, open);
      }
      if (s) write(rewrite(s));
    },
    end() { if (held) { const h = held; held = ''; write(rewrite(h).replace(/\[POINT:[^\]]*$/i, '')); } },
  };
}

/**
 * The words the app shows should be in the picture. When Accessibility names plenty and Vision reads none of
 * them, the picture is not of this screen: that is how a turned-off Screen Recording looks (wallpaper). Pure.
 */
export function pictureMissesApp(controls, ocr) {
  // Only words the app really draws: a button's name is often not on it (Calculator's "Divide" shows ÷).
  const named = controls.filter((c) => /Text/.test(c.role ?? '')).map((c) => norm(c.text)).filter((t) => t.length >= 3);
  if (new Set(named).size < 5) return false;
  const seen = norm(ocr.map((l) => l.text).join(' '));
  return !named.some((t) => seen.includes(t));
}

export const NO_PERMISSION = 'I can\'t see your screen: the picture came back empty. Turn on Screen Recording for OX Island in System Settings, Privacy and Security, then ask me again.';

/**
 * Look at the screenshots. → { screens, items, context, cannotSee, text }
 * `cannotSee` is what to tell the user instead of asking a model about a picture that shows nothing.
 * Without the helper (not built, not a Mac) there is nothing added and the picture alone is used.
 */
export async function seeShots(images, { ask = hands, useControls = true } = {}) {
  const context = await ask(['context']).catch(() => null);
  const live = context && !context.error ? context : null;
  const screens = [];
  const lists = [];
  let cursorScreen = 1;
  let cursor = null;
  for (let i = 0; i < images.length; i++) {
    const n = i + 1;
    const { meta } = companions(images[i]);
    // The words may already be read: the island reads them while you are still talking.
    const big = readDone(images[i]) ?? await ask(['see', path.resolve(images[i])]).catch((e) => ({ error: e.message }));
    if (big?.error) {
      if (i === 0 && /read the image/.test(big.error)) return { screens, items: [], context: live, cannotSee: 'I can\'t see that: the picture could not be read.', text: '' };
      // The helper is missing or failed: the picture alone still goes to the model.
      const own = sizeOf(images[i]);
      if (own) screens.push({ n, ...own, ...(meta ? { display: meta } : {}) });
      continue;
    }
    if (big.blank) {
      if (i === 0) return { screens, items: [], context: live, cannotSee: NO_PERMISSION, text: '' };
      continue;
    }
    const own = sizeOf(images[i]) ?? { width: big.width, height: big.height };
    const width = own.width;
    const screen = { n, width, height: own.height, ...(meta ? { display: meta } : {}) };
    screens.push(screen);
    const ocr = ocrItems(big, { sentWidth: width, screen: n });
    lists.push(ocr);
    if (meta && live?.cursor) {
      const { x, y } = live.cursor;
      if (x >= meta.x && y >= meta.y && x < meta.x + meta.w && y < meta.y + meta.h) {
        cursorScreen = n;
        const k = width / meta.w;
        cursor = { x: (x - meta.x) * k, y: (y - meta.y) * k };
      }
    }
    if (meta && useControls && live?.access && live.windowFrame) {
      const f = live.windowFrame;
      const cx = f[0] + f[2] / 2;
      const cy = f[1] + f[3] / 2;
      if (cx >= meta.x && cy >= meta.y && cx < meta.x + meta.w && cy < meta.y + meta.h) {
        const got = await ask(['list', '--max', '200']).catch(() => null);
        const controls = controlItems(got?.elements ?? [], { display: meta, sentWidth: width, screen: n });
        if (i === 0 && pictureMissesApp(controls, big.lines ?? [])) return { screens, items: [], context: live, cannotSee: NO_PERMISSION, text: '' };
        lists.push(controls);
      }
    }
  }
  const items = mergeItems(lists, { cursor, cursorScreen });
  return { screens, items, context: live, cursor, cursorScreen, text: itemsText(items) };
}
