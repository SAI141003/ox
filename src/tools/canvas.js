// `show_ui` - the model draws an OX Canvas (src/ui-lang.js) instead of
// describing data in prose: tables, charts, KPIs, diffs and buttons rendered
// in the terminal and in OX Island.
//
// The tool result the MODEL sees is deliberately tiny: a component digest and
// the exact errors, never the rendered text. That keeps the repair loop cheap
// (it re-sends only the bad lines with patch: true) and keeps the canvas'
// content from being paid for twice. The rendered view travels to the user in
// tool-end `meta.canvas`, which the REPL, headless mode and the island draw.

import { Canvas, LIBRARY, digest, languageSpec, signature } from '../ui-lang.js';

const canvases = new Map();

/** The live canvas of a session (created on first use). */
export function getCanvas(sessionId = 'default') {
  const key = String(sessionId ?? 'default');
  if (!canvases.has(key)) canvases.set(key, new Canvas());
  return canvases.get(key);
}

export function hasCanvas(sessionId = 'default') {
  return Boolean(canvases.get(String(sessionId ?? 'default'))?.source);
}

/** Query() runs real tools, but only under plan mode, so nothing it calls can write. */
export function readOnlyRunner(ctx = {}) {
  return async (tool, args) => {
    const { dispatchTool } = await import('./index.js');
    return dispatchTool(tool, args, { cwd: ctx.cwd, approval: 'plan' });
  };
}

export function canvasWidth(ctx = {}) {
  const cols = Number(ctx.termWidth ?? process.stdout.columns) || 80;
  return Math.max(40, Math.min(100, cols - 2));
}

export function canvasMeta(canvas, ev, ctx = {}) {
  const colors = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
  const r = canvas.render({ width: canvasWidth(ctx), colors });
  let tree = ev.root;
  // The island gets the tree; cap it so one canvas cannot flood the socket.
  if (tree && JSON.stringify(tree).length > 60_000) tree = null;
  return { text: r.text, actions: r.actions.map((a) => a.label), tree, errors: ev.errors.length + (ev.parseErrors?.length ?? 0) };
}

export async function showUiTool(args = {}, ctx = {}) {
  const ui = String(args.ui ?? '');
  if (!ui.trim()) return { content: 'show_ui: `ui` is empty. Send OX Canvas lines, starting with `root = …`.', isError: true };
  if (ui.trim() === '?') {
    return { content: `${languageSpec()}\nSignatures: ${Object.keys(LIBRARY).map(signature).join(' ')}` };
  }
  const canvas = getCanvas(ctx.sessionId);
  canvas.load(ui, { patch: args.patch === true });
  const ev = await canvas.refresh(readOnlyRunner(ctx));
  const errors = [...(ev.parseErrors ?? []), ...ev.errors];
  const meta = { canvas: canvasMeta(canvas, ev, ctx) };
  if (!ev.root) {
    return {
      content: `show_ui: nothing rendered.\n${errors.map(fmtError).join('\n')}\nSend the whole canvas again.`,
      isError: true,
      meta,
    };
  }
  const buttons = meta.canvas.actions.length;
  const head = `Shown to the user: ${digest(ev.root)}${buttons ? `; ${buttons} button(s) they can press` : ''}. Do not repeat its content in text.`;
  if (!errors.length) return { content: head, meta };
  return {
    content: `${head}\n${errors.length} statement(s) were dropped:\n${errors.slice(0, 12).map(fmtError).join('\n')}\nFix them: call show_ui with patch: true and only the corrected lines.`,
    meta,
  };
}

function fmtError(e) {
  return `- ${e.line ? `line ${e.line} ` : ''}${e.id ? `\`${e.id}\`: ` : ''}${e.msg}`;
}

export const CANVAS_TOOLS = ['show_ui'];

export const CANVAS_TOOL_SCHEMAS = [
  {
    name: 'show_ui',
    // Short on purpose: it rides every visual turn. The full syntax costs
    // tokens only when the model asks for it (ui: "?") or gets a line wrong,
    // and each error already carries the component's signature.
    description:
      'Show the user a live UI (tables, charts, KPIs, lists, diffs, buttons) in their terminal and notch instead of a long text answer. ' +
      'One `name = Component(args)` per line, positional args, `root = ...` renders, e.g.\n' +
      'root = Stack([k, t])\nk = Row([Stat("Tests", 412, 3), Stat("Failing", 2)])\nt = Table([Col("File", ["a.js", "b.js"]), Col("Lines", [12, 40], "number")])\n' +
      `Components: ${Object.keys(LIBRARY).join(' ')}. Send ui: "?" once for the full syntax (live Query data, buttons, $state, @builtins, patch).`,
    input_schema: {
      type: 'object',
      properties: {
        ui: { type: 'string', description: 'OX Canvas source, one statement per line.' },
        patch: { type: 'boolean', description: 'Merge into the current canvas by statement name (send only changed or new lines).' },
      },
      required: ['ui'],
    },
  },
];

// Turns where a visual answer is likely. Whole-word, prefix-matched >= 5 chars.
export const CANVAS_KEYWORDS = Object.freeze([
  'show', 'display', 'visualize', 'visualise', 'chart', 'charts', 'graph', 'plot',
  'table', 'tables', 'dashboard', 'dashboards', 'compare', 'comparison', 'summary',
  'summarize', 'overview', 'report', 'stats', 'statistics', 'metrics', 'breakdown',
  'canvas', 'widget', 'ui', 'kpi', 'status', 'progress', 'list', 'diff',
]);
