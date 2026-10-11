// PERSISTENT GOALS -- an objective kept across turn boundaries, compaction and
// session resume, with progress PROVEN rather than claimed.
//
// The contract under test, one section per requirement:
//   1. set / show / top of the next turn's prompt
//   2. survives compaction (it is prompt state, not message state)
//   3. survives session RESUME through a real transcript round-trip
//   4. `/goal done` REFUSES while items are unproven, naming them
//   5. `/goal done` succeeds when the checklist is satisfied
//   6. pause keeps it, clear removes it, a completed goal does not resurrect
//   7. progress never claims completion without evidence (prose is not evidence)
//   8. a credential is neither persisted nor replayed (write + read screens)
//   9. a budget stop leaves the goal ACTIVE with a budget reason
//  10. clearing leaves no residue
// Plus the E2E pass through the real binary with a scripted provider.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OX_BIN = path.join(ROOT, 'bin', 'ox.js');

// HOME must move BEFORE src/config.js loads: CONFIG_DIR resolves at import time.
const HOME_SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-home-goal-'));
process.env.HOME = HOME_SANDBOX;

const { loadSessionWithStatus } = await import('../src/session.js');
const { appendEvent } = await import('../src/session.js');
const { pureCompact } = await import('../src/context.js');
const { renderGoalBlock, buildSystemPrompt } = await import('../src/system-prompt.js').then(async (m) => ({
  renderGoalBlock: (await import('../src/goal.js')).renderGoalBlock,
  buildSystemPrompt: m.buildSystemPrompt,
}));
const goal = await import('../src/goal.js');
const { createCostBudget } = await import('../src/cost.js');
const { todoWriteTool, renderTodos } = await import('../src/tools/todo.js');
const { resetMemoryScreenStats, memoryScreenStats } = await import('../src/memory.js');

after(() => fs.rmSync(HOME_SANDBOX, { recursive: true, force: true }));

// A shape the shared screen in src/memory.js matches.
const SECRET = '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';

let seq = 0;
function newSession(home = HOME_SANDBOX) {
  const dir = path.join(home, '.ox', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `20261003-00000${seq++}.jsonl`);
  fs.writeFileSync(file, `${JSON.stringify({ t: 'meta', created: new Date().toISOString(), cwd: home })}\n`);
  return { file, id: `goal${seq}` };
}

// A transcript turn that actually did something: one real tool call with a real
// result. This is what `harvestEvidence` reads.
function workedTurn(text, calls) {
  const out = [{ role: 'user', content: text }];
  for (const c of calls) {
    out.push({
      role: 'assistant',
      content: '',
      tool_calls: [{ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } }],
    });
    out.push({ role: 'tool', tool_call_id: c.id, name: c.name, content: c.content ?? 'exit 0' });
  }
  out.push({ role: 'assistant', content: c => c });
  return out.slice(0, -1).concat([{ role: 'assistant', content: 'done.' }]);
}

// ---------------------------------------------------------------- 1. set/show

test('1. /goal <text> sets it, /goal shows it, and it renders at the top of the turn', async () => {
  const made = goal.createGoal({ objective: 'land the persistent goal feature' });
  assert.equal(made.refusal, undefined);
  assert.equal(made.goal.status, 'active');

  // Progress is reported by what is PROVEN. A fresh goal has no checklist, and
  // an empty checklist is NOT 100%.
  const p0 = goal.goalProgress(made.goal);
  assert.equal(p0.total, 0);
  assert.equal(p0.satisfied, false, 'an empty checklist must never read as complete');

  const block = goal.renderGoalBlock(made.goal);
  assert.match(block, /## ACTIVE GOAL \(persistent: survives compaction and session resume\)/);
  assert.match(block, /objective: land the persistent goal feature/);
  assert.match(block, /status: active/);
  assert.match(block, /progress: 0\/0 items proven done/);

  // The report is the human view of the same record.
  assert.match(goal.renderGoalReport(made.goal), /goal active — land the persistent goal feature/);
  assert.match(goal.renderGoalReport(null), /no goal set/);

  // It reaches the model through the SAME prompt layer as the goal contract,
  // above MEMORY, so it is in front of the model on every call.
  const prompt = await buildSystemPrompt({
    cwd: ROOT,
    contractBlock: [block, '## GOAL CONTRACT\noutcome: x'].filter(Boolean).join('\n'),
  });
  assert.match(prompt, /## ACTIVE GOAL/);
  assert.ok(prompt.indexOf('## ACTIVE GOAL') < prompt.indexOf('# MEMORY'), 'goal must sit above MEMORY');
  assert.ok(prompt.indexOf('## ACTIVE GOAL') < prompt.indexOf('## GOAL CONTRACT'), 'goal leads the contract');
});

// ---------------------------------------------------------------- 2. compaction

test('2. it survives compaction -- the goal is prompt state, not message state', () => {
  const made = goal.createGoal({ objective: 'ship it' }).goal;
  const history = [
    { role: 'system', content: 'system prompt' },
    ...workedTurn('long conversation here', [
      { id: 'c1', name: 'read_file', args: { path: 'a.js' }, content: 'x' },
      { id: 'c2', name: 'bash', args: { command: 'npm test' }, content: 'exit 0' },
    ]),
    ...workedTurn('more work', [{ id: 'c3', name: 'edit_file', args: { path: 'b.js' } }]),
  ];
  const before = goal.renderGoalBlock(made);
  const { head, toSummarize, tail } = pureCompact(history, 1);
  assert.ok(toSummarize.length >= 2, 'compaction actually summarized something');

  // Compaction rewrites MESSAGES. The goal block is built fresh from the record
  // on every system-prompt rebuild, so it is byte-identical afterwards.
  const compacted = [...head, { role: 'user', content: '[summary of earlier turns]' }, ...tail];
  assert.equal(goal.renderGoalBlock(made), before);
  assert.ok(compacted.length < history.length + 1);

  // And a compaction summary cannot fabricate progress: the record still says
  // nothing is proven.
  assert.equal(goal.goalProgress(made).done, 0);
  assert.equal(goal.renderGoalBlock(made).includes('0/0 items proven done'), true);
});

test('2b. compaction does not UN-PROVE work that was already proven', () => {
  const g = goal.syncGoalItems(goal.createGoal({ objective: 'survive compaction' }).goal, [
    { content: 'edit the parser file', status: 'completed' },
    { content: 'never touched anything', status: 'completed' },
  ]);
  const before = goal.harvestEvidence([
    { role: 'assistant', content: '', tool_calls: [{ id: 'e', function: { name: 'edit_file', arguments: '{"path":"src/parser.js"}' } }] },
  ]);
  const proven = goal.proveGoalItems(g, before);
  assert.equal(goal.goalProgress(proven).done, 1);

  // Compaction summarises the tool call away. Re-proving over the COMPACTED window
  // must not walk the goal backwards for work that really happened.
  const afterCompaction = goal.proveGoalItems(proven, []);
  const p = goal.goalProgress(afterCompaction);
  assert.equal(p.done, 1, 'evidence already observed still counts');
  assert.equal(p.unverified, 1, 'the item that never had evidence stays unverified');
  assert.match(afterCompaction.items[0].evidence, /edit_file/);

  // The receipt round-trips through the transcript, so a resume keeps it too.
  const s2 = newSession();
  appendEvent(s2, goal.goalEvent(afterCompaction, 'progress'));
  assert.equal(goal.goalProgress(loadSessionWithStatus(s2.file).goal).done, 1);
});

// ---------------------------------------------------------------- 3. resume

test('3. it survives a REAL transcript round-trip (no in-memory shortcut)', () => {
  const s = newSession();
  appendEvent(s, goal.goalEvent(goal.createGoal({ objective: 'real round trip' }).goal, 'set'));
  appendEvent(s, { t: 'user', text: 'go' });
  appendEvent(s, { t: 'assistant', text: 'working' });
  appendEvent(s, { t: 'user', text: 'keep going' });

  // Re-read from DISK through the status-aware loader the resume path uses.
  const loaded = loadSessionWithStatus(s.file);
  assert.equal(loaded.status, 'ok');
  assert.ok(loaded.goal, 'the goal must come back from the transcript');
  assert.equal(loaded.goal.objective, 'real round trip');
  assert.equal(loaded.goal.status, 'active');
  assert.equal(loaded.goalTerminal, null);
});

test('3b. a goal set in one session does not appear in a different session', () => {
  const a = newSession();
  appendEvent(a, goal.goalEvent(goal.createGoal({ objective: 'only in A' }).goal, 'set'));
  const b = newSession();
  appendEvent(b, { t: 'user', text: 'nothing here' });
  assert.equal(loadSessionWithStatus(a.file).goal.objective, 'only in A');
  assert.equal(loadSessionWithStatus(b.file).goal, null, 'sessions are independent');
});

// ---------------------------------------------------------------- 4/5. done

test('4. /goal done REFUSES while items are unproven, and NAMES them', () => {
  const g = goal.syncGoalItems(goal.createGoal({ objective: 'finish the feature' }).goal, [
    { content: 'write the parser', status: 'completed' },
    { content: 'add regression tests', status: 'in_progress' },
    { content: 'update the readme', status: 'blocked', blockedReason: 'needs the release date' },
  ]);
  // Nothing was actually done, so nothing is proven.
  const res = goal.completeGoal(g, []);
  assert.equal(res.goal.status, 'active', 'a refused completion must not flip status');
  assert.match(res.refusal, /refusing to mark the goal complete: 0\/3 items proven done/);
  assert.equal(res.unmet.length, 3);
  assert.ok(res.unmet.some((u) => /write the parser — claimed complete, NO evidence/.test(u)), res.unmet.join('\n'));
  assert.ok(res.unmet.some((u) => /add regression tests — in_progress/.test(u)), res.unmet.join('\n'));
  assert.ok(res.unmet.some((u) => /update the readme — BLOCKED: needs the release date/.test(u)), res.unmet.join('\n'));
  assert.match(goal.renderCompletionRefusal(res), /✗ refusing to mark the goal complete/);
});

test('5. /goal done succeeds when every item is PROVEN by the transcript', () => {
  const g = goal.syncGoalItems(goal.createGoal({ objective: 'finish the feature' }).goal, [
    { content: 'write the parser', status: 'completed' },
    { content: 'add regression tests', status: 'completed' },
  ]);
  const evidence = goal.harvestEvidence([
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'edit_file', arguments: '{"path":"src/parser.js"}' } }] },
    { role: 'tool', tool_call_id: 'c1', name: 'edit_file', content: 'ok' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c2', function: { name: 'bash', arguments: '{"command":"npm test -- test/regression.test.js"}' } }] },
    { role: 'tool', tool_call_id: 'c2', name: 'bash', content: 'exit 0' },
  ]);
  const res = goal.completeGoal(g, evidence);
  assert.equal(res.refusal, undefined, res.refusal);
  assert.equal(res.goal.status, 'done');
  assert.ok(res.goal.completedAt);
  const p = goal.goalProgress(res.goal);
  assert.equal(p.satisfied, true);
  assert.equal(p.done, 2);
  assert.equal(p.unverified, 0);
  for (const it of res.goal.items) assert.ok(it.evidence, 'a proven item carries its evidence');
});

test('5b. an empty checklist can never be marked complete', () => {
  const res = goal.completeGoal(goal.createGoal({ objective: 'vague' }).goal, []);
  assert.match(res.refusal, /refusing to mark the goal complete: 0\/0/);
  assert.match(res.unmet.join('\n'), /nothing has been proven/);
});

// ---------------------------------------------------------------- 6. lifecycle

test('6. pause keeps the goal; resume brings it back; clear removes it', () => {
  const g = goal.createGoal({ objective: 'keep this around' }).goal;

  const paused = goal.pauseGoal(g);
  assert.equal(paused.goal.status, 'paused');
  assert.equal(paused.goal.objective, 'keep this around', 'pause KEEPS the goal');
  assert.match(goal.renderGoalBlock(paused.goal), /status: PAUSED/);

  // A paused goal cannot be completed either.
  const bad = goal.completeGoal(paused.goal, []);
  assert.match(bad.refusal, /PAUSED/);

  const back = goal.resumeGoal(paused.goal);
  assert.equal(back.goal.status, 'active');

  const cleared = goal.clearGoal(back.goal);
  assert.equal(cleared.goal.status, 'cleared');
  assert.equal(goal.resumeGoal(cleared.goal).refusal !== undefined, true);
});

test('6b. a completed goal does NOT resurrect on resume', () => {
  const s = newSession();
  const g = goal.createGoal({ objective: 'one and done' }).goal;
  appendEvent(s, goal.goalEvent(g, 'set'));
  const done = goal.completeGoal(
    goal.syncGoalItems(g, [{ content: 'write the changelog entry', status: 'completed' }]),
    goal.harvestEvidence([
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'x',
            function: {
              name: 'edit_file',
              arguments: '{"path":"CHANGELOG.md","new_string":"updated the changelog entry"}',
            },
          },
        ],
      },
    ])
  );
  appendEvent(s, goal.goalEvent(done.goal, 'done'));

  const loaded = loadSessionWithStatus(s.file);
  assert.equal(loaded.goal, null, 'a completed goal must come back as NO active goal');
  assert.equal(loaded.goalTerminal.status, 'done');
  assert.equal(loaded.goalTerminal.objective, 'one and done');
  assert.match(goal.renderGoalReport(null, { terminal: loaded.goalTerminal }), /previous goal complete/);
  assert.match(goal.renderGoalReport(null, { terminal: loaded.goalTerminal }), /does not resume/);
  assert.equal(goal.resumeGoal(done.goal).refusal !== undefined, true);
});

test('6c. a completed goal whose items were never proven is reported as such', () => {
  const g = goal.createGoal({ objective: 'claimed done' }).goal;
  const bad = { ...goal.syncGoalItems(g, [{ content: 'do the impossible', status: 'completed' }]), status: 'done' };
  const s = newSession();
  appendEvent(s, goal.goalEvent(bad, 'done'));
  const loaded = loadSessionWithStatus(s.file);
  const report = goal.renderGoalReport(null, { terminal: loaded.goalTerminal });
  assert.match(report, /1 item\(s\) were not proven: do the impossible/);
});

test('6d. a cleared goal does not resurrect either', () => {
  const s = newSession();
  appendEvent(s, goal.goalEvent(goal.createGoal({ objective: 'temporary' }).goal, 'set'));
  appendEvent(s, goal.goalEvent(goal.clearGoal(goal.createGoal({ objective: 'temporary' }).goal), 'cleared'));
  const loaded = loadSessionWithStatus(s.file);
  assert.equal(loaded.goal, null);
  assert.equal(loaded.goalTerminal.status, 'cleared');
  assert.match(goal.renderGoalReport(null, { terminal: loaded.goalTerminal }), /previous goal cleared/);
});

// ---------------------------------------------------------------- 7. evidence

test('7. progress does NOT claim completion without evidence -- prose is not proof', () => {
  const g = goal.syncGoalItems(goal.createGoal({ objective: 'no shortcuts' }).goal, [
    { content: 'update the changelog entry', status: 'completed' },
    { content: 'publish the release tag', status: 'completed' },
  ]);
  // The model SAYS both are done. Nothing ran.
  const proseOnly = goal.harvestEvidence([
    { role: 'assistant', content: 'I have updated the changelog entry and published the release tag. All done!' },
  ]);
  assert.equal(proseOnly.length, 0, 'assistant text is not evidence at all');

  const proven = goal.proveGoalItems(g, proseOnly);
  assert.equal(proven.items[0].proven, undefined);
  assert.equal(proven.items[0].unverified, true);
  const p = goal.goalProgress(proven);
  assert.equal(p.done, 0);
  assert.equal(p.unverified, 2);
  assert.equal(p.satisfied, false);
  assert.match(goal.renderGoalBlock(proven), /UNVERIFIED: claimed complete, no supporting tool call/);
  assert.match(goal.renderGoalBlock(proven), /0\/2 items proven done · 2 claimed complete with NO evidence/);

  // One real call proves only the item it actually covers.
  const partial = goal.proveGoalItems(
    g,
    goal.harvestEvidence([
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'c',
            function: {
              name: 'edit_file',
              arguments: '{"path":"CHANGELOG.md","new_string":"updated the changelog entry"}',
            },
          },
        ],
      },
    ])
  );
  const p2 = goal.goalProgress(partial);
  assert.equal(p2.done, 1);
  assert.equal(p2.unverified, 1);
  assert.equal(p2.satisfied, false);
});

test('7d. reading a file is NOT doing it -- a read-only call proves nothing', () => {
  const g = goal.syncGoalItems(goal.createGoal({ objective: 'no credit for reading' }).goal, [
    { content: 'fix the parser', status: 'completed' },
  ]);
  const readOnly = goal.harvestEvidence([
    { role: 'assistant', content: '', tool_calls: [{ id: 'r1', function: { name: 'read_file', arguments: '{"path":"src/parser.js"}' } }] },
    // The tool message carries NO name, as real provider histories do: the
    // producing call must be resolved by id or this output looks like work.
    { role: 'tool', tool_call_id: 'r1', content: 'export function parseParser() { return 1; }' },
  ]);
  assert.equal(readOnly.length, 0, 'read_file is not evidence, in either form');
  assert.equal(goal.goalProgress(goal.proveGoalItems(g, readOnly)).done, 0);

  // todo_write echoing the checklist back must not let the claim prove itself.
  const echo = goal.harvestEvidence([
    { role: 'assistant', content: '', tool_calls: [{ id: 't1', function: { name: 'todo_write', arguments: '{"todos":[{"content":"fix the parser","status":"completed"}]}' } }] },
    { role: 'tool', tool_call_id: 't1', content: '1. [x] fix the parser\n1 item(s): 1 completed' },
  ]);
  assert.equal(echo.length, 0, 'the checklist echoing itself is not evidence');
  assert.equal(goal.goalProgress(goal.proveGoalItems(g, echo)).done, 0);

  // A real edit does prove it.
  const edited = goal.harvestEvidence([
    { role: 'assistant', content: '', tool_calls: [{ id: 'e1', function: { name: 'edit_file', arguments: '{"path":"src/parser.js"}' } }] },
    { role: 'tool', tool_call_id: 'e1', name: 'edit_file', content: 'ok' },
  ]);
  assert.equal(goal.goalProgress(goal.proveGoalItems(g, edited)).done, 1);
});

test('7b. a PASSING quality gate is evidence; a failing one is not', () => {
  const g = goal.syncGoalItems(goal.createGoal({ objective: 'gates count' }).goal, [
    { content: 'npm run lint', status: 'completed' },
  ]);
  const failing = goal.proveGoalItems(g, goal.evidenceFromGates(new Map([['npm run lint', { ok: false, exit: 1 }]])));
  assert.equal(goal.goalProgress(failing).done, 0, 'a failed gate proves nothing');
  const passing = goal.proveGoalItems(g, goal.evidenceFromGates(new Map([['npm run lint', { ok: true, exit: 0 }]])));
  assert.equal(goal.goalProgress(passing).done, 1, 'a passing gate with a real exit code is evidence');

  // Coverage is a floor of one token for a one/two-token item and half (rounded
  // up) beyond that, so an unrelated call cannot prove a specific claim.
  const wide = goal.syncGoalItems(goal.createGoal({ objective: 'wide' }).goal, [
    { content: 'migrate the legacy billing reconciliation pipeline', status: 'completed' },
  ]);
  const partial = goal.evidenceFromGates(new Map([['npm run lint', { ok: true, exit: 0 }]]));
  assert.equal(goal.goalProgress(goal.proveGoalItems(wide, partial)).done, 0, 'one loose token is not proof');
});

test('7c. blocked items are counted and reported as blocked, never as done', () => {
  const g = goal.syncGoalItems(goal.createGoal({ objective: 'blocked work' }).goal, [
    { content: 'await the upstream patch', status: 'blocked', blockedReason: 'upstream issue is open' },
    { content: 'unrelated work', status: 'pending' },
  ]);
  const p = goal.goalProgress(goal.proveGoalItems(g, []));
  assert.equal(p.blocked, 1);
  assert.equal(p.pending, 1);
  assert.equal(p.done, 0);
  assert.match(goal.renderGoalReport(g), /\[!\] await the upstream patch {2}\(BLOCKED: upstream issue is open\)/);
});

// ---------------------------------------------------------------- 8. screening

test('8. a credential is NEVER persisted (write screen)', () => {
  const made = goal.createGoal({ objective: `push with ${SECRET}` });
  assert.ok(made.refusal, 'the write screen must refuse');
  assert.match(made.refusal, /refusing to store: the goal objective looks like it contains/);
  assert.equal(made.goal, undefined, 'no record is produced, so nothing can be written');

  // And the refusal names the transcript it would have landed in.
  const direct = goal.screenGoalObjective(`token ${SECRET}`, '/tmp/x.jsonl');
  assert.match(direct, /\/tmp\/x\.jsonl is re-injected/);

  // CONTROL: a clean objective passes and produces a record.
  assert.ok(goal.createGoal({ objective: 'ship the goal feature' }).goal);
});

test('8b. a credential in an already-stored goal is NEVER replayed (read screen)', () => {
  // Simulates a goal written BEFORE the screen existed, or a hand-edited
  // transcript: the write screen cannot help, so the read screen must.
  resetMemoryScreenStats();
  const dirty = { t: 'goal', action: 'set', goal: { objective: `deploy with ${SECRET}`, status: 'active', items: [] } };
  const s = newSession();
  appendEvent(s, dirty);

  const loaded = loadSessionWithStatus(s.file);
  assert.equal(loaded.goal, null, 'a screened goal must not be restored');
  assert.equal(loaded.goalTerminal.status, 'withheld');
  assert.match(goal.renderGoalReport(null, { terminal: loaded.goalTerminal }), /withheld by the read screen/);

  const stats = memoryScreenStats();
  assert.ok(stats.withheld >= 1, 'the withholding is counted, not silent');
  resetMemoryScreenStats();

  // The transcript itself is UNCHANGED -- the read path never rewrites a record.
  assert.equal(fs.readFileSync(s.file, 'utf8').includes(SECRET), true);
  // And the secret never reaches a prompt.
  assert.equal(goal.renderGoalBlock(loaded.goal), '');
  assert.equal(goal.renderGoalBlock(goal.goalFromEvents([dirty]).goal), '');
});

test('8c. a credential smuggled into a checklist item withholds the whole goal', () => {
  const dirty = {
    t: 'goal',
    action: 'set',
    goal: {
      objective: 'harmless looking',
      status: 'active',
      items: [{ content: `use the key ${SECRET}`, status: 'pending' }],
    },
  };
  const { goal: g, terminal } = goal.goalFromEvents([dirty]);
  assert.equal(g, null);
  assert.equal(terminal.status, 'withheld');
  resetMemoryScreenStats();
});

// ---------------------------------------------------------------- 9. budget

test('9. a budget stop leaves the goal ACTIVE with a budget reason, NOT complete', () => {
  const g = goal.syncGoalItems(goal.createGoal({ objective: 'expensive work' }).goal, [
    { content: 'process the whole corpus', status: 'completed' },
    { content: 'write the summary', status: 'pending' },
  ]);
  const budget = createCostBudget({ maxCostUsd: 0.000001 });
  budget.record('grok-4.6', { inputTokens: 1_000_000, outputTokens: 1_000_000 });
  assert.equal(budget.reason, 'cost-cap');
  let code = null;
  try {
    budget.assert('grok-4.6');
  } catch (err) {
    code = err.code;
  }
  assert.equal(code, 'OX_BUDGET_STOP', 'the budget really did stop the run');

  const stopped = noteGoalStopFor(g, budget.reason, budget.explain());
  assert.equal(stopped.status, 'active', 'a stop is not a completion');
  assert.equal(stopped.stopReason, 'cost-cap');
  assert.notEqual(stopped.status, 'done');

  const p = goal.goalProgress(stopped);
  assert.equal(p.done, 0);
  assert.equal(p.pending, 1);
  const block = goal.renderGoalBlock(stopped);
  assert.match(block, /last stop: cost-cap/);
  assert.match(block, /THE GOAL IS STILL ACTIVE: stopping is not finishing/);
  assert.match(goal.renderGoalReport(stopped), /still ACTIVE \(a limit reached is not completion\)/);

  // It survives resume still active, still incomplete.
  const s = newSession();
  appendEvent(s, goal.goalEvent(stopped, 'stopped'));
  const loaded = loadSessionWithStatus(s.file);
  assert.equal(loaded.goal.status, 'active');
  assert.equal(loaded.goal.stopReason, 'cost-cap');
  assert.equal(goal.completeGoal(loaded.goal, []).refusal !== undefined, true, 'still cannot be completed');
});

function noteGoalStopFor(g, reason, note) {
  return goal.noteGoalStop(g, reason, note).goal;
}

// -------------------------------------------------------------- 10. no residue

test('10. clearing leaves no residue -- no active goal, no stale prompt line, no orphan store', async () => {
  const s = newSession();
  appendEvent(s, goal.goalEvent(goal.createGoal({ objective: 'transient work' }).goal, 'set'));
  appendEvent(s, goal.goalEvent(goal.clearGoal(goal.createGoal({ objective: 'transient work' }).goal), 'cleared'));

  const loaded = loadSessionWithStatus(s.file);
  assert.equal(loaded.goal, null);
  // The prompt carries nothing: no stale goal line rides every later turn.
  assert.equal(goal.renderGoalBlock(loaded.goal), '');
  assert.equal(goal.renderGoalBlock(null), '');
  const prompt = await buildSystemPrompt({ cwd: ROOT, contractBlock: [goal.renderGoalBlock(loaded.goal), ''].join('\n') });
  assert.equal(/ACTIVE GOAL/.test(prompt), false, 'no goal section when there is no goal');

  // No orphan store: the ONLY on-disk home of goal state is the transcript.
  const dir = path.join(HOME_SANDBOX, '.ox');
  const orphans = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (/goal/i.test(e.name)) orphans.push(full);
    }
  };
  walk(dir);
  assert.deepEqual(orphans, [], 'no goal store was created alongside the transcript');
  const text = fs.readFileSync(s.file, 'utf8');
  assert.equal(text.includes('"t":"goal"'), true, 'the lifecycle is auditable in the transcript');
});

// ------------------------------------------------------- todo_write integration

test('the goal checklist IS the existing todo_write list -- one mechanism, not two', async () => {
  const g = goal.createGoal({ objective: 'reuse the todo list' }).goal;
  const sessionState = {};
  await todoWriteTool(
    {
      todos: [
        { content: 'add the resolver', status: 'completed' },
        { content: 'document the flag', status: 'in_progress' },
        { content: 'ship it', status: 'blocked', blockedReason: 'waiting on review' },
      ],
    },
    { sessionState }
  );
  const merged = goal.syncGoalItems(g, sessionState.todos);
  assert.equal(merged.items.length, 3);
  assert.equal(merged.items[2].status, 'blocked');
  assert.equal(merged.items[2].blockedReason, 'waiting on review');
  // The tool's own render counts blocked separately.
  assert.match(renderTodos(sessionState.todos), /1 completed · 1 in_progress · 1 blocked · 0 pending/);
  // A blocked item with no reason is still recorded, but it is labelled rather
  // than silently dropped -- "blocked" and "gave up" must not read the same.
  const noReason = await todoWriteTool({ todos: [{ content: 'x', status: 'blocked' }] }, { sessionState: {} });
  assert.match(noReason.content, /no reason given/);
  // The old statuses still validate: this is additive.
  for (const status of ['pending', 'in_progress', 'completed']) {
    const ok = await todoWriteTool({ todos: [{ content: 'x', status }] }, { sessionState: {} });
    assert.equal(ok.isError, undefined, `${status} must still be accepted`);
  }
  const bad = await todoWriteTool({ todos: [{ content: 'x', status: 'nonsense' }] }, { sessionState: {} });
  assert.equal(bad.isError, true);
});

test('10b. an UNTOUCHED todo list does not wipe a checklist recovered from the transcript', async () => {
  // `ctx.sessionState.todos` starts as `[]` on every fresh process. Merging that
  // blindly is how a resume silently erases proven progress, which is the failure
  // the whole feature exists to prevent.
  const g = goal.syncGoalItems(goal.createGoal({ objective: 'survive the resume' }).goal, [
    { content: 'wire the goal into the repl', status: 'completed' },
  ]);
  const proven = goal.proveGoalItems(g, [
    { role: 'assistant', content: '', tool_calls: [{ id: 'c', function: { name: 'edit_file', arguments: '{"path":"src/repl.js"}' } }] },
  ]);
  const state = {};
  assert.deepEqual(goal.mergeGoalTodos(proven, state).items.length, 1, 'untouched list is not adopted');
  assert.deepEqual(goal.mergeGoalTodos(proven, { todos: [] }).items.length, 1);
  assert.deepEqual(goal.mergeGoalTodos(proven, null).items.length, 1);
  assert.deepEqual(goal.mergeGoalTodos(proven, undefined).items.length, 1);

  // Once the model HAS published a list, that list is authoritative -- including
  // a deliberate clear.
  await todoWriteTool({ todos: [{ content: 'something else entirely', status: 'pending' }] }, { sessionState: state });
  assert.equal(goal.mergeGoalTodos(proven, state).items[0].content, 'something else entirely');
  await todoWriteTool({ todos: [] }, { sessionState: state });
  assert.deepEqual(goal.mergeGoalTodos(proven, state).items, [], 'an explicit empty list clears the checklist');
});

// ------------------------------------------------------------------- E2E

function sse(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

// The FIRST agent turn calls todo_write to publish the checklist; later turns just
// answer. Indexed by AGENT turns, not by request: `/goal` drafts a contract and the
// first answer gets auto-titled, and those aux calls share the endpoint. Counting
// raw requests would hand the tool-call script to the contract drafter and the
// agent would never be asked to update its checklist.
function turn(index) {
  if (index === 0) {
    return [
      sse({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_goal_1',
                  type: 'function',
                  function: { name: 'todo_write', arguments: JSON.stringify({ todos: [{ content: 'wire the goal into the repl', status: 'in_progress' }] }) },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
      sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
      sse({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 4 } }),
      'data: [DONE]\n\n',
    ].join('');
  }
  return [
    sse({ choices: [{ index: 0, delta: { content: 'working on it' }, finish_reason: 'stop' }] }),
    sse({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 4 } }),
    'data: [DONE]\n\n',
  ].join('');
}

async function startMock(t, script) {
  const requests = [];
  let agentTurns = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      requests.push({ raw: body });
      let isAgentTurn = false;
      try {
        isAgentTurn = JSON.parse(body)?.messages?.some((m) => m?.role === 'system');
      } catch {}
      const idx = isAgentTurn ? agentTurns++ : 1;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(turn(script === 'reject' ? 1 : idx));
    });
  });
  t.after(() => {
    server.closeAllConnections?.();
    server.close();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, requests };
}

const SCRUB = [
  'OX_BASE_URL', 'OX_API_KEY', 'OX_MODEL', 'OX_YOLO', 'OX_MAX_COST',
  'XAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY',
  'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'DEEPSEEK_API_KEY', 'NODE_OPTIONS',
];

// The REPL reads stdin as fast as it arrives and answers "(busy)" to any line that
// lands mid-turn, so a here-string of N lines loses all but the first. Lines are
// therefore fed one at a time, each waiting for the prompt to come back WITHOUT a
// busy in between -- which is also the only way to see what an operator sees.
function runOx(t, { home, port, args, lines, timeoutMs = 45000 }) {
  const env = { ...process.env };
  for (const k of SCRUB) delete env[k];
  const child = spawn(process.execPath, [OX_BIN, ...args], {
    cwd: home,
    env: { ...env, HOME: home, NO_COLOR: '1', OX_BASE_URL: `http://127.0.0.1:${port}/v1`, OX_API_KEY: 'test' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => (stderr += d));
  const prompts = () => (stdout.match(/❯ /g) ?? []).length;
  const busies = () => (stdout.match(/\(busy —/g) ?? []).length;
  return new Promise((resolve, reject) => {
    const killer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`ox did not exit in ${timeoutMs}ms\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, timeoutMs);
    // `consumed`/`busyAt` is the pair that makes this correct: the prompt is
    // written after EVERY handled line INCLUDING a rejected one, so counting
    // prompts alone would happily feed the next line into a busy REPL.
    let consumed = 0;
    let busyAt = 0;
    const waiters = [];
    const settle = () => {
      while (prompts() > consumed && busies() === busyAt && waiters.length) {
        consumed = prompts();
        waiters.shift()();
      }
    };
    child.stdout.on('data', (d) => {
      stdout += d;
      settle();
    });
    const waitReady = () =>
      new Promise((res) => {
        settle();
        if (prompts() > consumed && busies() === busyAt) {
          consumed = prompts();
          return res();
        }
        waiters.push(res);
      });
    child.on('error', (e) => {
      clearTimeout(killer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(killer);
      resolve({ code, stdout, stderr });
    });
    (async () => {
      await waitReady();
      for (const line of lines) {
        child.stdin.write(`${line}\n`);
        await waitReady();
        assert.equal(busies(), busyAt, `line '${line}' was dropped by a busy REPL\n${stdout}`);
        busyAt = busies();
      }
    })().catch((e) => {
      clearTimeout(killer);
      child.kill('SIGKILL');
      reject(e);
    });
  });
}

test('E2E: the goal reaches the model on turn 1 AND turn 2, and survives a real --resume', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-goal-e2e-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const { port, requests } = await startMock(t, 'normal');

  const first = await runOx(t, {
    home,
    port,
    args: [],
    lines: ['/goal ship the persistent goal feature', 'do the work', '/goal', '/quit'],
  });
  assert.equal(first.code, 0, `exit ${first.code}\n${first.stdout}\n${first.stderr}`);
  assert.match(first.stdout, /goal set/);

  // Aux calls (contract drafting, auto-title) carry no system prompt, so the turn
  // that matters is the LAST request that has one.
  const agentTurns = requests
    .map((r) => {
      try {
        return JSON.parse(r.raw);
      } catch {
        return null;
      }
    })
    .filter((b) => b && Array.isArray(b.messages) && b.messages.some((m) => m.role === 'system'));
  assert.ok(agentTurns.length >= 2, `expected 2+ agent turns, got ${agentTurns.length}`);
  const systemOf = (body) => body.messages.find((m) => m.role === 'system').content;

  // EVERY agent turn carries it, first and last: the objective is prompt state, so
  // a turn boundary cannot drop it.
  for (const [i, body] of agentTurns.entries()) {
    const sys = systemOf(body);
    assert.match(sys, /## ACTIVE GOAL/, `agent turn ${i} lost the goal`);
    assert.match(sys, /ship the persistent goal feature/, `agent turn ${i} lost the objective`);
    assert.match(sys, /keep this checklist current with todo_write/, `agent turn ${i} lost the rules`);
    assert.ok(sys.indexOf('## ACTIVE GOAL') < sys.indexOf('# MEMORY'), `agent turn ${i}: goal must sit above MEMORY`);
  }
  // The turn AFTER the checklist was written carries the item too.
  assert.match(systemOf(agentTurns[agentTurns.length - 1]), /wire the goal into the repl/);

  // The transcript holds the goal as an event, and a fresh process recovers it.
  const dir = path.join(home, '.ox', 'sessions');
  const file = path.join(dir, fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort().pop());
  const reloaded = loadSessionWithStatus(file);
  assert.equal(reloaded.goal.objective, 'ship the persistent goal feature');
  assert.equal(reloaded.goal.items.length, 1, 'the todo_write call landed in the checklist');
  assert.equal(reloaded.goal.items[0].content, 'wire the goal into the repl');

  // RESUME in a NEW process: the goal is announced and reaches the model.
  const second = await runOx(t, { home, port, args: ['--resume', file], lines: ['carry on', '/goal', '/quit'] });
  assert.equal(second.code, 0, `exit ${second.code}\n${second.stdout}\n${second.stderr}`);
  assert.match(second.stdout, /goal: ship the persistent goal feature/);
  const resumed = requests
    .map((r) => {
      try {
        return JSON.parse(r.raw);
      } catch {
        return null;
      }
    })
    .filter((b) => b && Array.isArray(b.messages) && b.messages.some((m) => m.role === 'system'))
    .map((b) => b.messages.find((m) => m.role === 'system').content);
  assert.match(resumed[resumed.length - 1], /## ACTIVE GOAL/, 'a NEW process must still see the goal');
  assert.match(resumed[resumed.length - 1], /ship the persistent goal feature/);
  assert.match(resumed[resumed.length - 1], /wire the goal into the repl/, 'and the checklist from before the resume');
});

test('E2E: /goal done REFUSES through the binary while an item is unproven', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-goal-refuse-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const { port } = await startMock(t, 'normal');
  const r = await runOx(t, { home, port, args: [], lines: ['/goal ship it', 'do the work', '/goal done', '/quit'] });
  assert.equal(r.code, 0, `exit ${r.code}\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /refusing to mark the goal complete/);
  assert.match(r.stdout, /wire the goal into the repl/, 'the refusal NAMES the unmet item');
  assert.equal(/goal complete —/.test(r.stdout), false, 'it must not claim completion');
});

test('E2E: a budget stop leaves the goal ACTIVE, with the budget reason', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-goal-budget-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const { port } = await startMock(t, 'normal');
  // The turn spends 12 prompt / 4 completion tokens at a mock model with no price
  // row, so a tiny cap stops it for unknown-cost -- still a budget stop, still not
  // a completion.
  const r = await runOx(t, {
    home,
    port,
    args: ['--max-cost', '0.0000001'],
    lines: ['/goal expensive work', 'go', '/quit'],
  });
  assert.equal(r.code, 0, `exit ${r.code}\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /goal is still ACTIVE — stopped for budget \(unknown-cost\), not completion/);
  assert.equal(/goal complete/.test(r.stdout), false, 'a budget stop is not completion');

  const dir = path.join(home, '.ox', 'sessions');
  const file = path.join(dir, fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort().pop());
  const reloaded = loadSessionWithStatus(file);
  assert.equal(reloaded.goal.status, 'active');
  assert.equal(reloaded.goal.stopReason, 'unknown-cost');
});
