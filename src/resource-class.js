export const RESOURCE_CLASSES = Object.freeze([
  'pure_read',
  'fs_write',
  'approval_gated',
  'memory_write',
  'terminal',
  'unknown',
]);

// agent_status only reads the in-process registry of running agents.
const PURE_READ_TOOLS = new Set(['read_file', 'grep', 'glob', 'list_dir', 'ls', 'agent_status']);
const FS_WRITE_TOOLS = new Set(['edit_video', 'write_file', 'edit_file']);
const TERMINAL_TOOLS = new Set(['reply', 'finish', 'report_result']);

// Agent-to-agent messaging. Classified `memory_write`, which is the honest class
// and not a convenience one: both tools are durable operations on a persistence
// store in the project (teams.json), neither spawns a process, neither reaches the
// network, and neither touches the filesystem outside the workspace store — the
// same posture memory_add already has.
//
// It is NOT left `unknown`, because `unknown` means "forbidden in a batch"
// (src/agent.js rejects the whole turn), which would make the mailbox unusable
// the moment a model emitted `agent_observe` next to a read_file — which is
// exactly how a model polls for mail. It is deliberately NOT `approval_gated`
// either: the comparison-doc framing of this feature is "steer active work", and
// gating it would mean a confirmation prompt per steering note and no usable path
// at all in `-p` mode, where approvals decline. The brakes that make that
// proportionate are elsewhere and all still hold — the body is screened by
// screenPersistText before it is stored. Ordinary peer mail is opt-in on the
// receiving side: nothing pulls it into another agent's context until that
// agent calls agent_observe. Operator steering is the explicit exception:
// steerSubagent marks a note and the subagent loop drains marked notes at its
// next turn boundary. This is queued next-turn steering, not an interrupt.
const MAILBOX_TOOLS = new Set(['agent_message.send', 'agent_observe']);

// `todo_write` was left unclassified, i.e. `unknown`, which agent.js rejects with
// "unknown tools are forbidden in a batch" -- and it rejects a batch of ONE too.
// So the tool was offered in every narrowed prompt and every call to it failed.
// `memory_write` is the honest class for it: it is a durable write to session
// state that the CLI appends to the transcript, it spawns nothing, reaches no
// network and touches no file, which is the same posture the class already
// describes.
const SESSION_STATE_TOOLS = new Set(['todo_write', 'task_board', 'load_tools']);

// The same bug again, wider: 15 of 25 registered tools had no class, so every
// call to web_search, web_fetch, show_ui, the mail tools and the Mac tools was
// refused, alone or not (found by a real run: a local model's show_ui call got
// "unknown tools are forbidden in a batch"). test/resource-class-coverage.test.js
// now fails if a registered tool is left unclassified.
//
// Reads with no side effect: search and fetch the web, list mail accounts, draw
// a canvas (its queries run under plan mode), get a second opinion.
const NETWORK_READ_TOOLS = new Set(['library', 'social_research', 'web_search', 'web_fetch', 'youtube_transcript', 'current_page', 'mail_accounts', 'show_ui', 'critique', 'code_graph', 'ui_elements', 'session_recall']);
// Act on this computer or for the user (each also asks inside the tool): open
// things, type, take a screenshot, notify, write mail, drive a browser task.
const ACTING_TOOLS = new Set(['open_app', 'open_url', 'open_path', 'open_window', 'type_text', 'click', 'press_key', 'draw', 'screenshot', 'notify', 'mail_compose', 'messages_send', 'whatsapp_send', 'web_task']);

export function classifyTool(name) {
  const toolName = String(name ?? '');
  if (PURE_READ_TOOLS.has(toolName)) return 'pure_read';
  if (FS_WRITE_TOOLS.has(toolName)) return 'fs_write';
  if (toolName === 'bash' || toolName === 'subagent' || toolName === 'create_media' || toolName === 'install_skill' || toolName === 'create_bot' || toolName.startsWith('mcp__')) return 'approval_gated';
  if (ACTING_TOOLS.has(toolName)) return 'approval_gated';
  if (NETWORK_READ_TOOLS.has(toolName)) return 'pure_read';
  if (toolName.startsWith('memory_')) return 'memory_write';
  // ox brain (src/brain.js): searches and saves long-term notes, the same posture as memory_*.
  if (toolName === 'brain') return 'memory_write';
  if (MAILBOX_TOOLS.has(toolName)) return 'memory_write';
  if (SESSION_STATE_TOOLS.has(toolName)) return 'memory_write';
  if (TERMINAL_TOOLS.has(toolName)) return 'terminal';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// PARALLEL SUBAGENTS: which approval-gated tools may be BATCHED WITH THEMSELVES.
//
// `approval_gated` is a statement about the GATE (this call needs a decision
// before it runs), not about cardinality (this call must be the only one in its
// turn). src/agent.js used to read it as the second thing, and that reading was
// the whole blocker: two `subagent` calls in one turn produced
// "approval-gated tools must run solo (batch rejected)" and the turn was
// thrown away, so a model that batched lost the turn with no way to learn why.
//
// The class therefore stays `approval_gated` -- it is still gated, and it is
// still forbidden to MIX with anything else -- and the batching question moves
// to its own predicate below, where it can be answered per tool. Only
// `subagent` is on the list, and only because src/agent.js has a bounded
// scheduler for it (see runSubagentBatch) plus a replacement gate that is not
// weaker than the structural rule it replaces. A tool with no scheduler stays
// unbatched, whatever its class.
const CONCURRENTLY_BATCHABLE = new Set(['subagent']);

export function isConcurrentlyBatchable(name) {
  return CONCURRENTLY_BATCHABLE.has(String(name ?? ''));
}

// How many subagents may run at once. Three, and the number is a judgement with
// three parts:
//
//   - Wall clock. Independent tasks are what a fan-out is for, and the win is
//     bounded by the SLOWEST agent, not the sum. Past a small N the marginal
//     task finishes long after the first ones, so latency stops improving.
//   - The box. Every concurrent subagent is a full nested runAgentLoop: its own
//     tool set, its own scoped memory, its own IPC broadcast, its own audit
//     rows. On an 8-CPU host three nested loops is already ~40% of the machine;
//     a dozen is a stall that also slows the parent's own turn.
//   - Money. Spend is LINEAR in the number of agents. The cap is also the
//     denominator of the per-agent cost division (agent.js), so lowering it
//     RAISES each agent's ceiling -- a wide fan-out is the only way to spend a
//     session budget quickly.
//
// 3 is where the latency curve flattens and the resource curve is still flat.
// The ceiling is 8 rather than "unbounded" because an unbounded fan-out is a
// denial-of-service the model can issue in one turn, and it is the number the
// --json stream, /agents and the audit all have to be able to name.
export const DEFAULT_SUBAGENT_CONCURRENCY = 3;
export const MIN_SUBAGENT_CONCURRENCY = 1;
export const MAX_SUBAGENT_CONCURRENCY = 8;

// config.subagent.maxParallel (or .concurrency) > OX_SUBAGENT_CONCURRENCY >
// default, clamped. A garbage value falls back to the default rather than
// throwing: this is read on every delegation and a typo in a config file must
// not take the run down.
export function resolveSubagentConcurrency(config = null, env = process.env) {
  const raw = config?.subagent?.maxParallel
    ?? config?.subagent?.concurrency
    ?? env?.OX_SUBAGENT_CONCURRENCY;
  if (raw == null || raw === '') return DEFAULT_SUBAGENT_CONCURRENCY;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_SUBAGENT_CONCURRENCY;
  return Math.max(MIN_SUBAGENT_CONCURRENCY, Math.min(MAX_SUBAGENT_CONCURRENCY, Math.round(n)));
}

// The message the loop has always used for a batch it refuses. Kept verbatim so
// every existing consumer of that string -- and every test that greps for it --
// sees the same refusal for the same reason. What changed is WHICH batches land
// here: a same-tool batch of a scheduler-backed tool no longer does.
export const BATCH_REJECT_APPROVAL = 'approval-gated tools must run solo (batch rejected)';

// One decision per turn, computed once and consumed by the group loop.
//
//   serial     -- everything runs in the order it was emitted (unchanged)
//   concurrent-- one approval_gated group, one tool, and that tool has a
//                 bounded scheduler: the loop may run the group concurrently
//   reject     -- refuse the WHOLE turn, before anything executes
//
// A MIXED batch stays rejected even when the gated tool is scheduler-backed.
// [subagent, read_file] would have to promise a single gate over two classes of
// side effect, and the mixed case is where "the user approved this" quietly
// stops meaning what it says.
export function batchPlan(calls) {
  const list = Array.isArray(calls) ? calls : [];
  const groups = groupCalls(list);
  const gated = groups.filter((g) => g.class === 'approval_gated');
  if (!gated.length) return { mode: 'serial', tool: null, groups, reason: null };
  const firstName = String(gated[0].calls[0]?.function?.name ?? '');
  if (list.length <= 1) return { mode: 'serial', tool: firstName, groups, reason: null };
  // Gated calls with no scheduler of their own (bash, MCP, acting on the
  // computer) run ONE AFTER ANOTHER, in the order the model emitted them, each
  // through its own approval in runOne, exactly as if they had come in
  // separate turns. Refusing the whole turn instead cost a round trip every
  // time a model batched (measured: ox 11 requests vs Claude Code's 4 on the
  // same task, bench/h2h) and taught the model nothing. Only `subagent`, the
  // one tool whose batch is gated as a batch, keeps the no-mixing rule.
  const gatedNames = new Set(gated.flatMap((g) => g.calls.map((c) => String(c?.function?.name ?? ''))));
  if (![...gatedNames].some(isConcurrentlyBatchable)) return { mode: 'serial', tool: firstName, groups, reason: null };
  if (gated.length > 1 || groups.length > 1) {
    return { mode: 'reject', tool: firstName, groups, reason: BATCH_REJECT_APPROVAL };
  }
  const names = new Set(gated[0].calls.map((c) => String(c?.function?.name ?? '')));
  const only = [...names][0] ?? '';
  if (names.size !== 1 || !isConcurrentlyBatchable(only)) {
    return { mode: 'reject', tool: only, groups, reason: BATCH_REJECT_APPROVAL };
  }
  return { mode: 'concurrent', tool: only, groups, reason: null };
}

export function groupCalls(calls) {
  const groups = [];
  for (const call of calls ?? []) {
    const resourceClass = classifyTool(call?.function?.name);
    const previous = groups[groups.length - 1];
    if (previous?.class === resourceClass) {
      previous.calls.push(call);
    } else {
      groups.push({ class: resourceClass, calls: [call] });
    }
  }
  return groups;
}
