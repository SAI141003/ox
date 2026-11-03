// desktop: the rest of agent-desktop (vercel-labs/agent-desktop, Apache-2.0)
// as one tool, beside ui_elements / click / type_text / press_key.
//
// Reads (no approval): find a control by name, role or text instead of reading
// the whole window (the cheapest way to see an app), read a control's text,
// value or state, list windows, apps and notifications.
// Acts (ask first, like every ox action): set a value, clear, focus, pick an
// option, tick or untick, expand or collapse, scroll, bring a window forward,
// resize, move, minimise, maximise or restore it, open an app, dismiss a
// notification. ox's rules stay on top: a control that sends, pays or deletes
// is never touched; quitting apps and physical mouse input are not offered.
import * as macControl from '../mac-control.js';

export const DESKTOP_READS = Object.freeze(['find', 'get', 'is', 'windows', 'apps', 'notifications']);
export const DESKTOP_ACTS = Object.freeze(['set_value', 'clear', 'focus', 'select', 'toggle', 'check', 'uncheck', 'expand', 'collapse', 'scroll', 'scroll_to', 'focus_window', 'resize_window', 'move_window', 'minimize', 'maximize', 'restore', 'launch', 'dismiss_notification']);

export const DESKTOP_TOOL_SCHEMAS = Object.freeze([{
  name: 'desktop',
  description: 'Work in a desktop app through its accessibility tree (agent-desktop; no pointer moved, no focus taken). Cheapest first: action "find" with text/role returns just the matching controls; "get"/"is" read one. Acting (set_value, clear, focus, select, toggle, check, uncheck, expand, collapse, scroll, scroll_to) takes the control by name; window actions (focus_window, resize_window, move_window, minimize, maximize, restore, launch) take the app; notifications/dismiss_notification read and clear Notification Center. Never sends, pays or deletes.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [...DESKTOP_READS, ...DESKTOP_ACTS] },
      app: { type: 'string', description: 'The app, e.g. "Notes" (default: the app in front)' },
      element: { type: 'string', description: 'The control: its name or label, or its number from ui_elements' },
      role: { type: 'string', description: 'Narrow by role: button, textfield, checkbox, row, menuitem …' },
      text: { type: 'string', description: 'find: text in a control\'s name, value or label' },
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
const why = (r) => [r?.error?.message, r?.error?.suggestion].filter(Boolean).join(' ') || 'agent-desktop failed';

/** A control of the app, by name or number, refusing the ones that send, pay or delete. */
async function target(A, { app, element, role }) {
  const list = await A.listElements(app);
  if (list.error) return { error: list.error };
  const q = String(element ?? '').trim();
  if (!q) return { error: 'element is required: the control\'s name or label' };
  const el = /^\d+$/.test(q) && Number(q) <= list.elements.length ? list.elements[Number(q) - 1] : macControl.findElement(list.elements, q, role);
  if (!el) return { error: `no control called "${q}" in ${list.app}. ${macControl.describeElements({ ...list, elements: list.elements.slice(0, 40) })}` };
  if (macControl.isRisky(el)) return { error: `ox does not touch "${el.name || el.description}": that sends, pays or deletes. It is left for you.` };
  return { el };
}

/** The agent-desktop command for an action (refs filled in by the caller). */
export function commandFor(a, ref = null) {
  const app = a.app ? ['--app', String(a.app)] : [];
  switch (a.action) {
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

const NEEDS_CONTROL = new Set(['get', 'is', 'set_value', 'select', 'scroll', 'scroll_to', 'clear', 'focus', 'toggle', 'check', 'uncheck', 'expand', 'collapse']);

/** find's answer, short: one line per control (role, name, value, state), not the JSON. */
export function describeFound(data) {
  const items = Array.isArray(data) ? data : data?.matches ?? data?.elements ?? (data ? [data] : []);
  if (!items.length) return 'nothing matched';
  return items.slice(0, 30).map((m, i) => `${i + 1}. ${m.role ?? 'control'} "${m.name ?? m.title ?? ''}"${m.value != null && m.value !== '' ? ` = ${String(m.value).slice(0, 80)}` : ''}${m.enabled === false ? ' (disabled)' : ''}`).join('\n') + (items.length > 30 ? `\n…and ${items.length - 30} more` : '');
}

export async function desktop(args = {}, ctx = {}) {
  const A = await import('../agent-desktop.js');
  if (!A.available(ctx.env ?? process.env)) return err('desktop needs agent-desktop: npm install -g agent-desktop (then give it Accessibility in System Settings)');
  const a = { ...args, action: String(args.action ?? '') };
  if (![...DESKTOP_READS, ...DESKTOP_ACTS].includes(a.action)) return err(`desktop: action is one of ${[...DESKTOP_READS, ...DESKTOP_ACTS].join(', ')}`);
  if (a.action === 'launch' && !a.app) return err('launch: which app?');
  if (a.action === 'resize_window' && !(Number(a.width) > 0 && Number(a.height) > 0)) return err('resize_window: width and height are needed');
  if (a.action === 'move_window' && !(Number.isFinite(Number(a.x)) && Number.isFinite(Number(a.y)))) return err('move_window: x and y are needed');
  let ref = null, label = a.app || 'the app in front';
  if (NEEDS_CONTROL.has(a.action)) {
    const t = await target(A, a);
    if (t.error) return err(t.error);
    ref = t.el.ref; label = `${t.el.role} "${t.el.name || t.el.description || ''}"`;
  }
  if (DESKTOP_ACTS.includes(a.action) && ctx?.requestApproval) {
    const ok = await ctx.requestApproval('desktop', { action: a.action, app: a.app ?? null, element: a.element ?? null }, `${a.action.replace('_', ' ')} ${label}${a.value != null ? ` → "${String(a.value).slice(0, 60)}"` : ''}?`);
    if (!ok) return err(`declined: ${a.action} ${label}`);
  }
  const cmd = commandFor(a, ref);
  const r = await A.run(cmd, { env: ctx.env ?? process.env });
  if (!r.ok) return err(`${a.action}: ${why(r)}`);
  if (a.action === 'find') return { content: describeFound(r.data) };
  if (a.action === 'get' || a.action === 'is') return { content: `${label} ${a.property || (a.action === 'get' ? 'text' : 'visible')}: ${JSON.stringify(r.data?.value ?? r.data)}` };
  if (DESKTOP_READS.includes(a.action)) return { content: JSON.stringify(r.data).slice(0, 4000) };
  return { content: `done: ${a.action.replace('_', ' ')} ${label}` };
}
