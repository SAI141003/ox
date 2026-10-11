// The CANCEL wording, from the module that owns it. Imported rather than
// re-typed here because `/agents` is where an operator decides whether to trust
// a cancel, and a renderer free to re-word it is how that screen ends up
// promising more than src/subagent-control.js delivers. The chain
// ui.js -> subagent-control.js -> agent-teams.js -> memory.js is one-way:
// none of those import ui.js.
import { CANCEL_SEMANTICS as CANCEL_SEMANTICS_REF } from './subagent-control.js';

function colorsEnabled() {
  return Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
}

function wrap(open, close, str) {
  const text = String(str ?? '');
  if (!colorsEnabled()) return text;
  return `\x1b[${open}m${text}\x1b[${close}m`;
}

export const c = {
  dim: (s) => wrap(2, 22, s),
  s: (s) => String(s ?? ''),
  green: (s) => wrap(32, 39, s),
  yellow: (s) => wrap(33, 39, s),
  red: (s) => wrap(31, 39, s),
  cyan: (s) => wrap(36, 39, s),
  bold: (s) => wrap(1, 22, s),
  magenta: (s) => wrap(35, 39, s),
};

export function streamText(delta) {
  process.stdout.write(String(delta ?? ''));
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧'];
const SPINNER_INTERVAL_MS = 80;

export class Spinner {
  constructor(text = '') {
    this.text = String(text);
    this.frame = 0;
    this.timer = null;
    this.drawing = false;
  }

  draw() {
    this.drawing = true;
    process.stdout.write(`\r\x1b[2K${c.dim(SPINNER_FRAMES[this.frame])} ${this.text}`);
  }

  start() {
    if (this.timer || !process.stdout.isTTY) return this;
    this.frame = 0;
    this.draw();
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
      this.draw();
    }, SPINNER_INTERVAL_MS);
    this.timer.unref?.();
    return this;
  }

  stop(finalText = '') {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.drawing) {
      process.stdout.write('\r\x1b[2K');
      this.drawing = false;
    }
    if (finalText) process.stdout.write(`${finalText}\n`);
    return this;
  }
}

export function truncate(s, n) {
  const text = String(s ?? '');
  if (text.length <= n) return text;
  return `${text.slice(0, Math.max(n - 1, 0))}…`;
}

function firstLine(s) {
  return String(s ?? '').split('\n')[0].replace(/\r$/, '').trim();
}

export function renderDiff(diff, maxLines = 60) {
  const lines = String(diff ?? '').split('\n');
  const shown = lines.slice(0, maxLines).map((line) => {
    if (line.startsWith('+')) return c.green(line);
    if (line.startsWith('-')) return c.red(line);
    if (line.startsWith('@@')) return c.cyan(line);
    return c.dim(line);
  });
  if (lines.length > maxLines) shown.push(c.dim('[diff truncated]'));
  return shown.join('\n');
}

// `task` is checked FIRST, and it is the only ordering change: exactly one tool
// in the registry takes a `task` argument (the subagent schema in
// src/subagent.js), and for a subagent it is the only field that says what is
// being worked on. `● subagent` with nothing after it told an operator that a
// delegation happened and nothing about what it was for.
export function renderToolStart(name, args = {}) {
  const target = args?.task ?? args?.command ?? args?.path ?? args?.file_path ?? '';
  const label = target !== '' ? `: ${truncate(target, 80)}` : '';
  return c.dim(`● ${name}${label}`);
}

// The subagent lifecycle, rendered in the same dim/green/red vocabulary the
// tool lines already use so a delegation reads as part of the same stream
// rather than as a different program talking.

// 0s .. 9h, coarse on purpose: this is a "how long has this been going" glance,
// not a stopwatch, and it must not jitter by a second between two redraws of
// the same event.
export function formatElapsed(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '--';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

function oneLineText(s, n = 100) {
  return truncate(String(s ?? '').replace(/\s+/g, ' ').trim(), n);
}

// `● subagent <id>: <task>` -- the line an operator reads to learn WHAT is
// running. The id is not decoration: `/agents` and the dashboard both key on
// it, so printing it here is what makes the later lookup possible.
export function renderSubagentSpawn(ev = {}) {
  const id = String(ev.id ?? '?');
  const task = oneLineText(ev.task ?? ev.description ?? '', 100);
  return c.dim(`● subagent ${id}${task ? `: ${task}` : ''}${ev.resumed ? c.dim(' (resumed)') : ''}`);
}

// The end line carries the three facts that decide whether a delegation was
// worth it: outcome, wall time, and what it left behind. Files are named, not
// counted -- "3 files" is not actionable, "src/a.js" is.
export function renderSubagentEnd(ev = {}) {
  const id = String(ev.id ?? '?');
  // A cancelled agent gets its OWN marker and tone. It is neither the ✓ of a
  // finished run nor the ✗ of a broken one, and a green tick on a run an
  // operator stopped reads as success -- which is the specific misreport this
  // whole feature exists to avoid. src/ipc-watch.js already renders it as a
  // warning; the REPL was the surface that disagreed.
  const cancelled = ev.status === 'cancelled' || ev.cancelled === true;
  const ok = !cancelled && ev.status !== 'failed';
  const mark = cancelled ? c.yellow('⚠') : (ok ? c.green('✓') : c.red('✗'));
  const parts = [
    `${mark} subagent ${id} ${ev.status ?? 'done'}`,
    formatElapsed(Number(ev.elapsedMs) || 0),
  ];
  const files = Array.isArray(ev.filesTouched) ? ev.filesTouched.filter(Boolean) : [];
  if (files.length) parts.push(`${files.length} file${files.length === 1 ? '' : 's'}: ${oneLineText(files.join(', '), 90)}`);
  if (Number(ev.lessonsCount) > 0) parts.push(`${ev.lessonsCount} lesson${ev.lessonsCount === 1 ? '' : 's'}`);
  return c.dim(parts.join(' · '));
}

// The live count, and the "what is it doing right now" tail. This is the line
// that only appears while something is running, so its presence IS the signal.
export function renderSubagentCountLine(agents = []) {
  const n = agents.length;
  if (!n) return '';
  const head = n === 1 ? '1 subagent running' : `${n} subagents running`;
  const detail = agents
    .map((a) => {
      const tool = a.currentTool ? ` → ${a.currentTool}` : '';
      return `${a.id}${tool} (${formatElapsed(a.elapsedMs ?? 0)})`;
    })
    .join(', ');
  return c.dim(`  ${head} · ${detail}`);
}

// A ticker for the terminal surfaces. It holds the agent set, decides what is
// worth PRINTING, and hands back finished lines -- it never writes to stdout
// itself, so a test can drive the whole thing and assert on what an operator
// would have seen.
//
// The rule that keeps the stream readable: a line is printed when it CHANGES,
// never because time passed. A subagent that sits in one tool call for four
// minutes produces no output at all until something actually moves, which is
// what "a quiet agent does not spam" has to mean in a scrollback world.
export class SubagentTicker {
  constructor() {
    this.agents = new Map();
    this.lastCountLine = '';
  }

  get active() {
    return [...this.agents.values()];
  }

  countLine() {
    const line = renderSubagentCountLine(this.active);
    if (line === this.lastCountLine) return '';
    this.lastCountLine = line;
    return line;
  }

  // -> { line, count, becameEmpty, isEnd }
  apply(ev = {}) {
    const type = String(ev.type ?? '');
    const id = String(ev.id ?? '?');
    if (type === 'subagent-spawn' || type === 'subagent-start') {
      const prev = this.agents.get(id);
      // A resume re-spawns an id that is already on screen; merge rather than
      // duplicate, or the count would double for one agent.
      this.agents.set(id, {
        id,
        task: ev.task ?? prev?.task ?? '',
        phase: type === 'subagent-start' ? 'running' : 'spawned',
        currentTool: null,
        currentToolArgsPreview: '',
        startedAt: Date.now(),
        isNew: !prev,
      });
      return {
        line: type === 'subagent-start' ? '' : renderSubagentSpawn(ev),
        count: this.countLine(),
        becameEmpty: false,
        isEnd: false,
      };
    }
    if (type === 'subagent-progress') {
      const rec = this.agents.get(id);
      if (rec) {
        rec.phase = ev.phase ?? rec.phase;
        rec.currentTool = ev.currentTool ?? null;
        rec.currentToolArgsPreview = ev.currentToolArgsPreview ?? '';
        rec.iterations = ev.iterations ?? rec.iterations;
      }
      return { line: '', count: this.countLine(), becameEmpty: false, isEnd: false };
    }
    // 'subagent-cancelled' is the terminal-time cancel event, emitted right
    // after 'subagent-end' for the same agent. The end event already retired the
    // row and already printed the (now yellow) cancelled line, so this case
    // deliberately prints NOTHING: it exists so an unknown event type cannot
    // reach the default branch and so the handler is a real subscriber rather
    // than a silent drop. One line per cancelled agent, from the event that
    // carries the run's real terminal state.
    if (type === 'subagent-cancelled') {
      return { line: '', count: this.countLine(), becameEmpty: false, isEnd: false };
    }
    if (type === 'subagent-end') {
      const wasKnown = this.agents.delete(id);
      return {
        line: renderSubagentEnd(ev),
        count: this.countLine(),
        // `becameEmpty` is the clear signal: the count line stops being printed
        // and says so in words, because in a scrollback there is nothing to
        // erase and a line that merely stops updating is not a clear.
        becameEmpty: wasKnown && this.agents.size === 0,
        isEnd: true,
      };
    }
    return { line: '', count: this.countLine(), becameEmpty: false, isEnd: false };
  }
}

// ---- the /agents tree -------------------------------------------------------

// The operator list. Precedent is the `/team` plan renderer in src/cli.js: a
// bold heading, one dim line per agent, a marker for the ones that finished
// badly, and a plain sentence when there is nothing to show.
//
// The lead is the main session and it is always drawn, even when it is idle --
// "who is the lead" is half of what an operator came for, and a tree that
// starts at the first subagent does not answer it.
export function renderAgentTree({ cwd = process.cwd(), sessionId = null, model = '', snapshot = null, leadStatus = null } = {}) {
  // Imported here rather than at the top so the CANCEL wording is defined once
  // (src/subagent-control.js) and this renderer cannot re-word it into a promise
  // the rest of ox does not make.
  const CANCEL_SEMANTICS = CANCEL_SEMANTICS_REF;
  const snap = snapshot ?? { live: [], stale: [], recentFinished: [], activeCount: 0, staleCount: 0 };
  const live = Array.isArray(snap.live) ? snap.live : [];
  const stale = Array.isArray(snap.stale) ? snap.stale : [];
  const lines = [];

  const leadBits = ['lead: main session'];
  if (sessionId) leadBits.push(String(sessionId));
  if (model) leadBits.push(String(model));
  if (leadStatus) leadBits.push(String(leadStatus));
  lines.push(c.bold(`agent tree · ${cwd}`));
  lines.push(c.cyan(`◆ ${leadBits.join('  ·  ')}`));

  // "Nothing is running" is stated whenever nothing IS running -- including
  // when there is a stale descriptor below it. A stale row is not an agent, and
  // an operator reading "1 stale" with no count line above it cannot tell
  // whether one agent is working or not. Saying it is the whole point.
  if (!live.length) lines.push(c.dim('  no subagents running'));
  if (!live.length && !stale.length) return lines.join('\n');

  // Every live row carries the control hint, because a tree that shows an id but
  // not how to stop it is half an operator surface. The hint is only on the LAST
  // row: repeated on every line it is noise, and the ids are what an operator
  // copies anyway.
  live.forEach((a, i) => {
    const depth = Math.max(0, Number(a.depth) || 0);
    const indent = '  '.repeat(depth + 1);
    const tool = a.currentTool ? ` → ${a.currentTool}` : '';
    const args = a.currentToolArgsPreview ? ` ${truncate(oneLineText(a.currentToolArgsPreview, 60), 60)}` : '';
    // `cancelling` is its own visual state, not `running`. An agent mid-`bash`
    // can take seconds to come back after a cancel, and drawing it as ordinary
    // working would tell the operator their cancel did nothing.
    const cancelling = a.phase === 'cancelling' || a.cancelRequested === true;
    const mark = cancelling ? c.yellow('◐') : c.green('●');
    const phase = cancelling
      ? `cancelling by ${a.cancelBy ?? 'operator'} — ${CANCEL_SEMANTICS}`
      : (a.phase ?? 'running');
    lines.push(
      `${indent}${mark} ${c.cyan(String(a.id))} ${c.dim(oneLineText(a.task, 80))}` +
        `${c.dim(` · ${formatElapsed(a.elapsedMs ?? 0)} · ${phase}${tool}${args}`)}`
    );
    if (i === live.length - 1) {
      lines.push(`${indent}${c.dim(`  /agents cancel ${a.id}  ·  /agents steer ${a.id} <note>`)}`);
    }
  });

  // Stale descriptors are drawn, and drawn as STALE. A descriptor left behind
  // by a crashed run is a real thing an operator needs to know about -- there
  // may be half-finished work on disk -- and it is the one entry here that
  // must never be mistaken for a live agent, so it is marked, dimmed, and
  // explicitly excluded from the count above.
  for (const a of stale) {
    const indent = '  '.repeat(Math.max(0, Number(a.depth) || 0) + 1);
    lines.push(
      `${indent}${c.yellow('○')} ${c.yellow(String(a.id))} ${c.dim(oneLineText(a.task, 80))}` +
        `${c.yellow(` · STALE — ${a.staleReason ?? 'no live process'} · not working`)}`
    );
  }

  const parts = [];
  if (live.length) parts.push(`${live.length} running`);
  if (stale.length) parts.push(`${stale.length} stale`);
  // `cancelledTotal` is the number this process actually stopped. It is on the
  // tree because the first question after cancelling anything is "did that
  // work", and a count of zero next to a request is the answer.
  const cancelledTotal = Number(snap?.cancellation?.cancelledTotal) || 0;
  if (cancelledTotal) parts.push(c.yellow(`${cancelledTotal} cancelled`));
  lines.push(c.dim(`  ${parts.join(' · ')}`));
  return lines.join('\n');
}

export function renderToolEnd(name, result, isError = false) {
  const failed = Boolean(isError || (result && typeof result === 'object' && result.isError));
  const body = typeof result === 'string' ? result : String(result?.content ?? '');
  const line = firstLine(body);
  const shown = line !== '' ? truncate(line, 120) : 'done';
  if (failed) return c.red(`✗ ${shown}`);
  return c.dim(`✓ ${shown}`);
}

function fmtCount(n) {
  n = Number(n) || 0;
  const trim = (x) => x.toFixed(1).replace(/\.0$/, '');
  if (Math.abs(n) < 1_000) return String(n);
  if (Math.abs(n) < 1_000_000) return `${trim(n / 1_000)}k`;
  if (Math.abs(n) < 1_000_000_000) return `${trim(n / 1_000_000)}M`;
  return `${trim(n / 1_000_000_000)}B`;
}

export function renderMeter({ estTokens = 0, budget = 0, costUsd = null, model = '', providerName = '' } = {}) {
  const cells = 14;
  const ratio = budget > 0 ? Math.min(Math.max(Number(estTokens) / budget, 0), 1) : 0;
  const filled = Math.round(ratio * cells);
  const bar = `[${'█'.repeat(filled)}${'░'.repeat(cells - filled)}]`;
  const cost = Number.isFinite(costUsd) ? `$${Number(costUsd).toFixed(4)}` : '$0';
  return c.dim(`${bar} ${fmtCount(estTokens)}/${fmtCount(budget)} tokens · ${cost} · ${model}@${providerName}`);
}

export function renderError(e) {
  const message = e?.message ?? String(e);
  const status = e?.status != null ? ` (status ${e.status})` : '';
  return c.red(`✗ ${message}${status}`);
}

export function renderMarkdownLite(text) {
  const out = [];
  let inFence = false;
  for (const raw of String(text ?? '').split('\n')) {
    if (/^\s*```/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      out.push(c.cyan(`  ${raw}`));
      continue;
    }
    if (/^#{1,6}\s/.test(raw)) {
      out.push(c.bold(raw));
      continue;
    }
    let line = raw.replace(/\*\*(.+?)\*\*/g, (_, b) => c.bold(b));
    line = line.replace(/`([^`\n]+)`/g, (_, codeText) => c.cyan(codeText));
    out.push(line);
  }
  const rendered = out.join('\n');
  process.stdout.write(`${rendered}\n`);
  return rendered;
}
