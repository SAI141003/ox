// Persistent goals: an objective that stays ACTIVE across turn boundaries,
// compaction and session resume, together with the evidence that says whether
// it is actually finished.
//
// What already existed and what this adds. `goalContract` (src/agent.js) is a
// PER-CALL verification contract: five fields drafted by an aux model, handed to
// runAgent for one invocation, rendered into the prompt as `## GOAL CONTRACT`,
// and then gone. Nothing writes it anywhere, so it dies with the process and
// with the turn. It answers "how will this turn be judged", never "what are we
// still working toward".
//
// The goal record closes that gap WITHOUT a second store: it is an event in the
// append-only session transcript (`{t:'goal', ...}`), recovered by the same
// `loadSessionWithStatus` read that replays messages. That is deliberate. A
// separate file would be a second source of truth that could disagree with the
// transcript, and clearing the goal would have to clean up two places.
//
// Two rules carry the honesty of this module, and everything else is plumbing:
//
//   1. A claim is not evidence. `todo_write` says `completed`; the transcript
//      decides. An item with no supporting tool call stays UNVERIFIED and can
//      never satisfy the goal. Assistant prose is explicitly NOT evidence --
//      "done" written by the model is exactly the decorative completion this
//      feature exists to make impossible.
//   2. Reaching a limit is not succeeding. `noteGoalStop` records a stop reason
//      and keeps the goal ACTIVE. `--max-cost` cutting a run short says nothing
//      about whether the work got done.
//
// Persistence is a memory surface, so the SAME screen applies as for memory
// (screenPersistText on write, screenReadLines on read). A goal is user/model
// text written to disk and re-injected into every prompt forever; a credential
// in one must never be stored, and never replayed.

import { screenPersistText, screenReadLines } from './memory.js';

export const GOAL_STATUS = Object.freeze({
  ACTIVE: 'active',
  PAUSED: 'paused',
  DONE: 'done',
  CLEARED: 'cleared',
});

export const GOAL_READ_SOURCE = 'session goal resume';

const MAX_OBJECTIVE = 400;
const MAX_ITEMS = 40;
const MAX_ITEM = 200;
const MAX_EVIDENCE = 160;

// Items whose only salient word is this one are still checked, but a match must
// cover every salient token. A checklist of "fix it" must not report 100%:
// `fix` and `it` are both dropped, leaving zero tokens and therefore no evidence.
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'by', 'is',
  'are', 'be', 'do', 'does', 'did', 'it', 'its', 'that', 'this', 'then', 'so',
  'add', 'adds', 'make', 'makes', 'run', 'runs', 'use', 'using', 'get', 'gets',
  'new', 'one', 'all', 'any', 'into', 'from', 'at', 'as', 'but', 'not', 'can',
  'will', 'should', 'would', 'there', 'their', 'them', 'they', 'we', 'you',
  'have', 'has', 'had', 'been', 'was', 'were', 'fix', 'fails', 'failed',
  'write', 'writes', 'create', 'creates', 'update', 'updates', 'implement',
  'remove', 'removes', 'delete', 'document', 'documents', 'refactor', 'migrate',
  'rename', 'move', 'convert', 'generate', 'extract', 'replace', 'ensure',
  'ensures', 'full', 'whole', 'suite', 'every', 'clean', 'properly', 'finally',
  'wire', 'hook', 'hooks', 'support', 'supports', 'handle', 'handles', 'keep',
  'keeps', 'left', 'need', 'needs', 'should',
]);

// Reading is not doing. A read-only tool cannot demonstrate that an item is
// COMPLETE, so neither its call nor its output is evidence. `todo_write` is in
// this set for a sharper reason: its result echoes the checklist back, which
// would let the model's own claim prove itself.
const READ_ONLY_EVIDENCE = new Set(['read_file', 'list_dir', 'glob', 'grep', 'todo_write', 'todo_read']);

// The model controls `status` but never controls `proven`. `proven` is set only
// by proveGoalItems, which needs a transcript hit.
const ITEM_STATUSES = new Set(['pending', 'in_progress', 'blocked', 'completed']);

function nowIso() {
  return new Date().toISOString();
}

function shortId(seed) {
  let h = 5381;
  const s = String(seed ?? '');
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16).padStart(8, '0').slice(0, 8);
}

export function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const content = String(raw.content ?? '').trim().slice(0, MAX_ITEM);
  if (!content) return null;
  const status = ITEM_STATUSES.has(raw.status) ? raw.status : 'pending';
  const item = { content, status };
  if (status === 'blocked') {
    item.blockedReason = String(raw.blockedReason ?? raw.reason ?? '').trim().slice(0, MAX_ITEM) || 'no reason given';
  }
  // `proven`/`evidence` survive a round trip so a resume does not have to
  // re-derive them; proveGoalItems overwrites both on the next check.
  if (raw.proven === true) item.proven = true;
  if (typeof raw.evidence === 'string' && raw.evidence.trim()) {
    item.evidence = raw.evidence.trim().slice(0, MAX_EVIDENCE);
  }
  return item;
}

export function normalizeItems(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const r of list) {
    const it = normalizeItem(r);
    if (it) out.push(it);
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

// Clamps an arbitrary object (typically straight off disk) into the shape the
// rest of this module can trust. A transcript is user-writable, so nothing read
// back from one is assumed to be well formed.
export function normalizeGoal(raw) {
  if (!raw || typeof raw !== 'object') return null;
  // Lifecycle helpers return `{ goal }`, not the bare record, so passing one to
  // the other used to normalize to null and write `goal: null` into the
  // transcript -- a goal that silently stopped existing. Unwrap here instead of
  // trusting every caller to remember.
  if (!raw.objective && raw.goal && typeof raw.goal === 'object') raw = raw.goal;
  const objective = String(raw.objective ?? '').trim().slice(0, MAX_OBJECTIVE);
  if (!objective) return null;
  const status = Object.values(GOAL_STATUS).includes(raw.status) ? raw.status : GOAL_STATUS.ACTIVE;
  const g = {
    v: 1,
    id: String(raw.id ?? shortId(`${objective}${raw.created ?? ''}`)),
    objective,
    status,
    items: normalizeItems(raw.items),
    created: String(raw.created ?? nowIso()),
    updated: String(raw.updated ?? raw.created ?? nowIso()),
  };
  if (raw.contract && typeof raw.contract === 'object') {
    g.contract = {
      outcome: String(raw.contract.outcome ?? '').slice(0, 400),
      verification: String(raw.contract.verification ?? '').slice(0, 400),
      constraints: String(raw.contract.constraints ?? '').slice(0, 400),
      boundaries: String(raw.contract.boundaries ?? '').slice(0, 400),
      stop_when: String(raw.contract.stop_when ?? '').slice(0, 400),
    };
  }
  if (typeof raw.stopReason === 'string' && raw.stopReason.trim()) {
    g.stopReason = raw.stopReason.trim().slice(0, 80);
  }
  if (typeof raw.stopNote === 'string' && raw.stopNote.trim()) {
    g.stopNote = raw.stopNote.trim().slice(0, 300);
  }
  if (typeof raw.completedAt === 'string') g.completedAt = raw.completedAt;
  if (typeof raw.clearedAt === 'string') g.clearedAt = raw.clearedAt;
  return g;
}

// ---- WRITE-SIDE SCREEN ------------------------------------------------------
// Refuses the same shapes memory refuses, with `store` naming the transcript the
// text would land in rather than blaming .agent/MEMORY.md. Called BEFORE the
// record exists, so a refusal leaves no goal anywhere.
export function screenGoalObjective(objective, store = 'the session transcript') {
  return screenPersistText(objective, 'goal objective', store);
}

// ---- construction / lifecycle ----------------------------------------------

export function createGoal({ objective, items = [], contract = null, store = 'the session transcript', now = nowIso() } = {}) {
  const text = String(objective ?? '').trim();
  if (!text) return { refusal: 'usage: /goal <text> — the objective is the sentence you want kept active' };
  const refusal = screenGoalObjective(text, store);
  if (refusal) return { refusal };
  const clipped = text.slice(0, MAX_OBJECTIVE);
  return {
    goal: normalizeGoal({
      v: 1,
      id: shortId(`${clipped}${now}`),
      objective: clipped,
      status: GOAL_STATUS.ACTIVE,
      items: normalizeItems(items),
      contract,
      created: now,
      updated: now,
    }),
  };
}

export function pauseGoal(goal, now = nowIso()) {
  const g = normalizeGoal(goal);
  if (!g) return { refusal: 'no active goal — set one with /goal <text>' };
  if (g.status === GOAL_STATUS.DONE) return { refusal: 'goal is already complete — /goal clear to remove it' };
  if (g.status === GOAL_STATUS.CLEARED) return { refusal: 'goal was cleared — /goal <text> to set a new one' };
  if (g.status === GOAL_STATUS.PAUSED) return { goal: g, note: 'goal is already paused' };
  const next = { ...g, status: GOAL_STATUS.PAUSED, updated: now };
  delete next.stopReason;
  delete next.stopNote;
  return { goal: next };
}

export function resumeGoal(goal, now = nowIso()) {
  const g = normalizeGoal(goal);
  if (!g) return { refusal: 'no goal to resume — set one with /goal <text>' };
  if (g.status === GOAL_STATUS.ACTIVE) return { goal: g, note: 'goal is already active' };
  if (g.status === GOAL_STATUS.DONE) {
    return {
      refusal: `goal is COMPLETE and does not resume: ${g.objective} (/goal clear to remove it, /goal <text> for a new one)`,
    };
  }
  if (g.status === GOAL_STATUS.CLEARED) return { refusal: 'goal was cleared — /goal <text> to set a new one' };
  return { goal: { ...g, status: GOAL_STATUS.ACTIVE, updated: now, resumedAt: now } };
}

export function clearGoal(goal, now = nowIso()) {
  const g = normalizeGoal(goal);
  if (!g) return { refusal: 'no goal to clear' };
  return { goal: { ...g, status: GOAL_STATUS.CLEARED, updated: now, clearedAt: now } };
}

// A budget/limit stop is NOT a completion. The goal stays ACTIVE and records why
// the run ended, because "we hit the cap" and "we finished" are different facts
// and the checklist is what tells them apart.
export function noteGoalStop(goal, reason, note = '', now = nowIso()) {
  const g = normalizeGoal(goal);
  if (!g) return { goal: null };
  if (g.status !== GOAL_STATUS.ACTIVE) return { goal: g };
  return {
    goal: {
      ...g,
      status: GOAL_STATUS.ACTIVE,
      updated: now,
      stopReason: String(reason ?? 'stopped').trim().slice(0, 80),
      stopNote: String(note ?? '').trim().slice(0, 300),
    },
  };
}

// ---- evidence ---------------------------------------------------------------
// Assistant text is NOT evidence. The model saying "that is done" is the exact
// failure this feature closes, so only tool calls and tool results count, and
// read-only tools do not count at all.
//
// A tool message usually carries no `name`, so the producing call is resolved by
// id; without that a `read_file` result would look like anonymous work.
export function harvestEvidence(messages) {
  const out = [];
  const nameByCall = new Map();
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || typeof m !== 'object' || m.role === 'system') continue;
    for (const c of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
      const name = String(c?.function?.name ?? '?');
      const args = String(c?.function?.arguments ?? '');
      if (c?.id != null) nameByCall.set(String(c.id), name);
      if (READ_ONLY_EVIDENCE.has(name)) continue;
      out.push({ kind: 'call', name, text: `${name}(${args})` });
    }
    if (m.role === 'tool') {
      const name = String(m.name ?? nameByCall.get(String(m.tool_call_id ?? '')) ?? '');
      if (READ_ONLY_EVIDENCE.has(name)) continue;
      out.push({ kind: 'result', name, text: String(m.content ?? '') });
    }
  }
  return out;
}

// A passing shell quality gate is a real run with a real exit code, so it counts
// as evidence on the same footing as a tool call. Only PASSING gates; a failed
// gate is evidence that the item is NOT done.
export function evidenceFromGates(gates) {
  const rows = gates instanceof Map ? [...gates.entries()] : Array.isArray(gates) ? gates : [];
  const out = [];
  for (const [cmd, st] of rows) {
    if (st && st.ok === true) out.push({ kind: 'gate', name: String(cmd), text: `gate ${cmd} exit ${st.exit ?? 0}` });
  }
  return out;
}

// How many of an item's tokens one evidence entry has to cover: at least half,
// rounded up, and never zero. Half rather than all because the tokenizer is a
// heuristic -- demanding every token would make `/goal done` unreachable on
// ordinary phrasings, and an unreachable completion is its own kind of lie. The
// floor of 1 plus the prose/read-only exclusions are what keep this from
// degrading into "any tool call proves anything".
export function requiredCoverage(tokens) {
  return tokens.length <= 2 ? 1 : Math.ceil(tokens.length / 2);
}

// Salient words of an item, lowercased. A match must cover EVERY one of them, so
// a long item cannot be "proven" by a call that happens to mention one word.
// `tests` in a checklist item must match a `node test/x.test.js` tool call, so a
// trailing plural is stemmed. Skipped for -ss endings so `class` stays `class`.
// The failure direction stays safe either way: a token that matches nothing leaves
// the item UNVERIFIED, which only ever blocks completion.
function stemToken(word) {
  return word.length >= 5 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word;
}

export function salientTokens(content) {
  const raw = String(content ?? '').toLowerCase().match(/[a-z0-9_]+/g) ?? [];
  return [...new Set(raw.filter((w) => w.length >= 4 && !STOPWORDS.has(w)).map(stemToken))];
}

function evidenceHit(item, evidence) {
  const tokens = salientTokens(item.content);
  if (!tokens.length) return null;
  const need = requiredCoverage(tokens);
  let best = null;
  for (const ev of evidence) {
    if (!ev || ev.kind === 'text') continue; // prose is never proof
    const hay = String(ev.text ?? '').toLowerCase();
    if (!hay) continue;
    let hits = 0;
    for (const t of tokens) if (hay.includes(t)) hits += 1;
    if (hits < need) continue;
    const score = hits / tokens.length;
    if (!best || score > best.score) best = { score, ev };
  }
  return best?.ev ?? null;
}

// Recomputes `proven` for every item from the transcript. A completed item with no
// transcript hit becomes UNVERIFIED: the claim is kept (so the model can see what
// it thinks it did) but it no longer counts toward satisfaction.
//
// Evidence observed EARLIER still stands. Compaction summarises the tool calls out
// of the loop's history, so a re-proof over the compacted window would un-prove work
// that genuinely happened -- the goal would walk backwards every time the context
// filled up. The stored `evidence` string is the receipt, it survives in the
// transcript, and it can only exist because proveGoalItems already saw a real
// transcript hit: nothing the model writes can forge one, because `evidence` is
// never read from a tool argument or from the checklist itself.
export function proveGoalItems(goal, evidence = []) {
  const g = normalizeGoal(goal);
  if (!g) return null;
  const list = Array.isArray(evidence) ? evidence : [];
  const items = g.items.map((it) => {
    if (it.status !== 'completed') return { ...it, proven: false };
    const hit = evidenceHit(it, list);
    if (hit) return { ...it, proven: true, evidence: String(hit.text).slice(0, MAX_EVIDENCE) };
    if (typeof it.evidence === 'string' && it.evidence.trim()) {
      return { content: it.content, status: it.status, proven: true, evidence: it.evidence.trim().slice(0, MAX_EVIDENCE) };
    }
    const next = { content: it.content, status: it.status };
    if (it.blockedReason) next.blockedReason = it.blockedReason;
    return { ...next, unverified: true };
  });
  return { ...g, items };
}

export function goalProgress(goal) {
  const g = normalizeGoal(goal);
  if (!g) return null;
  const items = g.items ?? [];
  const done = items.filter((i) => i.status === 'completed' && i.proven === true);
  const unverified = items.filter((i) => i.status === 'completed' && i.proven !== true);
  const blocked = items.filter((i) => i.status === 'blocked');
  const pending = items.filter((i) => i.status !== 'completed' && i.status !== 'blocked');
  return {
    total: items.length,
    done: done.length,
    unverified: unverified.length,
    blocked: blocked.length,
    pending: pending.length,
    items,
    // No checklist means nothing has been proven. Reporting 100% for an empty
    // list is the "looks finished, is not" bug.
    satisfied: items.length > 0 && done.length === items.length,
  };
}

// Completion is refused unless every item is PROVEN. The refusal names the items,
// so the user learns which one to go and do.
export function completeGoal(goal, evidence = [], now = nowIso()) {
  const g = normalizeGoal(goal);
  if (!g) return { refusal: 'no active goal — /goal <text> to set one' };
  if (g.status === GOAL_STATUS.DONE) return { refusal: 'goal is already complete' };
  if (g.status === GOAL_STATUS.CLEARED) return { refusal: 'goal was cleared — /goal <text> to set a new one' };
  if (g.status === GOAL_STATUS.PAUSED) {
    return { refusal: `goal is PAUSED — /goal resume to pursue it again (${g.objective})` };
  }
  const proven = proveGoalItems(g, evidence);
  const p = goalProgress(proven);
  if (!p.satisfied) {
    const unmet = [];
    if (!p.total) unmet.push('(no checklist items yet — nothing has been proven)');
    for (const it of p.items) {
      if (it.status === 'completed' && it.proven !== true) {
        unmet.push(`${it.content} — claimed complete, NO evidence in the transcript`);
      } else if (it.status === 'blocked') {
        unmet.push(`${it.content} — BLOCKED${it.blockedReason ? `: ${it.blockedReason}` : ''}`);
      } else if (it.status !== 'completed') {
        unmet.push(`${it.content} — ${it.status}`);
      }
    }
    return {
      refusal: `refusing to mark the goal complete: ${p.done}/${p.total} items proven done`,
      unmet,
      goal: proven,
    };
  }
  return { goal: { ...proven, status: GOAL_STATUS.DONE, completedAt: now, updated: now } };
}

// The model's checklist (todo_write) IS the goal checklist — one mechanism, not
// two. Preserves `proven`/`evidence` for items whose text did not change.
export function syncGoalItems(goal, todos) {
  const g = normalizeGoal(goal);
  if (!g) return null;
  const list = normalizeItems(todos);
  const prior = new Map(g.items.map((i) => [i.content, i]));
  const items = list.map((it) => {
    const old = prior.get(it.content);
    if (!old) return it;
    const next = { ...it };
    if (old.proven === true) next.proven = true;
    if (old.evidence) next.evidence = old.evidence;
    return next;
  });
  return { ...g, items };
}

// The single merge entry point. A todo list that was never published this process
// is NOT adopted: `ctx.sessionState.todos` starts as `[]`, and merging that would
// silently erase a checklist recovered from the transcript on every resume.
export function mergeGoalTodos(goal, sessionState) {
  const g = normalizeGoal(goal);
  if (!g) return null;
  const st = sessionState && typeof sessionState === 'object' ? sessionState : null;
  if (!st || st.todosPublished !== true) return g;
  return syncGoalItems(g, st.todos);
}

// Progress fingerprint for "did anything change?", so a turn that changed nothing
// appends nothing. Without this, every turn would write a transcript event.
export function progressSignature(goal) {
  const g = normalizeGoal(goal);
  if (!g) return '';
  const items = (g.items ?? []).map((i) => `${i.content}|${i.status}|${i.proven === true ? 1 : 0}`).join('\n');
  return `${g.status}\u0000${items}`;
}

// ---- transcript events ------------------------------------------------------

export function goalEvent(goal, action = 'set') {
  return { t: 'goal', action: String(action ?? 'set'), at: nowIso(), goal: normalizeGoal(goal) };
}

// Last goal event wins. A DONE or CLEARED goal is terminal and returns NO active
// goal, which is what stops a completed goal resurrecting on resume.
export function goalFromEvents(events) {
  let last = null;
  for (const ev of Array.isArray(events) ? events : []) {
    if (ev && ev.t === 'goal' && ev.goal) last = ev;
  }
  if (!last) return { goal: null, terminal: null, withheld: 0 };
  const rec = normalizeGoal(last.goal);
  if (!rec) return { goal: null, terminal: null, withheld: 0 };
  // READ-SIDE SCREEN. The write screen only covers goals written after it
  // shipped, so a goal carrying a credential can still be sitting in an old or
  // hand-edited transcript. Fail closed: withhold the whole goal rather than
  // replay one field of it, because the objective IS the thing re-injected.
  const { withheld } = screenReadLines(
    [rec.objective, ...rec.items.map((i) => `${i.content}${i.blockedReason ? ` ${i.blockedReason}` : ''}`)],
    GOAL_READ_SOURCE,
    'session goal resume'
  );
  if (withheld > 0) {
    return {
      goal: null,
      terminal: { status: 'withheld', objective: '(withheld by the read screen)', withheld },
      withheld,
    };
  }
  if (rec.status === GOAL_STATUS.DONE) {
    return {
      goal: null,
      terminal: {
        status: GOAL_STATUS.DONE,
        objective: rec.objective,
        at: rec.completedAt ?? rec.updated,
        items: rec.items,
      },
      withheld: 0,
    };
  }
  if (rec.status === GOAL_STATUS.CLEARED) {
    return {
      goal: null,
      terminal: { status: GOAL_STATUS.CLEARED, objective: rec.objective, at: rec.clearedAt ?? rec.updated },
      withheld: 0,
    };
  }
  return { goal: rec, terminal: null, withheld: 0 };
}

// ---- rendering --------------------------------------------------------------

const MARK = { completed: '[x]', blocked: '[!]', in_progress: '[-]', pending: '[ ]' };

// The top-of-turn block. Placed in the same prompt layer as the goal contract
// (above MEMORY), so the objective is in front of the model on every single call
// and is not something a compaction summary can paraphrase away.
export function renderGoalBlock(goal) {
  const g = normalizeGoal(goal);
  if (!g) return '';
  const p = goalProgress(g);
  const lines = [
    '## ACTIVE GOAL (persistent: survives compaction and session resume)',
    `objective: ${g.objective}`,
  ];
  if (g.status === GOAL_STATUS.PAUSED) {
    lines.push('status: PAUSED — do not pursue this until the user resumes it');
  } else {
    lines.push('status: active');
  }
  lines.push(
    `progress: ${p.done}/${p.total} items proven done` +
      (p.unverified ? ` · ${p.unverified} claimed complete with NO evidence` : '') +
      (p.blocked ? ` · ${p.blocked} blocked` : '') +
      (p.pending ? ` · ${p.pending} pending` : '')
  );
  if (g.stopReason) {
    lines.push(
      `last stop: ${g.stopReason}${g.stopNote ? ` — ${g.stopNote}` : ''} · THE GOAL IS STILL ACTIVE: stopping is not finishing.`
    );
  }
  lines.push('checklist:');
  if (!p.total) lines.push('  [ ] (empty — write the checklist with todo_write before claiming anything)');
  for (const it of p.items) {
    const mark = it.status === 'completed' && it.proven !== true ? '[?]' : MARK[it.status] ?? '[ ]';
    let note = '';
    if (it.status === 'completed') {
      note = it.proven ? ` — evidence: ${it.evidence}` : ' — UNVERIFIED: claimed complete, no supporting tool call in the transcript';
    } else if (it.status === 'blocked') {
      note = ` — BLOCKED${it.blockedReason ? `: ${it.blockedReason}` : ''}`;
    }
    lines.push(`  ${mark} ${it.content}${note}`);
  }
  lines.push(
    'rules: keep this checklist current with todo_write; mark an item completed only AFTER real work in the transcript demonstrates it (a passing gate counts); never mark anything done to end a session early.'
  );
  return lines.join('\n');
}

// Human-facing `/goal` report. Says what is left, not a percentage.
export function renderGoalReport(goal, { terminal = null } = {}) {
  if (!goal) {
    if (terminal) {
      if (terminal.status === 'withheld') {
        return [
          `✗ goal withheld by the read screen (${terminal.withheld} field(s), credential or injection shape)`,
          '  the transcript file is UNCHANGED — inspect and remove the offending text yourself.',
        ].join('\n');
      }
      if (terminal.status === GOAL_STATUS.DONE) {
        const left = (terminal.items ?? []).filter((i) => i.status !== 'completed' || i.proven !== true);
        const caveat = left.length
          ? `  ⚠ this goal was marked complete but ${left.length} item(s) were not proven: ${left.map((i) => i.content).join('; ')}`
          : null;
        return [
          `✓ previous goal complete — ${terminal.objective}${terminal.at ? ` (${terminal.at})` : ''}`,
          '  a completed goal does not resume. /goal <text> to set a new one.',
          caveat,
        ]
          .filter(Boolean)
          .join('\n');
      }
      return `· previous goal cleared — ${terminal.objective}. /goal <text> to set a new one.`;
    }
    return 'no goal set — usage: /goal <text> | /goal done | /goal pause | /goal resume | /goal clear';
  }
  const p = goalProgress(goal);
  const head =
    goal.status === GOAL_STATUS.PAUSED
      ? `◼ goal PAUSED — ${goal.objective}`
      : goal.status === GOAL_STATUS.DONE
        ? `✓ goal complete — ${goal.objective}`
        : `● goal active — ${goal.objective}`;
  const lines = [head];
  lines.push(
    `  progress: ${p.done}/${p.total} proven done${p.blocked ? ` · ${p.blocked} blocked` : ''}${p.unverified ? ` · ${p.unverified} unverified` : ''}${p.pending ? ` · ${p.pending} pending` : ''}`
  );
  if (goal.stopReason) {
    lines.push(
      `  last stop: ${goal.stopReason}${goal.stopNote ? ` — ${goal.stopNote}` : ''} · still ACTIVE (a limit reached is not completion)`
    );
  }
  if (!p.total) lines.push('  checklist: empty — nothing is proven yet');
  for (const it of p.items) {
    const mark = it.status === 'completed' && it.proven !== true ? '[?]' : MARK[it.status] ?? '[ ]';
    let note = '';
    if (it.status === 'completed') {
      note = it.proven ? `  (evidence: ${it.evidence})` : '  (UNVERIFIED — no supporting tool call)';
    } else if (it.status === 'blocked') {
      note = `  (BLOCKED${it.blockedReason ? `: ${it.blockedReason}` : ''})`;
    }
    lines.push(`  ${mark} ${it.content}${note}`);
  }
  return lines.join('\n');
}

export function renderCompletionRefusal(result) {
  const lines = [`✗ ${result.refusal}`];
  for (const u of result.unmet ?? []) lines.push(`  · ${u}`);
  return lines.join('\n');
}
