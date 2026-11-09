// desktop: the rest of agent-desktop (vercel-labs/agent-desktop, Apache-2.0)
// as one tool, beside ui_elements / click / type_text / press_key.
//
// Reads (no approval): find a control by name, role or text instead of reading
// the whole window (the cheapest way to see an app), read a control's text,
// value or state, list windows, apps and notifications.
// Acts (ask first, like every ox action): set a value, clear, focus, pick an
// option, tick or untick, expand or collapse, scroll, bring a window forward,
// resize, move, minimise, maximise or restore it, open an app, dismiss a
// notification. ox's rules stay on top (src/computer-control.js): apps are allowed one by
// one, a control that sends or deletes asks every time, and one that pays is never touched.
import os from 'node:os';
import path from 'node:path';
import * as macControl from '../mac-control.js';
import { gate, isPayment } from '../computer-control.js';

export const DESKTOP_READS = Object.freeze(['map', 'drill', 'find', 'get', 'is', 'windows', 'apps', 'notifications', 'surfaces', 'displays', 'wait', 'screenshot']);
export const DESKTOP_ACTS = Object.freeze(['click', 'double_click', 'right_click', 'type', 'hover', 'drag', 'clipboard_get', 'clipboard_set', 'clipboard_clear', 'notification_action', 'dismiss_all_notifications', 'open_surface', 'set_value', 'clear', 'focus', 'select', 'toggle', 'check', 'uncheck', 'expand', 'collapse', 'scroll', 'scroll_to', 'focus_window', 'resize_window', 'move_window', 'minimize', 'maximize', 'restore', 'launch', 'dismiss_notification']);

export const DESKTOP_TOOL_SCHEMAS = Object.freeze([{
  name: 'desktop',
  description: 'Work in a desktop app through its accessibility tree (agent-desktop; no pointer moved, no focus taken). Cheapest first: action "find" with text/role returns just the matching controls; "get"/"is" read one. For a dense app, "map" gives a shallow outline with refs like @s1:e3 and how much is inside each; "drill" with one of those refs reads that region. An element can be its name or such a ref. After an async step use "wait", not a pause. Acting (set_value, clear, focus, select, toggle, check, uncheck, expand, collapse, scroll, scroll_to) takes the control by name; window actions (focus_window, resize_window, move_window, minimize, maximize, restore, launch) take the app; notifications/dismiss_notification read and clear Notification Center. Never sends, pays or deletes.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [...DESKTOP_READS, ...DESKTOP_ACTS] },
      app: { type: 'string', description: 'The app, e.g. "Notes" (default: the app in front)' },
      element: { type: 'string', description: 'The control: its name or label, or its number from ui_elements' },
      role: { type: 'string', description: 'Narrow by role: button, textfield, checkbox, row, menuitem …' },
      text: { type: 'string', description: 'find: text in a control\'s name, value or label; type: the text; wait: text to wait for; clipboard_set: the text' },
      to: { type: 'string', description: 'drag: the control to drop on, by name or ref' },
      ms: { type: 'number', description: 'wait: how long at most, up to 15000' },
      window: { type: 'string', description: 'wait: a window title to wait for' },
      surface: { type: 'string', description: 'open_surface: dock, menu-bar-extras, start-menu, taskbar, system-tray' },
      value: { type: 'string', description: 'set_value: the new value; select: the option' },
      property: { type: 'string', description: 'get: text, value, title, bounds, role, states; is: visible, enabled, checked, focused, expanded, selected' },
      direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
      amount: { type: 'number' },
      width: { type: 'number' }, height: { type: 'number' }, x: { type: 'number' }, y: { type: 'number' },
      index: { type: 'number', description: 'dismiss_notification: its number from notifications' },
    },
    required: ['action'],
  },
}]);

const err = (content) => ({ content, isError: true });

// What each ref from a map or drill is, so ox's rules can read it before acting: a
// bare ref says nothing about whether the control sends, pays or deletes.
const KNOWN_REFS = new Map();
const learnRef = (n) => { if (KNOWN_REFS.size > 2000) KNOWN_REFS.clear(); KNOWN_REFS.set(n.ref_id, { ref: n.ref_id, role: String(n.role ?? 'control'), name: n.name ?? '', description: n.description ?? '' }); };

/** A snapshot as short lines: ref, role, name, and how much a cut branch still holds. */
export function describeTree(tree, { max = 400 } = {}) {
  const lines = [];
  const walk = (n, depth) => {
    if (!n || lines.length >= max) return;
    if (n.ref_id) learnRef(n);
    const label = [n.name, n.value != null && n.value !== '' ? `= ${String(n.value).slice(0, 80)}` : null].filter(Boolean).join(' ');
    if (n.ref_id || label || n.children_count) lines.push(`${' '.repeat(depth)}${n.ref_id ? `${n.ref_id} ` : ''}${n.role ?? 'group'}${label ? ` "${String(label).slice(0, 120)}"` : ''}${n.children_count ? ` (${n.children_count} inside)` : ''}`);
    for (const c of n.children ?? []) walk(c, depth + 1);
  };
  walk(tree, 0);
  return lines.join('\n') || 'nothing to show';
}
const why = (r) => [r?.error?.message, r?.error?.suggestion].filter(Boolean).join(' ') || 'agent-desktop failed';

/** A control of the app, by name or number, refusing the ones that send, pay or delete. */
async function target(A, { app, element, role }, opts = {}) {
  if (/^@/.test(String(element ?? '').trim())) {
    const known = KNOWN_REFS.get(String(element).trim());
    if (!known) return { error: `${element} is not from a map or drill in this run: use "map" again` };
    if (isPayment(known)) return { error: `ox does not touch "${known.name || known.description}": it spends money. It is left for you.` };
    return { el: known };
  }
  const list = await A.listElements(app, opts);
  if (list.error) return { error: list.error };
  const q = String(element ?? '').trim();
  if (!q) return { error: 'element is required: the control\'s name or label' };
  const el = /^\d+$/.test(q) && Number(q) <= list.elements.length ? list.elements[Number(q) - 1] : macControl.findElement(list.elements, q, role);
  if (!el) return { error: `no control called "${q}" in ${list.app}. ${macControl.describeElements({ ...list, elements: list.elements.slice(0, 40) })}` };
  if (isPayment(el)) return { error: `ox does not touch "${el.name || el.description}": it spends money. It is left for you.` };
  return { el };
}

/** The agent-desktop command for an action (refs filled in by the caller). */
export function commandFor(a, ref = null) {
  const app = a.app ? ['--app', String(a.app)] : [];
  switch (a.action) {
    case 'map': return ['snapshot', ...app, '--skeleton', '-i', '--compact'];
    case 'drill': return ['snapshot', '--root', ref, '-i', '--compact'];
    case 'surfaces': return ['list-surfaces', ...app];
    case 'displays': return ['list-displays'];
    case 'wait': return ['wait', ...app, ...(a.text ? ['--text', String(a.text)] : a.window ? ['--window', String(a.window)] : [String(Math.max(1, Math.min(15000, Number(a.ms) || 1000)))]), ...(a.text || a.window ? ['--timeout', String(Math.max(1, Math.min(15000, Number(a.ms) || 10000)))] : [])];
    case 'screenshot': return ['screenshot', ...app, String(a.path)];
    case 'click': case 'double_click': case 'right_click': return [a.action.replace('_', '-'), ref];
    case 'type': return ['type', ref, String(a.text ?? '')];
    case 'hover': return ['--headed', 'hover', ref];
    case 'drag': return ['--headed', 'drag', '--from', ref, '--to', a.toRef];
    case 'clipboard_get': return ['clipboard-get'];
    case 'clipboard_set': return ['clipboard-set', String(a.text ?? '')];
    case 'clipboard_clear': return ['clipboard-clear'];
    case 'notification_action': return ['notification-action', String(Math.max(1, Math.round(Number(a.index) || 1))), String(a.value ?? '')];
    case 'dismiss_all_notifications': return ['dismiss-all-notifications', ...app];
    case 'open_surface': return ['open-system-surface', '--surface', String(a.surface ?? '')];
    case 'find': return ['find', ...app, ...(a.text ? ['--text', String(a.text)] : []), ...(a.role ? ['--role', String(a.role)] : []), ...(a.element ? ['--name', String(a.element)] : [])];
    case 'get': return ['get', ref, '--property', String(a.property || 'text')];
    case 'is': return ['is', ref, '--property', String(a.property || 'visible')];
    case 'windows': return ['list-windows', ...app];
    case 'apps': return ['list-apps', ...app];
    case 'notifications': return ['list-notifications', ...app, '--limit', '20'];
    case 'set_value': return ['set-value', ref, String(a.value ?? '')];
    case 'select': return ['select', ref, String(a.value ?? '')];
    case 'scroll': return ['scroll', ref, '--direction', String(a.direction || 'down'), '--amount', String(Math.max(1, Math.min(50, Number(a.amount) || 3)))];
    case 'scroll_to': return ['scroll-to', ref];
    case 'clear': case 'focus': case 'toggle': case 'check': case 'uncheck': case 'expand': case 'collapse': return [a.action, ref];
    case 'focus_window': case 'minimize': case 'maximize': case 'restore': return [a.action.replace('_', '-'), ...app];
    case 'resize_window': return ['resize-window', ...app, '--width', String(Math.round(Number(a.width))), '--height', String(Math.round(Number(a.height)))];
    case 'move_window': return ['move-window', ...app, `--x=${Math.round(Number(a.x))}`, `--y=${Math.round(Number(a.y))}`];
    case 'launch': return ['launch', String(a.app ?? ''), '--activate'];
    case 'dismiss_notification': return ['dismiss-notification', String(Math.max(1, Math.round(Number(a.index) || 1)))];
    default: return null;
  }
}

const NEEDS_CONTROL = new Set(['drill', 'click', 'double_click', 'right_click', 'type', 'hover', 'drag', 'get', 'is', 'set_value', 'select', 'scroll', 'scroll_to', 'clear', 'focus', 'toggle', 'check', 'uncheck', 'expand', 'collapse']);

/** find's answer, short: one line per control (role, name, value, state), not the JSON. */
export function describeFound(data) {
  const items = Array.isArray(data) ? data : data?.matches ?? data?.elements ?? (data ? [data] : []);
  if (!items.length) return 'nothing matched';
  return items.slice(0, 30).map((m, i) => `${i + 1}. ${m.role ?? 'control'} "${m.name ?? m.title ?? ''}"${m.value != null && m.value !== '' ? ` = ${String(m.value).slice(0, 80)}` : ''}${m.enabled === false ? ' (disabled)' : ''}`).join('\n') + (items.length > 30 ? `\n…and ${items.length - 30} more` : '');
}

/**
 * The desktop hand is a pinned agent-desktop release. Rather than send the person off
 * to install it, ox asks once and fetches it itself: the exact version, refused unless
 * its SHA-256 matches the published one, unpacked into ~/.ox/vendor, nothing run.
 */
async function installOnFirstUse(A, ctx) {
  const env = ctx.env ?? process.env;
  const manual = 'desktop needs agent-desktop: ox desktop install (then give it Accessibility / screen access when the OS asks)';
  const key = `${process.platform}-${process.arch}`;
  if (!A.AGENT_DESKTOP_FILES[key]) return { ok: false, why: `desktop control has no build for ${process.platform} ${process.arch}` };
  if (env.NODE_TEST_CONTEXT && !env.OX_TEST_DESKTOP_INSTALL) return { ok: false, why: manual };
  if (typeof ctx.requestApproval !== 'function') return { ok: false, why: manual };
  // -y with an approver that cannot be made to ask would say yes to a download unread.
  if (ctx.yolo && !ctx.requestApproval.honorsForce) return { ok: false, why: manual };
  const what = `Download agent-desktop ${A.AGENT_DESKTOP_VERSION} (the desktop hand ox uses on ${process.platform}) from github.com/vercel-labs/agent-desktop into ~/.ox/vendor. The file is checked against its pinned SHA-256 and nothing runs until you use the desktop.`;
  const yes = await ctx.requestApproval('desktop_install', { version: A.AGENT_DESKTOP_VERSION }, what, { force: true });
  if (!yes) return { ok: false, why: `declined: ${manual}` };
  try {
    await (ctx.installAgentDesktop ?? A.installAgentDesktop)({ env });
  } catch (e) {
    return { ok: false, why: `could not install agent-desktop: ${e?.message ?? e}` };
  }
  return A.available(env) ? { ok: true } : { ok: false, why: 'agent-desktop was installed but is not where ox looks; run ox desktop install' };
}

export async function desktop(args = {}, ctx = {}) {
  const A = await import('../agent-desktop.js');
  if (!A.available(ctx.env ?? process.env)) {
    const got = await installOnFirstUse(A, ctx);
    if (!got.ok) return err(got.why);
  }
  const a = { ...args, action: String(args.action ?? '') };
  if (![...DESKTOP_READS, ...DESKTOP_ACTS].includes(a.action)) return err(`desktop: action is one of ${[...DESKTOP_READS, ...DESKTOP_ACTS].join(', ')}`);
  if (a.action === 'launch' && !a.app) return err('launch: which app?');
  if (a.action === 'resize_window' && !(Number(a.width) > 0 && Number(a.height) > 0)) return err('resize_window: width and height are needed');
  if (a.action === 'move_window' && !(Number.isFinite(Number(a.x)) && Number.isFinite(Number(a.y)))) return err('move_window: x and y are needed');
  // A line break would press Return unasked: press_key does that, where it is asked for.
  if (a.action === 'type' && /[\r\n]/.test(String(a.text ?? ''))) return err('type: a line break would press Return unasked. Type the text without it, then use press_key return.');
  if (a.action === 'notification_action' && isPayment({ name: a.value })) return err(`ox does not press "${a.value}" on a notification: it spends money. It is left for you.`);
  if (a.action === 'screenshot') { a.path = path.join(os.tmpdir(), `ox-desktop-${process.pid}-${Date.now()}.png`); }
  const scope = await A.desktopScope(ctx);
  let ref = null, label = a.app || 'the app in front', risky = a.action === 'notification_action' && macControl.isRisky({ name: a.value });
  if (NEEDS_CONTROL.has(a.action)) {
    const t = await target(A, a, { scope, env: ctx.env ?? process.env });
    if (t.error) return err(t.error);
    ref = t.el.ref; label = `${t.el.role} "${t.el.name || t.el.description || ''}"`;
    risky = risky || macControl.isRisky(t.el);
    if (a.action === 'drag') {
      const d = await target(A, { app: a.app, element: a.to }, { scope, env: ctx.env ?? process.env });
      if (d.error) return err(`drag: ${d.error}`);
      a.toRef = d.el.ref;
    }
  }
  if (DESKTOP_ACTS.includes(a.action)) {
    const g = await gate(ctx, { tool: 'desktop', app: a.app ?? null, force: risky, what: `${a.action.replace('_', ' ')} ${label}${a.value != null ? ` → "${String(a.value).slice(0, 60)}"` : ''}${risky ? ': this can send or delete, and may not be undone' : ''}?`, args: { action: a.action, element: a.element ?? null } });
    if (!g.ok) return { content: g.content, isError: true };
  }
  const cmd = commandFor(a, ref);
  const r = await A.run(cmd, { env: ctx.env ?? process.env, scope, timeoutMs: a.action === 'wait' ? 20_000 : 15_000 });
  if (!r.ok) {
    if (/session/i.test(String(r.error?.code ?? ''))) A.forgetDesktopSession();
    return err(`${a.action}: ${why(r)}`);
  }
  if (a.action === 'map' || a.action === 'drill') return { content: describeTree(r.data?.tree) };
  if (a.action === 'screenshot') return { content: `saved: ${a.path}` };
  if (a.action === 'clipboard_get') return { content: JSON.stringify(r.data).slice(0, 4000) };
  if (a.action === 'find') return { content: describeFound(r.data) };
  if (a.action === 'get' || a.action === 'is') return { content: `${label} ${a.property || (a.action === 'get' ? 'text' : 'visible')}: ${JSON.stringify(r.data?.value ?? r.data)}` };
  if (DESKTOP_READS.includes(a.action)) return { content: JSON.stringify(r.data).slice(0, 4000) };
  return { content: `done: ${a.action.replace('_', ' ')} ${label}` };
}
