import { expandLlmsRefs } from './llms-txt.js';
import fs from 'node:fs';
import { resolveTurnMode } from './modes.js';
import { agentPersonaBlock } from './agents.js';
import { holdAwake } from './awake.js';
import path from 'node:path';
import { loadImage } from './providers/images.js';
import { runAgent, draftTitle } from './agent.js';
import { makeApprover } from './approval.js';
import { buildContext, expandContextRefs } from './context.js';
import { createCostBudget, currentCostBudget, formatCost } from './cost.js';
import { runMaxModePlanning, resolveMaxMode } from './maxmode.js';
import { createMemoryApi, loadMemoryBlock, writeSessionNote, writeEpisode } from './memory.js';
import { memoryPromptBlock, learnFromMessages } from './memory-graph.js';
import { readMcpPolicyDocs, resolveAuxTarget } from './config.js';
import { createSession, appendEvent, nextRewindId } from './session.js';
import { discoverSkills } from './skills.js';
import { buildSystemPrompt, loadPersona } from './system-prompt.js';
import { makeSubagentToolHandler, listSubagents } from './subagent.js';
import { makeAgentTeamsHandler } from './agent-teams.js';import { listToolSchemas } from './tools/index.js';
import { McpHub } from './mcp.js';
import { setMcpSearchHub } from './tools/web.js';
import { defaultBotSpec, resolveBot } from './bots.js';
import {
  c, renderError, renderToolEnd, renderToolStart, streamText, truncate,
  SubagentTicker,
} from './ui.js';
import { loadHooksConfig } from './hooks.js';
import { createEventBroadcaster, createIpcApprover } from './ipc.js';
import { createLedger, renderLedger } from './ledger.js';

const AUTO_MAX_ITERATIONS = 80;

function warnOnce(msg) {
  let done = false;
  return () => {
    if (!done) {
      done = true;
      process.stderr.write(`${msg}\n`);
    }
  };
}

function splitQualifiedSchemas(entries) {
  const out = [];
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || typeof e.name !== 'string' || !e.name.startsWith('mcp__')) continue;
    const rest = e.name.slice(5);
    const i = rest.indexOf('__');
    if (i <= 0) continue;
    out.push({
      server: rest.slice(0, i),
      name: rest.slice(i + 2),
      description: e.description,
      input_schema: e.input_schema,
    });
  }
  return out;
}

export async function assembleCtx({ config, target, opts = {}, auxTarget = null } = {}) {
  const memoryApi = createMemoryApi(config.cwd);
  const skills = discoverSkills({ cwd: config.cwd });
  const context = buildContext({ cwd: config.cwd });
  // The project's MEMORY.md, then what ox remembers about this user and what
  // bears on this task (src/memory-graph.js). OX_MEMORY=0 leaves the graph out.
  let graphBlock = '';
  if (process.env.OX_MEMORY !== '0') {
    try { graphBlock = memoryPromptBlock({ cwd: config.cwd, task: String(opts.memoryTask ?? '') }); } catch {}
  }
  const memoryBlock = [loadMemoryBlock(config.cwd), graphBlock].filter(Boolean).join('\n\n');
  const basePersona = loadPersona({ cwd: config.cwd, enabled: config.soul !== false });
  // A custom agent (`ox --agent <name>`) adds its own instructions to the persona.
  const persona = { ...basePersona, block: [basePersona.block, agentPersonaBlock(config.agentDef)].filter(Boolean).join('\n\n') };
  // Hoisted above the prompt build (it used to sit below) purely so the
  // # AGENT MESSAGING section can be gated on the same condition that
  // src/tools/index.js gates the two mailbox schemas on. Depends only on
  // opts and config.cwd, and nothing between here and its old position
  // referenced it, so the move is inert apart from that.
  const agentTeamsHandler = opts.agentTeamsHandler ?? makeAgentTeamsHandler(config.cwd);
  const systemPrompt = await buildSystemPrompt({
    cwd: config.cwd,
    contextParts: { memoryFiles: context.memoryFiles, tree: context.tree },
    memoryBlock,
    skillIndex: skills.index,
    personaBlock: persona.block,
    ...(Array.isArray(config.agentDef?.tools) ? { allowedTools: config.agentDef.tools, agentName: config.agentDef.name } : {}),
    agentMessaging: typeof agentTeamsHandler === 'function',
  });
  let hub = null;
  if (config.mcpServers && Object.keys(config.mcpServers).length > 0) {
    // Wave5a A / gap #1: the session's sandbox profile governs MCP server
    // processes too, so a server cannot open sockets the profile forbids.
    hub = new McpHub(config.mcpServers, { callTimeoutMs: 30000, sandbox: opts.sandbox ?? null });
    const warn = warnOnce('ox: MCP startup failed — continuing without MCP tools');
    try {
      await hub.start();
    } catch {
      warn();
    }
    // Hand the hub to web.js so web_search can use a configured MCP search tool
    // as the last link in its own backend chain -- the Exa-via-MCP route, minus
    // the external install. The hub already exists and is already started here, so
    // this costs one line and starts nothing new.
    setMcpSearchHub(hub);
  }
  const approval = opts.planMode ? 'plan' : opts.yesEdits ? 'accept-edits' : 'default';
  // --trust yolo is an explicit accept-all request and must mean the same thing
  // headless as it does in the REPL, where checkTrust allows every tool. Only
  // yolo implies accept-all; the other levels keep their headless behaviour
  // (approval prompts, which decline when stdin is not a TTY).
  const trustYolo = opts.trust === 'yolo' || config.trustLevel === 'yolo';
  const yolo = !!(opts.yolo || config.yolo || trustYolo);
  // Wave5b K: --strict-approvals disables the read-only auto-approve classifier.
  const strictApprovals = !!opts.strictApprovals;
  // F2: resolve the ordered cross-provider fallback chain once per session.
  const fallbackTargets = [];
  const fbWarned = new Set();
  for (const spec of Array.isArray(config.fallbackBots) ? config.fallbackBots : []) {
    try {
      fallbackTargets.push(resolveBot(spec, config));
    } catch (err) {
      if (!fbWarned.has(spec)) {
        fbWarned.add(spec);
        process.stderr.write(
          `ox: fallback bot '${spec}' unusable (${String(err?.message ?? err)}) — skipping\n`
        );
      }
    }
  }
  const policyDocs = readMcpPolicyDocs(config.cwd);
  const hooksConfig = loadHooksConfig(config.cwd);
  // GUI bridge (--ipc). Both seams are null without a server, so an ordinary
  // run keeps the exact approver and the exact event plumbing it had before.
  const ipcServer = opts.ipcServer ?? null;
  // Agent-to-agent messaging handler. Held in a local because it has to be
  // readable by the `ctx` literal below AND by the listToolSchemas call inside
  // that same literal (where `ctx` is still in its temporal dead zone).
  const ctx = {
    cwd: config.cwd,
    yolo,
    approval,
    // `critique` needs both: the model driving this session (to refuse a
    // same-model "second opinion") and the config (critique_bot, bots,
    // model_overrides). runAgentLoop re-publishes them onto its per-turn
    // toolCtx, so a mid-turn provider fallback is reflected there too.
    activeTarget: target,
    config,
    sessionState: { todos: [] },
    mcpPolicy: policyDocs.policy,
    requestApproval: makeApprover({ mode: approval, yolo, sandbox: opts.sandbox ?? null, mcpPolicy: policyDocs.policy, strictApprovals, external: createIpcApprover(ipcServer) }),
    // Live event fan-out consumed by runAgent(); null means "no GUI attached".
    ipcBroadcast: createEventBroadcaster(ipcServer),
    mcpTools: hub ? splitQualifiedSchemas(hub.schemas()) : [],
    mcpCall: hub ? (q, a) => hub.call(q, a) : null,
    mcpPolicyContext: {
      policy: policyDocs.policy,
      origins: policyDocs.origins,
      globalServers: policyDocs.globalServers,
      sideEffectsOk: !!opts.sideEffectsOk,
    },
    hooksConfig,
    memoryBlock,
    skillIndex: skills.index,
    memory: memoryApi,
    personaBlock: persona.block,
    ...(Array.isArray(config.agentDef?.tools) ? { allowedTools: config.agentDef.tools, agentName: config.agentDef.name } : {}),
    fallbackTargets,
    // Wave5a A: effective OS sandbox profile (kind 'off' when unset).
    sandbox: opts.sandbox ?? null,
    backend: opts.backend ?? null,
    // Wave5b K: read-only auto-approve ladder kill switch.
    strictApprovals,
    // Wave 6b: subagent delegation handler + tool inventory for nesting.
    subagentHandler: makeSubagentToolHandler({ config, target, auxTarget }),
    // Agent-to-agent messaging. Built BEFORE allTools below so the two mailbox
    // schemas are part of the offer — listToolSchemas only ships them when a
    // handler is actually installed, so ordering here is load-bearing, not
    // cosmetic. The handler holds no identity: it reads who is calling off the ctx
    // it is handed at dispatch time, which is why it is still correct after
    // cli.js sets ctx.sessionId below and after a subagent rewrites it.
    agentTeamsHandler,
    allTools: listToolSchemas({
      mcpTools: hub ? splitQualifiedSchemas(hub.schemas()) : [],
      memory: memoryApi,
      enableSubagents: true,
      // The offer follows the handler: these two schemas are shipped only because
      // there is a real mailbox behind them on this ctx. A local, because `ctx` is
      // still in its temporal dead zone inside its own object literal.
      agentTeamsHandler,
    }),
    enableSubagents: true,
    depth: 0,
    maxDepth: config?.subagent?.maxDepth ?? 2,
  };
  return { ctx, systemPrompt, skills, memoryApi, hub, context, persona };
}

export async function cleanupCtx(assembled) {
  // Drop the module-level hook BEFORE stopping the server: a web_search probe that
  // started while the hub was being torn down would otherwise get a call failure
  // reported as "the MCP route is broken" instead of "there is no MCP route here".
  if (assembled?.hub) setMcpSearchHub(null);
  try {
    await assembled?.hub?.stop?.();
  } catch {}
}

// How long to wait for piped input depends on what stdin is. A shell pipe
// (`cmd | ox -p`) or a redirected file is real input: wait for its end. A socket
// is what a program gets when it spawns ox with stdio 'pipe' and never writes:
// waiting the full limit there added 10s to every scripted, arena and island run,
// so it gets a short grace and is only read to the end once data starts.
function stdinWaitMs(limitMs) {
  try {
    const st = fs.fstatSync(0);
    if (st.isFIFO() || st.isFile()) return limitMs;
  } catch {}
  return Math.min(limitMs, Number(process.env.OX_STDIN_GRACE_MS) || 50);
}

function readPipedStdin(limitMs = 10000) {
  const graceMs = stdinWaitMs(limitMs);
  return new Promise((resolve) => {
    let buf = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      process.stdin.pause();
      resolve(buf);
    };
    let timer = setTimeout(finish, graceMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => {
      if (!buf && graceMs < limitMs) {
        clearTimeout(timer);
        timer = setTimeout(finish, limitMs);
      }
      buf += d;
    });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
  });
}

const dimYellow = (s) =>
  process.stdout.isTTY && !process.env.NO_COLOR ? `\x1b[2;33m${s}\x1b[39;22m` : String(s);

export async function runHeadless(args = {}) {
  const budget = currentCostBudget() ?? createCostBudget({ config: args.config, maxCostUsd: args.opts?.maxCostUsd });
  return budget.run(async () => {
    try {
      budget.assert();
      return await runHeadlessWithBudget(args);
    } catch (err) {
      if (err?.code !== 'OX_BUDGET_STOP') throw err;
      const event = { t: 'budget-stop', reason: budget.reason, message: budget.explain(), ...budget.snapshot() };
      if (args.opts?.json) console.log(JSON.stringify(event));
      else console.log(c.yellow(`· ${event.message}`));
      return { code: 2 };
    }
  });
}

async function runHeadlessWithBudget({ prompt = '', config, opts = {}, initialMessages = [] } = {}) {
  const budget = currentCostBudget();
  // Held while this process lives: the OS hold ends by itself when ox exits.
  holdAwake({ config });
  let target;
  try {
    target = resolveBot(opts.bot || opts.model || defaultBotSpec(config), config);
  } catch (err) {
    const e = new Error(String(err?.message ?? err));
    e.exitCode = 3;
    throw e;
  }
  const auxTarget = resolveAuxTarget(config);
  const assembled = await assembleCtx({ config, target, opts: { ...opts, memoryTask: prompt }, auxTarget });
  const { ctx } = assembled;
  // Mode: fixed by --mode / config, or picked per message by auto. The pick is
  // printed so a routed run can be checked, not taken on trust.
  const turnMode = resolveTurnMode(opts.mode ?? config.mode, prompt);
  ctx.mode = turnMode.mode;
  if (turnMode.routed) {
    if (opts.json) console.log(JSON.stringify({ t: 'mode', mode: turnMode.mode, routed: true, reason: turnMode.reason }));
    else process.stderr.write(c.dim(`· auto → ${turnMode.mode} (${turnMode.reason})\n`));
  }
  const auto = !!opts.auto;
  // A detached (`--daemon-worker`) run passes `opts.session` to get the
  // append-only transcript a supervised session exists for. That is the ONLY
  // difference: no iteration cap, no verifier, no memory write, no auto-summary,
  // so a worker is the same `-p` run plus a durable record. `workerId` is
  // stamped into the meta so the supervisor can join this transcript to this
  // worker by reading the file, instead of guessing from mtimes.
  const wantsTranscript = auto || !!opts.session;
  let session = null;
  if (wantsTranscript) {
    try {
      session = createSession(config.cwd, {
        bot: target.model,
        provider: target.provider,
        auto,
        ...(opts.workerId ? { workerId: String(opts.workerId), daemon: true } : {}),
      });
      // Wave5a A: pin the effective sandbox profile as a session meta event.
      if (opts.sandbox) {
        appendEvent(session, { t: 'sandbox', profile: opts.sandbox.name ?? 'off', degraded: !!opts.sandbox.degraded });
      }
    } catch {}
  }
  if (session && !ctx.sessionId) ctx.sessionId = session.id;
  try {
    let full = String(prompt ?? '');
    if (!process.stdin.isTTY) {
      const piped = await readPipedStdin(10000);
      if (piped.trim()) full = `${piped.replace(/\s+$/, '')}\n\n${full}`;
    }
    // F4: expand @file / @dir/ / @git.diff references before the prompt is
    // appended to the session or sent to the model.
    full = await expandLlmsRefs(expandContextRefs(full, config.cwd));
    const messages = [
      ...(Array.isArray(initialMessages) ? initialMessages : []),
    ];
    // --image: attached to the prompt, sent to the model as vision input.
    const images = (opts.images ?? []).map((f) => loadImage(path.resolve(config.cwd ?? process.cwd(), f)));
    if (full.trim() || images.length) messages.push({ role: 'user', content: full, ...(images.length ? { images } : {}) });
    if (session && full.trim()) {
      try {
        // Wave5a D: a user message beginning a turn drops a rewind point.
        appendEvent(session, { t: 'rewind-point', id: nextRewindId(session.file), label: full.slice(0, 40) });
        appendEvent(session, { t: 'user', text: full });
      } catch {}
    }
    const controller = new AbortController();
    const totals = { in: 0, out: 0, auxIn: 0, auxOut: 0 };
    const recomputeCost = () => budget.snapshot().costUsd;
    let costUsd = null;
    let failed = false;
    let denialCount = 0;
    let budgetStopped = false;
    let warnedUnhealthy = false;
    const touchedFiles = new Set();
    // Same ticker the REPL uses, for the same reason: a headless run's live
    // agent count must come from the same fold as its terminal lines.
    const subagentTicker = new SubagentTicker();
    // The subagents THIS run delegated to, taken from the lifecycle events
    // rather than from the on-disk list: an on-disk list cannot tell a
    // subagent of this run from one a previous run left behind, and a summary
    // that quietly credits a stale run's work to this one is worse than no
    // summary. The descriptors are read back at the end, because that is where
    // the durable record (files, lessons, status) lives.
    const delegated = [];
    const learnCalls = [];
    let toolCallCount = 0;
    let lastAssistantText = '';
    let titled = false;
    const baseApprove = ctx.requestApproval;
    ctx.requestApproval = async (name, args, detail) => {
      const ok = await baseApprove(name, args, detail);
      if (!ok) denialCount++;
      return ok;
    };
    const notice = (obj) => {
      if (opts.json) console.log(JSON.stringify(obj));
      else console.log(c.dim(`· ${obj.message ?? obj.t}`));
    };
    let extraGuidance = '';
    let mmUsage = null;
    const maxN = resolveMaxMode(opts.maxMode ?? config.maxMode);
    if (maxN > 1 && full.trim()) {
      const mm = await runMaxModePlanning({
        target,
        goal: full,
        n: maxN,
        signal: controller.signal,
        cwd: config.cwd,
        tree: assembled.context?.tree ?? '',
        auxTarget,
        overrides: config?.modelOverrides,
      });
      totals.in += mm.usage.inputTokens;
      totals.out += mm.usage.outputTokens;
      if (mm.aux) {
        totals.auxIn += mm.auxUsage.inputTokens;
        totals.auxOut += mm.auxUsage.outputTokens;
      }
      mmUsage = mm.usage;
      costUsd = recomputeCost();
      const payload = {
        t: 'max-mode',
        type: 'max-mode',
        candidates: mm.candidates,
        chosen: mm.chosen,
        costUsd: mm.costUsd,
        ...(mm.aux ? { aux: true, auxModel: auxTarget?.model ?? null } : {}),
      };
      if (opts.json) console.log(JSON.stringify(payload));
      else
        console.log(
          c.dim(
            `· max-mode: ${mm.candidates} plans considered, using #${mm.chosen}${mm.costUsd != null ? ` (${formatCost(mm.costUsd)})` : ''}${mm.aux ? ' via aux bot' : ''}`
          )
        );
      budget.assert();
      if (mm.plan) extraGuidance = `[SELECTED PLAN]\n${mm.plan}`;
    }
    const ledger = createLedger();
    try {
      for await (const ev of runAgent({
        target,
        auxTarget,
        messages,
        ctx,
        config,
        signal: controller.signal,
        verify: !!(opts.auto || opts.verify || config.defaultVerify),
        extraGuidance,
        initialUsage: mmUsage ?? undefined,
        ...(opts.auto ? { maxIterations: AUTO_MAX_ITERATIONS } : {}),
        ...(opts.goalContract ? { goalContract: opts.goalContract } : {}),
      })) {
        ledger.feed(ev);
        if (ev.type === 'error') failed = true;
        // What this run did, for learning at the end (assistant turns carry the
        // full tool arguments; tool-end says how each call went).
        if (ev.type === 'assistant-turn' && Array.isArray(ev.message?.tool_calls)) {
          for (const tc of ev.message.tool_calls) {
            let args = {};
            try { args = JSON.parse(tc.function?.arguments ?? '{}'); } catch {}
            learnCalls.push({ id: tc.id, name: tc.function?.name ?? '?', args, ok: null });
          }
        } else if (ev.type === 'tool-end') {
          const call = learnCalls.find((c) => c.id === ev.id && c.ok === null);
          if (call) call.ok = !ev.isError;
        }
        if (ev.type === 'usage-total') {
          Object.assign(ev, budget.snapshot());
        }
        if (ev.type === 'tool-start') {
          toolCallCount++;
          try {
            const a = JSON.parse(ev.argsPreview ?? '{}');
            if (typeof a?.path === 'string' && a.path) touchedFiles.add(a.path);
          } catch {}
          if (session) {
            try {
              appendEvent(session, {
                t: 'tool-result',
                callId: ev.id,
                name: ev.name,
                isError: !!ev.isError,
                content: `${ev.ms}ms · ${ev.bytes}b`,
              });
            } catch {}
          }
        } else if (ev.type === 'compaction' && session) {
          // The "Context Compacted" entry. Persisted so the record survives the
          // process: before/after tokens, drop counts, which model summarized,
          // and the per-segment composition either side. `replayMessages` only
          // reads user/assistant/tool-result events, so this is inert on resume.
          try {
            appendEvent(session, {
              t: 'compaction',
              from: ev.from,
              to: ev.to,
              tokensBefore: ev.tokensBefore,
              tokensAfter: ev.tokensAfter,
              savedTokens: ev.savedTokens,
              messagesSummarized: ev.messagesSummarized,
              messagesDropped: ev.messagesDropped,
              messagesKept: ev.messagesKept,
              model: ev.compactionModel ?? ev.model ?? null,
              compactionModelSource: ev.compactionModelSource ?? null,
              separateCompactionModel: ev.separateCompactionModel === true,
              index: ev.index ?? null,
              cap: ev.cap ?? null,
              breakdownBefore: ev.breakdownBefore ?? null,
              breakdownAfter: ev.breakdownAfter ?? null,
            });
          } catch {}
        } else if (ev.type === 'assistant-turn' && session) {
          try {
            appendEvent(session, {
              t: 'assistant',
              text: typeof ev.message?.content === 'string' ? ev.message.content : '',
              tool_calls: Array.isArray(ev.message?.tool_calls) ? ev.message.tool_calls : [],
            });
          } catch {}
        } else if (ev.type === 'subagent-spawn' && ev.id && !delegated.includes(ev.id)) {
          delegated.push(String(ev.id));
        } else if (ev.type === 'final') {
          if (typeof ev.message?.content === 'string') lastAssistantText = ev.message.content;
          if (session) {
            try {
              appendEvent(session, { t: 'assistant', text: lastAssistantText });
            } catch {}
          }
          // F5 auto-title: one aux call at the FIRST assistant final.
          if (session && !titled && lastAssistantText.trim()) {
            titled = true;
            try {
              const title = await draftTitle(auxTarget ?? target, { text: lastAssistantText, signal: controller.signal });
              if (title) appendEvent(session, { t: 'title', title });
            } catch {}
          }
        }
        if (opts.json) {
          if (ev.type === 'history' && process.env.OX_REDACT !== '0') {
            console.log(
              JSON.stringify({ t: ev.type, count: Array.isArray(ev.messages) ? ev.messages.length : 0 })
            );
          } else {
            console.log(JSON.stringify({ t: ev.type, ...ev }));
          }
          if (ev.type === 'usage') {
            totals.in += ev.inputTokens ?? 0;
            totals.out += ev.outputTokens ?? 0;
            if (ev.aux) {
              totals.auxIn += ev.inputTokens ?? 0;
              totals.auxOut += ev.outputTokens ?? 0;
            }
            costUsd = recomputeCost();
          }
        } else {
          switch (ev.type) {
            case 'text-delta':
              streamText(ev.text);
              break;
            case 'tool-start': {
              let args = {};
              try {
                args = JSON.parse(ev.argsPreview ?? '{}');
              } catch {}
              console.log(renderToolStart(ev.name, args));
              break;
            }
            case 'tool-end':
              console.log(renderToolEnd(ev.name, { content: `${ev.ms}ms · ${ev.bytes}b` }, ev.isError));
              if (ev.name === 'show_ui' && ev.meta?.canvas?.text) console.log(`\n${ev.meta.canvas.text}\n`);
              break;
            // Subagent lifecycle. Under `--json` these fall through to the
            // NDJSON branch above untouched, which is the point: one event
            // definition, two surfaces, no second schema to keep in step.
            case 'subagent-spawn':
            case 'subagent-start':
            case 'subagent-progress':
            // 'subagent-cancelled' is routed through the same ticker as the rest
            // of the lifecycle, and its case returns no line of its own (the
            // 'subagent-end' just above it already printed the cancelled agent,
            // in yellow). It is listed so the event is a known type here rather
            // than falling to this switch's default.
            case 'subagent-cancelled':
            case 'subagent-end': {
              const out = subagentTicker.apply(ev);
              if (out.line) console.log(out.line);
              if (out.count) console.log(out.count);
              if (out.becameEmpty) console.log(c.dim('  no subagents running'));
              break;
            }
            case 'reflection':
              console.log(dimYellow(`  ~ ${ev.text} (attempt ${ev.count})`));
              break;
            case 'continuation-retry':
              console.log(c.yellow(`· stream dropped (${ev.reason}) — retry ${ev.attempt}/3`));
              break;
            case 'warning':
              console.log(c.yellow(`! ${ev.text ?? ev.message}`));
              break;
            case 'continued':
              console.log(c.dim(`· output truncated by length — auto-continued (round ${ev.round})`));
              break;
            case 'fallback':
              if (!warnedUnhealthy) {
                warnedUnhealthy = true;
                console.log(c.yellow(`· primary provider unhealthy, using ${ev.to}`));
              }
              break;
            case 'compaction':
              // One line to stay scannable, then the audit detail — this is the
              // "expand the Context Compacted entry" surface.
              console.log(
                c.dim(
                  `· context compacted ${ev.from} → ${ev.to} tokens${ev.savedTokens > 0 ? ` (saved ${ev.savedTokens})` : ''}`
                )
              );
              console.log(
                c.dim(
                  `  ${ev.messagesSummarized} messages summarized into 1, ${ev.messagesKept} kept · ${ev.tokensBefore} → ${ev.tokensAfter} tokens` +
                    ` · summarized by ${ev.compactionModel ?? ev.model ?? 'the main model'}` +
                    `${ev.compactionModelSource && ev.compactionModelSource !== 'main' ? ` (${ev.compactionModelSource})` : ''}` +
                    `${ev.windowPctAfter != null ? ` · ${ev.windowPctAfter.toFixed(1)}% of a ${ev.window}-token window` : ''}` +
                    ` · compaction ${ev.index ?? 1} of ${ev.cap ?? '?'} this run`
                )
              );
              break;
            // `context-breakdown` is deliberately NOT rendered per turn in human
            // mode: a five-row table after every model call is noise. It is on
            // `--json` for programmatic consumers, and `/context` (or
            // `ox --context`) is the surface a human reads.
            case 'tool-narrowing':
              console.log(c.dim(`· tool offer narrowed to ${ev.offered} of ${ev.total} for this turn`));
              break;
            case 'approval':
              if (ev.decision === 'auto') console.log(c.dim(`· auto · read-only — ${ev.detail ?? ev.name}`));
              break;
            case 'verification':
              console.log(
                ev.complete
                  ? c.dim(`· verified complete (round ${ev.round})`)
                  : c.yellow(`· verification round ${ev.round}: incomplete — ${ev.gaps}`)
              );
              break;
            case 'gate':
              console.log(
                ev.ok
                  ? c.green(`· gate ok — ${ev.cmd}`)
                  : c.yellow(`· gate FAILED — ${ev.cmd} (exit ${ev.exit ?? 'null'})${ev.unchanged ? ' (state unchanged since last failure)' : ''}`)
              );
              break;
            case 'gate-exhausted':
              console.log(c.yellow(`· gate retry budget exhausted — continuing to verifier: ${ev.pending.join(', ')}`));
              break;
            case 'usage':
              totals.in += ev.inputTokens ?? 0;
              totals.out += ev.outputTokens ?? 0;
              if (ev.aux) {
                totals.auxIn += ev.inputTokens ?? 0;
                totals.auxOut += ev.outputTokens ?? 0;
              }
              costUsd = recomputeCost();
              break;
            case 'usage-total':
              if (ev.costUsd != null) costUsd = ev.costUsd;
              break;
            case 'final':
              streamText('\n');
              break;
            case 'error':
              failed = true;
              console.error(renderError(new Error(ev.error)));
              break;
          }
        }
        budget.assert();
      }
    } catch (err) {
      if (err?.code === 'OX_BUDGET_STOP') {
        budgetStopped = true;
        controller.abort();
        notice({ t: 'budget-stop', reason: budget.reason, message: budget.explain(), ...budget.snapshot() });
      } else {
        failed = true;
        console.error(renderError(err));
      }
    }
    // Which agent spent what. Printed when work was delegated; always in --json.
    if (opts.json) {
      if (ledger.rows().length) console.log(JSON.stringify({ t: 'ledger', agents: ledger.rows(), totals: ledger.totals() }));
    } else if (ledger.hasSubagents()) {
      console.log(renderLedger(ledger, { dim: c.dim, bold: c.bold }));
    }
    const skipped = budget.skippedModels;
    if (skipped.length) {
      notice({
        t: 'budget-cap-skipped',
        models: skipped,
        message: `cost cap skipped for ${skipped.join(', ')} — served by a keyless local endpoint that cannot bill, so there is nothing to cap`,
      });
    }
    // The agent record for this run: descriptors written by the subagents that
    // ran, intersected with the ids this run actually delegated to.
    const mySubs = listSubagents(config.cwd).filter((d) => delegated.includes(String(d.id)));
    const agentFiles = [...new Set(mySubs.flatMap((d) => (Array.isArray(d.filesTouched) ? d.filesTouched : [])))];
    const spend = budget.snapshot();
    costUsd = spend.costUsd;
    totals.in = spend.inputTokens;
    totals.out = spend.outputTokens;
    // A budget stop ends the run early, so it must not report success. 2 is the
    // same code the in-process OX_BUDGET_STOP throw and cmdAuto already carry.
    const code = failed ? 1 : budgetStopped ? 2 : denialCount > 0 ? 2 : 0;
    if (auto) {
      const goalText = full.trim();
      const files = [...touchedFiles];
      const status = budgetStopped ? 'budget-stopped' : failed ? 'error' : denialCount > 0 ? 'blocked' : 'complete';
      try {
        writeSessionNote(config.cwd, {
          phase: 'session-end',
          status: budgetStopped ? 'budget-stopped' : failed ? 'error' : 'ok',
          goal: goalText,
          files,
          decisions: lastAssistantText ? [truncate(lastAssistantText, 300)] : [],
          tokensIn: totals.in,
          tokensOut: totals.out,
          costUsd,
          model: target.model,
        });
      } catch {}
      try {
        writeEpisode(config.cwd, { goal: goalText, outcome: lastAssistantText, files, lessons: [] });
      } catch {}
      if (opts.json) {
        console.log(
          JSON.stringify({
            t: 'auto-summary',
            goal: goalText,
            status,
            files,
            toolCalls: toolCallCount,
            // What the subagents did, as its own field. Before this the whole
            // delegation was invisible in the auto summary except as one
            // opaque tool call.
            subagents: mySubs.map((d) => ({
              id: d.id,
              status: d.status,
              filesTouched: Array.isArray(d.filesTouched) ? d.filesTouched : [],
              lessons: Array.isArray(d.lessons) ? d.lessons.length : 0,
              error: d.error ?? null,
            })),
            inputTokens: totals.in,
            outputTokens: totals.out,
            costUsd,
            auxInputTokens: totals.auxIn,
            auxOutputTokens: totals.auxOut,
            ...(auxTarget ? { auxBot: auxTarget.bot ?? null, auxModel: auxTarget.model } : {}),
            session: session?.file ?? null,
          })
        );
      } else {
        const line = '─'.repeat(8);
        const auxPart = totals.auxIn || totals.auxOut ? ` · aux ${totals.auxIn}/${totals.auxOut} tok` : '';
        console.log(`\n${c.bold(`── ox auto summary ${line}`)}`);
        console.log(`goal:    ${truncate(goalText, 200) || '(empty)'}`);
        console.log(
          `status:  ${
            status === 'complete' ? c.green(status) : status === 'blocked' ? c.yellow(status) : c.red(status)
          } (exit ${code})`
        );
        console.log(`files:   ${files.length ? files.join(', ') : '(none)'}`);
        console.log(`tools:   ${toolCallCount} call(s)`);
        if (mySubs.length) {
          console.log(
            `agents:  ${mySubs.length} subagent(s) · ` +
              `${mySubs.filter((d) => d.status === 'failed').length} failed · ` +
              `files ${agentFiles.length ? agentFiles.join(', ') : '(none)'}`
          );
        }
        console.log(
          `tokens:  ${totals.in} in / ${totals.out} out${auxPart}${costUsd != null ? ` · ${formatCost(costUsd)}` : ''}`
        );
        if (session?.file) console.log(`session: ${session.file}`);
      }
    }
    // Learn from it: a task finished in several good steps becomes a draft
    // skill (never used until accepted). OX_LEARN=0 turns this off.
    // And from what you said: preferences and facts about yourself are kept in
    // ox's memory, so the next run starts already knowing them.
    if (process.env.OX_LEARN !== '0') {
      try {
        const said = [{ role: 'user', content: String(prompt ?? '') }];
        const learned = learnFromMessages(said, { source: session?.file ? path.basename(session.file) : 'headless' });
        if (learned.length && !opts.json) process.stderr.write(dimYellow(`· remembered: ${learned.map((r) => `"${r.memory.text}"${r.op === 'update' ? ` (replaces "${r.previous.text}")` : ''}`).join('; ')} — see them with: ox memory\n`));
        // How this project is tested / built / started, from the commands that worked.
        const { learnProjectCommands } = await import('./memory-graph.js');
        const cmds = learnProjectCommands(learnCalls, { cwd: config.cwd });
        if (cmds.length && !opts.json) process.stderr.write(dimYellow(`· remembered for this project: ${cmds.map((r) => r.memory.text).join('; ')}\n`));
      } catch {}
    }
    if (code === 0 && process.env.OX_LEARN !== '0') {
      try {
        const { draftFromSession, draftFromRecord } = await import('./skill-drafts.js');
        const drafted = session?.file
          ? draftFromSession(session.file, config.cwd)
          : draftFromRecord({ id: `run-${process.pid}-${Date.now()}`, task: String(prompt ?? ''), calls: learnCalls }, config.cwd);
        if (drafted && !opts.json) process.stderr.write(dimYellow(`· learned: drafted the skill '${drafted}' from this run — review it with: ox self-improve drafts\n`));
      } catch {}
    }
    return { code };
  } finally {
    await cleanupCtx(assembled);
    if (!process.stdin.isTTY) {
      try {
        process.stdin.pause();
        process.stdin.unref?.();
      } catch {}
    }
  }
}
