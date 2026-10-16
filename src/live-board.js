// Who is working on what, right now (the app's Office). Every run the app
// server starts registers here, and its own events keep it current: the tool it
// is using, the file or page it is on, and each helper agent it hands work to.
// Nothing is guessed: a desk shows only what a run reported. A finished run
// stays a few seconds (marked done) so it can be seen leaving.
const runs = new Map();
const KEEP_DONE_MS = 15_000;
let seq = 0;

const clip = (s, n = 80) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

export function startRun({ who, title, kind = 'chat', model = null } = {}) {
  const id = `r${Date.now().toString(36)}${(seq++).toString(36)}`;
  runs.set(id, { id, kind, who: clip(who, 40) || 'ox', model, title: clip(title), state: 'thinking', tool: null, detail: '', started: Date.now(), updated: Date.now(), parent: null, steps: 0 });
  return id;
}

function touch(r, patch) { Object.assign(r, patch, { updated: Date.now() }); }

export function onEvent(runId, ev) {
  const r = runs.get(runId);
  if (!r || !ev || typeof ev.type !== 'string') return;
  switch (ev.type) {
    case 'tool-start': touch(r, { state: 'tool', tool: clip(ev.name, 30), detail: clip(ev.argsPreview, 70), steps: r.steps + 1 }); break;
    case 'tool-end': touch(r, { state: 'thinking', tool: null, detail: '' }); break;
    case 'text-delta': if (r.state !== 'writing') touch(r, { state: 'writing', tool: null, detail: '' }); break;
    case 'subagent-start': {
      const id = `${runId}:${ev.id}`;
      runs.set(id, { id, kind: 'helper', who: clip(ev.model, 40) || 'helper', model: ev.model ?? null, title: clip(ev.description || ev.task), state: 'thinking', tool: null, detail: '', started: Date.now(), updated: Date.now(), parent: runId, steps: 0 });
      break;
    }
    case 'subagent-progress': {
      const h = runs.get(`${runId}:${ev.id}`);
      if (h) touch(h, ev.currentTool ? { state: 'tool', tool: clip(ev.currentTool, 30), detail: clip(ev.currentToolArgsPreview, 70), steps: ev.iterations ?? h.steps } : { state: 'thinking', tool: null, detail: '' });
      break;
    }
    case 'subagent-end': case 'subagent-cancelled': {
      const h = runs.get(`${runId}:${ev.id}`);
      if (h) touch(h, { state: ev.status === 'failed' ? 'failed' : 'done', tool: null, detail: '', ended: Date.now() });
      break;
    }
    case 'error': touch(r, { state: 'failed', detail: clip(ev.error, 70) }); break;
  }
}

export function endRun(runId, { failed = false } = {}) {
  const now = Date.now();
  for (const r of runs.values()) {
    if ((r.id === runId || r.parent === runId) && !r.ended) touch(r, { state: failed || r.state === 'failed' ? 'failed' : 'done', tool: null, detail: r.state === 'failed' ? r.detail : '', ended: now });
  }
}

export function liveBoard(now = Date.now()) {
  for (const [id, r] of runs) if (r.ended && now - r.ended > KEEP_DONE_MS) runs.delete(id);
  return { at: now, runs: [...runs.values()].map((r) => ({ ...r, seconds: Math.round(((r.ended ?? now) - r.started) / 1000) })) };
}

// The broadcaster a run's ctx carries (see withIpcBroadcast in agent.js).
export function boardBroadcaster(runId) {
  const fn = (ev) => onEvent(runId, ev);
  fn.flush = () => {};
  return fn;
}
