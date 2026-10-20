import { expandLlmsRefs } from './llms-txt.js';
import { parseBackendSpec } from './docker-backend.js';
import { buddyTurn, captureScreen } from './buddy.js';
import { dictate, verifyModel, whisperModel, whisperBinary, WHISPER_MODELS, MODELS_DIR, transcribeFile, projectVocabulary, cleanTranscript, correctVocabulary } from './dictation.js';
import { getCanvas, hasCanvas, canvasWidth, readOnlyRunner } from './tools/canvas.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { runAgent, applySubgoal, buildSummarizePrompt, draftContract, draftTitle, parseGates } from './agent.js';
// Persistent goal: an objective kept across turns, compaction and resume. The
// record is an event in the session transcript, so there is no parallel store to
// keep in sync and nothing to clean up beyond the transcript itself.
import {
  clearGoal,
  completeGoal,
  createGoal,
  evidenceFromGates,
  goalEvent,
  goalProgress,
  harvestEvidence,
  mergeGoalTodos,
  noteGoalStop,
  pauseGoal,
  progressSignature,
  proveGoalItems,
  renderCompletionRefusal,
  renderGoalReport,
  resumeGoal,
  GOAL_STATUS,
} from './goal.js';
import { buildPlan as planFirstBuildPlan, formatPlan, interactivePlanReview, savePlan } from './plan-first.js';
import {orchestrate, buildPlan} from './orchestrator.js';
import { KEY_ENV, PROVIDERS, defaultBotSpec, listBots, resolveBot } from './bots.js';
import { CONFIG_DIR, compactionKnobs, compactionModelChoice, compactionPassKnobs, loadConfig, resolveAuxTarget, saveConfigDoc } from './config.js';
import { buildContext, estimateTokens, pureCompact, expandContextRefs } from './context.js';
import { buildContextReport, contextBreakdownToJson, formatContextBreakdown } from './context-report.js';
import { formatLossReport, lossLedgerPath, readLossLedger } from './memory-loss.js';
import {
  appendEvent,
  buildSessionExport,
  createSession,
  forkSession,
  latestSessionFile,
  listSessions,
  loadSession,
  loadSessionWithStatus,
  HISTORY_STATUS,
  nextRewindId,
  pruneSessions,
  rewindPoints,
  rewindTo,
  searchSessions,
} from './session.js';
import {createCostBudget, formatCost, lookupModel, resolveModelWindow} from './cost.js';
import { installSkill } from './skill-add.js';
import { runMaxModePlanning, resolveMaxMode } from './maxmode.js';
import { assembleCtx, cleanupCtx, runHeadless } from './headless.js';
// Daemon continuity. The library half (src/daemon.js) owns every liveness
// decision; src/daemon-cmd.js is the rendering; src/daemon-worker.js is what a
// supervised run adds to the ordinary `-p` path. Imported eagerly because the
// four subcommands are cheap and the flag parse needs `--detach`/`--daemon-worker`
// recognized before anything else runs.
import { cmdAgents, cmdAttach, cmdDaemon, cmdShutdown, reportDetachedRun, startDetachedRun } from './daemon-cmd.js';
import {
  capabilityHeadline,
  capabilityReport,
  doctorCapabilityRows,
  DOCTOR_CHAIN_DEADLINE_MS,
  DOCTOR_PROBE_TIMEOUT_MS,
} from './capability.js';
// The library half, for the two things the `/schedule run-now` slash path must do
// itself: decide that a daemon exists, and hand a claimed schedule to the
// supervisor. It never spawns anything here — the supervisor is the only thing
// that may create a worker.
import { controlRequest as controlRequestFromCli, inspectDaemon, startDaemon } from './daemon.js';
import { runDaemonWorker } from './daemon-worker.js';
import {reflect as reflectSession} from './self-improve.js';
// /refine: reviews the current trajectory and applies small, evidence-backed
// updates to supplemental harness state. Never the base system prompt -- refine.js
// has no code path that can produce that file's path.
import { renderRefineCommand } from './refine.js';
import {
  listEpisodes,
  loadMemoryBlock,
  promoteEpisode,
  screenReadTexts,
  shortWithheldNotice,
  writeSessionNote,
  writeEpisode,
} from './memory.js';
import {
  adoptSkill,
  curateSkills,
  discoverSkills,
  purgeSkill,
  readSkillBody,
  recordSkillView,
  restoreSkill,
  screenSkillBody,
  skillScanDirs,
  withheldSkillBodyNotice,
  NAME_RE as SKILL_NAME_RE,
} from './skills.js';
import {
  buildPromptLayers,
  estimatePromptLayerTokens,
  loadPersona,
  renderContractBlock,
  summarizePromptLayers,
} from './system-prompt.js';
import { McpHub } from './mcp.js';
import { MCP_TEMPLATES, getTemplate, riskOf } from './mcp-templates.js';
import { assertSandboxPinCompatible, resolveSandbox, sandboxBackendFor, prepareSandbox } from './sandbox.js';
import { streamVia } from './providers/index.js';
import {
  c, renderError, renderMeter, renderToolEnd, renderToolStart, streamText, truncate,
  SubagentTicker, renderAgentTree,
} from './ui.js';
// One snapshot function, imported once, used by /agents. The registry is the
// only source of agent truth, so this command cannot disagree with the live
// count the ticker is printing or with the dashboard's rows.
import { agentSnapshot } from './subagent-registry.js';
// Cancel + steer. Imported once, at the top, because the `/agents` REPL command,
// the IPC control handler and the `ox agents` board must all reach the SAME
// functions: three local copies of a cancel is three chances for the report to
// say something different about what a cancel does.
import {
  cancelSubagent, steerSubagent, listSubagentControls, subagentCancelStats,
  CANCEL_SEMANTICS, SUBAGENT_STATUS_CANCELLED,
} from './subagent-control.js';
import { banner as oxBanner, intro as oxIntro } from './logo.js';
import { dispatchTool, listToolSchemas } from './tools/index.js';
import {handlePowerCommand} from './cmd-power.js';
import { listAgents, loadAgent, saveAgent, deleteAgent, resolveAgent, agentBotSpec, AGENT_NAME, renameAgent } from './agents.js';
import { MODES, MODE_NAMES, normalizeMode, resolveTurnMode } from './modes.js';
import { holdAwake } from './awake.js';
import { importAll } from './import.js';
import {getPlanCache, clearPlanCache} from './plan-cache.js';
import {createHierarchicalMemory} from './hierarchical-memory.js';
import {ReasoningDigest} from './reasoning-digest.js';
import {tocComp} from './toc-comp.js';
import {formatReport, computeStats} from './benchmark.js';
import { createPlatform } from './platform.js';
import { resolveTrustLevel, checkTrust, describeTrustLevel, saveTrustLevel, TRUST_LEVELS } from './trust.js';
import { createTrustApprovalWrapper } from './trust-gate.js';
import {AASCoreMcp, AAS_MCP_TOOLS, MAX_STACK_SIZE} from './aas-mcp.js';
import {validateStack, buildPlan as aasBuildPlan, formatStack, formatPlan as aasFormatPlan} from './aas-stack.js';
import {previewInstall, auditSkills, formatAuditReport, formatHostList} from './aas-cli.js';
import {createMemoryStore} from './memory-learn.js';
import { learnFromSession, findRecentSession } from './learn.js';
import {createBundleManager, listBundles} from './skill-bundles.js';
import { createArena } from './arena.js';
import { cmdSchedule as cmdScheduleStore, cmdCron, cmdHeartbeat } from './daemon-cmd.js';
import {
  addSchedule as addStoreSchedule,
  listSchedules as listStoreSchedules,
  getSchedule as getStoreSchedule,
  removeSchedule as removeStoreSchedule,
  updateSchedule as updateStoreSchedule,
  readPolicy as readSchedulePolicy,
  writePolicy as writeSchedulePolicy,
  parseIntervalSpec as parseScheduleInterval,
  parseCadenceToken as parseScheduleCadenceToken,
  scheduleRunStatus as scheduleNextRunStatus,
  claimSchedule as claimScheduleThroughStore,
} from './schedule.js';
import {BACKENDS, createBackendManager} from './backends.js';
import { createVoiceMode } from './voice-mode.js';
import { createAcpServer } from './acp.js';
import {inspectProject, formatInspect} from './inspect.js';
import {createCodebaseIndex, formatSearchResults} from './codebase-index.js';
import { createResearchBrain } from './brain-research.js';
import { startServer } from './serve.js';
import { DEFAULT_APPROVAL_TIMEOUT_MS, controlReply, createIpcServer, socketPathFor } from './ipc.js';
import { WATCH_DEFAULT_FPS, runWatch } from './ipc-watch.js';
import { islandRunning } from './island.js';
import { expandCommand, listCustomCommands } from './plugins.js';
import { createLedger, renderLedger } from './ledger.js';
import {createVerifier, formatVerificationReport} from './verify-loop.js';
import {createSpecTracker} from './spec-tracker.js';
import {createArchMemory, exportArchitectureContext} from './arch-memory.js';
import {createRegressionGuard} from './regression-guard.js';
import {createCodeReviewer, formatReviewReport} from './code-review.js';
import {createTeamWorkflows} from './team-workflows.js';
import {pickModel, listCandidates, makeTask, ollamaReachability} from './model-registry.js';
import { listTasks, addTask, getTask, updateTask, deleteTask, runTask, claimTask, releaseTask, completeTask, approveTask, rejectTask, nextTask, goalChain, taskBrief, addSpend, taskActivity } from './tasks.js';
import {
  createLocalRunner, LOCAL_MODELS, recommendLocalModel,
  scanLocalEndpoints, approveEndpoint, forgetEndpoint, readTrustRecords,
  approvalQuestion, canPrompt, presetModelWarning, listModels, formatModelSize,
  formatLocalModelList,
} from './local-inference.js';
import {createModelBenchmarker, MODEL_BENCHMARKS} from './model-benchmark.js';
import {formatModelRecommendation} from './model-router.js';
import * as osint from './osint.js';
import * as userProfile from './user-profile.js';
// package.json's version, the one `ox --version` prints (bin/ox.js) and the release is tagged with.
const VERSION = (() => { try { return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version; } catch { return '0.0.0'; } })();

// The banner is for humans on a terminal. Piped/CI runs stay byte-identical to
// the plain `ox ${VERSION}` line that scripts and tests match on.
function printVersion() {
  if (process.stdout.isTTY) {
    console.log(`${oxBanner({ version: VERSION })}\nox ${VERSION}`);
  } else {
    console.log(`ox ${VERSION}`);
  }
}
const SUBCOMMANDS = new Set(['version', 'help', 'bots', 'prompt', 'sessions', 'session', 'history', 'doctor', 'mcp', 'skill', 'clone', 'episode', 'mem', 'memory-loss', 'auto', 'schedule', 'heartbeat', 'agent', 'agents', 'daemon', 'attach', 'shutdown', 'plan-cache', 'hmem', 'reason', 'toc', 'voice', 'video', 'benchmark', 'model', 'models', 'bench', 'local', 'platform', 'aas', 'brain', 'kanban', 'arena', 'connect', 'mail', 'awake', 'do', 'watch', 'gateway', 'cron', 'backend', 'inspect', 'acp', 'bundles', 'index', 'voice-mode', 'self-improve', 'verify', 'spec', 'arch', 'regression', 'review', 'workflow', 'import', 'task', 'serve', 'clicky', 'listen', 'ipc', 'refine', 'island', 'plugin', 'plugins', 'app', 'speak', 'memory', 'hook', 'hook-relay', 'hooks', 'market', 'create', 'usage', 'hf', 'name', 'evolve', 'update', 'system1', 'flow', 'flows', 'dictionary', 'mcp-mac', 'secure', 'build', 'port', 'graph', 'transfer', 'handoff', 'statusline', 'org', 'mesh', 'pr', 'env', 'trace', 'traces', 'dictation', 'research', 'library', 'race', 'git', 'wiki', 'studio', 'browse', 'theme', 'commands', 'make', 'office']);
const SLASH_HELP = [
  `${c.bold('commands')}`,
  '  /help                 show this list',
  '  /bot [name]           show or hot-switch bot (keeps conversation)',
  '  /model <spec>         switch model, e.g. anthropic:claude-haiku-4-5',
  '  /auxbot [name]        show or set the auxiliary bot used for cheap calls (compaction, verifier, max-mode)',
  '  /soul                 persona sources (~/.ox/soul.md, ./SOUL.md): paths + status',
  '  /cost                 token + spend totals',
  '  /ui                   redraw the last canvas (type a number to press its buttons)',
  '  /screen [question]    ask about what is on your screen (attaches a screenshot)',
  '  /island on|off|status turn the notch island on or off (remembered across runs)',
  '  /compact              summarize older history to shrink context',
  '  /context              per-segment context breakdown: system / tool schemas / history / latest input',
  '  /clear                wipe in-memory context (session file kept)',
  '  /mode [name]          auto | code | ask | plan | debug | data | orchestrate (enforced at the tool gate)',
  '  /plan                 toggle plan mode (read-only tools)',
  '  /tools                list available tools',
  '  /mem [query]          rank learned memory by TF-IDF (bare /mem prints the tally)',
  '  /memory               show project memory (.agent/MEMORY.md)',
  '  /memory-loss [--limit n]  what the memory subsystem archived / evicted / refused / deleted, and when (read-only)',
  '  /skill <name>         load a skill body into context',
  '  /refine                review the current trajectory for evidence-backed refinements (dry run)',
  '  /refine apply [file]   apply reviewed proposals: supplemental guidance, memories, skill descriptions, subagent specs',
  '  /refine history|undo   recorded refinement history (applied AND rejected, with reasons) / roll back a snapshot',
  '  /mcp                  MCP server status',
  '  /session              current session info',
  '  /resume <id|path>     load another session into context',
  '  /goal <text>          set a PERSISTENT goal: kept across turns, compaction and resume (also drafts a contract)',
  '  /goal                 show the active goal + proven progress',
  '  /goal done            mark complete — REFUSES and names items until every one is proven',
  '  /goal pause           stop pursuing it, keep it',
  '  /goal resume          pursue it again',
  '  /goal clear           remove it',
  '  /subgoal <criterion>  append a criterion to the contract verification field',
  '  /gates                show current shell quality-gate states',
  '  /schedule                        list every schedule: cadence, cap, next run, last result',
  '  /schedule add <cadence> "<text>"  cadence = 30s | 5m | 2h | 1d, or an ISO time (2026-10-04T09:00:00Z)',
  '  /schedule enable|disable <id>   /schedule remove <id>   /schedule remove-all',
  '  /schedule run-now <id>           claim it and dispatch it through the daemon NOW',
  '  /schedule opt-in | opt-out       the daemon-wide switch — OFF until you opt in',
  '  /heartbeat                       this session: heartbeat state + goal progress',
  '  /heartbeat every <30s|5m|2h>     re-enter THIS session on an interval and advance its goal',
  '      unattended work needs TWO opt-ins: the daemon-wide `ox schedule opt-in`, and',
  '      `--enable` on the row itself. A schedule may only carry --max-cost/--bot/--model —',
  '      it can never set its own sandbox profile, trust level, approval policy or API keys.',
  '  /fork                 fork the current session',
  '  /rewind [n]           list rewind points, or rewind the conversation to turn n (files untouched)',
  '  /sandbox [name]       show OS sandbox state; switching mid-session is refused (session-pinned)',
  '  /verify               toggle the independent goal verifier (audits each final answer)',
  '  /verify-status        show verifier state and its default source',
  '  /max [n]              Max Mode: N planning passes pick a best plan before each run (off <=1, cap 5)',
  '  /yolo                 toggle approval skipping',
  '  /strict               toggle strict approvals (disables the read-only auto-approve classifier)',
  '  /trust [level]         show or set trust level: paranoid|strict|balanced|trusted|yolo',
  '  /patterns             show procedural memory stats and recent patterns',
  '  /agents               live agent tree: lead + active/stale subagents, task, elapsed, current tool',
  '  /agents cancel <id>   cancel a running subagent (no further steps; an in-flight request may finish)',
  '  /agents steer <id> .. queue a steering note; it lands at the agent\'s next turn boundary',
  '  /doctor               environment checks',
  '  /exit, /quit          save episode and exit',
  '  /osint <cmd> <target> OSINT: email|username|domain|ip|breach|shodan|vt|censys|abusedb|github|dns|dorks|footprint|paste|phone|whois|subdomain|url|sanctions',
  '  /profile show         show current profile + volatile context',
  '  /profile habit <text> add a habit to profile',
  '  /profile preference <text> add a preference to profile',
  '  /profile fact <text>  add a fact to profile',
  '  /profile project <name> set current project',
  '  /profile task <desc>  set current task',
  '  /profile state <desc> set current state',
  `  /init                analyze project, save initial memory entries',
  /commit [msg]        draft conventional commit from git diff and commit',
  /review              code review unstaged/staged changes',
  /test [path]         generate tests for a file (or ask which file)',
  /explain [path]      explain a file or code snippet in detail',
  /fix                 run detected linter and fix reported issues',
  /refactor [path]     suggest refactorings for a file',
  /doc [path]          add JSDoc/docstrings to a file',
  /migrate <desc>      plan + execute a code migration',
  !<cmd>                run a shell command (denylist applies; approvals do not gate ! commands)
  `,
  '  /pcache               show plan cache stats and cached templates',
  '  /pcache clear         clear the plan cache',
  '  /hmem                 show hierarchical working memory (active subgoals + observations)',
  '  /hmem <goal>          add a subgoal to working memory',
  '  /reason               show reasoning digests + sliding window state',
  '  /toc                  run TOC-Comp compression on the current context and report the ratio',
  '  /voice                voice agent MCP status (STT/TTS servers)',
  '  /video                video generation MCP status (T2V/I2V/V2V servers)',
  '/benchmark            run agent benchmarks and show results',
  '/platform             show platform status and available subsystems',
  '  /clone <url>          clone a website into Next.js/Vite/plain HTML',
  '  /aas                  AAS Core: search catalog, compose stack, validate, plan, install',
  '  /aas search <query>   search the AAS skill catalog',
  '  /aas stack <ids>      compose a stack from skill IDs (comma-separated)',
  '  /aas validate <ids>   validate a skill selection',
  '  /aas plan <target>    build an immutable install plan for a target host',
  '  /aas hosts            list supported agent hosts and install paths',
  '  /aas install <host>   preview or execute a host skill install',
  '  /aas audit <dir>      audit a skill directory for safety signals',
].join('\n');

// `/help` in the chat: the everyday commands on one screen; `/help all` for the
// full list, `/help <word>` for the lines that mention it.
export function slashHelp(arg = '') {
  const q = String(arg).trim().toLowerCase();
  if (q === 'all') return SLASH_HELP;
  if (q) {
    const hits = SLASH_HELP.split('\n').filter((l) => l.toLowerCase().includes(q));
    return hits.length ? hits.join('\n') : c.dim(`no command mentions '${q}' — /help all lists everything`);
  }
  const row = (cmd, what) => `  ${cmd.padEnd(22)}${c.dim(what)}`;
  return [
    c.bold('Talk and switch'),
    row('/model <spec>', 'switch model, conversation kept (/bot for presets)'),
    row('/screen [question]', 'ask about what is on your screen'),
    row('/mode [name]', 'auto · code · ask · plan · debug · data · orchestrate'),
    row('/plan', 'read-only mode: look and plan, change nothing'),
    row('/yolo', 'skip approvals (dangerous commands stay blocked)'),
    c.bold('Context and cost'),
    row('/cost', 'tokens and spend so far'),
    row('/context', 'what fills the context window'),
    row('/compact', 'summarize older history'),
    row('/clear', 'start fresh (the session file is kept)'),
    c.bold('Goals and agents'),
    row('/goal <text>', 'a goal ox keeps working toward and proves'),
    row('/agents', 'live subagents: cancel or steer them'),
    row('/rewind [n]', 'go back to an earlier turn'),
    c.bold('This session'),
    row('/session', 'id and file; /resume <id>, /fork'),
    row('/ui', 'redraw the last canvas; type 1, 2… to press its buttons'),
    row('/island on|off', 'the notch island'),
    row('/exit', 'save and leave'),
    c.bold('ox tools'),
    row('/browse "<goal>"', 'the fast browser does a task on a website'),
    row('/studio · /create', 'images, video and sound with open models'),
    row('/theme "<look>"', 'restyle the app from a sentence'),
    row('/library · /research', 'your saved reading; what the web says'),
    row('/pr · /org · /mesh', 'pull requests, your agent company, your machines'),
    '',
    c.dim('/commands for every ox command · /help all for everything · /help <word> to search'),
  ].join('\n');
}

// `ox help` / `ox --help`: what you can do, on one screen. Every flag and
// subcommand detail lives in usageAll() (`ox help all`), and one section of it
// is `ox help <topic>`.
function usage() {
  const row = (cmd, what) => `  ${cmd.padEnd(34)}${c.dim(what)}`;
  console.log([
    `${c.bold(`ox ${VERSION}`)} — a fast, frugal coding agent`,
    `usage: ox [-p "<task>"] [flags]   ·   ox <command> [args]`,
    '',
    c.bold('Start'),
    row('ox', 'chat with ox in this project'),
    row('ox -p "fix the failing test"', 'one task, then exit (--image, --max-cost, --json)'),
    row('ox auto "<goal>"', 'a long run with checkpoints and verification'),
    row('ox app', 'ox in its own window (Mac app; app window on Windows/Linux)'),
    row('ox serve', 'OpenAI-compatible API + web chat on 127.0.0.1:8080'),
    row('ox connect', 'use a plan you already pay for: Claude, ChatGPT, Gemini, Qwen, Kimi, ...'),
    row('ox mail draft --from --to', 'an email draft in Mail, from the account you name'),
    row('ox awake [2h|off|--lid]', 'keep the computer awake for your agents (automatic while ox works)'),
    row('ox do "open notes"', 'small tasks offline, no AI needed: apps, search, timers, notes, math'),
    row('ox watch add <url> --price-below 99', 'tell me when a page changes, shows text, or a price drops'),
    '',
    c.bold('Tasks and teams'),
    row('ox task', 'the task board: add, next, claim, done, approve, log'),
    row('ox schedule', 'recurring runs (opt-in), ox heartbeat, ox cron'),
    row('ox daemon', 'keep agents running in the background; ox agents, ox attach'),
    '',
    c.bold('Models and cost'),
    row('ox models', 'browse and switch models; ox model, ox bots, ox local'),
    row('ox bench', 'benchmark models on your machine'),
    row('ox doctor', 'check keys, providers, tools and the environment'),
    '',
    c.bold('Extend'),
    row('ox skill', 'skills: ls, add, new, curate'),
    row('ox plugin', 'Claude Code plugins: add, import-claude, ls'),
    row('ox mcp', 'MCP servers: add, test, remove'),
    row('ox agent new <name>', 'your own agent: a bot, a mode and instructions; run with --agent'),
    '',
    c.bold('History and memory'),
    row('ox sessions', 'past sessions; ox history <query>, ox episode'),
    row('ox mem', 'what ox remembers about this project'),
    '',
    c.bold('Mac'),
    row('ox island', 'live runs, approvals and OX Buddy in the notch (on, off)'),
    row('ox backend', 'where commands run: local or a Docker container'),
    '',
    c.bold('Check'),
    row('ox verify', 'syntax, smoke, unit, bench and live checks'),
    row('ox prompt', 'the exact system prompt ox sends, layer by layer'),
    '',
    `  ox <subcommand>   ${c.dim('version | help | task | serve | skill | mcp | plugin | island | backend | doctor')}`,
    '',
    `${c.dim('Details:')} ox help <topic> ${c.dim('(task, serve, skill, mcp, autonomy, ipc, sessions, flags, …)')} · ox help all`,
    `${c.dim('In the chat:')} /help`,
  ].join('\n'));
}

/** The real subcommand closest to a typo (edit distance <= 2), or null. */
export function closestCommand(word) {
  const w = String(word ?? '').toLowerCase();
  const dist = (a, b) => {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
    }
    return d[a.length][b.length];
  };
  let best = null;
  for (const c of SUBCOMMANDS) {
    const n = dist(w, c);
    if (n <= 2 && (!best || n < best.n)) best = { c, n };
  }
  return best?.c ?? null;
}

// The section of usageAll() whose header matches `topic` ("tasks:" for "task").
function usageTopic(topic) {
  const full = captureUsageAll();
  const want = String(topic).toLowerCase().replace(/s$/, '');
  const lines = full.split('\n');
  const start = lines.findIndex((l) => /^[a-z][a-z /&-]*:$/.test(l) && l.slice(0, -1).replace(/s$/, '') === want);
  if (start < 0) return false;
  const end = lines.findIndex((l, i) => i > start && /^[a-z][a-z /&-]*:$/.test(l));
  console.log(lines.slice(start, end < 0 ? undefined : end).join('\n').trimEnd());
  return true;
}

function captureUsageAll() {
  const log = console.log;
  let out = '';
  console.log = (s) => { out += `${s}\n`; };
  try { usageAll(); } finally { console.log = log; }
  return out;
}

function usageAll() {
  const lines = [
    `ox ${VERSION} — featherweight coding agent`,
    '',
    'usage:',
    '  ox                      interactive REPL',
    '  ox -p <prompt words>    one-shot headless run',
    '  ox <subcommand>         version | help | bots | prompt | sessions | history [query] | doctor | mcp | skill [name|ls|new|rm|path|add] | episode [ls|promote <id>] | mem | memory-loss | agent',
    '',
    'prompt:',
    '  ox prompt              the assembled system prompt with its layer breakdown: kind, bytes,',
    '      [--breakdown]    ~tokens and hash per layer, then the cacheable prefix vs the volatile',
    '                         tail (no model call; this is the text a run actually sends)',
    '',
    'memory:',
    '  ox memory-loss [--limit n]  the loss ledger: every artefact the memory subsystem archived,',
    '      evicted, refused or deleted, with the reason and the timestamp (read-only;',
    `      rows live in ${lossLedgerPath()})`,
    '',
    'skills:',
    '  ox skill ls                     table of discovered skills: name/source/trigger/description (+warnings)',
    '  ox skill new <name> [--global]  scaffold a SKILL.md template (default ~/.agents/skills/<name>; --project uses ./.agents/skills)',
    '      [--project] [--force]         --force overwrites an existing scaffold',
    '  ox skill rm <name> [--yes]      delete a skill directory across scan dirs (asks on TTY; non-TTY needs --yes)',
    '  ox skill path <name>            print the absolute SKILL.md path (exit 1 if missing)',
    '  ox skill <name>                 print a skill body',
    '  ox skill add <dir>              install a local skill directory (SKILL.md required)',
    '  ox skill add owner/repo[/path]  install from raw.githubusercontent.com (HEAD, then main, then master)',
    '  safety scan refuses installs with denylist hits unless --force; receipt appended to ~/.ox/skills-install.log',
    '  ox skill curate [--dry-run]     lifecycle pass: archive stale skills (snapshot + ledger); --dry-run reports only',
    '  ox skill pin|unpin <name>       curator immunity via config skill_pins',
    '  ox skill restore <name>         bring the latest snapshot back to its active path',
    '  ox skill adopt <name>           start tracking an unmanaged skill (fresh .usage.json sidecar)',
    '  ox skill purge <name> [--yes]   delete an archived skill + old snapshots (non-TTY needs --yes)',
    '',
    'mcp:',
    '  ox mcp [ls]                     table of configured servers: name/type/risk/status/tools',
    `  ox mcp add <template>           curated registry: ${Object.keys(MCP_TEMPLATES).join(' ')}`,
    '      [--global] [--yes] [--force]  write ./.mcp.json (default) or ~/.ox/config.json; --yes skips review; --force overwrites',
    '  ox mcp remove <name> [--global] delete entry (project .mcp.json takes precedence)',
    '  ox mcp test <name>              initialize + tools/list one server; prints tools + latency',
    '',
    'autonomy:',
    '  ox auto "<goal>" [flags]        long-horizon headless run: forced --verify, 80 iterations, checkpoints + summary block',
    '      [--contract ["<goal>"]]       draft a goal contract (aux model) and enforce its shell quality gates;',
    '                                    with no value the positional goal is used as the contract source',
    '      [--max-cost <usd>] [--json] [--bot <name>] [--model <spec>] [--yes-edits] [-y] [--side-effects-ok] [--cwd <dir>]',
    '      refuses -y while money-risk MCP servers are configured unless --side-effects-ok (exit 4)',
    '  ox agent                        your own agents: ox agent new <name> --bot --mode --prompt; run with --agent',
    '  ox agent save <name> --provider <p> --model <m> [--base-url <u>] [--system-prompt <text>]',
    '  ox agent use <name>             show a saved agent (provider/model/url/skills)',
    '  ox agent delete <name> [--yes]  delete a saved agent',
    '',
    'tasks:',
    '  ox task list [--status <s>]       the board: owner, budget, blockers (pending|running|in_review|blocked|done|failed)',
    '  ox task add <title>               add a task; --parent <id> puts it under a goal, --blocked-by <id,id>,',
    '      [--budget <usd>] [--review]     --budget is a hard spend cap, --review requires an approval to finish',
    '      [--description <d>] [--tags <a,b>] [--cron <cron>]',
    '  ox task next [--as <name>]        claim the oldest ready task and print its brief (goal chain, budget, notes)',
    '  ox task claim|release <id> [--as <name>]   take or give back a task (one owner at a time)',
    '  ox task done <id> [--note <text>] [--failed]   finish it (goes to review when --review was set)',
    '  ox task approve|reject <id> [--note <text>]   decide a task in review',
    '  ox task brief <id>                what an agent is told: the task, the goals above it, notes',
    '  ox task spend <id> <usd>          record spend; past the budget the task is blocked',
    '  ox task log [<id>] [--limit n]    activity: who did what, when',
    '  ox task get|run|update|delete <id>',
    '  ox task assign <id> <agent|none>  give a task to an org agent (its heartbeat picks it up)',
    '',
    'org (a company of agents, after Paperclip):',
    '  ox org                            the org chart: who reports to whom, runtime, budget, state',
    '  ox org hire <name> [--title T] [--reports-to <id>] [--runtime ox|claude-plan|chatgpt-plan|<bot>]',
    '      [--budget <usd/month>] [--every <minutes>] [--instructions <text>] [--cwd <dir>]',
    '      [--approval read|edits|all]   unattended, edits (default) changes files in --cwd; commands are declined',
    '      [--machine <paired machine>]  its runs happen on that machine (ox mesh; it must allow tasks there)',
    '  ox org hire "<a sentence>" [--draft]   the job in your words: name, title, schedule, budget, runtime filled in',
    '  ox org approve|reject <id>        decide a hire an agent proposed',
    '  ox org pause|resume|fire <id>     stop or restart waking an agent',
    '  ox org set <id> [--budget n|none] [--every n|none] [--title T] [--reports-to id] [--runtime r]',
    '  ox org beat <id> | --due          wake an agent now (or every agent that is due): it runs its next task',
    '  ox org log                        hires, approvals, pauses, budget warnings and stops',
    '  ox org tell <id> "<message>" [--now]   give an agent work in words; --now wakes it',
    '  ox org thread <id>                its runs: what it was asked and what it said',
    '  ox org timeline                   who did what, every tool call, and the count of irreversible actions',
    '  ox org team "<sentence>" [--draft]   the chief sets up a whole team and its group chat; ox org say <team> "…"; ox org group <team>',
    '  ox skill from <book.pdf|folder>   a book or docs → a skill: an index plus chapters read only when needed',
    '',
    'library: ox library [add <url|pdf> | read | ask <id> "q" | search]   saved articles and PDFs; highlight and ask in the app',
    'commands: ox commands [list | install [--claude] [--codex] [--cursor] | uninstall]   every ox command as /name, here and inside Claude Code, Codex, Cursor',
    'theme: ox theme ["<look>" | list | use <name> | reset]   restyle the app from a sentence (neumorphic, glass, paper, terminal, contrast…)',
    'browse: ox browse "<goal>" [--url <page>] [--show] [--model <id>]   the fast browser: one goal, a checked finish, asks before buy/pay/send',
    'studio: ox studio [models [kind] | recipes [name] | connect | mcp]   open image and video models for any agent (Claude, Codex, Cursor)',
    'video: ox video transcribe|captions|cut|speed|vertical|highlights|gif|polish|understand <file> …   on this machine',
    '       ox video explain "<title>" "Step: what happens" …   an explainer video, a slide per step with a lit diagram',
    '       ox video animate <video|transcript|"script"> [--aspect 9:16]   scene-by-scene motion animations with sound effects',
    'traces: ox trace [--signals] | ox trace <id> [--steps]   each run: turns, tokens, cost, tool calls, and "stuck" signals',
    '',
    'pull requests (until they can merge; merging stays yours):',
    '  ox env [show|detect|check]        how this repo installs, lints, builds, tests (.ox/environment.yml, saved once)',
    '  ox pr open [--title T] [--draft] [--shots /,/pricing]  branch, commit, checks, push, PR; --shots adds the running app\'s pages and a GIF',
    '  ox pr status | comments           CI checks, review state and comments',
    '  ox pr fix [--rounds n]            review comments and failing CI become one ox task; committed and pushed',
    '  ox task run <id> --worktree [--pr]   a task in its own worktree and branch, then a PR from it',
    '  ox race "<task>" --agents ox,claude-plan,<model>   several agents on one task, side by side; ox race keep <id> <agent>',
    '  ox git clone <url> [dir]          clones that borrow history from one local mirror (no second download)',
    '  ox wiki [--out dir]               the project\'s wiki from its code graph: subsystems, files, what uses what',
    '',
    'mesh (your own machines as one ox; every file, key and model stays on its machine):',
    '  ox mesh                           this machine, your paired machines, their health and alerts',
    '  ox mesh name <name>               name this machine ("Studio Mac")',
    '  ox mesh invite                    show a one-time code (10 min) for another machine to join',
    '  ox mesh join <code> [--name N] [--at host:port]   pair this machine (--at: across networks, e.g. Tailscale)',
    '  ox mesh allow|deny <machine> <grant|preset>   what that machine may ask of THIS one: status, infer, tasks, files, agents; presets viewer, helper, full',
    '  ox mesh describe <machine>        its makeup: chip, cores, memory, GPU, disks, OS, agent tools, models, keys (names)',
    '  ox mesh agents <machine> [read <id>]   the agent sessions running there, and what one said',
    '  ox mesh ls <machine>[:<folder>] · ox mesh pull <machine>:<file> [<here>]   its shared folders',
    '  ox mesh share <machine> <folder>…  which folders of THIS machine that one may browse (default: home)',
    '  ox mesh audit · ox mesh lockdown  what other machines asked here · every machine back to status only',
    '  ox mesh forget <machine>          unpair',
    '  ox mesh up [--port n]             run this machine\'s node in the foreground (the OX app runs it too)',
    '  ox mesh models                    every model your machines offer, as mesh:<machine>/<model>',
    '  ox mesh run <machine> "<task>" [--in <folder>]   an ox task on that machine, under its own approvals',
    '      use another machine\'s model anywhere a model goes:  ox --model "mesh:Gaming laptop/qwen2.5:7b" -p "…"',
    '',
    'serve:',
    '  ox serve [--port <port>] [--host <host>] [--api-key]   start HTTP server (OpenAI-compatible API)',
    '      default port 8080, host 127.0.0.1; --api-key reads OX_SERVE_API_KEY from env',
'      routes: GET /health, GET /v1/models, GET /v1/models/:id,',
'              POST /v1/chat/completions, POST /v1/responses  (every error OpenAI-shaped)',
'      /v1/models is generated from the bot registry, so every id listed is a real bot',
'      /v1/responses is the core text shape only (no store, conversations, client tools)',
'      auth: no key = open (loud warning at startup); a non-loopback --host with no key is',
'            REFUSED, because an unauthenticated ox endpoint runs code as this user',
'            (OX_SERVE_ALLOW_UNAUTHENTICATED=1 overrides it, at your own risk)',
    '      runs until SIGINT/SIGTERM',
    'ipc:',
    '  ox ipc serve [--socket <path>] [--approval-timeout <ms>]',
    '      run the GUI bridge in the foreground and print the resolved socket path',
    '      (default: <tmpdir>/ox-ipc-default.sock; --approval-timeout caps how long a connected',
    '       client may hold an approval before ox gives up and falls back to declining)',
    '  ox ipc status [--socket <path>]  report whether a bridge is listening (exit 1 when it is not)',
    '  ox island [start|stop|on|off|status|build]  OX Island: live runs, approvals and OX Buddy in the',
    '      MacBook notch (macOS). Every ox run connects while it runs; OX_ISLAND=0 opts one run out,',
    '      `ox island off` turns it off until `ox island on`',
    '  ox ipc watch [--socket <path>] [--fps <n>] [--plain]',
    '      live dashboard in this terminal: session, current tool, turns/tokens/cost, and a',
    '      keyboard approval panel (a = allow, d = deny, s = fall back to the terminal prompt,',
    '      q = quit). Needs a bridge (`ox ipc serve`, or a run started with --ipc) and exits',
    '      non-zero when there is none. Off a TTY it becomes a plain line log (no answering);',
    '      --fps defaults to ' + WATCH_DEFAULT_FPS + '. NO_COLOR is honoured in both modes.',
    '  --ipc[=<path>]                   with -p or the REPL: start the bridge for THIS run and close it',
    '      on exit (SIGINT/SIGTERM too); default socket unless =<path>. OX_IPC_APPROVAL_TIMEOUT_MS',
    '      caps the approval hold. Wire: newline-delimited JSON, {hello,event,approval-request,pong}',
    '      down / {ready,approval-answer,ping} up. Silence (no client, no answer, timeout, disconnect)',
    '      always DECLINES — an out-of-band client can never silently allow.',
    '',
    'daemon continuity:',
    '  ox daemon start                 start the supervisor detached; idempotent (a concurrent start never',
    '                                  spawns a second one). Writes ~/.ox/daemon/daemon.json + c.sock',
    '  ox daemon status                running/stopped, pid, uptime, worker count (exit 1 when stopped)',
    '  ox daemon stop [--force]        stop the workers, then the supervisor',
    '  ox daemon doctor [--fix]        inspect the pidfile / socket perms / orphaned workers; --fix repairs',
    '                                  what is safely repairable (never signals a recycled pid)',
    '  ox daemon log [--lines <n>]     the supervisor\'s own account of what it did',
    '  ox agents cancel <id> cancel one subagent in the run behind the IPC bridge (ox --ipc)',
  '  ox agents steer <id> <note>  queue a steering note for one subagent in that run',
  '  ox agents [--json] [--limit <n>] running (live worker) / idle (detected, no live worker) /',
    '                                  saved (transcript on disk, no worker)',
    '  ox attach <id> [--no-replay]    stream a running session live and answer its approvals;',
    '                                  DETACHING LEAVES THE WORKER RUNNING (q or ctrl-c to let go)',
    '  ox shutdown [--force]           stop workers + supervisor',
    '  ox -p "<task>" --detach         run the session as a worker under the supervisor and return at once;',
    '                                  starts a supervisor if none is running (and says so). Reattach with',
    '                                  `ox attach <id>`. The control socket is a privilege boundary: 0700',
    '                                  dir, 0600 socket, and every path there is ownership-screened.',
    '  ox schedule add "<prompt>"      a schedule that runs INSIDE the daemon',
  '  ox schedule "<goal>" [--install]  print (or install) a system crontab block for it',
  '  ox cron ...                     the old name for `ox schedule`; same store, free-text cadence',
    '      [--every <30s|5m|2h>] [--at HH:MM] [--max-cost <usd>] [--cwd <dir>]',
    '      [--bot <name>] [--model <spec>] [--enable]',
    '  ox schedule list|enable|disable|remove|remove-all|run-now|policy|opt-in',
    '  ox schedule print-crontab "<goal>"  PRINT a crontab block for humans; ox installs nothing',
    '  ox heartbeat start [<session>] [--every <5m>] [--max-runs 3]',
    '                              re-enter an existing session and advance its persistent goal;',
    '                              stops when the goal completes, is paused, or the budget is spent',
    '',
    'import:',
    '  ox import <claude-code|hermes|codex|all> [--dry-run]  import skills, MCP servers, and memory from another agent tool into ox',
    '      [--dry-run]             report what would be imported without writing anything; without it',
    '                              skills are copied to ~/.agents/skills, MCP servers are merged into ./.mcp.json,',
    '                              and memory files are appended to ./.agent/',
    'sessions:',
    '  ox sessions                     table of recent sessions (id/date/cwd/title/first prompt)',
    '  ox sessions resume <prefix>     resume a session by id OR title prefix in the REPL',
    '  ox session export (<id>|latest) [--format md|jsonl] [--redact] [--out <file>]',
    '                                  readable markdown transcript (default) or verbatim JSONL events;',
    '                                  --redact strips common secret shapes; --out writes with 0600 perms',
    '  ox session prune [--older-than <Nd>] [--dry-run]',
    '                                  delete ~/.ox/sessions files older than N days (default 90); --dry-run lists only',
    '',
    'flags:',
    '  -p, --print                    headless: run one prompt and exit',
    '      --json                     emit JSONL agent events (with -p)',
    '  -c, --continue                 continue the most recent session',
    '      --resume <id|path>         resume a specific session',
  '      --bot <name>               pick a bot (see: ox bots)',
  '      --model <spec>             provider:model override',
  '      --aux-bot <name>           auxiliary bot for cheap calls: compaction, verifier, max-mode',
    '      --max-cost <usd>           stop subsequent work at this spend (0 disables paid work)',
    '      --image <file>             attach an image (png/jpg/gif/webp) to the prompt; repeatable',
    '      --backend <where>          run the agent\'s commands: local (default) | docker | docker:<image>[:offline]',
    '      --verify                   independent goal verifier audits final answers',
      '      --repo-map                include repo structure map in system prompt',
      '      --context                print the per-segment context breakdown and exit (no model call)',
    '      --trust <level>            trust level: paranoid|strict|balanced|trusted|yolo (overrides config)',
    '      --max-mode <n>             MiMo Max planning: N candidate plans judged before the run (2-5)',
    '      --routing <strat>   model selection strategy: pinned|cost|quality|fast (default: cost)',
    '      --orchestrate              run the prompt with the multi-agent team (planner + coder + reviewer)',
    '      --yes-edits                auto-approve file writes',
  '      --strict-approvals         disable the read-only auto-approve classifier (everything prompts)',
    '      --side-effects-ok          authorize money-risk MCP servers under -y / ox auto (see docs/autonomy.md)',
    '      --ipc[=<path>]              GUI bridge for this run: live events + out-of-band approvals (see `ox ipc serve`)',
    '      --detach                    with -p: run the session as a supervised worker and return immediately',
    '      --sandbox <profile>        OS sandbox for child processes: off | workspace | read-only | strict (or a',
    '                                 custom profile name from ~/.ox/sandbox.json / ./.ox-sandbox.json)',
    '      --rewind <n>               with --resume/--continue: rewind the conversation to rewind-point n',
    '                                 before the new turn (append-only; files on disk are NOT reverted)',
    '  -y, --dangerously-skip-approvals   skip all approvals',
    '      --plan                     plan mode (read-only)',
    '      --mode <name>              auto | code | ask | plan | debug | data | orchestrate',
    '      --agent <name>             run as a saved agent (its bot, mode and instructions)',
    '      --cwd <dir>                workspace directory',
    '  -h, --help                     show help',
    '  -v, --version                  print version',
    '',
    SLASH_HELP,
  ];
  console.log(lines.join('\n'));
}

const dimItalic = (s) =>
  process.stdout.isTTY && !process.env.NO_COLOR ? `\x1b[2;3m${s}\x1b[22;23m` : String(s);

function idFromSessionFile(file) {
  const base = path.basename(String(file ?? ''));
  const m = base.match(/-([0-9a-f]{6})\.jsonl$/);
  return m ? m[1] : base.replace(/\.jsonl$/, '');
}

// Resolve a session reference to a file path: explicit path, exact id, or
// (F5) unique case-insensitive TITLE PREFIX match.
export function sessionFileFromRef(ref) {
  const r = String(ref ?? '').trim();
  if (!r) return null;
  if (r.includes('/') || r.endsWith('.jsonl')) {
    return fs.existsSync(r) ? path.resolve(r) : null;
  }
  const rows = listSessions(500);
  for (const row of rows) {
    if (row.id === r) return row.file;
  }
  const needle = r.toLowerCase();
  for (const row of rows) {
    if (row.title && row.title.toLowerCase().startsWith(needle)) return row.file;
  }
  return null;
}

// Resume path: load the transcript through the status-aware API so a degraded
// read is recorded for the system-prompt channel, and so a failed read is never
// printed as a healthy empty session. `healthy` is the existing line for an
// intact load and is skipped entirely when the load failed.
function loadResumedSession(file, id, healthy) {
  const loaded = loadSessionWithStatus(file);
  const messages = replayMessages(loaded.messages);
  if (loaded.status === HISTORY_STATUS.UNAVAILABLE) {
    warnMissingHistory(id, loaded.reason);
  } else {
    console.log(c.dim(healthy(messages.length)));
  }
  // The goal rides out of the SAME load. A degraded read leaves it null on
  // purpose: the transcript could not be read, so claiming the goal survived
  // would be inventing state.
  return { messages, goal: loaded.goal ?? null, goalTerminal: loaded.goalTerminal ?? null };
}

// A goal recovered by a resume is announced once, in the same place the session
// itself is announced. A terminal goal is reported as terminal: a completed goal
// that quietly comes back as active on the next resume is the resurrection bug.
function reportResumedGoal(goal, terminal) {
  if (!goal && !terminal) return;
  console.log(c.dim(`goal: ${goal ? goal.objective : `none (${terminal.status}: ${terminal.objective})`}`));
  if (terminal && terminal.status === GOAL_STATUS.DONE) {
    const left = (terminal.items ?? []).filter((i) => i.status !== 'completed' || i.proven !== true);
    console.log(
      c.dim(
        left.length
          ? `  this goal was completed but ${left.length} item(s) were never proven: ${left.map((i) => i.content).join('; ')}`
          : '  this goal is complete and will not be resumed; /goal <text> for a new one'
      )
    );
  }
}

// Every goal state change is appended to the SAME transcript the messages go to.
// No sidecar file, so there is nothing to orphan and nothing to clean up when the
// goal is cleared beyond the one terminal event.
function persistGoal(session, goal, action) {
  if (!goal) return null;
  try {
    appendEvent(session, goalEvent(goal, action));
    return goal;
  } catch {
    return goal;
  }
}

function warnMissingHistory(id, reason) {
  console.log(c.red(`ox: could not load prior history for ${id} — ${reason}`));
  console.log(c.dim('starting from an empty context; prior turns are missing and were NOT read'));
}

// Read-side screen for a REPLAYED TRANSCRIPT (--resume, --continue, /rewind,
// /resume). This is the one seam where stored events become injected messages,
// and a credential recorded in any past turn -- a pasted key in a user message,
// the body of a failed auth call in a TOOL RESULT -- otherwise replays verbatim
// into every single resume. The shared screen from src/memory.js runs here, the
// same read-time approach loadMemoryBlock uses for .agent/MEMORY.md.
//
// The transcript is the user's own record and is NEVER modified: the screen
// changes only the injected form. `events` is read, never written, so the file
// on disk is byte-identical after a resume.
//
// Shape guarantees, because a transcript is a structured record and not a text
// file:
//   * message COUNT and ORDER are preserved. A withheld message still occupies
//     its slot; only its content is replaced by the notice.
//   * role, tool_call ids and tool_call_id are never touched, so every
//     tool_call keeps its matching tool result and no result is orphaned -- the
//     pairing the provider validates on the next request.
//   * a withheld tool_call's `arguments` stays VALID JSON (a provider rejects a
//     malformed one), so only the argument text is swapped for a marker object.
// The shared screen supplies the patterns; the notice is the shared short
// notice, so no wording is re-derived here.
const SESSION_REPLAY_SOURCE = 'session transcript replay';

// A tool-call argument string must remain parseable JSON after screening.
const WITHHELD_ARGS_JSON =
  '{"_ox":"withheld by the read-side screen (credential or injection shape); see the session transcript on disk"}';

// Collects every text field of the rebuilt messages that the model would see.
// Returns handles (not values) so the caller can rewrite exactly the failing
// field and leave position, role and ids alone.
function replayTextFields(msgs) {
  const fields = [];
  for (const m of msgs) {
    if (!m || typeof m !== 'object') continue;
    if (typeof m.content === 'string' && m.content) fields.push({ msg: m, text: m.content });
    if (Array.isArray(m.tool_calls)) {
      for (const call of m.tool_calls) {
        const fn = call?.function;
        if (fn && typeof fn.arguments === 'string' && fn.arguments) fields.push({ fn, text: fn.arguments });
      }
    }
  }
  return fields;
}

// Returns the number of withheld messages (0 = nothing withheld, which is the
// common case and adds zero bytes to the prompt).
function screenReplayedMessages(msgs) {
  const fields = replayTextFields(msgs);
  if (!fields.length) return 0;
  const { flags, withheld } = screenReadTexts(
    fields.map((f) => f.text),
    SESSION_REPLAY_SOURCE,
    'session replay into prompt'
  );
  if (!withheld) return 0;
  for (let i = 0; i < fields.length; i++) {
    if (flags[i]) continue;
    const f = fields[i];
    if (f.fn) f.fn.arguments = WITHHELD_ARGS_JSON;
    else f.msg.content = shortWithheldNotice(1, 'message');
  }
  return withheld;
}

// Exported for the session-replay screen tests: this is the one seam where a
// stored transcript becomes injected messages, so it is the seam under test.
export function replayMessages(events) {
  const msgs = [];
  const pendingIds = [];
  for (const ev of Array.isArray(events) ? events : []) {
    if (ev?.t === 'user' && typeof ev.text === 'string' && ev.text.trim()) {
      msgs.push({ role: 'user', content: ev.text });
    } else if (ev?.t === 'assistant') {
      const hasCalls = Array.isArray(ev.tool_calls) && ev.tool_calls.length > 0;
      const text = typeof ev.text === 'string' ? ev.text : null;
      if (text == null && !hasCalls) continue;
      const m = { role: 'assistant', content: text };
      if (hasCalls) {
        m.tool_calls = ev.tool_calls.map((call, i) => ({
          id: String(call?.id ?? `call_${msgs.length}_${i}`),
          type: 'function',
          function: {
            name: String(call?.function?.name ?? 'unknown'),
            arguments: String(call?.function?.arguments ?? '{}'),
          },
        }));
        for (const cc of m.tool_calls) pendingIds.push(cc.id);
      }
      msgs.push(m);
    } else if (ev?.t === 'tool-result') {
      const id =
        typeof ev.callId === 'string' && ev.callId ? ev.callId : pendingIds.shift() ?? `tool_${msgs.length}`;
      msgs.push({ role: 'tool', tool_call_id: id, content: String(ev.content ?? '') });
    }
  }
  // Screen AFTER rebuilding: the array holds exactly what the model would be
  // sent, and nothing here has been written back to the transcript.
  const withheld = screenReplayedMessages(msgs);
  if (withheld) {
    // Never silent. The prompt carries shortWithheldNotice per withheld message,
    // the count lands in memoryScreenStats() and the OX_AUDIT ledger; this line
    // is what the person at the terminal actually sees.
    process.stderr.write(
      c.yellow(
        `ox: warning: ${withheld} replayed message${withheld === 1 ? '' : 's'} withheld by the read-side screen ` +
          '(credential or injection shape). The transcript on disk is UNCHANGED -- inspect it yourself.'
      )
    );
  }
  return msgs;
}

function padCell(s, width) {
  const str = String(s ?? '');
  return str.padEnd(width);
}

function cmdBots() {
  const config = loadConfig();
  const bots = listBots(config);
  const rows = bots.map(([name, d]) => {
    const p = lookupModel(d?.model);
    return {
      name,
      provider: d?.provider ?? '?',
      model: d?.model ?? '(requires explicit model)',
      in: p.priced ? `$${p.in}` : '—',
      out: p.priced ? `$${p.out}` : '—',
      desc: d?.desc ?? '',
    };
  });
  const w = {
    name: Math.max(4, ...rows.map((r) => r.name.length)),
    provider: Math.max(8, ...rows.map((r) => r.provider.length)),
    model: Math.max(5, ...rows.map((r) => r.model.length)),
    in: Math.max(3, ...rows.map((r) => r.in.length)),
    out: Math.max(3, ...rows.map((r) => r.out.length)),
  };
  console.log(
    `${padCell('BOT', w.name)}  ${padCell('PROVIDER', w.provider)}  ${padCell('MODEL', w.model)}  ${padCell('$IN', w.in)}  ${padCell('$OUT', w.out)}  DESC`
  );
  for (const r of rows) {
    console.log(
      `${padCell(r.name, w.name)}  ${padCell(r.provider, w.provider)}  ${padCell(r.model, w.model)}  ${padCell(r.in, w.in)}  ${padCell(r.out, w.out)}  ${r.desc}`
    );
  }
}

function cmdSessions() {
  const rows = listSessions(15);
  if (!rows.length) {
    console.log('(no sessions yet)');
    return;
  }
  for (const r of rows) {
    const date = r.mtime.slice(0, 16).replace('T', ' ');
    const cwd = truncate(r.cwd ?? '?', 32);
    const title = truncate(r.title ?? '-', 24);
    const prompt = truncate(r.firstUserPrompt ?? '', 40);
    console.log(`${padCell(r.id, 8)} ${padCell(date, 17)} ${padCell(cwd, 34)} ${padCell(title, 26)} ${prompt}`);
  }
}

async function cmdSession(args = []) {
  const sub = String(args[0] ?? '').trim().toLowerCase();
  const rest = args.slice(1);
  if (sub === 'export') return cmdSessionExport(rest);
  if (sub === 'prune') return await cmdSessionPrune(rest);
  process.stderr.write(`ox: unknown session subcommand '${args[0] ?? ''}' (use export or prune)\n`);
  process.exitCode = 3;
}

function cmdSessionExport(args = []) {
  const ref = args.find((a) => !String(a).startsWith('-'));
  if (!ref) {
    process.stderr.write('usage: ox session export (<id>|latest) [--format md|jsonl] [--redact] [--out <file>]\n');
    process.exitCode = 3;
    return;
  }
  let format = 'md';
  let out = null;
  let redact = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--format') {
      const v = args[i + 1];
      if (v !== 'md' && v !== 'jsonl') {
        process.stderr.write(`ox: --format needs 'md' or 'jsonl', got '${v ?? ''}'\n`);
        process.exitCode = 3;
        return;
      }
      format = v;
      i++;
    } else if (a === '--out') {
      const v = args[i + 1];
      if (!v) {
        process.stderr.write('ox: --out needs a file path\n');
        process.exitCode = 3;
        return;
      }
      out = v;
      i++;
    } else if (a === '--redact') redact = true;
  }
  let file;
  if (ref.toLowerCase() === 'latest') {
    file = latestSessionFile();
    if (!file) {
      process.stderr.write('ox: no sessions to export yet\n');
      process.exitCode = 3;
      return;
    }
  } else {
    file = sessionFileFromRef(ref);
    if (!file) {
      process.stderr.write(`${c.red(`✗ no session '${ref}'`)}\n`);
      process.exitCode = 3;
      return;
    }
  }
  let result;
  try {
    result = buildSessionExport(file, { format, redact });
  } catch (err) {
    process.stderr.write(`${c.red(`✗ ${err?.message ?? err}`)}\n`);
    process.exitCode = 1;
    return;
  }
  if (out) {
    try {
      fs.writeFileSync(out, result.data, { mode: 0o600 });
    } catch (err) {
      process.stderr.write(`${c.red(`✗ cannot write ${out}: ${err?.message ?? err}`)}\n`);
      process.exitCode = 1;
      return;
    }
    console.log(c.dim(`wrote ${result.count} event(s) → ${path.resolve(out)} (${format}, ${redact ? 'redacted' : 'raw'})`));
  } else {
    process.stdout.write(result.data);
  }
}

// `ox session prune` -- it moves aged transcripts into ~/.ox/sessions/archive.
//
// The report used to say `deleted <file>` and `freed X KB` for transcripts it
// had only ARCHIVED. Both halves were false: nothing was deleted, and nothing
// was freed -- res.freedBytes counts the bytes that were moved, not bytes that
// were released. A false claim about irreversible destruction, on the one
// command where an operator is deciding whether their history still exists.
//
// So: the archive stays the default and the report now says what happened.
// Permanent deletion is reachable only behind --delete, and only after an
// explicit confirmation (--yes to pre-answer it, which is what a non-TTY
// needs). The archive root is derived from the same place pruneSessions writes
// to, so the pointer below cannot drift from the bytes.
async function cmdSessionPrune(args = []) {
  let days = 90;
  let dryRun = false;
  let deleteMode = false;
  let assumeYes = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--older-than') {
      const v = args[i + 1];
      const m = String(v ?? '').match(/^(\d+)\s*d?$/i);
      if (!m) {
        process.stderr.write(`ox: --older-than needs a number of days, got '${v ?? ''}'\n`);
        process.exitCode = 3;
        return;
      }
      days = Number(m[1]);
      i++;
    } else if (a === '--dry-run') dryRun = true;
    else if (a === '--delete') deleteMode = true;
    else if (a === '--yes' || a === '-y') assumeYes = true;
    else if (String(a).startsWith('-')) {
      process.stderr.write(`ox: unknown flag '${a}'\n`);
      process.exitCode = 3;
      return;
    }
  }

  // --delete is the only irreversible path, so it is the only one that asks.
  // The candidates are counted first, so the question names the real number
  // instead of a worst case.
  if (deleteMode && !assumeYes) {
    const preview = pruneSessions({ olderThanDays: days, dryRun: true });
    if (!preview.deleted.length) {
      console.log(`nothing to delete: no session file is older than ${days} day(s)`);
      return;
    }
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      process.stderr.write(
        `${c.red(`✗ refusing to permanently delete ${preview.deleted.length} session transcript(s) without confirmation`)}` +
          ' — re-run with --delete --yes (non-TTY)\n'
      );
      process.exitCode = 4;
      return;
    }
    const okToDelete = await confirmPrompt(
      `permanently DELETE ${preview.deleted.length} session transcript(s) older than ${days} day(s)? this cannot be undone`
    );
    if (!okToDelete) {
      console.log(c.dim('aborted — nothing deleted'));
      process.exitCode = 4;
      return;
    }
  }

  const res = pruneSessions({ olderThanDays: days, dryRun, mode: deleteMode ? 'delete' : 'archive' });

  if (dryRun) {
    const verb = deleteMode ? 'would permanently delete' : 'would archive';
    console.log(`dry-run: ${res.deleted.length} of ${res.scanned} session file(s) older than ${days} day(s):`);
    for (const f of res.deleted) console.log(`  ${verb} ${f}`);
    if (deleteMode) console.log(c.dim('  (irreversible — re-run with --delete and confirm to do it)'));
    else console.log(c.dim('  (archived, not deleted — nothing is destroyed and no space is freed)'));
    if (!res.deleted.length) console.log('(nothing old enough to prune)');
    return;
  }

  if (deleteMode) {
    const kb = res.freedBytes > 1024 ? ` · freed ${(res.freedBytes / 1024).toFixed(1)} KB` : '';
    console.log(`deleted ${res.deleted.length} of ${res.scanned} session file(s) older than ${days} day(s)${kb}`);
    for (const f of res.deleted) console.log(c.dim(`  deleted ${f} (permanent — opt-in via --delete)`));
    return;
  }

  // The default path ARCHIVES. Say so, and say that the bytes are still there.
  const movedKb = res.archiveBytes > 1024 ? ` · ${(res.archiveBytes / 1024).toFixed(1)} KB moved` : '';
  console.log(
    `archived ${res.archived.length} of ${res.scanned} session file(s) older than ${days} day(s)${movedKb} ` +
      '— nothing deleted, no space freed'
  );
  for (const f of res.archived) console.log(c.dim(`  archived ${f}`));
  for (const f of res.kept) console.log(c.dim(`  kept ${f} (the archive write was refused; still in place)`));
  if (res.archived.length) {
    console.log(c.dim(`  recoverable in ${path.join(os.homedir(), '.ox', 'sessions', 'archive')}`));
  }
}

function cmdHistory(args = []) {
  const query = args
    .filter((a) => !String(a).startsWith('-'))
    .join(' ')
    .trim();
  if (!query) {
    const rows = listSessions(10);
    if (!rows.length) {
      console.log('(no sessions yet)');
      return;
    }
    for (const r of rows) {
      const date = r.mtime.slice(0, 16).replace('T', ' ');
      const cwdCell = truncate(r.cwd ?? '?', 32);
      const prompt = truncate(r.firstUserPrompt ?? '', 40);
      console.log(`${padCell(r.id, 8)} ${padCell(date, 17)} ${padCell(cwdCell, 34)} ${prompt}`);
    }
    return;
  }
  const hits = searchSessions(query, { limit: 50 });
  if (!hits.length) {
    console.log(`(no matches for '${query}')`);
    return;
  }
  console.log(`${hits.length} match(es) for '${query}', newest first:`);
  for (const h of hits) {
    const id = idFromSessionFile(h.file);
    const date = h.date.slice(0, 16).replace('T', ' ');
    const cwdCell = truncate(h.cwd ?? '?', 28);
    console.log(`${padCell(id, 8)} ${padCell(date, 17)} ${padCell(cwdCell, 30)} ${truncate(h.snippet, 96)}`);
  }
}

// `ox local` — real local-model discovery.
//
// This used to print "backends available" from `curl -s` (which exits 0 on HTTP
// 404 and 500, so any process on the port counted) and a RAM recommendation
// against a hardcoded 16GB. It now probes for a POSITIVE IDENTIFICATION, lists
// the models actually installed with their real sizes, and asks for approval
// before ox is allowed to send anything there.
//
// Non-interactive by construction: without a TTY we neither prompt nor connect.
// We report what was found and how to approve it, and exit 0.
async function cmdLocal(args = []) {
  const argv = args.map(a => String(a));
  const json = argv.includes('--json');
  const noPrompt = argv.includes('--no-prompt') || json;
  const sub = argv.find(a => !a.startsWith('-'));

  const config = loadConfig();
  const dir = config.configDir ?? CONFIG_DIR;
  const approved = readTrustRecords({ dir });

  // ox local models -- the catalogue ox knows how to RECOMMEND, as opposed to the
  // discovery scan below, which reports what is installed somewhere already.
  //
  // The two answer different questions and the catalogue had no surface at all:
  // `ox local` only ever printed models on a port that is already answering, so a
  // user with nothing installed could not see what ox supports, what each model
  // costs in RAM, or which one the recommender would pick for their machine.
  if (sub && sub.toLowerCase() === 'models') {
    if (json) {
      console.log(JSON.stringify({ models: LOCAL_MODELS.map(m => ({ ...m })) }, null, 2));
      return;
    }
    console.log(c.bold(`local model catalogue (${LOCAL_MODELS.length})`));
    console.log(formatLocalModelList(LOCAL_MODELS));
    // recommendLocalModel() gates on min(total, free), so say which figure gated
    // it -- "insufficient memory" alone reads as a claim about the machine, when
    // on a big box with a full disk it is only a claim about right now.
    const totalGB = (os.totalmem() / (1024 ** 3)).toFixed(1);
    const freeGB = (os.freemem() / (1024 ** 3)).toFixed(1);
    const pick = recommendLocalModel({});
    console.log('');
    console.log(c.dim(`  this machine: ${totalGB}GB total, ${freeGB}GB free`));
    console.log(pick.error
      ? c.dim(`  no recommendation: ${pick.error} (smallest needs ${pick.minRAM}GB available right now)`)
      : c.dim(`  for this machine: ${pick.name} -- ${pick.bestFor}`));
    console.log(c.dim(`  pull one:        ollama pull ${LOCAL_MODELS[0].ollamaName}`));
    console.log(c.dim(`  use one:         ox --bot ox-ollama:${LOCAL_MODELS[0].ollamaName}`));
    return;
  }

  // ox local forget <endpoint>  — revoke one trust record.
  if (sub && sub.toLowerCase() === 'forget') {
    const ref = argv.find(a => !a.startsWith('-') && a.toLowerCase() !== 'forget');
    if (!ref) {
      const known = approved.map(r => r.baseUrl);
      process.stderr.write(
        `usage: ox local forget <endpoint>\n${known.length ? c.dim(`approved: ${known.join(', ')}`) : c.dim('nothing is approved yet')}\n`
      );
      process.exitCode = 3;
      return;
    }
    const res = forgetEndpoint(ref, { dir });
    if (json) {
      console.log(JSON.stringify({ ok: res.removed, ...res }));
      return;
    }
    if (res.removed) {
      console.log(c.green(`\u2713 revoked ${res.key}`));
      console.log(c.dim('  ox will not send anything there until you approve it again with: ox local'));
    } else {
      process.stderr.write(`${c.red(`\u2717 nothing to revoke for '${ref}'`)} (${res.reason})\n`);
      process.exitCode = 3;
    }
    return;
  }

  const found = await scanLocalEndpoints();
  const interactive = canPrompt() && !noPrompt;

  // --json / non-interactive report shape, shared by `ox doctor` and install.
  const report = {
    found: found.map(f => ({
      runtime: f.protocol,
      name: f.displayName,
      baseUrl: f.baseUrl,
      version: f.version,
      models: f.models.map(m => ({ name: m.name, size: m.size, sizeBytes: m.sizeBytes })),
    })),
    approved: approved.map(r => ({ baseUrl: r.baseUrl, runtime: r.runtime, version: r.version, models: r.models.map(m => m.name), approvedAt: r.approvedAt })),
    interactive,
    connected: [],
  };

  if (json) {
    // Re-report live findings against persisted records so a script can see what
    // changed without a second scan.
    for (const f of found) {
      const rec = approved.find(r => r.baseUrl === f.baseUrl);
      report.found.find(x => x.baseUrl === f.baseUrl).approved = Boolean(rec);
      if (rec && rec.version && f.version && rec.version !== f.version) {
        report.found.find(x => x.baseUrl === f.baseUrl).versionChanged = { was: rec.version, now: f.version };
      }
    }
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(c.bold('local inference'));
  if (!found.length) {
    console.log(`  ${c.dim('no local model server identified on 11434, 8080, 8000 or 1234')}`);
    console.log(c.dim('  (a socket answering 404/500 is NOT counted — identification must be positive)'));
    console.log(c.dim(`  install one:  ollama pull ${LOCAL_MODELS[1].ollamaName}`));
    return;
  }

  for (const f of found) {
    const rec = approved.find(r => r.baseUrl === f.baseUrl);
    console.log(`  ${c.green('\u2713')} ${c.bold(f.displayName)}${f.version ? ` ${c.dim(f.version)}` : ''}  ${c.dim(f.baseUrl)}`);
    if (f.models.length) {
      for (const m of f.models) console.log(`      ${m.name}${m.size ? c.dim(`  ${m.size}`) : ''}`);
    } else {
      console.log(`      ${c.dim('(no models installed — this server reports an empty list)')}`);
    }
    if (rec) {
      console.log(`      ${c.green('approved')} ${c.dim(rec.approvedAt ?? '')}`);
      if (rec.version && f.version && rec.version !== f.version) {
        // A different process may now be answering the port it was approved for.
        console.log(`      ${c.yellow(`! version changed: approved ${rec.version}, now reports ${f.version}`)}`);
      }
      report.connected.push(f.baseUrl);
    } else {
      console.log(`      ${c.yellow('not approved')} ${c.dim('— ox will not send anything here')}`);
    }
  }

  // Surface, never silently resolve, a preset whose hardcoded model is absent.
  for (const f of found) {
    const warn = presetModelWarning(f);
    if (warn) console.log(`  ${c.yellow('!')} ${warn.message}`);
  }

  const pending = found.filter(f => !approved.some(r => r.baseUrl === f.baseUrl));
  if (!pending.length) {
    console.log(c.dim(`\n  connected: ${report.connected.join(', ') || 'none'}`));
    console.log(c.dim('  use one:    ox --bot ox-ollama:<model>    revoke: ox local forget <endpoint>'));
    return;
  }

  if (!interactive) {
    console.log(c.dim('\n  not connected — this is a non-interactive run, so nothing was approved.'));
    console.log(c.dim('  approve interactively with:  ox local'));
    return;
  }

  for (const f of pending) {
    console.log('');
    // approvalQuestion is self-contained (and unit-testable), so print everything
    // but its last line and let confirmPrompt render that line with its [y/N]
    // suffix -- one question, not two.
    const qLines = approvalQuestion(f).split('\n');
    const question = qLines.pop();
    console.log(c.yellow([...qLines, ''].join('\n')));
    const ok = await confirmPrompt(question);
    if (!ok) {
      console.log(c.dim(`  skipped ${f.baseUrl} — nothing written`));
      continue;
    }
    const rec = approveEndpoint(f, { dir });
    report.connected.push(f.baseUrl);
    console.log(c.green(`\u2713 approved ${rec.base_url}`));
    console.log(c.dim('  use one:  ox --bot ox-ollama:<model>    revoke: ox local forget ' + rec.base_url));
  }
}

async function cmdDoctor(args = []) {
  const json = args.includes('--json');
  const rows = [];
  const add = (ok, label) => rows.push([!!ok, label]);
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  add(nodeMajor >= 18, `node >= 18 (running ${process.versions.node})`);
  let gitOk = false;
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    gitOk = true;
  } catch {}
  add(gitOk, 'git on PATH');
  let homeOk = false;
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.accessSync(CONFIG_DIR, fs.constants.W_OK);
    homeOk = true;
  } catch {}
  add(homeOk, `~/.ox writable (${CONFIG_DIR})`);
  for (const p of PROVIDERS) {
    const ke = KEY_ENV[p];
    if (!ke) add(true, `${p}: no API key needed`);
    else add(Boolean(process.env[ke]), `${p}: ${ke} ${process.env[ke] ? 'set' : 'MISSING'}`);
  }
  // Local model discovery. This probe used to be `res.ok` on /api/version, which
  // passes for any process that answers 200 on 11434 — including one that is not
  // Ollama at all. Now identification must be positive (a `version` field in an
  // Ollama-shaped body, or an OpenAI-compatible `data` array), and we report the
  // APPROVAL state separately from the reachability state: a discovered server
  // that was never approved is deliberately unusable, which is not a failure.
  let localFound = [];
  let localApproved = [];
  try {
    localFound = await scanLocalEndpoints();
  } catch {}
  localApproved = readTrustRecords({ dir: CONFIG_DIR });
  const ollamaRec = localFound.find(f => f.protocol === 'ollama');
  add(Boolean(ollamaRec), ollamaRec
    ? `local model server identified: ${ollamaRec.displayName}${ollamaRec.version ? ` ${ollamaRec.version}` : ''} at ${ollamaRec.baseUrl}`
    : 'no local model server identified on 11434/8080/8000/1234');
  const localNotes = [];
  for (const f of localFound) {
    const rec = localApproved.find(r => r.baseUrl === f.baseUrl);
    const listed = f.models.map(m => `${m.name}${m.size ? ` (${m.size})` : ''}`).join(', ') || 'none installed';
    if (rec) {
      localNotes.push(`  ${c.green('\u2713')} ${f.baseUrl} APPROVED \u2014 ${f.models.length} model(s): ${listed}`);
    } else {
      // Unapproved is the safe default, not a fault, so it is not a doctor row.
      localNotes.push(`  ${c.dim('\u00b7')} ${f.baseUrl} not approved \u2014 ox will not send anything there (${f.models.length} model(s) found: ${listed})`);
    }
    if (rec && rec.version && f.version && rec.version !== f.version) {
      localNotes.push(c.yellow(`  ! ${f.baseUrl} version changed since approval: ${rec.version} -> ${f.version} \u2014 re-approve if this is not your doing`));
    }
    const warn = presetModelWarning(f);
    if (warn) localNotes.push(c.yellow(`  ! ${warn.message}`));
  }
  if (localFound.some(f => !localApproved.some(r => r.baseUrl === f.baseUrl))) {
    localNotes.push(c.dim('  approve with: ox local    revoke with: ox local forget <endpoint>'));
  }
  // None at all (a fresh machine): the next step, not just the absence.
  if (!localFound.length) {
    localNotes.push(c.dim('  none found. For a model on this machine: install Ollama (https://ollama.com) or LM Studio, start it, then approve with: ox local'));
  }
// ---- the capability layer: the part doctor CONSUMES --------------------------
//
// Everything above this point prints and discards. That is what made doctor a
// status screen rather than a capability layer: a report nothing reads cannot
// change a single later decision. These probes are different -- they populate
// the SAME verdict cache src/capability.js hands web_search and web_fetch, so the
// route doctor just proved is the route the next call takes, and the route that
// failed is not retried until the TTL expires.
//
// Three things this section must answer that a boolean cannot:
//   * which backend is LIVE for each capability (not "reachable yes/no"),
//   * a backend whose credential is present and whose route is broken, kept
//     apart from one nobody ever configured -- different problem, different fix,
//   * the fix, as a concrete command or reason, per capability.
const capabilityReports = await capabilityReport({
  capabilities: ['web_search', 'web_fetch'],
  env: process.env,
  timeoutMs: DOCTOR_PROBE_TIMEOUT_MS,
  deadlineMs: DOCTOR_CHAIN_DEADLINE_MS,
});
const capabilityRows = doctorCapabilityRows(capabilityReports);

  const config = loadConfig();
  const nMcp = Object.keys(config.mcpServers ?? {}).length;
  add(true, `MCP servers configured: ${nMcp}`);
  const skills = discoverSkills({ cwd: config.cwd });
  add(true, `skills discovered: ${skills.length}`);
  try {
    const rep = curateSkills({ home: os.homedir(), cwd: config.cwd }, { apply: false, config });
    const count = (st) => rep.rows.filter((r) => r.state === st).length;
    const would = rep.rows.filter((r) => r.action === 'would-archive').length;
    add(
      true,
      `skill curator (report-only): ${rep.rows.length} scanned — ${count('active')} active, ${count('stale')} stale, ` +
        `${count('unmanaged')} unmanaged, ${count('archived')} archived${would ? `, ${would} archivable (run: ox skill curate)` : ''}`
    );
    // Incidental output would corrupt a --json payload, so it moves to stderr
    // rather than being dropped: the warning is still shown, to the stream a
    // machine is not parsing.
    for (const w of rep.warnings.slice(0, 3)) {
      const line = c.dim(`  · ${w}`);
      if (json) process.stderr.write(`${line}\n`);
      else console.log(line);
    }
  } catch {}
  add(fs.existsSync(path.join(config.cwd, '.agent')), '.agent/ memory dir exists');
  // --json is the scripting surface: a stable shape with the SAME probe results
  // the text renders, so a CI job and a human read one source of truth.
  if (json) {
    console.log(
      JSON.stringify(
        {
          ok: rows.every(([ok]) => ok),
          checks: rows.map(([ok, label]) => ({ ok, label })),
          capabilities: capabilityReports.map((r) => ({
            capability: r.capability,
            kind: r.kind,
            order: r.order,
            live: r.live,
            source: r.source,
            fix: r.fix,
            chain: r.chain.map((b) => ({
              backend: b.backend,
              ok: b.ok,
              code: b.code,
              configState: b.configState,
              envVar: b.envVar,
              detail: b.detail,
              latencyMs: b.latencyMs,
              fix: b.fix,
            })),
            configuredBroken: r.configuredBroken,
            neverConfigured: r.neverConfigured,
            keylessUnusable: r.keylessUnusable,
          })),
          capabilityRows,
          local: {
            found: localFound.map((f) => ({ baseUrl: f.baseUrl, displayName: f.displayName, version: f.version })),
            approved: localFound
              .filter((f) => localApproved.some((r) => r.baseUrl === f.baseUrl))
              .map((f) => f.baseUrl),
          },
          mcpServersConfigured: nMcp,
        },
        null,
        2
      )
    );
    return;
  }

  for (const [ok, label] of rows) {
    console.log(`${ok ? c.green('✓') : c.red('✗')} ${label}`);
  }
  if (localNotes.length) {
    console.log(c.bold('local model discovery'));
    for (const n of localNotes) console.log(n);
  }
  if (capabilityRows.length) {
    console.log('');
    console.log(c.bold('capability layer'));
    console.log(`  ${c.dim(capabilityHeadline(capabilityRows))}`);
    for (const row of capabilityRows) {
      console.log(`${row.ok ? c.green('\u2713') : c.red('\u2717')} ${c.bold(row.headline)}`);
      for (const b of row.backends) {
        const mark = b.ok ? c.green('\u2713') : c.dim('\u00b7');
        const tag = b.ok
          ? c.green(b.label)
          : b.configState === 'configured'
            ? c.yellow(b.label)
            : c.dim(b.label);
        const timing = b.ok || b.latencyMs ? c.dim(` ${b.latencyMs}ms`) : '';
        console.log(`    ${mark} ${b.name} ${tag}${timing}  ${c.dim(b.detail)}`);
        if (!b.ok && b.fix) console.log(`        ${c.dim(`fix: ${b.fix}`)}`);
      }
      if (row.fix) console.log(`    ${c.yellow(`fix: ${row.fix}`)}`);
    }
    console.log(
      c.dim(
        "  re-order a chain: setBackendOrder('web_search', [...]) · pin without a restart: OX_WEB_SEARCH_BACKEND=<name>"
      )
    );
  }
}

// `ox prompt` — the debugging view of the one string that is re-sent on every
// single turn. It builds through buildPromptLayers, the same function the agent
// loop calls, so this table cannot drift from what a real run sends. No model
// call, no side effects: it is a measurement tool, not a probe.
//
// The point of the table is the last two rows. A provider reuses only an
// unbroken prefix of the prompt, so what matters is not "how long is the
// prompt" but "how much of it is byte-identical next turn". The BEFORE state of
// this codebase answered 42 bytes; this prints the real number.
async function cmdPrompt(args = []) {
  const unknown = args.filter((a) => !['--breakdown', '--json', '--text'].includes(String(a)));
  if (unknown.length) {
    process.stderr.write(`ox prompt: unknown flag '${unknown[0]}'\n\n`);
    usage();
    process.exitCode = 3;
    return;
  }
  const breakdownOnly = args.includes('--breakdown');
  const config = loadConfig();
  const context = buildContext({ cwd: config.cwd });
  const layers = await buildPromptLayers({
    cwd: config.cwd,
    contextParts: { memoryFiles: context.memoryFiles, tree: context.tree },
    memoryBlock: loadMemoryBlock(config.cwd),
    skillIndex: discoverSkills({ cwd: config.cwd }).index,
    personaBlock: loadPersona({ cwd: config.cwd, enabled: config.soul !== false }).block,
    // A real run always installs a mailbox handler (headless.js defaults to
    // makeAgentTeamsHandler), so show the section a real prompt carries rather
    // than one that silently omits it. Static, so it is inside the prefix
    // and shows up in the static-prefix byte count below.
    agentMessaging: true,
    includeRepoMap: config.repoMap === true || process.env.OX_REPO_MAP === '1',
  });
  const sum = summarizePromptLayers(layers);
  if (args.includes('--json')) {
    console.log(JSON.stringify({ cwd: config.cwd, ...sum, layers: layers.map(({ text, ...rest }) => rest) }, null, 2));
    return;
  }

  const wName = Math.max(9, ...layers.map((l) => l.name.length));
  const wKind = Math.max(4, ...layers.map((l) => l.kind.length));
  const row = (kind, name, bytes, extra) =>
    console.log(
      `  ${padCell(kind, wKind)}  ${padCell(name, wName)}  ${padCell(String(bytes), 7)}  ${padCell(`~${estimatePromptLayerTokens(bytes)}`, 7)}${extra ? '  ' + extra : ''}`
    );
  console.log(c.bold(`ox system prompt — ${config.cwd}`));
  console.log(c.dim(`  ${padCell('KIND', wKind)}  ${padCell('LAYER', wName)}  ${padCell('BYTES', 7)}  ${padCell('~TOK', 7)}  HASH`));
  for (const l of layers) row(l.kind, l.name, l.bytes, c.dim(l.hash));
  console.log(c.dim('  ' + '-'.repeat(wKind + wName + 30)));
  // The volatile tail is measured from the END of the cacheable prefix, which is
  // where the cache stops being reusable. It is the number to keep small.
  row('', 'static prefix', sum.cacheablePrefixBytes, c.dim('guaranteed cacheable'));
  row('', 'stable prefix', sum.stablePrefixBytes, c.dim('static + session, fixed for the run'));
  row('', 'volatile tail', sum.totalBytes - sum.stablePrefixBytes, c.dim('breaks the cache when it changes'));
  row('', 'TOTAL', sum.totalBytes, c.dim('~' + sum.totalTokens + ' tokens'));
  console.log(
    c.dim(
      `  static ${sum.bytesByKind.static}B / session ${sum.bytesByKind.session}B / dynamic ${sum.bytesByKind.dynamic}B — ` +
        'a provider caches the stable prefix verbatim and only re-reads the volatile tail.'
    )
  );
  if (breakdownOnly) return;
  console.log('');
  console.log(layers.map((l) => l.text).join('\n'));
}

function mcpEntryType(cfg) {
  if (cfg && typeof cfg === 'object') {
    if (cfg.type === 'http') return 'http';
    if (typeof cfg.command === 'string' && cfg.command.trim()) return 'stdio';
    if (typeof cfg.url === 'string' && cfg.url.trim()) return 'http';
  }
  return '?';
}

function readMcpDocStrict(file, what) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return {};
    throw new Error(`cannot read ${what} (${file}): ${err.message}`);
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw new Error(`malformed JSON in ${what} (${file}): ${err.message}`);
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error(`${what} (${file}) is not a JSON object`);
  }
  return doc;
}

function indentBlock(s, pad = '  ') {
  return String(s ?? '')
    .split('\n')
    .map((l) => (l.trim() ? pad + l : l))
    .join('\n');
}

// `ox mcp list` / `ox mcp test` really do start the server, so they confine it
// the same way a session does. A profile that will not resolve degrades to
// unsandboxed with a warning rather than failing the diagnostic command.
function mcpSandboxFor(config) {
  try {
    return resolveSandbox({ flag: null, config });
  } catch (err) {
    console.warn(`ox: MCP servers run UNSANDBOXED (${String(err?.message ?? err).replace(/\n/g, ' ')})`);
    return null;
  }
}

async function cmdMcpList() {
  const config = loadConfig();
  const servers = config.mcpServers ?? {};
  const names = Object.keys(servers);
  if (!names.length) {
    console.log('no MCP servers configured (~/.ox/config.json or ./.mcp.json)');
    console.log(c.dim(`curated templates: ${Object.keys(MCP_TEMPLATES).join(', ')} — install with: ox mcp add <template>`));
    return;
  }
  let hub = null;
  let startErr = null;
  try {
    hub = new McpHub(servers, { startupTimeoutMs: 8000, callTimeoutMs: 8000, sandbox: mcpSandboxFor(config) });
    await hub.start();
  } catch (err) {
    startErr = err;
    hub = null;
  }
  const byName = hub ? new Map(hub.status().map((r) => [r.server, r])) : new Map();
  const rows = names.map((n) => {
    const cfg = servers[n] ?? {};
    const st = byName.get(n);
    return {
      name: n,
      type: mcpEntryType(cfg),
      risk: riskOf(n) ?? '-',
      status: st?.status ?? '-',
      tools: st ? st.tools : 0,
    };
  });
  try {
    await hub?.stop();
  } catch {}
  const w = {
    name: Math.max(4, ...rows.map((r) => r.name.length)),
    type: Math.max(4, ...rows.map((r) => r.type.length)),
    risk: Math.max(4, ...rows.map((r) => r.risk.length)),
    status: Math.max(6, ...rows.map((r) => r.status.length)),
  };
  console.log(
    `${padCell('NAME', w.name)}  ${padCell('TYPE', w.type)}  ${padCell('RISK', w.risk)}  ${padCell('STATUS', w.status)}  TOOLS`
  );
  for (const r of rows) {
    console.log(
      `${padCell(r.name, w.name)}  ${padCell(r.type, w.type)}  ${padCell(r.risk, w.risk)}  ${padCell(r.status, w.status)}  ${r.tools}`
    );
  }
  if (!hub) {
    console.log(
      c.dim(`could not probe servers live${startErr ? ` (${startErr.message})` : ''} — showing configuration only`)
    );
  } else {
    console.log(c.dim('live probe done — ox mcp test <name> for tool-level detail'));
  }
}

async function confirmPrompt(question, { defaultNo = true } = {}) {
  const suffix = defaultNo ? '[y/N]' : '[Y/n]';
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise((resolve) => rl.question(`${question} ${suffix} `, resolve));
    const a = String(answer).trim().toLowerCase();
    if (!a) return !defaultNo;
    return a === 'y' || a === 'yes';
  } finally {
    rl.close();
  }
}

async function cmdMcpAdd(args = []) {
  const globalScope = args.includes('--global');
  const assumeYes = args.includes('--yes');
  const force = args.includes('--force');
  const name = args.find((a) => !String(a).startsWith('-'));
  if (!name) {
    process.stderr.write(
      `usage: ox mcp add <template> [--global] [--yes] [--force]\ntemplates: ${Object.keys(MCP_TEMPLATES).join(', ')}\n`
    );
    process.exitCode = 3;
    return;
  }
  const tpl = getTemplate(name);
  if (!tpl) {
    process.stderr.write(
      `${c.red(`✗ no MCP template '${name}'`)}\navailable templates: ${Object.keys(MCP_TEMPLATES).join(', ')}\n`
    );
    process.exitCode = 3;
    return;
  }
  const cwd = process.cwd();
  const projectFile = path.join(cwd, '.mcp.json');
  const configFile = path.join(CONFIG_DIR, 'config.json');
  let projectDoc;
  let configDoc;
  try {
    projectDoc = readMcpDocStrict(projectFile, './.mcp.json');
    configDoc = readMcpDocStrict(configFile, '~/.ox/config.json');
  } catch (err) {
    process.stderr.write(`${c.red(`✗ ox mcp add: ${err.message}`)}\n`);
    process.exitCode = 3;
    return;
  }
  const inProject = Object.prototype.hasOwnProperty.call(projectDoc.mcpServers ?? {}, name);
  const inGlobal = Object.prototype.hasOwnProperty.call(configDoc.mcpServers ?? {}, name);
  if ((inProject || inGlobal) && !force) {
    const where = inProject ? './.mcp.json' : '~/.ox/config.json';
    process.stderr.write(
      `${c.red(`✗ MCP server '${name}' is already configured in ${where}`)} — re-run with --force to overwrite\n`
    );
    process.exitCode = 4;
    return;
  }

  const entry = tpl.entry({});
  const requires = Array.isArray(tpl.requires) ? tpl.requires : [];
  const missing = requires.filter((v) => !process.env[v]);

  console.log(`${c.bold(tpl.title)}  (${tpl.name}) · risk: ${tpl.risk}`);
  console.log(tpl.desc);
  console.log('');
  if (requires.length) {
    console.log(c.bold('required env'));
    for (const v of requires) {
      console.log(`  ${padCell(v, Math.max(24, ...requires.map((x) => x.length)))}  ${missing.includes(v) ? c.yellow('MISSING') : c.green('present')}`);
    }
  } else {
    console.log(c.dim('required env: none'));
  }
  console.log(`\n${c.bold('setup')}\n${indentBlock(tpl.setup)}`);

  if (!assumeYes) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      process.stderr.write(
        `\n${c.red(`✗ refusing to install '${name}' without confirmation`)} — review the setup above, then re-run with --yes\n`
      );
      process.exitCode = 4;
      return;
    }
    const ok = await confirmPrompt(`install '${name}' into ${globalScope ? '~/.ox/config.json' : './.mcp.json'}?`);
    if (!ok) {
      console.log(c.dim('aborted — nothing written'));
      process.exitCode = 4;
      return;
    }
  }

  const file = globalScope ? configFile : projectFile;
  const doc = globalScope ? configDoc : projectDoc;
  const destLabel = globalScope ? '~/.ox/config.json' : './.mcp.json';
  doc.mcpServers = { ...(doc.mcpServers ?? {}), [name]: entry };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
  } catch (err) {
    process.stderr.write(`${c.red(`✗ write failed (${destLabel}): ${err.message}`)}\n`);
    process.exitCode = 3;
    return;
  }
  console.log(`\n${c.green(`✓ added '${name}' to ${destLabel}`)}`);
  if (missing.length) {
    console.log(`\nnext steps — export before starting ox:`);
    for (const v of missing) console.log(`  export ${v}=…   ${c.yellow('(currently MISSING)')}`);
  }
  console.log('');
  console.log(indentBlock(tpl.setup));
  console.log(c.dim('policy: money-risk tools always ask before they execute'));
  console.log(c.dim(`verify with: ox mcp test ${name}`));
}

async function cmdMcpRemove(args = []) {
  const globalScope = args.includes('--global');
  const name = args.find((a) => !String(a).startsWith('-'));
  if (!name) {
    process.stderr.write('usage: ox mcp remove <name> [--global]\n');
    process.exitCode = 3;
    return;
  }
  let projectDoc;
  let configDoc;
  try {
    projectDoc = readMcpDocStrict(path.join(process.cwd(), '.mcp.json'), './.mcp.json');
    configDoc = readMcpDocStrict(path.join(CONFIG_DIR, 'config.json'), '~/.ox/config.json');
  } catch (err) {
    process.stderr.write(`${c.red(`✗ ox mcp remove: ${err.message}`)}\n`);
    process.exitCode = 3;
    return;
  }
  const inProject = Object.prototype.hasOwnProperty.call(projectDoc.mcpServers ?? {}, name);
  const inGlobal = Object.prototype.hasOwnProperty.call(configDoc.mcpServers ?? {}, name);
  const target = globalScope ? (inGlobal ? 'global' : null) : inProject ? 'project' : inGlobal ? 'global' : null;
  if (!target) {
    process.stderr.write(
      `${c.red(`✗ no MCP server '${name}' configured`)} (project .mcp.json takes precedence; known templates: ${Object.keys(MCP_TEMPLATES).join(', ')})\n`
    );
    process.exitCode = 3;
    return;
  }
  const file = target === 'global' ? path.join(CONFIG_DIR, 'config.json') : path.join(process.cwd(), '.mcp.json');
  const doc = target === 'global' ? configDoc : projectDoc;
  const destLabel = target === 'global' ? '~/.ox/config.json' : './.mcp.json';

  const doRemove = () =>
    (async () => {
      delete doc.mcpServers[name];
      try {
        fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
      } catch (err) {
        process.stderr.write(`${c.red(`✗ write failed (${destLabel}): ${err.message}`)}\n`);
        process.exitCode = 3;
      }
      if (!process.exitCode) console.log(`${c.green(`✓ removed '${name}' from ${destLabel}`)}`);
    })();

  if (process.stdin.isTTY && process.stdout.isTTY) {
    try {
      const ok = await confirmPrompt(`remove '${name}' from ${destLabel}?`);
      if (!ok) {
        console.log(c.dim('aborted — nothing changed'));
        process.exitCode = 4;
        return;
      }
    } catch {
      process.exitCode = 4;
      return;
    }
  }
  // Non-TTY removal is scriptable and needs no confirmation.
  await doRemove();
}

async function cmdMcpTest(args = []) {
  const name = args.find((a) => !String(a).startsWith('-'));
  const config = loadConfig();
  const servers = config.mcpServers ?? {};
  const cfg = name ? servers[name] : undefined;
  if (!cfg) {
    process.stderr.write(
      `${c.red(`✗ ${name ? `no configured MCP server '${name}'` : 'usage: ox mcp test <configured-name>'}`)}\nconfigured: ${Object.keys(servers).join(', ') || '(none)'}\n`
    );
    process.exitCode = 3;
    return;
  }
  const hub = new McpHub({ [name]: cfg }, { startupTimeoutMs: 20000, callTimeoutMs: 20000, sandbox: mcpSandboxFor(config) });
  const t0 = Date.now();
  try {
    await hub.start();
  } catch {}
  const row = hub.status().find((r) => r.server === name) ?? null;
  const ms = Date.now() - t0;
  if (!row || row.status !== 'ok') {
    process.stderr.write(`${c.red(`✗ ${name}: ${row?.status ?? 'failed'} after ${ms}ms`)}\n`);
    if (row?.stderrTail) process.stderr.write(`${c.dim(truncate(row.stderrTail, 400))}\n`);
    process.exitCode = 1;
    try {
      await hub.stop();
    } catch {}
    return;
  }
  console.log(`${c.green('✓')} ${name} — ok · initialize+tools/list in ${ms}ms`);
  for (const s of hub.schemas()) {
    const first = String(s.description ?? '').split(/(?<=\.)\s/)[0] ?? '';
    console.log(`  ${s.name}${first ? ` — ${truncate(first, 96)}` : ''}`);
  }
  console.log(c.dim(`${row.tools} tool(s) · ${ms}ms total`));
  try {
    await hub.stop();
  } catch {}
}

async function cmdMcp(args = []) {
  const sub = String(args[0] ?? '').trim().toLowerCase();
  if (!sub || sub === 'ls') {
    await cmdMcpList();
    return;
  }
  const rest = args.slice(1);
  if (sub === 'add') {
    await cmdMcpAdd(rest);
    return;
  }
  if (sub === 'remove' || sub === 'rm') {
    await cmdMcpRemove(rest);
    return;
  }
  if (sub === 'test') {
    await cmdMcpTest(rest);
    return;
  }
  process.stderr.write(`ox: unknown mcp subcommand '${args[0]}' (use ls | add | remove | test)\n`);
  process.exitCode = 3;
}

// ---------------------------------------------------------------------------
// v3b autonomy: ox auto + ox schedule
// ---------------------------------------------------------------------------

// Preflight for `ox auto`: refuse yolo while money-risk MCP servers are active
// unless --side-effects-ok explicitly accepts real-world spend risk.
export function autoPreflight({ yolo = false, sideEffectsOk = false, mcpServers = {} } = {}) {
  if (!yolo) return { ok: true };
  const money = Object.keys(mcpServers && typeof mcpServers === 'object' ? mcpServers : {}).filter(
    (n) => riskOf(n) === 'money'
  );
  if (!money.length) return { ok: true };
  if (sideEffectsOk) return { ok: true };
  return {
    ok: false,
    reason:
      `refusing autonomous yolo run with money-risk MCP server(s): ${money.join(', ')}. ` +
      'Drop -y, remove the server(s), or re-run with --side-effects-ok to accept real-world spend risk.',
  };
}

function parseAutoFlags(args, { allowInstallFlags = false } = {}) {
  const flags = {
    json: false,
    bot: null,
    model: null,
    auxBot: null,
    maxCostUsd: null,
    yesEdits: false,
    yolo: false,
    maxMode: null,
    routingStrategy: null,
    contract: null,
    sideEffectsOk: false,
    cwd: null,
    at: null,
    install: false,
    yes: false,
  };
  const words = [];
  const bad = (msg) => {
    process.stderr.write(`${c.red(`✗ ${msg}`)}\n`);
    process.exitCode = 3;
    return null;
  };
  const needValue = (name, i) => {
    const v = args[i + 1];
    if (v === undefined) return bad(`${name} needs a value`);
    return v;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case '--json':
        flags.json = true;
        break;
      case '--bot':
      case '--model':
      case '--aux-bot':
      case '--cwd': {
        const v = needValue(a, i);
        if (v === null) return null;
        i++;
        if (a === '--bot') flags.bot = v;
        else if (a === '--model') flags.model = v;
        else if (a === '--aux-bot') flags.auxBot = v;
        else flags.cwd = v;
        break;
      }
      case '--image': {
        const v = needValue(a, i);
        if (v === null) return null;
        i++;
        (flags.images ??= []).push(v);
        break;
      }
      case '--max-cost': {
        const v = needValue(a, i);
        if (v === null) return null;
        i++;
        const n = Number(v);
        if (!v.trim() || !Number.isFinite(n) || n < 0) return bad(`--max-cost needs a finite nonnegative number, got '${v}'`);
        flags.maxCostUsd = n;
        break;
      }
      case '--max-mode': {
        const v = needValue(a, i);
        if (v === null) return null;
        i++;
        const n = Number(v);
        if (!Number.isFinite(n)) return bad(`--max-mode needs a number (2-5), got '${v}'`);
        flags.maxMode = n;
        break;
      }
      case '--routing': {
        const v = needValue(a, i);
        if (v === null) return null;
        i++;
        const valid = ['pinned', 'cost', 'quality', 'fast'];
        const lower = String(v).toLowerCase().trim();
        if (!valid.includes(lower)) return bad(`--routing needs one of ${valid.join('|')}, got '${v}'`);
        flags.routingStrategy = lower;
        break;
      }
      case '--contract': {
        // F3: `--contract "<goal>"` uses the value as the goal; a bare
        // `--contract` enables contract drafting for the positional goal.
        const v = args[i + 1];
        if (v !== undefined && !String(v).startsWith('-')) {
          flags.contract = v;
          i++;
        } else {
          flags.contract = true;
        }
        break;
      }
      case '--at': {
        const v = needValue(a, i);
        if (v === null) return null;
        i++;
        flags.at = v;
        break;
      }
      case '--yes-edits':
        flags.yesEdits = true;
        break;
      case '-y':
      case '--dangerously-skip-approvals':
        flags.yolo = true;
        break;
      case '--side-effects-ok':
        flags.sideEffectsOk = true;
        break;
      default:
        if (allowInstallFlags && a === '--install') {
          flags.install = true;
          break;
        }
        if (allowInstallFlags && a === '--yes') {
          flags.yes = true;
          break;
        }
        if (String(a).startsWith('-')) return bad(`unknown flag '${a}'`);
        words.push(a);
    }
  }
  return { flags, goal: words.join(' ').trim() };
}

async function cmdAuto(args = []) {
  const parsed = parseAutoFlags(args);
  if (!parsed) return;
  const config = loadConfig({ cwd: parsed.flags.cwd ? path.resolve(parsed.flags.cwd) : undefined, maxCostUsd: parsed.flags.maxCostUsd });
  const budget = createCostBudget({ config });
  return budget.run(async () => {
    try {
      budget.assert();
      return await cmdAutoWithBudget(args);
    } catch (err) {
      if (err?.code !== 'OX_BUDGET_STOP') throw err;
      const message = budget.explain();
      if (parsed.flags.json) console.log(JSON.stringify({ t: 'budget-stop', reason: budget.reason, message, ...budget.snapshot() }));
      else console.log(c.yellow(`· ${message}`));
      process.exitCode = 2;
    }
  });
}

async function cmdAutoWithBudget(args = []) {
  const parsed = parseAutoFlags(args);
  if (!parsed) return;
  const { flags, goal: positionalGoal } = parsed;
  const contractGoal = typeof flags.contract === 'string' ? flags.contract.trim() : '';
  const goal = contractGoal || positionalGoal;
  if (!goal) {
    process.stderr.write('usage: ox auto "<goal>" [--contract ["<goal>"]] [--max-cost <usd>] [--json] [--bot <name>] [--yes-edits] [-y] [--side-effects-ok]\n');
    process.exitCode = 3;
    return;
  }
  const config = loadConfig({ cwd: flags.cwd ? path.resolve(flags.cwd) : undefined, auxBot: flags.auxBot, routingStrategy: flags.routingStrategy, maxCostUsd: flags.maxCostUsd });
  const pf = autoPreflight({
    yolo: flags.yolo || config.yolo,
    sideEffectsOk: flags.sideEffectsOk,
    mcpServers: config.mcpServers,
  });
  if (!pf.ok) {
    process.stderr.write(`${c.red(`✗ ox auto: ${pf.reason}`)}\n`);
    process.exitCode = 4;
    return;
  }
  // F3 goal contracts: `ox auto --contract "<goal>"` (or bare --contract)
  // drafts a contract via the aux model before the run; drafting failure
  // degrades silently to a normal verified run.
  let goalContract = null;
  if (flags.contract != null) {
    const sourceGoal = contractGoal || goal;
    if (sourceGoal) {
      let draftTarget = null;
      try {
        draftTarget = resolveAuxTarget(config) ?? resolveBot(flags.bot || flags.model || defaultBotSpec(config), config);
      } catch {}
      if (draftTarget) {
        goalContract = await draftContract(draftTarget, { goal: sourceGoal });
        if (!goalContract) {
          process.stderr.write(`${c.dim('· goal-contract drafting failed — continuing without a contract')}\n`);
        } else if (flags.json) {
          console.log(JSON.stringify({ t: 'goal-contract', ...goalContract }));
        } else {
          console.log(c.dim(renderContractBlock(goalContract)));
        }
      } else {
        process.stderr.write(`${c.dim('· no model available for contract drafting — continuing without one')}\n`);
      }
    }
  }
  await runPrint(goal, config, {
    json: flags.json,
    yolo: flags.yolo,
    verify: true,
    yesEdits: flags.yesEdits,
    maxCostUsd: flags.maxCostUsd,
    maxMode: flags.maxMode,
    bot: flags.bot,
    model: flags.model,
    sideEffectsOk: flags.sideEffectsOk,
    auto: true,
    ...(goalContract ? { goalContract } : {}),
  });
}

// The crontab block builder and its idempotency decision now live in
// src/schedule.js, next to the store they describe and next to the note on why the
// installer was removed. They are RE-EXPORTED here because they are pure
// functions that were part of this module's public surface, and `test/v3b.test.js`
// grades them through it. Re-exporting rather than re-implementing is the point:
// there is one implementation, and it is the one the printer actually uses.
export { buildScheduleBlock, planScheduleInstall, SCHEDULE_MARKER_PREFIX } from './schedule.js';

// `ox schedule` now means the REAL store: schedules that run inside the daemon.
// It used to print a crontab block and, with `--install`, append it to the real
// system crontab. The installer is gone — the reasoning is in src/schedule.js
// under "The crontab block generator"; the short version is that a crontab entry
// is invisible state that bypasses the daemon's 0700/0600 boundary, cannot be
// cost-capped by ox, is not listed by `ox schedule list`, and would run the same
// goal a second time on the same timer. The PURE block builder survives, and is
// reachable only as `ox schedule print-crontab`, which writes to stdout and
// installs nothing.
async function cmdSchedule(args = []) {
  return cmdScheduleStore(args);
}

async function cmdAgent(args = []) {
  const sub = String(args[0] ?? '').trim().toLowerCase();
  const rest = args.slice(1);
  if (sub === '--help' || sub === '-h' || sub === 'help') {
    console.log(`${c.bold('ox agent')} — your own agents: a bot, a mode and standing instructions`);
    console.log(c.dim('  ox agent new <name> [--bot <bot>] [--mode <mode>] [--tools read_file,grep,web_search|all] [--prompt "<instructions>" | --prompt-file <f>] [--description "<d>"]'));
    console.log(c.dim('  --tools: the only tools it may use (mcp__server__* for a whole MCP server); refused calls name the rule'));
    console.log(c.dim('  ox agent list | show <name> | rename <name> <new> | delete <name>'));
    console.log(c.dim('  run one:  ox --agent <name>        (chat)'));
    console.log(c.dim('            ox --agent <name> -p "<task>"'));
    console.log(c.dim(`  modes: auto, ${MODE_NAMES.join(', ')} · bots: ox bots, or a plan you pay for (ox connect)`));
    return;
  }
  if ((sub === 'list' || sub === 'ls') && rest.includes('--json')) {
    // For the island: every agent, with what it runs on and its mode.
    const agents = listAgents().map((n) => loadAgent(n)).filter(Boolean)
      .map((a) => ({ name: a.name, bot: agentBotSpec(a), mode: a.mode ?? 'code', description: a.description || String(a.systemPrompt ?? '').split('\n')[0].slice(0, 80) }));
    console.log(JSON.stringify({ agents }));
    return;
  }
  if (sub === 'list' || sub === 'ls' || !sub) {
    const names = listAgents();
    if (!names.length) {
      console.log('no agents yet — make one: ox agent new reviewer --mode ask --prompt "review diffs for bugs; cite file:line"');
      return;
    }
    console.log(`${padCell('NAME', 18)}  ${padCell('RUNS ON', 26)}  ${padCell('MODE', 11)}  ABOUT`);
    for (const n of names) {
      const a = loadAgent(n);
      if (!a) continue;
      const about = a.description || truncate(String(a.systemPrompt ?? '').split('\n')[0], 48) || '-';
      console.log(`${padCell(n, 18)}  ${padCell(agentBotSpec(a) ?? 'default bot', 26)}  ${padCell(a.mode ?? 'code', 11)}  ${c.dim(about)}`);
    }
    console.log(c.dim('run one: ox --agent <name>'));
    return;
  }
  if (sub === 'new' || sub === 'create') {
    return cmdAgentNew(rest);
  }
  if (sub === 'save') {
    return cmdAgentSave(rest);
  }
  if (sub === 'use' || sub === 'show') {
    return cmdAgentUse(rest);
  }
  if (sub === 'delete' || sub === 'rm') {
    return cmdAgentDelete(rest);
  }
  if (sub === 'rename' || sub === 'mv') {
    const [from, to] = rest.filter((a) => !String(a).startsWith('-'));
    if (!from || !to) { process.stderr.write('usage: ox agent rename <name> <new name>\n'); process.exitCode = 3; return; }
    try { renameAgent(from, to, { saveConfig: saveConfigDoc }); console.log(`${from} is now ${to} — run it: ox --agent ${to}`); }
    catch (e) { process.stderr.write(`${c.red(`✗ ${e.message}`)}\n`); process.exitCode = 3; }
    return;
  }
  process.stderr.write(`ox: unknown agent subcommand '${args[0] ?? ''}' (use new | list | show | delete; ox agent --help)\n`);
  process.exitCode = 3;
}

function cmdAgentNew(args = []) {
  const usage = 'usage: ox agent new <name> [--bot <bot>] [--mode <mode>] [--tools a,b,mcp__github__*|all] [--prompt "<instructions>" | --prompt-file <f>] [--description "<d>"]';
  const name = args[0] && !String(args[0]).startsWith('-') ? args[0] : null;
  if (!name) { process.stderr.write(`${usage}\n`); process.exitCode = 3; return; }
  if (!AGENT_NAME.test(name)) { process.stderr.write(`${c.red(`✗ agent names are letters, digits, - and _ (got '${name}')`)}\n`); process.exitCode = 3; return; }
  const def = { ...(loadAgent(name) ?? {}) };
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    const v = args[i + 1];
    if (['--bot', '--mode', '--prompt', '--prompt-file', '--description', '--tools'].includes(a) && v === undefined) {
      process.stderr.write(`${c.red(`✗ ${a} needs a value`)}\n`); process.exitCode = 3; return;
    }
    if (a === '--bot') { def.bot = v; i++; }
    else if (a === '--mode') {
      const m = normalizeMode(v);
      if (!m) { process.stderr.write(`${c.red(`✗ --mode must be one of: auto, ${MODE_NAMES.join(', ')}`)}\n`); process.exitCode = 3; return; }
      def.mode = m; i++;
    }
    else if (a === '--prompt') { def.systemPrompt = v; i++; }
    else if (a === '--prompt-file') {
      try { def.systemPrompt = fs.readFileSync(path.resolve(v), 'utf8'); } catch (e) { process.stderr.write(`${c.red(`✗ cannot read ${v}: ${e.message}`)}\n`); process.exitCode = 3; return; }
      i++;
    }
    else if (a === '--description') { def.description = v; i++; }
    else if (a === '--tools') {
      const list = v.split(',').map((t) => t.trim()).filter(Boolean);
      def.tools = list.length && !(list.length === 1 && list[0] === 'all') ? list : null;
      i++;
    }
    else { process.stderr.write(`${c.red(`✗ unknown flag '${a}'`)}\n${usage}\n`); process.exitCode = 3; return; }
  }
  if (def.bot) {
    // Checked now, so a typo is caught here rather than at the first run.
    try { resolveBot(def.bot, loadConfig()); } catch (e) {
      process.stderr.write(`${c.red(`✗ --bot ${def.bot}: ${e?.message ?? e}`)}\n`); process.exitCode = 3; return;
    }
  }
  const data = saveAgent(name, def);
  console.log(`${c.green(`✓ agent '${name}'`)} ${c.dim(`— ${agentBotSpec(data) ?? 'default bot'} · ${data.mode ?? 'code'} mode${Array.isArray(data.tools) ? ` · ${data.tools.length} tool(s) granted` : ''}${data.systemPrompt ? ' · own instructions' : ''}`)}`);
  console.log(c.dim(`  run it: ox --agent ${name}   or   ox --agent ${name} -p "<task>"`));
}

function cmdAgentSave(args = []) {
  const name = args.find((a) => !String(a).startsWith('-'));
  if (!name) {
    process.stderr.write('usage: ox agent save <name> --provider <p> --model <m> [--base-url <u>] [--system-prompt <text>]\n');
    process.exitCode = 3;
    return;
  }
  let provider, model, baseUrl, systemPrompt;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--provider') { provider = args[++i]; }
    else if (a === '--model') { model = args[++i]; }
    else if (a === '--base-url') { baseUrl = args[++i]; }
    else if (a === '--system-prompt') { systemPrompt = args[++i]; }
    else if (String(a).startsWith('-')) {
      process.stderr.write(`ox: unknown flag '${a}'\n`);
      process.exitCode = 3;
      return;
    }
  }
  if (!provider || !model) {
    process.stderr.write(`${c.red('✗ --provider and --model are required')}\n`);
    process.exitCode = 3;
    return;
  }
  const existing = loadAgent(name);
  const data = saveAgent(name, {
    provider,
    model,
    baseUrl,
    systemPrompt,
    skills: existing?.skills ?? [],
    mcpServers: existing?.mcpServers ?? {},
  });
  console.log(`${c.green(`✓ saved agent '${name}'`)} — ${data.provider}/${data.model}`);
}

function cmdAgentUse(args = []) {
  const name = args.find((a) => !String(a).startsWith('-'));
  if (!name) {
    process.stderr.write('usage: ox agent show <name>\n');
    process.exitCode = 3;
    return;
  }
  const agent = loadAgent(name);
  if (!agent) {
    process.stderr.write(`${c.red(`✗ no agent '${name}'`)} — list with: ox agent list\n`);
    process.exitCode = 3;
    return;
  }
  const merged = resolveAgent(name, loadConfig());
  console.log(`${c.bold('agent:')} ${name}${merged.description ? c.dim(` — ${merged.description}`) : ''}`);
  console.log(`  runs on: ${agentBotSpec(merged) ?? 'the default bot'}`);
  console.log(`  mode:    ${merged.mode ?? 'code'}`);
  console.log(`  tools:   ${Array.isArray(merged.tools) ? merged.tools.join(', ') : 'everything its mode allows'}`);
  if (merged.baseUrl) console.log(`  url:     ${merged.baseUrl}`);
  if (merged.systemPrompt) console.log(`  prompt:  ${truncate(merged.systemPrompt, 80)}`);
  console.log(c.dim(`  run it: ox --agent ${name}   or   ox --agent ${name} -p "<task>"`));
}

async function cmdAgentDelete(args = []) {
  const yes = args.includes('--yes');
  const name = args.find((a) => !String(a).startsWith('-'));
  if (!name) {
    process.stderr.write('usage: ox agent delete <name> [--yes]\n');
    process.exitCode = 3;
    return;
  }
  if (!loadAgent(name)) {
    process.stderr.write(`${c.red(`✗ no agent '${name}'`)}\n`);
    process.exitCode = 3;
    return;
  }
  if (!yes) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      process.stderr.write(`${c.red(`✗ refusing to delete agent '${name}' without confirmation`)} — re-run with --yes (non-TTY)\n`);
      process.exitCode = 4;
      return;
    }
    const confirmed = await confirmPrompt(`delete agent '${name}'?`);
    if (!confirmed) {
      console.log(c.dim('aborted — nothing deleted'));
      process.exitCode = 4;
      return;
    }
  }
  const ok = deleteAgent(name);
  console.log(ok ? `${c.green(`✓ deleted agent '${name}'`)}` : `${c.red(`✗ failed to delete agent '${name}'`)}`);
}

async function cmdImport(args = []) {
  const dryRun = args.includes('--dry-run');
  const source = args.find((a) => !String(a).startsWith('-'));
  const validSources = ['claude-code', 'hermes', 'codex', 'all'];
  if (!source || !validSources.includes(source)) {
    process.stderr.write('usage: ox import <claude-code|hermes|codex|all> [--dry-run]\n');
    process.stderr.write('sources:\n');
    process.stderr.write('  claude-code  read from ~/.claude/skills + ./.claude/skills + ./.mcp.json + CLAUDE.md/AGENTS.md\n');
    process.stderr.write('  hermes       read from ~/.hermes/skills + config + AGENTS.md\n');
    process.stderr.write('  codex        read from ~/.codex/config.toml + AGENTS.md\n');
    process.stderr.write('  all          merge all of the above\n');
    process.exitCode = 3;
    return;
  }
  const cwd = process.cwd();
  const homeDir = os.homedir();
  const result = importAll(cwd, source);
  const skills = result.skills || [];
  const mcpServers = result.mcpServers || {};
  const memoryFiles = result.memoryFiles || [];
  const mcpNames = Object.keys(mcpServers);

  console.log(c.bold(`ox import ${source}${dryRun ? ' (dry-run — no changes made)' : ''}`));
  console.log('');
  console.log(c.bold(`skills (${skills.length}):`));
  if (skills.length) {
    for (const s of skills) console.log(`  ${s.name}  ${c.dim(s.path)}`);
  } else {
    console.log(c.dim('  (none found)'));
  }
  console.log('');
  console.log(c.bold(`mcp servers (${mcpNames.length}):`));
  if (mcpNames.length) {
    const w = Math.max(8, ...mcpNames.map((n) => n.length));
    for (const n of mcpNames) console.log(`  ${n.padEnd(w)}  ${c.dim(JSON.stringify(mcpServers[n]))}`);
  } else {
    console.log(c.dim('  (none found)'));
  }
  console.log('');
  console.log(c.bold(`memory files (${memoryFiles.length}):`));
  if (memoryFiles.length) {
    for (const m of memoryFiles) console.log(`  ${m.name}  ${c.dim(m.path)}`);
  } else {
    console.log(c.dim('  (none found)'));
  }

  if (dryRun || (!skills.length && !mcpNames.length && !memoryFiles.length)) {
    console.log('');
    if (!skills.length && !mcpNames.length && !memoryFiles.length) {
      console.log(c.dim('nothing to import — all sources empty'));
    } else if (dryRun) {
      console.log(c.dim('dry-run — no files written (re-run without --dry-run to apply)'));
    }
    return;
  }

  // Copy skills to ~/.agents/skills/<name>/SKILL.md
  const skillsDest = path.join(homeDir, '.agents', 'skills');
  fs.mkdirSync(skillsDest, { recursive: true });
  let copiedSkills = 0;
  let skippedSkills = 0;
  for (const s of skills) {
    const destDir = path.join(skillsDest, s.name);
    const destFile = path.join(destDir, 'SKILL.md');
    if (fs.existsSync(destFile)) {
      skippedSkills++;
      continue;
    }
    fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(s.path, destFile);
    copiedSkills++;
  }

  // Merge MCP servers into ./.mcp.json (project precedence: do not overwrite existing)
  const mcpFile = path.join(cwd, '.mcp.json');
  let mcpDoc = { mcpServers: {} };
  try {
    if (fs.existsSync(mcpFile)) {
      mcpDoc = JSON.parse(fs.readFileSync(mcpFile, 'utf8'));
      if (!mcpDoc || typeof mcpDoc !== 'object' || Array.isArray(mcpDoc)) mcpDoc = { mcpServers: {} };
      if (typeof mcpDoc.mcpServers !== 'object' || mcpDoc.mcpServers === null) mcpDoc.mcpServers = {};
    }
  } catch (err) {
    process.stderr.write(`${c.red(`✗ could not parse ${mcpFile}: ${err?.message ?? err}`)}\n`);
    process.exitCode = 3;
    return;
  }
  let mergedMcp = 0;
  for (const n of mcpNames) {
    if (Object.prototype.hasOwnProperty.call(mcpDoc.mcpServers, n)) continue;
    mcpDoc.mcpServers[n] = mcpServers[n];
    mergedMcp++;
  }
  if (mergedMcp) {
    fs.mkdirSync(path.dirname(mcpFile), { recursive: true });
    fs.writeFileSync(mcpFile, `${JSON.stringify(mcpDoc, null, 2)}\n`);
  }

  // Append memory files to ./.agent/
  const agentDir = path.join(cwd, '.agent');
  fs.mkdirSync(agentDir, { recursive: true });
  let appendedMemory = 0;
  let skippedMemory = 0;
  for (const m of memoryFiles) {
    const base = path.basename(m.path);
    const destMem = path.join(agentDir, base);
    let existing = '';
    try { existing = fs.readFileSync(destMem, 'utf8') ?? ''; } catch {}
    if (existing.includes(m.content)) {
      skippedMemory++;
      continue;
    }
    fs.appendFileSync(destMem, `\n\n--- imported from ${source} (${m.name}) ---\n\n${m.content}\n`);
    appendedMemory++;
  }

  if (copiedSkills) console.log(`${c.green(`✓ copied ${copiedSkills} skill(s)`)}${skippedSkills ? ` · ${skippedSkills} skipped (already present)` : ''} → ${c.dim(skillsDest)}`);
  else console.log(c.dim(`skills: nothing new to copy`));
  if (mergedMcp) console.log(`${c.green(`✓ merged ${mergedMcp} MCP server(s)`)} → ${c.dim(mcpFile)}`);
  else console.log(c.dim(`mcp: nothing new to merge`));
  if (appendedMemory) console.log(`${c.green(`✓ appended ${appendedMemory} memory file(s)`)}${skippedMemory ? ` · ${skippedMemory} skipped (already present)` : ''} → ${c.dim(agentDir)}`);
  else console.log(c.dim(`memory: nothing new to append`));
  console.log(c.green('\n✓ import complete'));
}

function skillSourceLabel(skillMdPath) {
  const dirs = skillScanDirs({ cwd: process.cwd() });
  const labels = ['global', 'project', 'claude-global', 'claude-project'];
  const resolved = path.resolve(String(skillMdPath ?? ''));
  for (let i = 0; i < dirs.length; i++) {
    if (withinDirStr(resolved, dirs[i])) return labels[i] ?? '?';
  }
  return '?';
}

// path-sep-safe "is child of" for label mapping (case-sensitive on purpose).
function withinDirStr(child, ancestor) {
  const rel = path.relative(path.resolve(ancestor), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function cmdSkillLs() {
  const skills = discoverSkills({ cwd: process.cwd() });
  if (!skills.length) {
    console.log('(no skills found)');
  } else {
    const rows = skills.map((s) => ({
      name: s.name,
      source: skillSourceLabel(s.path),
      trigger: s.trigger ? 'command' : '-',
      desc: truncate(s.description, 64),
    }));
    const w = {
      name: Math.max(4, ...rows.map((r) => r.name.length)),
      source: Math.max(6, ...rows.map((r) => r.source.length)),
      trigger: Math.max(7, ...rows.map((r) => r.trigger.length)),
    };
    console.log(
      `${padCell('NAME', w.name)}  ${padCell('SOURCE', w.source)}  ${padCell('TRIGGER', w.trigger)}  DESCRIPTION`
    );
    for (const r of rows) {
      console.log(`${padCell(r.name, w.name)}  ${padCell(r.source, w.source)}  ${padCell(r.trigger, w.trigger)}  ${r.desc}`);
    }
  }
  for (const warning of skills.warnings ?? []) console.log(c.dim(`warning: ${warning}`));
}

function skillTemplate(name) {
  return [
    '---',
    `name: ${name}`,
    'description: TODO — one line saying what this skill does and when the agent should load it',
    'metadata:',
    `  created: ${new Date().toISOString().slice(0, 10)}`,
    '---',
    '',
    `# ${name}`,
    '',
    'TODO: When should this skill be used? Name the situations and inputs it covers.',
    '',
    '## Steps',
    '',
    '- TODO: first step',
    '- TODO: second step',
    '',
    '## Notes',
    '',
    '- TODO: gotchas, edge cases, or links to reference files.',
    '',
  ].join('\n');
}

function cmdSkillNew(args = []) {
  const force = args.includes('--force');
  const project = args.includes('--project') || args.includes('--local');
  const name = args.find((a) => !String(a).startsWith('-'));
  if (!name) {
    process.stderr.write('usage: ox skill new <name> [--global] [--project] [--force]\n');
    process.exitCode = 3;
    return;
  }
  if (!SKILL_NAME_RE.test(name)) {
    process.stderr.write(
      `${c.red(`✗ invalid skill name '${name}'`)} — use lowercase [a-z0-9-], e.g. 'tidy-imports'\n`
    );
    process.exitCode = 3;
    return;
  }
  const dir = project
    ? path.join(process.cwd(), '.agents', 'skills', name)
    : path.join(os.homedir(), '.agents', 'skills', name);
  if (fs.existsSync(dir)) {
    if (!force) {
      process.stderr.write(
        `${c.red(`✗ skill directory already exists: ${dir}`)} — re-run with --force to overwrite\n`
      );
      process.exitCode = 4;
      return;
    }
    if (!fs.statSync(dir).isDirectory()) {
      process.stderr.write(`${c.red(`✗ ${dir} exists and is not a directory`)}\n`);
      process.exitCode = 4;
      return;
    }
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), skillTemplate(name));
  } catch (err) {
    process.stderr.write(`${c.red(`✗ scaffold failed: ${err?.message ?? err}`)}\n`);
    process.exitCode = 3;
    return;
  }
  const scope = project ? './.agents/skills' : '~/.agents/skills';
  console.log(`${c.green(`✓ scaffolded '${name}' in ${scope}`)}`);
  console.log(`  ${path.join(dir, 'SKILL.md')}`);
  console.log(c.dim('next steps:'));
  console.log(c.dim(`  1. edit description + body: $EDITOR ${path.join(dir, 'SKILL.md')}`));
  console.log(c.dim('  2. preview discovery: ox skill ls'));
  console.log(c.dim(`  3. check what the agent sees: ox skill ${name}`));
}

async function cmdSkillRm(args = []) {
  const yes = args.includes('--yes');
  const name = args.find((a) => !String(a).startsWith('-'));
  if (!name) {
    process.stderr.write('usage: ox skill rm <name> [--yes]\n');
    process.exitCode = 3;
    return;
  }
  const dirs = skillScanDirs({ cwd: process.cwd() });
  const matches = dirs.filter((d) => fs.existsSync(path.join(d, name, 'SKILL.md')));
  if (!matches.length) {
    process.stderr.write(
      `${c.red(`✗ no skill '${name}'`)} — searched:\n${dirs.map((d) => `  ${d}`).join('\n')}\n`
    );
    process.exitCode = 3;
    return;
  }
  if (matches.length > 1) {
    process.stderr.write(
      `${c.red(`✗ ambiguous: skill '${name}' exists in ${matches.length} scan dirs`)} — remove one copy manually or narrow your request:\n${matches
        .map((d) => `  ${path.join(d, name)}`)
        .join('\n')}\n`
    );
    process.exitCode = 4;
    return;
  }
  const target = path.join(matches[0], name);
  if (!yes) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      process.stderr.write(
        `${c.red(`✗ refusing to delete ${target} without confirmation`)} — re-run with --yes (non-TTY)\n`
      );
      process.exitCode = 4;
      return;
    }
    const okToDelete = await confirmPrompt(`delete ${target}?`);
    if (!okToDelete) {
      console.log(c.dim('aborted — nothing deleted'));
      process.exitCode = 4;
      return;
    }
  }
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (err) {
    process.stderr.write(`${c.red(`✗ delete failed: ${err?.message ?? err}`)}\n`);
    process.exitCode = 3;
    return;
  }
  console.log(`${c.green(`✓ removed ${target}`)}`);
}

function cmdSkillPath(args = []) {
  const name = args.find((a) => !String(a).startsWith('-'));
  if (!name) {
    process.stderr.write('usage: ox skill path <name>\n');
    process.exitCode = 3;
    return;
  }
  const dirs = skillScanDirs({ cwd: process.cwd() });
  const cwdRoots = new Set([
    path.join(process.cwd(), '.agents', 'skills'),
    path.join(process.cwd(), '.claude', 'skills'),
  ]);
  // Project precedence: cwd-scoped dirs win over home-scoped copies.
  const ordered = [...dirs.filter((d) => cwdRoots.has(d)), ...dirs.filter((d) => !cwdRoots.has(d))];
  for (const d of ordered) {
    const p = path.join(d, name, 'SKILL.md');
    if (fs.existsSync(p)) {
      console.log(p);
      return;
    }
  }
  process.stderr.write(`${c.red(`✗ no skill '${name}'`)}\n`);
  process.exitCode = 1;
}

async function cmdSkill(args) {
  const sub = String(args[0] ?? '').trim().toLowerCase();
  if (sub === 'ls' || sub === 'list') {
    cmdSkillLs();
    return;
  }
  if (sub === 'new') {
    cmdSkillNew(args.slice(1));
    return;
  }
  if (sub === 'rm' || sub === 'remove') {
    await cmdSkillRm(args.slice(1));
    return;
  }
  if (sub === 'path') {
    cmdSkillPath(args.slice(1));
    return;
  }
  if (sub === 'add') {
    await cmdSkillAdd(args.slice(1));
    return;
  }
  if (sub === 'from') {
    // A book, PDF or folder of docs → a skill with an index and chapters read on demand.
    const rest = args.slice(1);
    const flag = (n) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
    const src = rest.find((a, i) => !a.startsWith('--') && !['--name', '--description'].includes(rest[i - 1]));
    if (!src) { process.stderr.write('usage: ox skill from <book.pdf | file.md | folder> [--name N] [--description D] [--force]\n'); process.exitCode = 3; return; }
    try {
      const B = await import('./book-skill.js');
      const r = B.bookToSkill(src, { name: flag('--name') ?? null, description: flag('--description') ?? null, force: rest.includes('--force') });
      console.log(`${c.green('✓ skill')} ${c.bold(r.name)}  ${c.dim(r.dir)}`);
      if (r.short) console.log(`  ${r.chapters.length} chapter${r.chapters.length > 1 ? 's' : ''} · ≈ ${r.bookTokens.toLocaleString('en-US')} tokens: short enough that reading it whole is as cheap; the skill still makes it findable`);
      else console.log(`  ${r.chapters.length} chapters${r.parts ? ` in ${r.parts} parts` : ''} · the whole text ≈ ${r.bookTokens.toLocaleString('en-US')} tokens · per question ≈ ${(r.indexTokens + r.avgChapterTokens).toLocaleString('en-US')} (index + one chapter) → ${r.ratio}× fewer`);
      for (const ch of r.chapters.slice(0, 12)) console.log(c.dim(`  ${String(ch.n).padStart(2)}. ${ch.title.slice(0, 70)}  (${ch.terms.slice(0, 4).join(', ')})`));
      if (r.chapters.length > 12) console.log(c.dim(`  … ${r.chapters.length - 12} more`));
    } catch (e) { console.error(c.red(e.message)); process.exitCode = 1; }
    return;
  }
  if (sub === 'curate') {
    cmdSkillCurate(args.slice(1));
    return;
  }
  if (sub === 'pin') {
    cmdSkillPin(args.slice(1), true);
    return;
  }
  if (sub === 'unpin') {
    cmdSkillPin(args.slice(1), false);
    return;
  }
  if (sub === 'restore') {
    cmdSkillRestore(args.slice(1));
    return;
  }
  if (sub === 'adopt') {
    cmdSkillAdopt(args.slice(1));
    return;
  }
  if (sub === 'purge') {
    await cmdSkillPurge(args.slice(1));
    return;
  }
  if (sub === 'learn') {
    cmdSkillLearn(args.slice(1));
    return;
  }
  const skills = discoverSkills({ cwd: process.cwd() });
  const name = String(args[0] ?? '').trim();
  if (name) {
    const body = readSkillBody(name, skills);
    if (body == null) {
      process.stderr.write(`${c.red(`✗ no skill '${name}'`)}\n`);
      process.exitCode = 3;
      return;
    }
    console.log(body);
    return;
  }
  if (!skills.length) {
    console.log('(no skills found)');
    return;
  }
  console.log(skills.index);
  for (const w of skills.warnings ?? []) console.log(c.dim(`warning: ${w}`));
}

function renderFindingsTable(findings, log = console.log) {
  const w = { file: 4, line: 4, pattern: 7 };
  for (const f of findings) {
    w.file = Math.max(w.file, f.file.length);
    w.line = Math.max(w.line, String(f.line).length);
    w.pattern = Math.max(w.pattern, f.pattern.length);
  }
  log(
    `${padCell('FILE', w.file)}  ${padCell('LINE', w.line)}  ${padCell('PATTERN', w.pattern)}  EXCERPT`
  );
  for (const f of findings) {
    log(
      `${padCell(f.file, w.file)}  ${padCell(String(f.line), w.line)}  ${padCell(f.pattern, w.pattern)}  ${truncate(f.excerpt, 72)}`
    );
  }
}

function printSkillAddBox(res) {
  const rows = [
    ['name', res.name],
    ['source', res.source],
    ['path', res.dest],
    ['sha256', res.sha256],
    ['scanned', `${res.filesScanned} file(s), ${res.findings.length} pattern hit(s)${res.patternsHit.length ? ` [${res.patternsHit.join(', ')}]` : ''}`],
  ];
  const width = Math.max(24, ...rows.map(([k, v]) => k.length + 2 + String(v ?? '').length));
  console.log(`\u250c\u2500 skill installed ${'\u2500'.repeat(Math.max(2, width - 17))}\u2510`);
  for (const [k, v] of rows) {
    console.log(`\u2502 ${padCell(`${k}:`, 9)}${truncate(String(v ?? ''), width - 11)}`);
  }
  console.log(`\u2514${'\u2500'.repeat(width + 1)}\u2518`);
}

async function cmdSkillAdd(args) {
  const force = args.includes('--force');
  const source = args.find((a) => !String(a).startsWith('-'));
  if (!source) {
    process.stderr.write('usage: ox skill add <local-dir | owner/repo[/path]> [--force]\n');
    process.exitCode = 3;
    return;
  }
  let res;
  try {
    res = await installSkill(source, { force, cwd: process.cwd() });
  } catch (err) {
    process.stderr.write(`${c.red(`✗ skill add failed: ${err?.message ?? err}`)}\n`);
    process.exitCode = 3;
    return;
  }
  if (res.ok) {
    printSkillAddBox(res);
    return;
  }
  if (res.kind === 'unsafe') {
    console.error(c.red(`\u2717 ${res.message}`));
    console.error('');
    renderFindingsTable(res.findings, console.error);
    console.error('');
    console.error(c.dim('re-run with --force to install anyway'));
    process.exitCode = 4;
    return;
  }
  process.stderr.write(`${c.red(`✗ ${res.message}`)}\n`);
  process.exitCode = 3;
}

// ---------------------------------------------------------------------------
// F1 skill lifecycle curator commands
// ---------------------------------------------------------------------------

function cmdSkillPin(args = [], pin = true) {
  const name = args.find((a) => !String(a).startsWith('-'));
  if (!name) {
    process.stderr.write(`usage: ox skill ${pin ? 'pin' : 'unpin'} <name>\n`);
    process.exitCode = 3;
    return;
  }
  const verb = pin ? 'pin' : 'unpin';
  const file = path.join(CONFIG_DIR, 'config.json');
  let doc;
  try {
    doc = readMcpDocStrict(file, '~/.ox/config.json');
  } catch (err) {
    process.stderr.write(`${c.red(`✗ ox skill ${verb}: ${err.message}`)}\n`);
    process.exitCode = 3;
    return;
  }
  const pins = (Array.isArray(doc.skill_pins) ? doc.skill_pins : []).map((s) => String(s).trim()).filter(Boolean);
  let next;
  if (pin) {
    if (!SKILL_NAME_RE.test(name)) {
      process.stderr.write(`${c.red(`✗ invalid skill name '${name}'`)} — lowercase [a-z0-9-]\n`);
      process.exitCode = 3;
      return;
    }
    next = [...new Set([...pins, name])];
  } else {
    next = pins.filter((p) => p !== name);
    if (!pins.includes(name)) {
      console.log(c.dim(`'${name}' was not pinned — nothing changed`));
      return;
    }
  }
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ ...doc, skill_pins: next }, null, 2)}\n`);
  } catch (err) {
    process.stderr.write(`${c.red(`✗ write failed (~/.ox/config.json): ${err.message}`)}\n`);
    process.exitCode = 3;
    return;
  }
  console.log(
    pin
      ? `${c.green(`✓ pinned '${name}'`)} — the curator will never archive it (${next.length} pin(s))`
      : `${c.green(`✓ unpinned '${name}'`)} — it is now curatable (${next.length} pin(s))`
  );
}

function cmdSkillCurate(args = []) {
  const dryRun = args.includes('--dry-run');
  const config = loadConfig();
  const rep = curateSkills(
    { home: os.homedir(), cwd: process.cwd() },
    // No crontab to consult: ox no longer installs system crontab entries (that
    // path went with the daemon-backed schedule store), so no skill can be
    // crontab-scheduled by ox and the immunity haystack is correctly empty. This
    // used to call `currentCrontab()`, which was removed with the installer and
    // left this call site as a ReferenceError — `ox skill curate` crashed on both
    // the dry-run and the applying path.
    { apply: !dryRun, config, crontab: '' }
  );
  const rows = [...rep.rows].sort((a, b) => a.name.localeCompare(b.name) || String(a.dir).localeCompare(String(b.dir)));
  const w = {
    name: Math.max(4, ...rows.map((r) => r.name.length)),
    state: Math.max(5, ...rows.map((r) => r.state.length)),
    action: Math.max(6, ...rows.map((r) => String(r.action ?? '-').length)),
  };
  console.log(`skill curation pass${dryRun ? ' (dry-run — no mutations)' : ''}:`);
  console.log(
    `${padCell('NAME', w.name)}  ${padCell('STATE', w.state)}  ${padCell('ACTION', w.action)}  REASON`
  );
  for (const r of rows) {
    console.log(
      `${padCell(r.name, w.name)}  ${padCell(r.state, w.state)}  ${padCell(String(r.action ?? '-'), w.action)}  ${truncate(r.reason, 72)}`
    );
  }
  for (const warning of rep.warnings) console.log(c.dim(`warning: ${warning}`));
  const archived = rows.filter((r) => r.action === 'archived').length;
  const wouldArchive = rows.filter((r) => r.action === 'would-archive').length;
  if (dryRun && wouldArchive > 0) {
    console.log(c.dim(`${wouldArchive} skill(s) archivable — re-run without --dry-run to apply (snapshots + ledger kept)`));
  } else if (!dryRun && archived > 0) {
    console.log(c.dim(`${archived} skill(s) archived — restore with: ox skill restore <name>`));
  } else {
    console.log(c.dim('nothing to do'));
  }
}

function cmdSkillRestore(args = []) {
  const name = args.find((a) => !String(a).startsWith('-'));
  if (!name) {
    process.stderr.write('usage: ox skill restore <name>\n');
    process.exitCode = 3;
    return;
  }
  const res = restoreSkill({ home: os.homedir(), cwd: process.cwd() }, name);
  if (!res.ok) {
    process.stderr.write(`${c.red(`✗ ${res.message}`)}\n`);
    process.exitCode = res.kind === 'not-found' ? 3 : 1;
    return;
  }
  console.log(`${c.green(`✓ restored '${res.name}'`)} → ${res.dest}`);
  console.log(c.dim(`snapshot: ${res.snapshot}${res.removedArchives.length ? ` · removed ${res.removedArchives.length} archived cop(y/ies)` : ''}`));
}

function cmdSkillAdopt(args = []) {
  const name = args.find((a) => !String(a).startsWith('-'));
  if (!name) {
    process.stderr.write('usage: ox skill adopt <name>\n');
    process.exitCode = 3;
    return;
  }
  const res = adoptSkill({ home: os.homedir(), cwd: process.cwd() }, name);
  if (!res.ok) {
    process.stderr.write(`${c.red(`✗ ${res.message}`)}\n`);
    process.exitCode = 3;
    return;
  }
  console.log(`${c.green(`✓ adopted '${res.name}'`)} — fresh .usage.json written; the curator now tracks it`);
}

async function cmdSkillPurge(args = []) {
  const yes = args.includes('--yes');
  const name = args.find((a) => !String(a).startsWith('-'));
  if (!name) {
    process.stderr.write('usage: ox skill purge <name> [--yes]\n');
    process.exitCode = 3;
    return;
  }
  if (!yes) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      process.stderr.write(
        `${c.red(`✗ refusing to purge '${name}' without confirmation`)} — re-run with --yes (non-TTY)\n`
      );
      process.exitCode = 4;
      return;
    }
    const okToPurge = await confirmPrompt(`permanently delete archived skill '${name}' and its old snapshots?`);
    if (!okToPurge) {
      console.log(c.dim('aborted — nothing purged'));
      process.exitCode = 4;
      return;
    }
  }
  const res = purgeSkill({ home: os.homedir(), cwd: process.cwd() }, name);
  if (!res.ok) {
    process.stderr.write(`${c.red(`✗ ${res.message}`)}\n`);
    process.exitCode = res.kind === 'not-archived' ? 3 : 1;
    return;
  }
  console.log(
    `${c.green(`✓ purged '${res.name}'`)} — ${res.removedArchives.length} archived cop(y/ies) + ${res.removedSnapshots.length} old snapshot(s) deleted`
  );
  console.log(c.dim(`final safety snapshot kept: ${res.keptSnapshot}`));
}

// `ox models hw|recommend|search|pull` — find, fit and fetch open models.
async function cmdModelHub(sub, args = []) {
  const H = await import('./model-hub.js');
  const hw = H.detectHardware();
  const where = hw.kind === 'apple-unified' ? `${hw.chip}, ${hw.ramGB} GB unified memory`
    : hw.kind === 'nvidia' ? `${hw.gpu}, ${hw.vramGB} GB VRAM` : `CPU only, ${hw.ramGB} GB RAM`;
  const header = () => console.log(c.dim(`${where} · model budget ${hw.budgetGB} GB · ~${hw.bandwidthGBs} GB/s`));
  const table = (rows) => {
    if (!rows.length) {
      console.log(c.dim('nothing fits this machine — try `ox models recommend --task small`'));
      return;
    }
    for (const r of rows) {
      const fit = r.fit === 'comfortable' ? c.green(r.fit) : r.fit === 'tight' ? c.yellow(r.fit) : r.fit;
      console.log(`${c.bold(r.repo)}\n  ${r.quant} · ${r.sizeGB} GB · ${fit} · ~${r.tokensPerSec} tok/s (estimate)${r.license ? c.dim(` · ${r.license}`) : ''}\n  ${c.dim(r.pull)}`);
    }
  };
  try {
    if (sub === 'hw' || sub === 'hardware') {
      header();
      return 0;
    }
    if (sub === 'recommend') {
      const ti = args.indexOf('--task');
      const task = ti >= 0 ? args[ti + 1] : 'code';
      header();
      console.log(c.dim(`searching Hugging Face for ${task} models that fit…`));
      table(await H.recommend({ task, hw }));
      return 0;
    }
    if (sub === 'search') {
      const q = args.filter((a) => !a.startsWith('--')).join(' ');
      if (!q) {
        process.stderr.write('usage: ox models search <query>\n');
        return 3;
      }
      header();
      const repos = await H.searchModels(q, { limit: 10 });
      const rows = [];
      for (const r of repos) {
        const d = await H.repoQuants(r.repo).catch(() => null);
        if (!d) continue;
        const pick = H.pickQuant(d.sizes, hw.budgetGB);
        if (pick) rows.push({ repo: r.repo, ...pick, fit: H.fitLabel(pick.sizeGB, hw.budgetGB), tokensPerSec: H.estimateTokensPerSec(pick.sizeGB, hw), pull: H.pullCommand(r.repo, pick.quant), license: d.license });
        else console.log(c.dim(`${r.repo}: no quant fits ${hw.budgetGB} GB`));
      }
      table(rows);
      return 0;
    }
    if (sub === 'pull') {
      const ref = args.find((a) => !a.startsWith('--'));
      if (!ref) {
        process.stderr.write('usage: ox models pull <owner/repo>[:QUANT]\n');
        return 3;
      }
      let [repo, quant] = ref.split(':');
      if (!quant) {
        const d = await H.repoQuants(repo);
        quant = H.pickQuant(d.sizes, hw.budgetGB)?.quant;
        if (!quant) {
          console.log(c.red(`✗ no quant of ${repo} fits ${hw.budgetGB} GB`));
          return 1;
        }
        console.log(c.dim(`picked ${quant} for this machine`));
      }
      const { spawnSync } = await import('node:child_process');
      const r = spawnSync('ollama', ['pull', `hf.co/${repo}:${quant}`], { stdio: 'inherit' });
      if (r.error) {
        console.log(c.red('✗ ollama is not installed — get it from https://ollama.com, or in LM Studio search for ' + repo));
        return 1;
      }
      if (r.status === 0) console.log(`${c.green('✓')} ready: ox --model ollama:hf.co/${repo}:${quant}`);
      return r.status ?? 1;
    }
  } catch (err) {
    console.log(c.red(`✗ ${err?.message ?? err}`));
    return 1;
  }
  return 3;
}

// `ox plugin ls|add|rm|enable|disable|import-claude` — Claude Code plugins in ox.
async function cmdPlugin(args = []) {
  const P = await import('./plugins.js');
  const sub = String(args[0] ?? 'ls').toLowerCase();
  const force = args.includes('--force');
  const target = args.slice(1).find((a) => !String(a).startsWith('-'));
  const printFindings = (findings) => {
    for (const f of findings.slice(0, 20)) {
      console.log(`  ${c.red('✗')} ${f.file}:${f.line}  ${c.bold(f.pattern)}  ${c.dim(f.why ?? '')}`);
    }
    if (findings.length > 20) console.log(c.dim(`  … ${findings.length - 20} more`));
  };
  const describe = (p) =>
    `${p.skills.length} skills, ${p.commands.length} commands, ${Object.keys(p.mcpServers).length} MCP servers` +
    (p.hasHooks ? c.dim(' (hooks not run by ox)') : '');

  if (sub === 'ls' || sub === 'list') {
    const reg = P.readRegistry();
    const names = Object.keys(reg.plugins).sort();
    if (!names.length) {
      console.log('no plugins — try: ox plugin import-claude, ox plugin add owner/repo, or ox plugin add name@owner/marketplace');
      return 0;
    }
    for (const name of names) {
      const rec = reg.plugins[name];
      const p = P.readPlugin(rec.path);
      const state = rec.enabled === false ? c.dim('disabled') : c.green('on');
      const mcpNote = p && Object.keys(p.mcpServers).length && rec.mcp === false ? c.dim(' (MCP off: ox plugin mcp ' + name + ' on)') : '';
      console.log(`${c.bold(name.padEnd(24))} ${state.padEnd(10)} ${p ? describe(p) : c.red('missing on disk')}${mcpNote}  ${c.dim(rec.kind)}`);
    }
    return 0;
  }
  if (sub === 'add' || sub === 'install') {
    if (!target) {
      process.stderr.write('usage: ox plugin add <folder | owner/repo[/path] | plugin@owner/marketplace> [--force]\n');
      return 3;
    }
    console.log(c.dim(`fetching ${target}…`));
    try {
      const res = await P.addPlugin(target, { force });
      if (!res.ok) {
        console.log(`${c.red('✗')} ${res.message}`);
        if (res.findings) printFindings(res.findings);
        if (res.kind === 'unsafe') console.log(c.dim('  review the files, then re-run with --force to install anyway'));
        return res.kind === 'unsafe' ? 4 : 1;
      }
      console.log(`${c.green('✓')} ${res.message}: ${describe(res.plugin)}`);
      if (res.plugin.skills.length) console.log(c.dim(`  skills: ${res.plugin.skills.map((s) => `${res.plugin.name}:${s}`).join(', ')}`));
      if (res.plugin.commands.length) console.log(c.dim(`  commands: ${res.plugin.commands.map((s) => `/${res.plugin.name}:${s}`).join(', ')}`));
      return 0;
    } catch (err) {
      console.log(`${c.red('✗')} ${err?.message ?? err}`);
      return 1;
    }
  }
  if (sub === 'import-claude') {
    const out = await P.importClaudePlugins({ force });
    for (const p of out.linked) console.log(`${c.green('✓')} linked ${c.bold(p.name)}: ${describe(p)}`);
    for (const w of out.warned) {
      const kinds = [...new Set(w.findings.map((f) => f.pattern))].join(', ');
      console.log(`${c.yellow('!')} ${w.name}: ${w.findings.length} scanner warning(s) (${kinds}) — linked because you installed it in Claude Code`);
    }
    if (!out.linked.length) console.log('no Claude Code plugins found in ~/.claude/plugins');
    console.log(c.dim('linked plugins are read in place; ox never modifies them'));
    return 0;
  }
  if (sub === 'rm' || sub === 'remove' || sub === 'uninstall') {
    const res = P.removePlugin(target ?? '');
    console.log(`${res.ok ? c.green('✓') : c.red('✗')} ${res.message}`);
    return res.ok ? 0 : 1;
  }
  if (sub === 'mcp') {
    const on = String(args[2] ?? '').toLowerCase();
    if (!target || !['on', 'off'].includes(on)) {
      process.stderr.write('usage: ox plugin mcp <name> on|off\n');
      return 3;
    }
    const res = P.setPluginMcp(target, on === 'on');
    console.log(`${res.ok ? c.green('✓') : c.red('✗')} ${res.message}`);
    return res.ok ? 0 : 1;
  }
  if (sub === 'enable' || sub === 'disable') {
    const res = P.setPluginEnabled(target ?? '', sub === 'enable');
    console.log(`${res.ok ? c.green('✓') : c.red('✗')} ${res.message}`);
    return res.ok ? 0 : 1;
  }
  process.stderr.write(`ox: unknown plugin subcommand '${sub}' (ls, add, rm, enable, disable, mcp, import-claude)\n`);
  return 3;
}

function cmdSkillLearn(args = []) {
  const sessionFile = args.find((a) => !String(a).startsWith('-')) ?? null;
  const target = sessionFile ?? process.env.OX_SESSION_FILE ?? null;
  if (!target) {
    process.stderr.write('usage: ox skill learn [session-file]\n');
    process.exitCode = 3;
    return;
  }
  const abs = path.resolve(process.cwd(), target);
  const result = learnFromSession({ sessionFile: abs });
  if (!result.ok) {
    process.stderr.write(`${c.red(`✗ ${result.message}`)}\n`);
    process.exitCode = result.kind === 'not-learned' ? 1 : 3;
    return;
  }
  console.log(`${c.green('✓ learned')} ${c.bold(result.name)} from ${path.basename(abs)}`);
  console.log(c.dim(`  lesson: "${result.message}"`));
  console.log(c.dim(`  skill:  ${result.file}`));
}

function cmdEpisode(args) {
  const sub = String(args[0] ?? '').trim().toLowerCase();
  if (sub === 'ls' || sub === '') {
    const rows = listEpisodes(process.cwd());
    if (!rows.length) {
      console.log('(no episodes yet)');
      return;
    }
    console.log(`${rows.length} episode(s), newest first:`);
    for (const r of rows) {
      const score = r.score != null ? String(r.score) : '-';
      const ver = r.verified ? (r.verifiedDate ?? 'yes') : '-';
      console.log(
        `${padCell(r.file.replace(/\.md$/, ''), 44)}  ${padCell(r.date ?? '-', 10)}  ${padCell(score, 5)}  ${padCell(ver, 10)}  ${truncate(r.goal, 48)}`
      );
    }
    return;
  }
  if (sub === 'promote') {
    const rest = args.slice(1);
    const force = rest.includes('--force');
    const ref = rest.find((a) => !String(a).startsWith('-'));
    if (!ref) {
      process.stderr.write('usage: ox episode promote <id|filename> [--force]\n');
      process.exitCode = 3;
      return;
    }
    const res = promoteEpisode(process.cwd(), ref, { force });
    if (res.ok) {
      console.log(res.path);
      console.log(
        c.dim(`skill '${res.name}' created from episode (${res.lessons} lesson(s), score ${res.score ?? '-'}, ${res.verified ? 'verified' : 'unverified'})`)
      );
      return;
    }
    process.stderr.write(`${c.red(`✗ ${res.message}`)}\n`);
    process.exitCode = res.kind === 'unqualified' || res.kind === 'exists' ? 4 : 3;
    return;
  }
  process.stderr.write(`ox: unknown episode subcommand '${args[0]}' (use ls or promote)\n`);
  process.exitCode = 3;
}

function cmdMem() {
  const block = loadMemoryBlock(process.cwd());
  console.log(block || '(empty)');
}

// `/memory-loss` -- what the memory subsystem archived, evicted, refused or
// deleted, and when.
//
// formatLossReport() has been exported and called by nothing but the tests. A
// ledger nobody can read is not observability: the events are all there, they
// are all truthful, and there was simply no way to see them. So the rows get a
// surface.
//
// READ-ONLY. This command reads the ledger and prints it. It moves nothing,
// prunes nothing, clears nothing, and takes no flags that could. The tally
// below is derived from the rows being printed, not from the in-process
// counters, so it describes the file the operator can go and read.
function cmdMemoryLoss(args = []) {
  let limit = 20;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--limit' || a === '-n') {
      const n = Number(args[i + 1]);
      if (!Number.isFinite(n) || n <= 0) {
        process.stderr.write(`ox: --limit needs a positive number of rows, got '${args[i + 1] ?? ''}'\n`);
        process.exitCode = 3;
        return;
      }
      limit = Math.floor(n);
      i++;
    } else {
      process.stderr.write(`ox: unknown argument '${a}' (usage: /memory-loss [--limit <n>])\n`);
      process.exitCode = 3;
      return;
    }
  }

  // One read, used for both the report and the tally, so the two can never
  // describe different data.
  const rows = readLossLedger({ limit });
  const tally = rows.reduce(
    (acc, r) => {
      acc.total += 1;
      if (r.action === 'archived') acc.archived += 1;
      else if (r.action === 'deleted') acc.deleted += 1;
      else if (r.action === 'kept') acc.kept += 1;
      else if (r.action === 'refused') acc.refused += 1;
      else if (r.action === 'uniquified') acc.uniquified += 1;
      return acc;
    },
    { total: 0, archived: 0, deleted: 0, kept: 0, refused: 0, uniquified: 0 }
  );

  console.log(formatLossReport({ limit }));
  if (tally.total) {
    console.log('');
    console.log(
      `last ${tally.total} row(s): ${tally.archived} archived · ${tally.deleted} deleted ` +
        `· ${tally.kept} kept (refused to move) · ${tally.refused} refused · ${tally.uniquified} uniquified`
    );
    const events = [...new Set(rows.map((r) => r.event))].sort();
    console.log(`events: ${events.join(', ')}`);
    if (tally.deleted) {
      console.log(c.dim('  (deleted rows are transcripts removed on explicit --delete opt-in; the rest were moved, not destroyed)'));
    }
  }
  console.log(c.dim(`ledger: ${lossLedgerPath()}`));
}

async function cmdClone(args = []) {
  const url = args.find((arg) => !String(arg).startsWith('-'));
  if (!url) {
    console.log(c.dim('usage: /clone <url> [--stack nextjs|vite|svelte|plain]'));
    console.log(c.dim('available stacks: nextjs, vite, svelte, plain'));
    return;
  }

  const stackIndex = args.indexOf('--stack');
  const opts = { cwd: process.cwd() };
  if (stackIndex >= 0 && args[stackIndex + 1]) opts.stack = args[stackIndex + 1];

  const { cloneWebsite } = await import('./website-cloner.js');
  try {
    const result = await cloneWebsite(url, opts);
    console.log(c.bold(`cloned ${url} into ${result.stack}`));
    console.log(`templates: ${result.specs.length} component spec(s)`);
    console.log(`components: ${result.components.length}`);
  } catch (err) {
    console.log(c.red(`✗ ${err?.message ?? err}`));
    process.exitCode = 1;
  }
}

// The board verbs: who holds what, review gates, the activity log. Returns
// undefined when `sub` is not one of them.
async function taskBoardVerb(sub, rest) {
  // Positional args, skipping each flag's value (`--limit 6` is not a task id).
  const VALUED = new Set(['--as', '--note', '--limit', '--usd']);
  const positional = rest.filter((a, i) => !String(a).startsWith('--') && !VALUED.has(rest[i - 1]));
  const id = positional[0];
  const flag = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
  const as = flag('--as');
  const note = flag('--note');
  const fail = (msg) => { process.stderr.write(`${c.red(`✗ ${msg}`)}\n`); process.exitCode = 1; return true; };
  const need = () => { process.stderr.write(`usage: ox task ${sub} <id>\n`); process.exitCode = 3; return true; };
  // A CLI claim is a lease (no process to watch): pid null.
  const who = { pid: null, ...(as ? { owner: as, actor: as } : {}) };
  switch (sub) {
    case 'claim': {
      if (!id) return need();
      const r = claimTask(id, who);
      if (!r.ok) return fail(r.reason);
      console.log(`${c.green('✓ claimed')} ${id} as ${r.task.assignee}`);
      return true;
    }
    case 'release': {
      if (!id) return need();
      const r = releaseTask(id, { ...who, force: rest.includes('--force') });
      return r.ok ? (console.log(`${c.green('✓ released')} ${id}`), true) : fail(r.reason);
    }
    case 'done': {
      if (!id) return need();
      const r = completeTask(id, { ...who, note, failed: rest.includes('--failed') });
      if (!r.ok) return fail(r.reason);
      console.log(r.task.status === 'in_review' ? `${c.yellow('◐ submitted for review')} ${id}` : `${c.green(`✓ ${r.task.status}`)} ${id}`);
      return true;
    }
    case 'approve':
    case 'reject': {
      if (!id) return need();
      const r = sub === 'approve' ? approveTask(id, { ...who, note }) : rejectTask(id, { ...who, note });
      if (!r.ok) return fail(r.reason);
      console.log(sub === 'approve' ? `${c.green('✓ approved')} ${id}` : `${c.yellow('↺ sent back')} ${id}${note ? `: ${note}` : ''}`);
      return true;
    }
    case 'next': {
      const t = nextTask(who);
      if (!t) { console.log(c.dim('nothing ready (every open task is claimed, blocked or in review)')); return true; }
      console.log(`${c.green('✓ claimed')} ${t.id}: ${t.title}`);
      const brief = taskBrief(t.id);
      if (brief) console.log(c.dim(brief));
      return true;
    }
    case 'brief': {
      if (!id) return need();
      const b = taskBrief(id);
      return b ? (console.log(b), true) : fail(`task not found: ${id}`);
    }
    case 'log': {
      const rows = taskActivity({ id, limit: Number(flag('--limit')) || 30 });
      if (!rows.length) { console.log(c.dim('(no activity)')); return true; }
      for (const e of rows) {
        const extra = e.fields ? ` ${e.fields.join(', ')}` : e.note ? `: ${e.note}` : '';
        console.log(`${(e.at ?? '').slice(0, 19)}  ${padCell(e.by ?? '?', 10)}  ${e.action}${extra}  ${c.dim(e.task)}`);
      }
      return true;
    }
    case 'spend': {
      const usd = Number(flag('--usd') ?? positional[1]);
      if (!id || !Number.isFinite(usd)) { process.stderr.write('usage: ox task spend <id> <usd>\n'); process.exitCode = 3; return true; }
      const r = addSpend(id, usd, who);
      return r.ok ? (console.log(`${c.green('✓ recorded')} $${usd} → $${r.spentUsd}`), true) : fail(r.reason === 'over budget' ? `over budget ($${r.spentUsd}): task blocked` : r.reason);
    }
    default:
      return undefined;
  }
}

// `ox voice status|setup|test`: OX Buddy's dictation (src/dictation.js).
async function cmdVoiceDictation(action, rest) {
  const bin = whisperBinary();
  const model = whisperModel();
  if (action === 'status') {
    console.log(c.bold('OX Buddy dictation'));
    console.log(`  recognizer   ${bin ? c.green(`whisper.cpp (${bin})`) : c.dim('Apple speech (install whisper.cpp for better accuracy: brew install whisper-cpp)')}`);
    console.log(`  model        ${model ? c.green(path.basename(model)) : c.dim(`none: ox voice setup  (base.en ${WHISPER_MODELS['base.en'].mb} MB, small.en ${WHISPER_MODELS['small.en'].mb} MB)`)}`);
    console.log(`  cleanup      ${c.green('on')} ${c.dim('fillers, stutters, punctuation, spacing, "new line"')}`);
    console.log(`  names        ${c.green('on')} ${c.dim(`${projectVocabulary(process.cwd()).length} names from this project (package dot json -> package.json)`)}`);
    return true;
  }
  if (action === 'test') {
    const file = rest.find((a) => !a.startsWith('--'));
    if (!file) {
      // Without audio: show what cleanup and correction do to typed text.
      process.stderr.write('usage: ox voice test <audio file>   or   ox voice test --text "um so open package dot json"\n');
      process.exitCode = 3;
      return true;
    }
    const ti = rest.indexOf('--text');
    if (ti >= 0) {
      const vocab = projectVocabulary(process.cwd());
      console.log(correctVocabulary(cleanTranscript(rest[ti + 1] ?? ''), vocab));
      return true;
    }
    const d = await dictate({ audioPath: path.resolve(file), cwd: process.cwd() });
    if (d.via !== 'whisper') {
      process.stderr.write(`${c.red('✗ whisper is not available')} — ${!bin ? 'install whisper.cpp (brew install whisper-cpp)' : 'run: ox voice setup'}\n`);
      process.exitCode = 1;
      return true;
    }
    console.log(d.text);
    return true;
  }
  // setup: download a whisper model, after saying what and how big.
  const name = rest.find((a) => !a.startsWith('--')) ?? 'base.en';
  const spec = WHISPER_MODELS[name];
  if (!spec) {
    process.stderr.write(`ox: unknown model '${name}' (choose ${Object.keys(WHISPER_MODELS).join(', ')})\n`);
    process.exitCode = 3;
    return true;
  }
  const dest = path.join(MODELS_DIR, spec.file);
  if (fs.existsSync(dest)) {
    console.log(`${c.green('✓')} ${spec.file} is already installed (${dest})`);
    return true;
  }
  const url = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${spec.file}`;
  console.log(`Download ${c.bold(spec.file)} (~${spec.mb} MB) from huggingface.co/ggerganov/whisper.cpp to ${dest}`);
  if (!rest.includes('--yes')) {
    if (!process.stdin.isTTY) {
      process.stderr.write('ox: confirm with --yes to download in a non-interactive shell\n');
      process.exitCode = 3;
      return true;
    }
    const readline = await import('node:readline/promises');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question('Download it now? [y/N] ')).trim().toLowerCase();
    rl.close();
    if (answer !== 'y' && answer !== 'yes') { console.log(c.dim('cancelled')); return true; }
  }
  fs.mkdirSync(MODELS_DIR, { recursive: true });
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) {
    process.stderr.write(`${c.red('✗ download failed')}: HTTP ${res.status}\n`);
    process.exitCode = 1;
    return true;
  }
  const total = Number(res.headers.get('content-length')) || spec.mb * 1048576;
  const tmp = `${dest}.part`;
  const out = fs.createWriteStream(tmp);
  let got = 0;
  let shown = -1;
  for await (const chunk of res.body) {
    out.write(chunk);
    got += chunk.length;
    const pct = Math.floor((got / total) * 100);
    if (pct !== shown && process.stdout.isTTY) { shown = pct; process.stdout.write(`\r  ${pct}%  ${(got / 1048576).toFixed(0)} MB`); }
  }
  await new Promise((r) => out.end(r));
  if (!verifyModel(tmp, spec)) {
    fs.rmSync(tmp, { force: true });
    process.stderr.write(`\n${c.red('✗ checksum mismatch')}: the download is not ox's pinned ${spec.file} (sha1 ${spec.sha1}); nothing was installed\n`);
    process.exitCode = 1;
    return true;
  }
  fs.renameSync(tmp, dest);
  console.log(`\n${c.green('✓')} installed ${spec.file}. OX Buddy now transcribes with whisper.`);
  return true;
}

async function cmdOrg(args = []) {
  const O = await import('./org.js');
  const sub = String(args[0] ?? '').toLowerCase();
  const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const num = (v) => (v === undefined ? undefined : v === 'none' ? null : Number(v));
  try {
    if (!sub || sub === 'chart' || sub === 'list') {
      const lines = O.chart({ all: args.includes('--all') });
      console.log(lines.length > 1 ? lines.join('\n') : `${lines[0]}\n${c.dim('  no agents yet: ox org hire <name> --title <title>')}`);
      const waiting = Object.values(O.readOrg().agents).filter((a) => a.status === 'proposed');
      if (waiting.length) console.log(c.yellow(`\n${waiting.length} hire(s) waiting for you: ${waiting.map((a) => `${a.id} (proposed by ${a.hiredBy})`).join(', ')} — ox org approve <id>`));
      return;
    }
    if (sub === 'hire') {
      const name = args.slice(1).filter((a, i, l) => !a.startsWith('--') && !(l[i - 1] ?? '').startsWith('--')).join(' ');
      // A sentence ("someone who reviews my PRs every morning on claude, $20 a month"): drafted, shown, hired.
      if (!flag('--title') && name.split(/\s+/).length >= 5) {
        const ask = async ({ system, user }) => {
          const { workingModelSpec } = await import('./working-model.js');
          const { quickText } = await import('./quick-text.js');
          const cfg = loadConfig();
          const spec = await workingModelSpec(cfg, { say: () => {} });
          return (await quickText(resolveBot(spec, cfg), { system, user, maxTokens: 400 })).text;
        };
        const d = await O.draftHire(name, { ask: args.includes('--no-model') ? null : ask });
        console.log(c.dim(`from your sentence${d.fromModel ? ' (with a model)' : ' (no model answered: read from the words)'}:`));
        for (const [k, v] of [['name', d.name], ['title', d.title], ['runtime', d.runtime ?? 'ox'], ['every', d.heartbeatMin ? `${d.heartbeatMin} min` : null], ['budget', d.budgetUsd != null ? `$${d.budgetUsd}/month` : null], ['may', d.approval ?? 'edits'], ['folder', d.cwd ?? null], ['reports to', d.reportsTo ?? null]]) if (v) console.log(`  ${k.padEnd(11)} ${v}`);
        console.log(c.dim(`  instructions: ${d.instructions.split('\n')[0].slice(0, 120)}`));
        if (args.includes('--draft')) return;
        const a = O.hire(d, { by: process.env.OX_ORG_AGENT || 'you' });
        console.log(a.status === 'proposed' ? `${c.yellow('proposed')} ${a.id}: waits for the owner (ox org approve ${a.id})` : `${c.green('✓ hired')} ${a.name} (${a.id})`);
        return;
      }
      const a = O.hire({ name, title: flag('--title'), role: flag('--role'), reportsTo: flag('--reports-to'), runtime: flag('--runtime'), budgetUsd: num(flag('--budget')), heartbeatMin: num(flag('--every')), instructions: flag('--instructions'), cwd: flag('--cwd'), approval: flag('--approval'), machine: flag('--machine') }, { by: process.env.OX_ORG_AGENT || 'you' });
      console.log(a.status === 'proposed' ? `${c.yellow('proposed')} ${a.id}: waits for the owner (ox org approve ${a.id})` : `${c.green('✓ hired')} ${a.name} (${a.id}) — ${a.title}, runs on ${a.runtime}${a.heartbeatMin ? `, wakes every ${a.heartbeatMin} min` : ''}`);
      return;
    }
    const id = args[1];
    const by = process.env.OX_ORG_AGENT || 'you';
    if (sub === 'approve') { O.approveHire(id, { by }); console.log(`${c.green('✓')} ${id} hired`); return; }
    if (sub === 'reject') { O.rejectHire(id, { by }); console.log(`${id} not hired`); return; }
    if (sub === 'pause') { O.pause(id, { by }); console.log(`${id} paused`); return; }
    if (sub === 'resume') { O.resume(id, { by }); console.log(`${c.green('✓')} ${id} active`); return; }
    if (sub === 'fire' || sub === 'terminate') { O.terminate(id, { by }); console.log(`${id} terminated`); return; }
    if (sub === 'set') {
      const a = O.update(id, { budgetUsd: num(flag('--budget')), heartbeatMin: num(flag('--every')), warnAt: flag('--warn-at'), title: flag('--title'), role: flag('--role'), reportsTo: flag('--reports-to'), runtime: flag('--runtime'), instructions: flag('--instructions'), approval: flag('--approval') }, { by });
      console.log(`${c.green('✓')} ${a.id} updated`);
      return;
    }
    if (sub === 'beat') {
      const runs = args.includes('--due') ? await O.beatDue() : [await O.beat(id)];
      if (!runs.length) console.log(c.dim('nobody is due'));
      for (const r of runs) console.log(`${r.agent}: ${r.state}${r.task ? ` ${r.task}` : ''}${r.ok === false ? c.red(` failed: ${r.why}`) : r.why ? ` (${r.why})` : ''}${r.costUsd != null ? ` · $${r.costUsd.toFixed(4)}` : ''}${r.warned ? c.yellow(' · budget warning') : ''}${r.stopped ? c.red(' · budget reached, paused') : ''}`);
      return;
    }
    if (sub === 'team' || sub === 'say' || sub === 'group') {
      const askModel = async ({ system, user }) => {
        const { workingModelSpec } = await import('./working-model.js');
        const { quickText } = await import('./quick-text.js');
        const cfg = loadConfig();
        return (await quickText(resolveBot(await workingModelSpec(cfg, { say: () => {} }), cfg), { system, user, maxTokens: 600 })).text;
      };
      if (sub === 'team') {
        // A team from one sentence (DeepSeek Bot's Chief of Staff): drafted, shown, hired, with a group chat.
        const sentence = args.slice(1).filter((a) => a !== '--draft').join(' ');
        if (!sentence) throw new Error('usage: ox org team "a writer who drafts blog posts and a coder who reviews code" [--draft]');
        const d = await O.draftTeam(sentence, { ask: askModel });
        console.log(`${c.bold(d.team)}`);
        for (const a of d.agents) console.log(`  ${c.bold(a.name)} · ${a.title}  ${c.dim(a.instructions.split('\n')[0].slice(0, 90))}`);
        if (args.includes('--draft')) return;
        const t = O.hireTeam(d, { by });
        console.log(`${c.green('✓ hired')} ${t.members.join(', ')}; group chat: ox org say ${t.group} "…"`);
        return;
      }
      if (sub === 'say') {
        const [gid, ...words] = args.slice(1);
        const replies = await O.groupSay(gid, words.join(' '), { ask: askModel, by });
        for (const r of replies) console.log(`${c.bold(r.from)}: ${r.text}`);
        if (!replies.length) console.log(c.dim('nobody had anything to add'));
        return;
      }
      const g = O.group(args[1]);
      for (const m of g.messages.slice(-30)) console.log(`${c.dim(m.at.slice(11, 16))} ${c.bold(m.from === 'you' ? 'you' : O.readOrg().agents[m.from]?.name ?? m.from)}: ${m.text}`);
      return;
    }
    // KODEMON: levels from real work, and battles through ox race.
    if (sub === 'levels') {
      const lv = O.levels();
      const org = O.readOrg();
      const rows = Object.entries(lv).filter(([aid]) => org.agents[aid]?.status !== 'terminated').sort((x, y) => y[1].xp - x[1].xp);
      if (!rows.length) { console.log(c.dim('no agents yet: ox org hire "…"')); return; }
      for (const [aid, v] of rows) console.log(`${c.bold(`Lv ${v.level}`)}  ${org.agents[aid].name.padEnd(14)} ${String(v.xp).padStart(5)} / ${v.next} XP  ${c.dim(`${v.tasks} tasks · ${v.calls} tool calls · ${v.wins} wins · ${v.losses} losses`)}`);
      return;
    }
    if (sub === 'battle') {
      const skip = new Set(['--test', '--apply']);
      const rest = [];
      for (let i = 3; i < args.length; i++) { if (args[i] === '--test') { i++; continue; } if (!skip.has(args[i])) rest.push(args[i]); }
      const before = O.levels();
      console.log(c.dim(`${args[1]} vs ${args[2]}: each works in its own copy of this project…`));
      const r = await O.battle(args[1], args[2], rest.join(' '), { test: flag('--test') ?? null, apply: args.includes('--apply'), log: (l) => console.log(c.dim(l)) });
      const after = O.levels();
      if (!r.winner) { console.log(c.yellow('no winner: neither change could be kept')); return; }
      const w = O.readOrg().agents[r.winner];
      console.log(`${c.green('✓')} ${c.bold(w.name)} wins${r.result.winner?.applied ? ' — its change is applied (captured)' : ` — its change is kept in ${r.result.patchDir}`}`);
      for (const aid of [r.winner, r.loser]) if (after[aid].level > before[aid].level) console.log(`  ${c.bold(O.readOrg().agents[aid].name)} levels up: Lv ${after[aid].level}`);
      return;
    }
    if (sub === 'timeline') {
      const t = O.timeline({ limit: Number(flag('--limit') ?? 40) });
      console.log(`${c.bold('irreversible actions:')} ${t.irreversible ? c.yellow(t.irreversible) : c.green('0')}   ${c.dim(`stopped by approvals: ${t.denied}`)}`);
      for (const x of t.items) console.log(`${x.at.slice(5, 16).replace('T', ' ')}  ${x.irreversible ? c.yellow('!') : x.denied ? c.red('×') : ' '} ${x.text.slice(0, 150)}`);
      return;
    }
    if (sub === 'thread') {
      const th = O.thread(id);
      console.log(`${c.bold(th.agent.name)} ${c.dim(`${th.agent.title} · ${th.runs.length} runs`)}`);
      for (const r of th.runs.slice(-Number(flag('--last') ?? 10))) {
        console.log(`\n${c.dim(r.at.slice(0, 16).replace('T', ' '))} ${r.ok ? c.green('✓') : c.red('✗')} ${c.bold(r.title)}${r.costUsd != null ? c.dim(` · $${r.costUsd.toFixed(4)}`) : ''}`);
        console.log(r.ok ? r.said.split('\n').slice(-6).join('\n') : c.red(r.why ?? 'failed'));
      }
      if (!th.runs.length) console.log(c.dim(`no runs yet: ox org tell ${th.agent.id} "…" --now`));
      return;
    }
    if (sub === 'tell') {
      const text = args.slice(2).filter((a) => a !== '--now').join(' ');
      const r = await O.tell(id, text, { by });
      console.log(`${c.green('✓')} ${r.agent.name} has it (${r.task.id})${args.includes('--now') ? '' : c.dim(' — picked up on its next beat; --now to wake it')}`);
      if (args.includes('--now')) {
        const b = await O.beat(id);
        console.log(`${b.agent}: ${b.state}${b.ok === false ? c.red(` failed: ${b.why}`) : ''}`);
        const last = O.thread(id).runs.at(-1);
        if (last) console.log(last.said.split('\n').slice(-8).join('\n'));
      }
      return;
    }
    if (sub === 'log') { for (const e of O.readOrg().log.slice(-40)) console.log(`${e.at.slice(0, 19)}  ${e.by.padEnd(10)} ${e.action} ${e.agent}${e.why ? c.dim(` — ${e.why}`) : ''}`); return; }
    console.error('usage: ox org [hire|approve|reject|pause|resume|fire|set|beat|tell|thread|timeline|log] — ox help for details');
    process.exitCode = 1;
  } catch (e) {
    console.error(c.red(e.message));
    process.exitCode = 1;
  }
}

async function cmdMesh(args = []) {
  const M = await import('./mesh.js');
  const sub = String(args[0] ?? 'status').toLowerCase();
  const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const words = (from) => args.slice(from).filter((a, i, l) => !a.startsWith('--') && !(l[from + i - 1] ?? '').startsWith('--'));
  const pct = (v) => (v == null ? '—' : `${Math.round(v * 100)} %`);
  const showAlerts = (alerts) => {
    for (const a of alerts ?? []) {
      console.log(c.yellow(`! ${a.text}`));
      a.options.forEach((o, i) => console.log(`    ${i + 1}. ${o.label}${o.model ? c.dim(`  (ox --model "${o.model}")`) : ''}`));
    }
  };
  // A throwaway node for one request when the machine's node is busy elsewhere:
  // peers know this machine by its key, not its port.
  const oneShot = () => M.startNode({ port: 0, proxyPort: 0, beacon: false, heartbeat: false });
  try {
    if (sub === 'status' || sub === 'list') {
      if (!M.hasIdentity()) { console.log(`This machine is not on a mesh yet.\n  ${c.bold('ox mesh invite')}       on the machine you use most, then\n  ${c.bold('ox mesh join <code>')}  on each other machine`); return; }
      let st = null;
      try { st = await M.control('heartbeat', { method: 'POST', timeoutMs: 8000 }); } catch {}
      const me = M.identity();
      console.log(`${c.bold(me.name)} ${c.dim(`(this machine, ${me.id})`)}${st ? '' : c.dim(' — node not running: ox mesh up, or open the OX app')}`);
      if (st?.self) console.log(c.dim(`  CPU ${pct(st.self.load)} · memory ${pct(st.self.mem)} · ${st.self.models.length} local models · keys: ${st.self.providers.join(', ') || 'none'}`));
      const peers = st?.peers ?? Object.values(M.readPeers()).map((p) => ({ ...p, live: null }));
      if (!peers.length) console.log(c.dim('  no paired machines yet: ox mesh invite here, then ox mesh join <code> on the other one'));
      for (const p of peers) {
        const s = p.live?.stats;
        const state = !st ? c.dim('?') : p.live?.error ? c.red(`unreachable (${p.live.error})`) : s ? c.green('up') : c.dim('…');
        const gives = Object.entries(p.grants ?? {}).filter(([, v]) => v).map(([k]) => k).join(', ');
        console.log(`${c.bold(p.name)} ${c.dim(p.id)}  ${state}${s ? `  CPU ${pct(s.load)} · memory ${pct(s.mem)}${s.battery != null ? ` · battery ${pct(s.battery)}${s.charging ? ' charging' : ''}` : ''} · ${s.models.length} models` : ''}`);
        console.log(c.dim(`    this machine lets it: ${gives || 'nothing'}${p.addr ? ` · at ${p.addr}` : ''}`));
      }
      showAlerts(st?.alerts);
      return;
    }
    if (sub === 'name') {
      const n = words(1).join(' ');
      if (!n) { console.log(M.identity().name); return; }
      console.log(`${c.green('✓')} this machine is now ${c.bold(M.setName(n))}`);
      return;
    }
    if (sub === 'invite') {
      let inv = null;
      try { inv = await M.control('invite', { method: 'POST' }); } catch {}
      if (inv) {
        console.log(`On the other machine:  ${c.bold(`ox mesh join ${inv.code}`)}\n${c.dim(`one use, until ${new Date(inv.expires).toLocaleTimeString()}; this machine's node is listening`)}`);
        return;
      }
      // No node running: run one here until someone joins (or the code expires).
      const node = await M.startNode({ plans: M.planHeadroom });
      const { code, expires } = node.invite();
      console.log(`${c.bold(M.identity().name)} is waiting. On the other machine:\n\n    ${c.bold(`ox mesh join ${code}`)}\n`);
      console.log(c.dim(`one use, 10 minutes. Same network: found automatically. Elsewhere: add --at <this machine's address>:${node.port}`));
      await new Promise((resolve) => {
        const t = setInterval(() => {
          if (!node.state.invite) { clearInterval(t); resolve(); }
          else if (Date.now() > expires) { clearInterval(t); console.log(c.yellow('the code expired')); resolve(); }
        }, 500);
      });
      const paired = Object.values(M.readPeers()).sort((a, b) => String(b.pairedAt).localeCompare(String(a.pairedAt)))[0];
      if (paired && Date.now() - Date.parse(paired.pairedAt) < 60_000) console.log(`${c.green('✓ paired with')} ${c.bold(paired.name)}. It may see this machine's status; model calls and tasks stay off until you allow them: ox mesh allow "${paired.name}" infer`);
      await node.close();
      return;
    }
    if (sub === 'join') {
      const code = args[1];
      if (!code) throw new Error('usage: ox mesh join <code> [--name <this machine>] [--at host:port]');
      console.log(c.dim(flag('--at') ? `pairing with ${flag('--at')}…` : 'looking for the inviting machine on this network…'));
      const peer = await M.join({ code, at: flag('--at') ?? null, name: flag('--name') ?? null, myPort: flag('--port') ? Number(flag('--port')) : undefined });
      console.log(`${c.green('✓ paired with')} ${c.bold(peer.name)} as ${c.bold(M.identity().name)}. Start this machine's node (ox mesh up, or the OX app) so it can be reached.`);
      return;
    }
    if (sub === 'allow' || sub === 'deny') {
      const grant = args[args.length - 1];
      const who = args.slice(1, -1).join(' ');
      const p = M.setGrant(who, grant, sub === 'allow');
      const what = M.PRESETS?.[grant] ? `${grant === 'full' ? 'everything' : grant} (${M.PRESETS[grant].join(', ')})` : grant;
      console.log(`${c.green('✓')} ${p.name} ${sub === 'allow' ? 'may now' : 'may no longer'} ask this machine for ${what}`);
      return;
    }
    if (sub === 'forget') { const p = M.forget(words(1).join(' ')); console.log(`${p.name} unpaired`); return; }
    if (sub === 'up') {
      const node = await M.startNode({ port: flag('--port') ? Number(flag('--port')) : undefined, plans: M.planHeadroom, onLog: (l) => console.log(c.dim(`[mesh] ${l}`)), onPaired: (p) => console.log(`${c.green('✓ paired with')} ${p.name}`) });
      console.log(`${c.bold(node.me.name)} is on the mesh ${c.dim(`(port ${node.port}, local endpoint ${node.proxyPort ?? 'held by another ox'}). Ctrl-C to stop.`)}`);
      let last = '';
      setInterval(() => {
        const now = JSON.stringify(node.state.alerts.map((a) => a.id));
        if (now !== last) { last = now; showAlerts(node.state.alerts); }
      }, 2000);
      await new Promise(() => {});
    }
    if (sub === 'models') {
      const node = await oneShot();
      try {
        await node.heartbeat();
        let any = false;
        for (const m of node.machines()) {
          if (m.error) { console.log(c.dim(`${m.name}: ${m.error}`)); continue; }
          for (const x of m.stats?.models ?? []) { any = true; console.log(`mesh:${m.name}/${x.name}`); }
          for (const pr of m.stats?.providers ?? []) { any = true; console.log(`mesh:${m.name}/${pr}  ${c.dim('(its key; needs a model, e.g. mesh:' + m.name + '/' + pr + ':<model>)')}`); }
        }
        if (!any) console.log(c.dim('no models offered yet (each machine shares what its local models and keys can run; model calls need: ox mesh allow <this machine> infer, on that machine)'));
      } finally { await node.close(); }
      return;
    }
    // Another machine's makeup, its agent sessions, its shared folders (read-only).
    const target = (ref) => { const i = String(ref ?? '').indexOf(':'); return i > 0 ? [ref.slice(0, i), ref.slice(i + 1)] : [ref, null]; };
    if (sub === 'describe' || sub === 'machine') {
      if (!args[1]) throw new Error('usage: ox mesh describe <machine>');
      const node = await oneShot();
      try {
        const d = await node.ask(args.slice(1).join(' '), 'describe', {}, { timeoutMs: 20_000 });
        console.log(`${c.bold(d.name)}  ${c.dim(`${d.model ?? ''} · ${d.os} · ${d.arch}`)}`);
        console.log(`  ${d.cpu ?? '?'} · ${d.cores} cores · ${d.memGb} GB memory${d.gpu ? ` · ${d.gpu}` : ''} · up ${d.uptimeH} h`);
        for (const k of d.disks) console.log(`  disk ${k.path}: ${k.freeGb} of ${k.totalGb} GB free`);
        console.log(`  agent tools: ${d.tools.join(', ') || 'none'}`);
        console.log(`  local models: ${d.models.join(', ') || 'none'}   keys for: ${d.providers.join(', ') || 'none'}`);
        console.log(`  ox ${d.ox ?? '?'} · ${d.sessions} agent session(s) live`);
      } finally { await node.close(); }
      return;
    }
    if (sub === 'agents') {
      if (!args[1]) throw new Error('usage: ox mesh agents <machine> [read <session id>]');
      const node = await oneShot();
      try {
        if (args[2] === 'read' && args[3]) {
          const r = await node.ask(args[1], 'agent-read', { id: args[3] }, { timeoutMs: 20_000 });
          for (const m of (r.messages ?? []).slice(-12)) console.log(`${c.bold(m.role)}: ${String(m.text).slice(0, 400)}`);
        } else {
          const r = await node.ask(args[1], 'agents', {}, { timeoutMs: 20_000 });
          if (!r.sessions.length) console.log(c.dim('no agent sessions there'));
          for (const x of r.sessions) console.log(`${x.state === 'idle' ? c.dim('○') : c.green('●')} ${c.bold(x.project)} ${c.dim(x.tool)}  ${x.doing || (x.state === 'idle' ? `idle ${Math.round(x.idleSec / 60)} min` : x.state)}  ${c.dim(x.id)}`);
        }
      } finally { await node.close(); }
      return;
    }
    // A dev server on another machine (Tesser's idea, your own machines): its own
    // dev command in a folder it shares, the pages here through the mesh.
    if (sub === 'dev') {
      const [who, p] = target(args[1]);
      if (!who) throw new Error('usage: ox mesh dev <machine>:<folder> | ox mesh dev <machine> list | ox mesh dev <machine> stop <port>');
      const node = await oneShot();
      let keep = false;
      try {
        if (args[2] === 'list') {
          const r = await node.ask(who, 'dev-list', {}, { timeoutMs: 20_000 });
          if (!r.servers.length) console.log(c.dim(`no dev servers started through ox on ${who}`));
          for (const x of r.servers) console.log(`${c.bold(String(x.port))}  ${x.dir}  ${c.dim(x.command)}`);
          return;
        }
        if (args[2] === 'stop') {
          const r = await node.ask(who, 'dev-stop', { port: Number(args[3]) }, { timeoutMs: 20_000 });
          console.log(r.stopped ? `${c.green('✓')} stopped` : c.yellow(`no dev server on port ${args[3]}`));
          return;
        }
        if (!p) throw new Error('say which folder: ox mesh dev <machine>:<folder>');
        console.log(c.dim(`starting ${p} on ${who}…`));
        const d = await node.ask(who, 'dev-start', { path: p }, { timeoutMs: 90_000 });
        const M = await import('./mesh.js');
        let base = null;
        try { if ((await M.control('status', { timeoutMs: 1500 }))) base = `http://127.0.0.1:${M.PROXY_PORT}`; } catch {}
        if (!base) { base = `http://127.0.0.1:${node.proxyPort}`; keep = true; }
        const url = `${base}/dev/${encodeURIComponent(who)}/${d.port}/`;
        console.log(`${c.green('✓')} ${c.bold(path.basename(d.dir))} is running on ${who} (${d.command})`);
        console.log(`  ${url}`);
        if (args.includes('--open')) { const { spawnSync } = await import('node:child_process'); spawnSync('open', [url]); }
        if (keep) {
          console.log(c.dim('  served from here until Ctrl-C (with ox running, its mesh node serves it instead)'));
          await new Promise((res) => process.once('SIGINT', res));
        }
      } finally { await node.close(); }
      return;
    }
    if (sub === 'ls') {
      const [who, p] = target(args[1]);
      if (!who) throw new Error('usage: ox mesh ls <machine>[:<folder>]');
      const node = await oneShot();
      try {
        const r = await node.ask(who, 'ls', { path: p ?? '~', all: args.includes('-a') }, { timeoutMs: 20_000 });
        console.log(c.dim(r.path));
        for (const e of r.entries) console.log(`${e.dir ? c.cyan(`${e.name}/`) : e.name}${!e.dir && e.size != null ? c.dim(`  ${e.size >= 1e6 ? `${(e.size / 1e6).toFixed(1)} MB` : `${Math.ceil(e.size / 1024)} KB`}`) : ''}`);
      } finally { await node.close(); }
      return;
    }
    if (sub === 'pull') {
      const [who, p] = target(args[1]);
      if (!who || !p) throw new Error('usage: ox mesh pull <machine>:<file> [<where here>]');
      const node = await oneShot();
      try {
        let dest = path.resolve(args[2] ?? '.');
        if (fs.existsSync(dest) && fs.statSync(dest).isDirectory()) dest = path.join(dest, path.basename(p));
        if (fs.existsSync(dest) && !args.includes('--overwrite')) throw new Error(`${dest} exists (--overwrite to replace it)`);
        const tmp = `${dest}.ox-part`;
        const fd = fs.openSync(tmp, 'w');
        let got = 0;
        const r = await node.ask(who, 'pull', { path: p }, { timeoutMs: 60_000, onChunk: (b) => { fs.writeSync(fd, b); got += b.length; } });
        fs.closeSync(fd);
        if (got !== r.size) { fs.rmSync(tmp, { force: true }); throw new Error(`incomplete copy (${got} of ${r.size} bytes)`); }
        fs.renameSync(tmp, dest);
        console.log(`${c.green('✓')} ${dest} ${c.dim(`(${got} bytes from ${who})`)}`);
      } finally { await node.close(); }
      return;
    }
    if (sub === 'share') {
      const who = args[1], folders = args.slice(2);
      if (!who || !folders.length) throw new Error('usage: ox mesh share <machine> <folder> [<folder>…]   (what that machine may browse and copy from here)');
      const pr = M.setRoots(who, folders);
      console.log(`${c.green('✓')} ${pr.name} may browse and copy from: ${pr.roots.join(', ')} ${c.dim(pr.grants.files ? '' : `(also: ox mesh allow "${pr.name}" files)`)}`);
      return;
    }
    if (sub === 'audit') {
      const S = await import('./mesh-services.js');
      const rows = S.readAudit(path.join(process.env.OX_HOME || path.join(os.homedir(), '.ox')), { limit: Number(args[1]) || 40 });
      if (!rows.length) console.log(c.dim('no other machine has asked anything of this one'));
      for (const r of rows) console.log(`${r.at.slice(0, 16).replace('T', ' ')}  ${c.bold(r.from)} ${r.op}${r.detail ? c.dim(` ${r.detail}`) : ''}`);
      return;
    }
    if (sub === 'lockdown') {
      const n = M.lockdown();
      console.log(`${c.green('✓')} ${n} paired machine(s) back to status only. Allow again with ox mesh allow <machine> <grant>`);
      return;
    }
    if (sub === 'run') {
      const who = args[1];
      const prompt = words(2).join(' ');
      if (!who || !prompt) throw new Error('usage: ox mesh run <machine> "<task>" [--in <folder on that machine>]');
      const node = await oneShot();
      try {
        const r = await node.ask(who, 'run', { prompt, cwd: flag('--in') ?? null }, { timeoutMs: 0, onChunk: (b) => process.stdout.write(b) });
        if (r?.code) process.exitCode = r.code;
      } finally { await node.close(); }
      return;
    }
    console.error('usage: ox mesh [status|name|invite|join|allow|deny|forget|up|models|run|describe|agents|ls|pull|share|audit|lockdown] — ox help for details');
    process.exitCode = 1;
  } catch (e) {
    console.error(c.red(e.message));
    process.exitCode = 1;
  }
}

async function cmdPr(args = []) {
  const D = await import('./dev-flow.js');
  const sub = String(args[0] ?? 'status').toLowerCase();
  const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const step = (s, d) => console.log(c.dim(`  ${s}: ${String(d).split('\n')[0].slice(0, 140)}`));
  try {
    if (sub === 'open' || sub === 'create') {
      const shots = flag('--shots');
      const pr = await D.openPr(process.cwd(), { title: flag('--title') ?? null, body: flag('--body') ?? '', base: flag('--base') ?? null, draft: args.includes('--draft'), checks: !args.includes('--no-checks'), onStep: step, capture: shots || flag('--url') ? { routes: (shots ?? '/').split(',').map((x) => x.trim()).filter(Boolean), base: flag('--url') ?? null } : null });
      for (const r of pr.checks.results) console.log(`  ${r.ok ? c.green('✓') : c.red('✗')} ${r.command}`);
      console.log(`${c.green(pr.created ? '✓ opened' : '✓ updated')} ${pr.url}`);
      if (!pr.checks.ok) console.log(c.yellow('a check failed before opening: ox pr fix hands it to ox'));
      return;
    }
    if (sub === 'status' || sub === 'comments') {
      const st = D.prStatus(process.cwd(), flag('--pr') ?? args[1] ?? null);
      console.log(`${c.bold(`#${st.number}`)} ${st.title}  ${c.dim(st.url)}`);
      console.log(`  ${st.state.toLowerCase()} · review: ${st.review?.toLowerCase().replace('_', ' ') ?? 'none'} · ${st.mergeable === 'CONFLICTING' ? c.red('conflicts with base') : 'no conflicts'}`);
      if (!st.checks.length) console.log(c.dim('  no CI checks on this PR'));
      for (const ch of st.checks) console.log(`  ${['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(ch.state) ? c.green('✓') : st.failing.includes(ch) ? c.red('✗') : c.yellow('…')} ${ch.name}`);
      if (sub === 'comments' || st.comments.length) for (const cm of st.comments) console.log(`  ${c.cyan(cm.author ?? '?')}${cm.path ? c.dim(` ${cm.path}:${cm.line ?? ''}`) : ''}: ${cm.body.trim().split('\n')[0].slice(0, 160)}`);
      console.log(st.canMerge ? c.green('ready to merge (merging is yours)') : c.dim(`not ready yet${st.openThreads ? ` (${st.openThreads} unresolved review thread${st.openThreads > 1 ? 's' : ''})` : ''}: ox pr fix`));
      return;
    }
    if (sub === 'fix') {
      const rounds = Number(flag('--rounds') ?? 1);
      for (let i = 0; i < rounds; i++) {
        const r = await D.fixPr(process.cwd(), { ref: flag('--pr') ?? null, onStep: step });
        console.log(`${r.done ? c.green('✓') : '•'} ${r.why}`);
        if (r.done || !r.pushed) break;
        if (i + 1 < rounds) { console.log(c.dim('  waiting for CI…')); await new Promise((res) => setTimeout(res, 90_000)); }
      }
      return;
    }
    console.error('usage: ox pr open [--title T] [--body B] [--base main] [--draft] [--no-checks] | status | comments | fix [--rounds n]');
    process.exitCode = 1;
  } catch (e) { console.error(c.red(e.message)); process.exitCode = 1; }
}

async function cmdRace(args = []) {
  // ox race "<task>" --agents ox,claude-plan,chatgpt-plan  |  ox race keep <race-id> <agent>
  const D = await import('./dev-flow.js');
  try {
    if (args[0] === 'keep') { const r = D.keep(process.cwd(), args[1], args[2]); console.log(`${c.green('✓ kept')} ${r.merged}; ${r.removed} worktree(s) cleaned up`); return; }
    const ai = args.indexOf('--agents');
    const agents = ai >= 0 ? String(args[ai + 1]).split(',').map((x) => x.trim()).filter(Boolean) : ['ox', 'claude-plan', 'chatgpt-plan'];
    const prompt = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--agents').join(' ');
    if (!prompt) throw new Error('usage: ox race "<task>" [--agents ox,claude-plan,chatgpt-plan,<model>]');
    const r = await D.race(process.cwd(), prompt, agents, { onStep: (k, d) => console.log(c.dim(`  ${d}`)) });
    console.log(`\n${c.bold(r.id)}  ${c.dim(prompt)}`);
    for (const x of r.results) console.log(`  ${x.ok && x.files ? (x.checksOk || !x.checks.length ? c.green('●') : c.yellow('●')) : c.red('●')} ${x.agent.padEnd(16)} ${x.files} files ${c.green(`+${x.plus}`)} ${c.red(`−${x.minus}`)}  ${Math.round(x.ms / 1000)} s  ${x.checks.map((k) => `${k.step} ${k.ok ? '✓' : '✗'}`).join(' ')}  ${c.dim(x.branch)}`);
    console.log(c.dim(`\ncompare: git diff ${r.results[0]?.branch} ${r.results[1]?.branch ?? ''}\nkeep one: ox race keep ${r.id} <agent>`));
  } catch (e) { console.error(c.red(e.message)); process.exitCode = 1; }
}

async function cmdEnv(args = []) {
  const D = await import('./dev-flow.js');
  const sub = String(args[0] ?? 'show').toLowerCase();
  try {
    const root = D.repoRoot(process.cwd());
    if (sub === 'show' || sub === 'detect') {
      if (sub === 'detect') D.writeRecipe(root, D.detectRecipe(root));
      const r = D.recipe(root);
      if (!Object.keys(r.recipe).length) { console.log(c.dim('nothing detected: write .ox/environment.yml (install:, lint:, build:, test:, start:)')); return; }
      if (r.saved) console.log(c.dim(`saved to ${path.relative(root, r.file)}`));
      for (const [k, v] of Object.entries(r.recipe)) console.log(`${k.padEnd(8)} ${v}`);
      return;
    }
    if (sub === 'check' || sub === 'run') {
      const steps = args.slice(1).filter((a) => !a.startsWith('--'));
      const out = D.runChecks(root, steps.length ? steps : ['lint', 'build', 'test'], { onStep: (s, cmd) => console.log(c.dim(`${s}: ${cmd}`)) });
      for (const r of out.results) console.log(`${r.ok ? c.green('✓') : c.red('✗')} ${r.step} ${c.dim(`${Math.round(r.ms / 1000)} s`)}${r.ok ? '' : `\n${r.tail}`}`);
      if (!out.results.length) console.log(c.dim('no steps to run'));
      if (!out.ok) process.exitCode = 1;
      return;
    }
    console.error('usage: ox env [show|detect|check [steps…]]');
    process.exitCode = 1;
  } catch (e) { console.error(c.red(e.message)); process.exitCode = 1; }
}

async function cmdTask(args = []) {
  const sub = String(args[0] ?? '').trim().toLowerCase();
  const rest = args.slice(1);
  if (sub === 'assign') {
    const [id, who] = rest;
    if (!id || !who) { console.error('usage: ox task assign <id> <agent|none>'); process.exitCode = 1; return; }
    const t = getTask(id);
    if (!t) { console.error(`no task ${id}`); process.exitCode = 1; return; }
    updateTask(id, { assignee: who === 'none' ? null : who });
    console.log(`${c.green('✓')} ${id} ${who === 'none' ? 'unassigned' : `assigned to ${who}`}`);
    return;
  }
  if (sub === 'list' || sub === '') {
    let statusFilter = null;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--status' && rest[i + 1]) {
        statusFilter = rest[i + 1];
        i++;
      }
    }
    const tasks = listTasks().filter(t => !statusFilter || t.status === statusFilter);
    if (!tasks.length) {
      console.log('(no tasks)');
      return;
    }
    const w = { id: Math.max(2, ...tasks.map((t) => String(t.id).length)), title: 30, status: 9, owner: 10 };
    console.log(`${padCell('ID', w.id)}  ${padCell('TITLE', w.title)}  ${padCell('STATUS', w.status)}  ${padCell('OWNER', w.owner)}  CREATED`);
    for (const t of tasks) {
      const extra = [
        (() => { const n = (t.blockedBy ?? []).filter((x) => getTask(x)?.status !== 'done').length; return n ? `blocked by ${n}` : ''; })(),
        t.budgetUsd != null ? `$${Number(t.spentUsd ?? 0).toFixed(2)}/$${Number(t.budgetUsd).toFixed(2)}` : '',
        t.review ? 'review' : '',
      ].filter(Boolean).join(' · ');
      console.log(`${padCell(t.id, w.id)}  ${padCell(t.title, w.title)}  ${padCell(t.status, w.status)}  ${padCell(t.assignee ?? '-', w.owner)}  ${(t.createdAt ?? '').slice(0, 19)}${extra ? `  ${c.dim(extra)}` : ''}`);
    }
    return;
  }
  if (sub === 'add') {
    const title = rest.find((a) => !String(a).startsWith('--'));
    if (!title) {
      process.stderr.write('usage: ox task add <title> [--description <desc>] [--tags <a,b>] [--cron <cron>] [--parent <id>] [--blocked-by <id,id>] [--budget <usd>] [--review]\n');
      process.exitCode = 3;
      return;
    }
    let description = '', tags = [], cron = null, parentId = null, blockedBy = [], budgetUsd = null, review = false;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--description' && rest[i + 1]) { description = rest[i + 1]; i++; }
      else if (rest[i] === '--tags' && rest[i + 1]) { tags = rest[i + 1].split(',').map(s => s.trim()).filter(Boolean); i++; }
      else if (rest[i] === '--cron' && rest[i + 1]) { cron = rest[i + 1]; i++; }
      else if (rest[i] === '--parent' && rest[i + 1]) { parentId = rest[i + 1]; i++; }
      else if (rest[i] === '--blocked-by' && rest[i + 1]) { blockedBy = rest[i + 1].split(',').map(s => s.trim()).filter(Boolean); i++; }
      else if (rest[i] === '--budget' && rest[i + 1]) {
        budgetUsd = Number(rest[i + 1]);
        i++;
        if (!Number.isFinite(budgetUsd) || budgetUsd < 0) {
          process.stderr.write(`${c.red('✗ --budget needs a dollar amount')}\n`);
          process.exitCode = 3;
          return;
        }
      } else if (rest[i] === '--review') review = true;
    }
    let task;
    try {
      task = addTask({ title, description, tags, cron, parentId, blockedBy, budgetUsd, review });
    } catch (err) {
      process.stderr.write(`${c.red(`✗ ${err.message}`)}\n`);
      process.exitCode = 3;
      return;
    }
    console.log(`${c.green('✓ task added')} ${task.id}: ${task.title}`);
    return;
  }
  if (sub === 'get') {
    const id = rest.find((a) => !String(a).startsWith('--'));
    if (!id) {
      process.stderr.write('usage: ox task get <id>\n');
      process.exitCode = 3;
      return;
    }
    const task = getTask(id);
    if (!task) {
      process.stderr.write(`${c.red('✗ task not found')}: ${id}\n`);
      process.exitCode = 3;
      return;
    }
    console.log(`${c.bold('task:')} ${task.id}`);
    console.log(`  title: ${task.title}`);
    console.log(`  description: ${task.description || '(none)'}`);
    console.log(`  status: ${task.status}`);
    console.log(`  tags: ${task.tags?.length ? task.tags.join(', ') : '(none)'}`);
    console.log(`  cron: ${task.cron || '(none)'}`);
    console.log(`  owner: ${task.assignee ?? '(unclaimed)'}`);
    if (task.parentId) console.log(`  why: ${goalChain(task.id).slice(1).map((g) => g.title).join(' ← ')}`);
    const open = task.blockedBy.filter((x) => getTask(x)?.status !== 'done');
    if (open.length) console.log(`  blocked by: ${open.join(', ')}`);
    if (task.budgetUsd != null) console.log(`  budget: $${task.spentUsd.toFixed(4)} of $${Number(task.budgetUsd).toFixed(2)}`);
    if (task.review) console.log(`  review: required${task.approvedBy ? ` (approved by ${task.approvedBy})` : ''}`);
    if (task.blockedReason) console.log(`  blocked: ${task.blockedReason}`);
    for (const n of task.comments.slice(-5)) console.log(`  note (${n.by}): ${n.text}`);
    console.log(`  created: ${task.createdAt}`);
    console.log(`  updated: ${task.updatedAt}`);
    return;
  }
  if (sub === 'run') {
    const id = rest.find((a) => !String(a).startsWith('--'));
    if (!id) {
      process.stderr.write('usage: ox task run <id>\n');
      process.exitCode = 3;
      return;
    }
    const task = getTask(id);
    if (!task) {
      process.stderr.write(`${c.red('✗ task not found')}: ${id}\n`);
      process.exitCode = 3;
      return;
    }
    const pi = rest.indexOf('--prompt');
    const prompt = pi >= 0 ? rest[pi + 1] : undefined;
    // --worktree: its own checkout and branch (agent-orchestrator), --pr: then a pull request from it.
    let wt = null;
    if (rest.includes('--worktree') || rest.includes('--pr')) {
      const D = await import('./dev-flow.js');
      wt = D.taskWorktree(process.cwd(), id);
      console.log(c.dim(`${wt.created ? 'new worktree' : 'worktree'} ${wt.dir} on ${wt.branch}`));
    }
    console.log(c.dim(`running task ${id}: ${task.title}`));
    const result = await runTask(id, { prompt, cwd: wt?.dir });
    if (result.success) {
      console.log(c.green('✓ task completed'));
      if (wt && rest.includes('--pr')) {
        const D = await import('./dev-flow.js');
        try {
          const pr = await D.openPr(wt.dir, { title: task.title, body: `Task ${id}: ${task.title}\n\n${task.description ?? ''}`, onStep: (s, d) => console.log(c.dim(`  ${s}: ${d}`)) });
          updateTask(id, { pr: pr.url, branch: wt.branch });
          console.log(`${c.green('✓ pull request')} ${pr.url}`);
        } catch (e) { console.log(c.yellow(`no PR: ${e.message}`)); }
      }
    } else {
      console.log(c.red(`✗ task failed: ${result.error}`));
    }
    return;
  }
  if (sub === 'update') {
    const id = rest.find((a) => !String(a).startsWith('--'));
    if (!id) {
      process.stderr.write('usage: ox task update <id> [--status <status>] [--title <t>] [--desc <d>]\n');
      process.exitCode = 3;
      return;
    }
    let status = null, title = null, description = null;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--status' && rest[i + 1]) { status = rest[i + 1]; i++; }
      else if (rest[i] === '--title' && rest[i + 1]) { title = rest[i + 1]; i++; }
      else if (rest[i] === '--desc' && rest[i + 1]) { description = rest[i + 1]; i++; }
    }
    const updates = {};
    if (status !== null) updates.status = status;
    if (title !== null) updates.title = title;
    if (description !== null) updates.description = description;
    const task = updateTask(id, updates);
    if (!task) {
      process.stderr.write(`${c.red('✗ task not found')}: ${id}\n`);
      process.exitCode = 3;
      return;
    }
    console.log(`${c.green('✓ task updated')} ${task.id}: ${task.title}`);
    return;
  }
  if (sub === 'delete' || sub === 'rm') {
    const id = rest.find((a) => !String(a).startsWith('--'));
    if (!id) {
      process.stderr.write('usage: ox task delete <id>\n');
      process.exitCode = 3;
      return;
    }
    const ok = deleteTask(id);
    console.log(ok ? c.green(`✓ deleted task ${id}`) : c.red(`✗ task not found: ${id}`));
    return;
  }
  const board = await taskBoardVerb(sub, rest);
  if (board !== undefined) return;
  process.stderr.write(`ox: unknown task subcommand '${args[0] ?? ''}' (use list | add | get | run | update | delete | claim | release | done | approve | reject | next | brief | log | spend)\n`);
  process.exitCode = 3;
}


async function cmdServe(args = []) {
  let port = 8080;
  let host = '127.0.0.1';
  let apiKey = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--port') {
      const v = args[i + 1];
      if (v === undefined) {
        process.stderr.write('ox: --port needs a value\n');
        process.exitCode = 3;
        return;
      }
      port = Number(v);
      i++;
    } else if (a === '--host') {
      const v = args[i + 1];
      if (v === undefined) {
        process.stderr.write('ox: --host needs a value\n');
        process.exitCode = 3;
        return;
      }
      host = v;
      i++;
    } else if (a === '--api-key') {
      apiKey = true;
    } else if (a === '--help' || a === '-h') {
      console.log(`${c.bold('ox serve')} — an OpenAI-compatible API and a web chat, on this machine`);
      console.log(c.dim('  ox serve [--port 8080] [--host 127.0.0.1] [--api-key]'));
      console.log(c.dim('  then open http://127.0.0.1:8080 for the chat, or point any OpenAI client at http://127.0.0.1:8080/v1'));
      console.log(c.dim('  --api-key requires a bearer token (printed at start); use it before binding beyond loopback'));
      return;
    } else if (String(a).startsWith('-')) {
      process.stderr.write(`ox: unknown flag '${a}'\n`);
      process.exitCode = 3;
      return;
    }
  }

  if (apiKey && !process.env.OX_SERVE_API_KEY) {
    process.stderr.write('ox: --api-key set but OX_SERVE_API_KEY is not in the environment\n');
    process.exitCode = 1;
    return;
  }

  let server = null;
  const sigHandlers = [];
  const shutdown = async (signal) => {
    process.stderr.write(`\n[serve] received ${signal}, shutting down...\n`);
    try {
      if (server) await server.close();
    } catch {}
    process.exit(0);
  };
  for (const sig of ['SIGINT', 'SIGTERM']) {
    const handler = () => shutdown(sig);
    process.on(sig, handler);
    sigHandlers.push({ sig, handler });
  }

  try {
    server = await startServer(port, host);
  } catch (err) {
    process.stderr.write(`${c.red(`✗ cannot start server: ${err?.message ?? err}`)}\n`);
    process.exitCode = 1;
    return;
  }
}

// ---------------------------------------------------------------------------
// ox ipc — the GUI bridge (see README "IPC / GUI bridge").
//
// A unix socket carrying newline-delimited JSON. A connected client watches the
// run live and may answer approval prompts out of band. The socket is the only
// channel and the only trust boundary: silence (no client, no answer, a
// timeout, a disconnect, a malformed frame) is always a DECLINE, never an
// allow, so the default non-TTY posture is untouched.
// ---------------------------------------------------------------------------

// Exactly one bridge per process. The closer is kept here because the bridge's
// lifetime is the RUN's lifetime: an accepted client socket is a ref'd handle,
// so a background bridge that is never closed keeps the process alive forever
// after the run has finished. Idempotent, and the process 'exit' hook remains
// the backstop for every path that does not reach an explicit close.
let closeIpcBridgeNow = null;

function closeIpcBridge() {
  const close = closeIpcBridgeNow;
  closeIpcBridgeNow = null;
  if (!close) return;
  try { close(); } catch {}
}

// One well-known default so a GUI can find ox without a discovery file.
const IPC_DEFAULT_SESSION = 'default';
const ipcDefaultSocketPath = () => socketPathFor(IPC_DEFAULT_SESSION);

// The session id is derived from the socket basename so `hello.sessionId` is
// meaningful and a client can tell two bridges apart.
function ipcSessionIdFor(socketPath) {
  return path.basename(String(socketPath ?? '')).replace(/\.sock$/, '') || IPC_DEFAULT_SESSION;
}

// Server metadata is best-effort: `ox ipc serve` must work on a machine with no
// provider configured at all, so a failed bot resolution just omits bot/model.
// `spec` is the run's own --bot/--model when there is one: hello is the only
// place a client learns which model is running, so it must describe the run
// rather than the config default the run overrode.
function ipcMeta(cwd, spec) {
  const meta = { version: VERSION, cwd };
  try {
    const config = loadConfig({ cwd });
    const target = resolveBot(spec ?? defaultBotSpec(config), config);
    if (target) {
      meta.bot = target.bot ?? null;
      // A bare provider spec ("custom") resolves with the provider name as its
      // model; the model actually sent is OX_MODEL / config.model.
      const bare = !target.model || target.model === target.provider;
      meta.model = (bare ? process.env.OX_MODEL || config.model : null) || target.model || null;
      meta.provider = target.provider ?? null;
    }
  } catch { /* no usable bot configured: the bridge still serves events */ }
  return meta;
}

function ipcApprovalTimeout() {
  const n = Number(process.env.OX_IPC_APPROVAL_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_APPROVAL_TIMEOUT_MS;
}

// close() is async, but an 'exit' handler cannot await, so the exit path also
// unlinks the socket synchronously. Both are idempotent, so a SIGINT followed
// by 'exit' cannot double-close or throw.
function installIpcLifecycle(server) {
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try { server.close(); } catch {}
    try { fs.unlinkSync(server.socketPath); } catch { /* already gone */ }
  };
  // Close the bridge, then re-raise with the DEFAULT disposition: an
  // interrupted run must still die exactly the way it did before --ipc existed
  // (a SIGINT listener would otherwise cancel Node's default kill).
  for (const sig of ['SIGINT', 'SIGTERM']) {
    const onSignal = () => {
      close();
      process.removeListener(sig, onSignal);
      try { process.kill(process.pid, sig); } catch { process.exit(1); }
    };
    process.on(sig, onSignal);
  }
  process.on('exit', close);
  return close;
}

// Bind the socket and wait for a verdict. A socket already owned by another ox
// run is an error, never a silent takeover.
// The bridge's CONTROL channel for subagent cancel and steer.
//
// Why this exists rather than a new socket or a new protocol: `subagent-cancel`
// and `subagent-steer` are ordinary control frames on the socket a run already
// has, so the dashboard and `ox agents cancel` reach a RUNNING agent without a
// discovery file, a pid, or a shared memory. And it is the only honest route:
// the control records are in-process (src/subagent-control.js), so a separate CLI
// process genuinely cannot cancel an agent by writing a file, and pretending
// otherwise would be the same "descriptor proves it is running" mistake
// src/subagent-registry.js was written to stop.
//
// The reply shape is the protocol's own `control-reply` (src/ipc.js), so a client
// waits on exactly the frame shape it already waits on for anything else.
function subagentControlRequest(msg, client) {
  const reply = (ok, result, error) => controlReply(msg, { ok, result, error });
  const type = String(msg?.type ?? '');
  // `msg.id` is the protocol's REQUEST-CORRELATION id (src/ipc.js controlReply
  // stamps the reply with it), NOT a subagent id. Reading the target out of it
  // would make every reply fail to correlate with the request that asked for it.
  const target = String(msg?.subagentId ?? '').trim();
  try {
    if (type === 'subagent-cancel') {
      const res = cancelSubagent(target, { by: 'operator', reason: msg?.reason ?? null });
      return reply(true, {
        ...res,
        // The tree, on every reply. A cancel that changed nothing and a cancel
        // that changed everything then answer the client with the SAME evidence,
        // and the client never has to hold a second opinion about the state.
        snapshot: agentSnapshot({ cwd: process.cwd() }),
      });
    }
    if (type === 'subagent-steer') {
      const res = steerSubagent(target, msg?.note ?? msg?.text ?? '', { by: 'operator' });
      return reply(Boolean(res.ok), res, res.ok ? null : res.reason);
    }
    if (type === 'subagent-snapshot') {
      return reply(true, {
        snapshot: agentSnapshot({ cwd: process.cwd() }),
        controls: listSubagentControls(),
        cancellation: subagentCancelStats(),
      });
    }
    if (type === 'subagent-steer-effect') {
      // The semantics, on demand. A client that needs to explain a steer to a
      // human asks the source of truth instead of paraphrasing it.
      return reply(true, { semantics: CANCEL_SEMANTICS, status: SUBAGENT_STATUS_CANCELLED });
    }
    return undefined;
  } catch (err) {
    return reply(false, undefined, String(err?.message ?? err));
  }
}

async function startIpcBridge({ socketPath, cwd, spec, foreground = false, approvalTimeoutMs = ipcApprovalTimeout() }) {
  const server = createIpcServer({
    socketPath,
    sessionId: ipcSessionIdFor(socketPath),
    approvalTimeoutMs,
    meta: ipcMeta(cwd ?? process.cwd(), spec),
    onRequest: subagentControlRequest,
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
  } catch (err) {
    try { server.close(); } catch {}
    throw new Error(
      err?.code === 'EIPCINUSE'
        ? `ipc socket already in use at ${socketPath} — another ox run owns it (pass --ipc=<path> to pick a different socket)`
        : `cannot start ipc bridge at ${socketPath}: ${err?.message ?? err}`
    );
  }
  // A background bridge must never be the reason a run stays alive: unref the
  // listening handle so the process still exits the moment the run is over.
  // The handle keeps serving while the loop is alive (the agent's own I/O
  // holds it), and the 'exit' hook below still removes the socket file.
  if (!foreground) {
    try { server.server?.unref?.(); } catch {}
    closeIpcBridgeNow = installIpcLifecycle(server);
  }
  return server;
}

// Resolve once a client has announced 'ready', or after timeoutMs regardless.
function waitForReadyClient(server, timeoutMs) {
  const ready = () => [...(server.clients ?? [])].some((cl) => cl?.ready);
  if (ready()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (v) => {
      clearTimeout(timer);
      server.removeListener?.('client-connected', onConnect);
      resolve(v);
    };
    const onConnect = () => done(true);
    const timer = setTimeout(() => done(ready()), timeoutMs);
    server.on?.('client-connected', onConnect);
  });
}

// Liveness uses the protocol's own 'probe' frame, which the server tears down
// on sight (src/ipc.js), so checking status can never be mistaken for a GUI
// that is ready to answer approvals.
function probeIpcSocket(socketPath, timeoutMs = 300) {
  return new Promise((resolve) => {
    let sock = null;
    let settled = false;
    const done = (live) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { sock?.destroy(); } catch {}
      resolve(live);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    try {
      sock = net.connect({ path: socketPath });
      sock.on('connect', () => {
        try { sock.write('{"type":"probe"}\n'); } catch {}
        done(true);
      });
      sock.on('error', () => done(false));
    } catch {
      done(false);
    }
  });
}

async function cmdIpc(args = []) {
  const sub = String(args[0] ?? '').toLowerCase();
  if (sub === 'serve') return cmdIpcServe(args.slice(1));
  if (sub === 'status') return cmdIpcStatus(args.slice(1));
  if (sub === 'watch') return cmdIpcWatch(args.slice(1));
  if (sub === '' || sub === '-h' || sub === '--help') {
    console.log(
      [
        'usage:',
        '  ox ipc serve [--socket <path>] [--approval-timeout <ms>]',
        '      run the GUI bridge in the foreground; prints the resolved socket path',
        '  ox ipc status [--socket <path>]',
        '      report whether a bridge is listening (exit 1 when it is not)',
        '  ox ipc watch [--socket <path>] [--fps <n>] [--plain] [--no-color]',
        '      live dashboard for a connected run; a=allow d=deny s=ask x=cancel-oldest-agent q=quit',
      ].join('\n')
    );
    return;
  }
  process.stderr.write(`ox: unknown ipc subcommand '${args[0]}'\n`);
  process.exitCode = 3;
}

async function cmdIpcServe(args = []) {
  let socketPath = ipcDefaultSocketPath();
  let approvalTimeoutMs = ipcApprovalTimeout();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const need = (flag) => {
      const v = args[i + 1];
      if (v === undefined) {
        process.stderr.write(`ox: ${flag} needs a value\n`);
        process.exitCode = 3;
        return null;
      }
      i++;
      return v;
    };
    if (a === '--socket') {
      const v = need(a);
      if (v === null) return;
      socketPath = path.resolve(v);
    } else if (a === '--approval-timeout') {
      const v = need(a);
      if (v === null) return;
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) {
        process.stderr.write(`ox: --approval-timeout needs a positive number of milliseconds, got '${v}'\n`);
        process.exitCode = 3;
        return;
      }
      approvalTimeoutMs = Math.floor(n);
    } else {
      process.stderr.write(`ox: unknown ipc flag '${a}'\n`);
      process.exitCode = 3;
      return;
    }
  }

  if (process.stdout.isTTY && !process.env.OX_NO_BANNER) console.log(oxBanner({ version: VERSION }));

  let server;
  try {
    server = await startIpcBridge({ socketPath, cwd: process.cwd(), foreground: true, approvalTimeoutMs });
  } catch (err) {
    process.stderr.write(`${c.red(`✗ ${err?.message ?? err}`)}\n`);
    process.exitCode = 4;
    return;
  }
  // The resolved path is the one line a client (or a script) needs; keep it
  // greppable and unadorned.
  console.log(`socket: ${server.socketPath}`);
  console.log(c.dim(`approval hold: ${approvalTimeoutMs}ms · silence (no answer) declines`));

  await new Promise((resolve) => {
    for (const sig of ['SIGINT', 'SIGTERM']) {
      process.on(sig, () => {
        process.stderr.write(`\n[ipc] received ${sig}, shutting down...\n`);
        try { server.close(); } catch {}
        resolve();
        process.exit(0);
      });
    }
  });
}

async function cmdIpcStatus(args = []) {
  let socketPath = ipcDefaultSocketPath();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--socket') {
      const v = args[i + 1];
      if (v === undefined) {
        process.stderr.write('ox: --socket needs a value\n');
        process.exitCode = 3;
        return;
      }
      socketPath = path.resolve(v);
      i++;
    } else {
      process.stderr.write(`ox: unknown ipc flag '${args[i]}'\n`);
      process.exitCode = 3;
      return;
    }
  }
  console.log(`socket: ${socketPath}`);
  const live = await probeIpcSocket(socketPath);
  if (live) {
    console.log(`state: ${c.green('listening')}`);
    return;
  }
  console.log(`state: ${c.dim('not listening')}`);
  process.exitCode = 1;
}

async function cmdIpcWatch(args = []) {
  let socketPath = ipcDefaultSocketPath();
  let fps = WATCH_DEFAULT_FPS;
  let plain = false;
  let color = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--socket') {
      const v = args[++i];
      if (v === undefined) {
        process.stderr.write('ox: --socket needs a value\n');
        process.exitCode = 3;
        return;
      }
      socketPath = path.resolve(v);
    } else if (a === '--fps') {
      const v = args[++i];
      if (v === undefined) {
        process.stderr.write('ox: --fps needs a value\n');
        process.exitCode = 3;
        return;
      }
      const n = Number(v);
      if (!Number.isFinite(n) || n < 1 || n > 60) {
        process.stderr.write(`ox: --fps needs a number between 1 and 60, got '${v}'\n`);
        process.exitCode = 3;
        return;
      }
      fps = Math.floor(n);
    } else if (a === '--plain') {
      plain = true;
    } else if (a === '--no-color') {
      color = false;
    } else if (a === '-h' || a === '--help') {
      console.log(
        [
          'usage:',
          '  ox ipc watch [--socket <path>] [--fps <n>] [--plain] [--no-color]',
          '      attach to a bridge and draw a live dashboard of the run in this terminal',
          `      (default socket ${ipcDefaultSocketPath()}, default fps ${WATCH_DEFAULT_FPS})`,
          '',
          '      keys while an approval is pending:',
          '        [a]llow   approve it       [d]eny   refuse it',
          '        [s]kip    decline to decide, so ox falls back to the terminal prompt',
          '        [q]uit   leave the dashboard (any pending approval then DECLINES)',
          '',
          '      --plain forces the line log used when stdout is not a TTY, where there is',
          '      no dashboard to draw and no keyboard to answer with. NO_COLOR disables',
          '      colour and needs no flag.',
        ].join('\n')
      );
      return;
    } else {
      process.stderr.write(`ox: unknown ipc flag '${a}'\n`);
      process.exitCode = 3;
      return;
    }
  }

  try {
    // runWatch rejects when no bridge answers, so this exits non-zero instead of
    // leaving a human staring at an empty dashboard.
    const result = await runWatch({ socketPath, fps, plain, color });
    if (result.reason === 'quit' || result.reason === 'interrupt' || result.reason === 'sigint') process.exit(0);
  } catch (err) {
    process.stderr.write(`${c.red(`✗ ${err?.message ?? err}`)}\n`);
    process.exitCode = 4;
  }
}

// `ox <cmd> --help` for the commands whose own parsers would otherwise reject
// --help as an unknown subcommand or flag. Each line is the usage the command
// already reports on a wrong argument, so the two cannot disagree.
const SUB_USAGE = {
  help: 'usage: ox help [task | serve | skill | mcp | autonomy | ipc | sessions | flags | all]',
  prompt: 'usage: ox prompt [--breakdown]  — show the system prompt ox would send here, layer by layer',
  session: 'usage: ox session export <id> | ox session prune',
  mcp: 'usage: ox mcp ls | add | remove | test',
  skill: 'usage: ox skill <name> | ox skill add <dir | owner/repo[/path]>',
  episode: 'usage: ox episode ls | ox episode promote <id>',
  'memory-loss': 'usage: ox memory-loss [--limit <n>]',
  create: 'usage: ox create "<prompt>" [--edit <image>] [--provider higgsfield|fal|openai|openrouter|local] [--model <id>] [--set key=value]... [--start <url>] [--end <url>] [--ref <url>]... [--video <url>] [--audio <url>] | --models [provider] | --history',
  hf: 'usage: ox hf search "<words>" | ox hf files <owner/repo> | ox hf pull <owner/repo>[:QUANT]',
  name: 'usage: ox name [<new name> | --reset]  — what ox is called everywhere; it answers to that name when you say it',
  usage: 'usage: ox usage [--days <n>] [--json]  — tokens and cost by model, agent, surface, project and day',
  market: 'usage: ox market ["<search>"] | install <name>@<owner/repo> | install <owner/repo> | add <owner/repo>',
  hook: 'usage: ox hook <claude|codex|gemini|cursor|copilot> [event]  — run by the agent itself with the event on stdin (set up with: ox hooks install <agent>)',
  'hook-relay': 'usage: ox hook-relay <agent> <session id>  — started by ox hook; one per agent session, not run by hand',
  hooks: 'usage: ox hooks install <claude|codex|gemini|cursor|copilot> [--yes] | uninstall <agent> [--yes] | status | safe on|off',
  memory: 'usage: ox memory [recall "<question>" | add "<fact>" [--project] | history <id> | forget <id> | all [--project]]',
  auto: 'usage: ox auto "<goal>" [--contract ["<goal>"]] [--max-cost <usd>] [--json] [--bot <name>] [--yes-edits] [-y] [--side-effects-ok]',
  attach: 'usage: ox attach <worker id>  — follow a detached run (ox agents lists them)',
  import: 'usage: ox import <claude-code | hermes | codex | all> [--dry-run]',
  task: 'usage: ox task list | add | get | run | update | delete | claim | release | next | done | approve | log',
  island: 'usage: ox island [start | stop | status | on | off | build | web]',
  plugin: 'usage: ox plugin ls | add | rm | enable | disable | mcp | import-claude',
  plugins: 'usage: ox plugin ls | add | rm | enable | disable | mcp | import-claude',
  verify: 'usage: ox verify  — run this project\'s tests (npm test, or test:unit) and report what passed',
};

async function runSubcommand(cmd, args) {
  if ((args[0] === '--help' || args[0] === '-h') && SUB_USAGE[cmd]) {
    console.log(SUB_USAGE[cmd]);
    return;
  }
  switch (cmd) {
    case 'version':
      printVersion();
      return;
    case 'help': {
      const topic = String(args[0] ?? '').trim().toLowerCase();
      if (!topic) usage();
      else if (topic === 'all') usageAll();
      else if (!usageTopic(topic)) {
        process.stderr.write(`ox: no help topic '${topic}'. Try: task, serve, skill, mcp, autonomy, ipc, sessions, flags, or all\n`);
        process.exitCode = 3;
      }
      return;
    }
    case 'bots':
      cmdBots();
      return;
    case 'sessions':
      cmdSessions();
      return;
    case 'session':
      await cmdSession(args);
      return;
    case 'history':
      cmdHistory(args);
      return;
    case 'doctor':
      await cmdDoctor(args);
      return;
    case 'prompt':
      await cmdPrompt(args);
      return;
    case 'mcp':
      await cmdMcp(args);
      return;
    case 'clone':
      await cmdClone(args);
      return;
    case 'skill':
      await cmdSkill(args);
      return;
    case 'episode':
      cmdEpisode(args);
      return;
    case 'mem':
      cmdMem();
      return;
    case 'memory-loss':
    case 'memoryloss':
      cmdMemoryLoss(args);
      return;
    case 'auto':
      await cmdAuto(args);
      return;
    case 'schedule':
      await cmdSchedule(args);
      return;
    case 'agent':
      await cmdAgent(args);
      return;
    // Daemon continuity. `agents`/`agent` differ by one letter and mean
    // different things: `ox agent` is the saved-agent library
    // (~/.ox/agents/*.json), `ox agents` is the LIVE session board.
    case 'agents':
      await cmdAgents(args);
      return;
    case 'daemon':
      await cmdDaemon(args);
      return;
    case 'attach':
      await cmdAttach(args);
      return;
    case 'shutdown':
      await cmdShutdown(args);
      return;
    case 'heartbeat':
      await cmdHeartbeat(args);
      return;
    case 'import':
      await cmdImport(args);
      return;
    case 'task':
      await cmdTask(args);
      return;
    case 'org':
      await cmdOrg(args);
      return;
    case 'mesh':
      await cmdMesh(args);
      return;
    case 'pr':
      await cmdPr(args);
      return;
    case 'library': {
      // ox library [add <url|file> | read <id> | ask <id> "q" | search <words> | rm <id>]
      const L = await import('./library.js');
      const sub = args[0] ?? 'list';
      const askModel = async ({ system, user }) => {
        const { workingModelSpec } = await import('./working-model.js');
        const { quickText } = await import('./quick-text.js');
        const cfg = loadConfig();
        return (await quickText(resolveBot(await workingModelSpec(cfg, { say: () => {} }), cfg), { system, user, maxTokens: 700 })).text;
      };
      try {
        if (sub === 'list') {
          const items = L.list();
          if (!items.length) { console.log(c.dim('your library is empty: ox library add <link or file>')); return; }
          for (const it of items) console.log(`${c.dim(it.id)}  ${c.bold(it.title.slice(0, 70))}  ${c.dim(`${it.kind} · ${it.words.toLocaleString('en-US')} words${it.highlights.length ? ` · ${it.highlights.length} highlights` : ''}`)}`);
          return;
        }
        if (sub === 'add') { const it = await L.add(args[1]); console.log(`${c.green('✓ on the shelf')} ${c.bold(it.title)} ${c.dim(`(${it.kind}, ${it.words.toLocaleString('en-US')} words, ${it.id})`)}`); return; }
        if (sub === 'read') { const it = L.load(args[1]); if (!it) throw new Error(`no item ${args[1]}`); console.log(`${c.bold(it.title)}\n${c.dim(it.source)}\n\n${it.text}`); return; }
        if (sub === 'ask') { const r = await L.askAbout(args[1], args.slice(2).join(' '), { ask: askModel }); console.log(`${c.dim(r.title)}\n${r.answer}`); return; }
        if (sub === 'search') { for (const x of L.search(args.slice(1).join(' '))) console.log(`${c.dim(x.id)}  ${c.bold(x.title)}\n  ${c.dim(x.passage.replace(/\s+/g, ' ').slice(0, 200))}`); return; }
        if (sub === 'rm') { console.log(L.remove(args[1]) ? 'removed' : 'no such item'); return; }
        // Connect your agent: Claude Code, Codex, ChatGPT… use the library over MCP.
        if (sub === 'mcp') { L.serveLibraryMcp(); await new Promise(() => {}); }
        if (sub === 'connect') {
          const bin = `${process.execPath} ${path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'bin', 'ox.js')}`;
          console.log(`Give any agent your library (it can save, search and read; never delete):\n\n  Claude Code:  claude mcp add ox-library -- ${bin} library mcp\n  Codex:        add to ~/.codex/config.toml:\n                [mcp_servers.ox-library]\n                command = "${process.execPath}"\n                args = ["${path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'bin', 'ox.js')}", "library", "mcp"]\n  Any MCP app:  command ${bin} library mcp`);
          return;
        }
        console.error('usage: ox library [add <url|file> | read <id> | ask <id> "<question>" | search <words> | rm <id> | connect | mcp]'); process.exitCode = 3;
      } catch (e) { console.error(c.red(e.message)); process.exitCode = 1; }
      return;
    }
    case 'commands': {
      // ox's commands as slash commands everywhere (src/slash-catalog.js).
      const S = await import('./slash-catalog.js');
      const sub = args[0] ?? 'list';
      if (sub === 'install') {
        const only = ['claude', 'codex', 'cursor'].filter((t) => args.includes(`--${t}`));
        const bin = (() => { try { return execFileSync('which', ['ox'], { encoding: 'utf8' }).trim() ? 'ox' : null; } catch { return null; } })() ?? `${process.execPath} ${path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'bin', 'ox.js')}`;
        const done = S.install({ only: only.length ? only : null, bin });
        if (!done.length) { console.log(c.yellow('none of Claude Code, Codex or Cursor is installed here')); return; }
        for (const d of done) console.log(`${c.green('✓')} ${c.bold(d.tool)}: ${d.files} files · try ${d.invoke} "…"${d.tool !== 'Cursor' ? ' · and the ox skill, so it uses ox commands on its own' : ''}`);
        console.log(c.dim('ox commands uninstall removes exactly these files'));
        return;
      }
      if (sub === 'uninstall') { console.log(`removed ${S.uninstall()} files`); return; }
      let group = '';
      for (const x of S.COMMANDS) {
        if (x.group !== group) { group = x.group; console.log(c.bold(group)); }
        console.log(`  ${x.usage.padEnd(70).slice(0, 70)} ${c.dim(x.what)}`);
      }
      return;
    }
    case 'theme': {
      // Restyle ox from a sentence (src/ui-theme.js); the open app picks it up in seconds.
      const T = await import('./ui-theme.js');
      const sub = args[0] ?? 'list';
      try {
        if (sub === 'list') { for (const t of T.list()) console.log(`${t.active ? c.green('●') : ' '} ${c.bold(t.name.padEnd(12))} ${c.dim(`${t.description}${t.preset ? ' (built in)' : ''}`)}`); return; }
        if (sub === 'reset') { T.reset(); console.log('back to the app\'s own look'); return; }
        if (sub === 'use') { const t = T.use(args[1]); console.log(`${c.green('✓')} ${t.name}: ${t.description}`); return; }
        const askModel = async ({ system, user }) => {
          const { workingModelSpec } = await import('./working-model.js');
          const { quickText } = await import('./quick-text.js');
          const cfg = loadConfig();
          return (await quickText(resolveBot(await workingModelSpec(cfg, { say: () => {} }), cfg), { system, user, maxTokens: 1500 })).text;
        };
        const t = await T.fromPrompt(args.join(' '), { ask: args.includes('--preset') ? null : askModel });
        const ratio = T.contrast(t.tokens['--text'] ?? '#EDEDED', t.tokens['--bg'] ?? '#000000');
        console.log(`${c.green('✓')} ${c.bold(t.name)}: ${t.description}${ratio ? c.dim(` · text contrast ${ratio}:1${ratio < 4.5 ? ' (low)' : ''}`) : ''}${t.dropped.length ? c.yellow(` · left out: ${t.dropped.join(', ')}`) : ''}`);
      } catch (e) { console.error(c.red(e.message)); process.exitCode = 1; }
      return;
    }
    case 'browse': {
      // The fast browser (src/fast-browser.js; jev-ultrafast's design, ox's own code).
      const F = await import('./fast-browser.js');
      const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
      const VALUED = new Set(['--url', '--model']);
      const goal = args.filter((a, i) => !a.startsWith('--') && !VALUED.has(args[i - 1])).join(' ');
      if (!goal) { console.error('usage: ox browse "<goal>" [--url <page>] [--show] [--model <id>]'); process.exitCode = 3; return; }
      if (flag('--model')) process.env.OX_FAST_BROWSER_MODEL = flag('--model');
      const url = flag('--url') ?? 'about:blank';
      if (url !== 'about:blank' && !/^(https?|file):\/\//.test(url)) { console.error(c.red('the start page is an http(s) link')); process.exitCode = 3; return; }
      try {
        const r = await F.runGoal(goal, {
          url, headless: !args.includes('--show'),
          onStep: ({ row, elapsedMs }) => { if (!row.operation.endsWith('?') && row.operation !== 'WAIT') console.log(`${c.dim(`${(elapsedMs / 1000).toFixed(2).padStart(6)}s`)} ${c.green('✓')} ${F.chip(row)} ${c.dim(row.operation.toLowerCase())}`); },
          confirm: async ({ label, url: at }) => {
            if (!process.stdin.isTTY) return false;
            const rl = (await import('node:readline/promises')).createInterface({ input: process.stdin, output: process.stdout });
            const a = await rl.question(c.yellow(`Click "${label}" on ${at}? This commits something. [y/N] `));
            rl.close();
            return /^y(es)?$/i.test(a.trim());
          },
        });
        const secs = (r.elapsedMs / 1000).toFixed(2);
        console.log(r.status === 'done' ? `\n${c.green(c.bold(`${secs} s`))}  ${c.dim(`done · ${r.decisions.length} decisions · ${r.title}`)}` : `\n${c.yellow(`${r.status} after ${secs} s`)}${r.reason ? `: ${r.reason}` : ''}`);
        if (r.status !== 'done') process.exitCode = 1;
      } catch (e) { console.error(c.red(e.message)); process.exitCode = 1; }
      return;
    }
    case 'studio': {
      // OX Studio for any agent (src/studio-mcp.js, docs/STUDIO_ARCHITECTURE.md).
      const S = await import('./studio-mcp.js');
      const sub = args[0] ?? 'models';
      try {
        if (sub === 'mcp') { S.serveStudioMcp(); await new Promise(() => {}); }
        if (sub === 'connect') {
          const script = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'bin', 'ox.js');
          const bin = `${process.execPath} ${script}`;
          console.log(`Give any agent OX Studio (open image, video and audio models; it makes and edits, never deletes):\n\n  Claude Code:  claude mcp add ox-studio -- ${bin} studio mcp\n  Codex:        add to ~/.codex/config.toml:\n                [mcp_servers.ox-studio]\n                command = "${process.execPath}"\n                args = ["${script}", "studio", "mcp"]\n  Cursor:       ~/.cursor/mcp.json → {"mcpServers":{"ox-studio":{"command":"${process.execPath}","args":["${script}","studio","mcp"]}}}\n  Any MCP app:  command ${bin} studio mcp\n\nThe models run where you have a key: FAL_KEY (fal) or HF_TOKEN (Hugging Face), or your own Stable Diffusion server (OX_SD_URL). Nothing is installed.`);
          return;
        }
        const st = S.createStudio();
        if (sub === 'models') { console.log(await st.call('models_explore', args[1] ? { kind: args[1] } : {})); return; }
        if (sub === 'recipes') { console.log(await st.call('workflow_instructions', args[1] ? { name: args[1] } : {})); return; }
        console.error('usage: ox studio [models [kind] | recipes [name] | connect | mcp]'); process.exitCode = 3;
      } catch (e) { console.error(c.red(e.message)); process.exitCode = 1; }
      return;
    }
    case 'research': {
      // ox research "<topic>" [--on reddit,hn,youtube,x,linkedin]: what people say.
      const S = await import('./social-research.js');
      const oi = args.indexOf('--on');
      const q = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--on').join(' ');
      if (!q) { console.error('usage: ox research "<topic>" [--on reddit,hn,youtube,x,linkedin]'); process.exitCode = 3; return; }
      const r = await S.research(q, { platforms: oi >= 0 ? String(args[oi + 1]).split(',') : S.PLATFORMS });
      for (const p of r) {
        console.log(`\n${c.bold(p.platform === 'hn' ? 'Hacker News' : p.platform[0].toUpperCase() + p.platform.slice(1))}${p.error ? c.yellow(`  ${p.error}`) : p.rows.length ? '' : c.dim('  nothing found')}`);
        for (const x of p.rows) console.log(`  ${x.title}${c.dim(`${x.where ? ` · ${x.where}` : ''}${x.author ? ` · ${x.author}` : ''}${x.score != null ? ` · ${x.score} pts` : ''}`)}\n  ${c.dim(x.url)}`);
      }
      return;
    }
    case 'dictation': {
      // ox dictation style <as-said|natural|polished> [--app Mail] | translate <language|off> | show
      const D = await import('./dictation-style.js');
      const sub = args[0] ?? 'show';
      const ai = args.indexOf('--app');
      try {
        if (sub === 'style') D.setStyle(args[1], ai >= 0 ? args[ai + 1] : null);
        else if (sub === 'translate') D.setTranslate(args.slice(1).join(' '));
        else if (sub !== 'show') { console.error('usage: ox dictation style <as-said|natural|polished> [--app <App>] | translate <language|off> | show'); process.exitCode = 3; return; }
        const st = D.readStyles();
        console.log(`style: ${st.default}${Object.keys(st.apps).length ? `  ·  ${Object.entries(st.apps).map(([a, v]) => `${a}: ${v}`).join(', ')}` : ''}${st.translate ? `  ·  translated into ${st.translate}` : ''}`);
      } catch (e) { console.error(c.red(e.message)); process.exitCode = 1; }
      return;
    }
    case 'trace':
    case 'traces': {
      const T = await import('./trace.js');
      const id = args.find((a) => !a.startsWith('--'));
      const fmt = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
      if (!id) {
        const list = T.listTraces({ limit: Number(args[args.indexOf('--limit') + 1]) || 20, signals: args.includes('--signals') });
        if (args.includes('--json')) { console.log(JSON.stringify(list, null, 2)); return; }
        if (!list.length) { console.log(c.dim('no traces yet: every ox run from now on keeps one (~/.ox/traces)')); return; }
        for (const t of list) console.log(`${c.dim(t.id)}  ${t.outcome === 'error' ? c.red('✗') : t.signals.length ? c.yellow('!') : c.green('✓')} ${String(t.surface ?? '').padEnd(6)} ${String(t.model ?? '?').slice(0, 22).padEnd(22)} ${String(t.turns).padStart(3)} turns ${fmt(t.inTokens + t.outTokens).padStart(6)} tok ${t.cost != null ? `$${t.cost.toFixed(4)}` : '     —'} ${String(t.tools).padStart(3)} tools${t.failed ? c.red(` ${t.failed} failed`) : ''}  ${c.dim(t.prompt.slice(0, 50))}${t.signals.length ? `\n${' '.repeat(18)}${c.yellow(t.signals.map((x) => x.text).join(' · '))}` : ''}`);
        return;
      }
      const t = T.readTrace(id);
      if (args.includes('--json')) { console.log(JSON.stringify(t, null, 2)); return; }
      console.log(`${c.bold(t.id)}  ${t.outcome} · ${Math.round(t.ms / 1000)} s · ${t.model ?? '?'} · ${t.surface}${t.agent ? ` · agent ${t.agent}` : ''}\n${c.dim(t.prompt)}`);
      console.log(`${t.turns} turns · ${fmt(t.inTokens)} in / ${fmt(t.outTokens)} out${t.cost != null ? ` · $${t.cost.toFixed(4)}` : ''} · ${t.tools} tool calls${t.failed ? `, ${t.failed} failed` : ''}`);
      for (const [n, b] of Object.entries(t.byTool).sort((a, b) => b[1].calls - a[1].calls)) console.log(c.dim(`  ${n.padEnd(18)} ${b.calls}×${b.failed ? ` (${b.failed} failed)` : ''} ${Math.round(b.ms)} ms`));
      for (const s of t.signals) console.log(c.yellow(`! ${(s.at / 1000).toFixed(1)} s: ${s.text}`));
      if (args.includes('--steps')) for (const r of t.rows) if (r.t !== 'run') console.log(c.dim(`${(r.at / 1000).toFixed(1).padStart(7)} s  ${r.t === 'tool' ? `→ ${r.name} ${r.args}` : r.t === 'tool-end' ? `  ${r.ok ? 'ok' : 'FAILED'} ${r.ms ?? '?'} ms ${r.bytes ?? ''}b` : r.t === 'turn' ? `model ${r.in}+${r.out} tok` : `${r.t} ${r.text ?? r.error ?? r.outcome ?? ''}`}`));
      return;
    }
    case 'env':
      await cmdEnv(args);
      return;
    case 'race':
      await cmdRace(args);
      return;
    case 'wiki': {
      // ox wiki [--out <dir>] [--top N]: the project's wiki from its code graph (Devin's Wiki, no model).
      const W = await import('./wiki.js');
      const oi = args.indexOf('--out'), ti = args.indexOf('--top');
      const t = Date.now();
      const r = W.buildWiki(process.cwd(), { ...(oi >= 0 ? { out: path.resolve(args[oi + 1]) } : {}), ...(ti >= 0 ? { top: Number(args[ti + 1]) } : {}) });
      console.log(`${c.green('✓')} ${r.pages} pages, ${r.subsystems} subsystems in ${((Date.now() - t) / 1000).toFixed(1)} s ${c.dim(`→ ${path.relative(process.cwd(), r.dir) || r.dir}/index.md`)}`);
      return;
    }
    case 'git': {
      // ox git clone <url> [dir] | ox git mirror <url> | ox git mirrors: one local mirror per repo.
      const D = await import('./dev-flow.js');
      try {
        if (args[0] === 'clone' && args[1]) {
          const dest = args[2] ?? path.basename(String(args[1]).replace(/\.git$/, '').replace(/\/$/, ''));
          const t = Date.now();
          const r = D.mirrorClone(args[1], dest, { dissociate: !args.includes('--shared') });
          console.log(`${c.green('✓')} ${r.dest} ${c.dim(`(${((Date.now() - t) / 1000).toFixed(1)} s; history from the local mirror${r.mirrorCreated ? ', made just now' : ''}: ${r.mirror})`)}`);
          return;
        }
        if (args[0] === 'mirror' && args[1]) { const m = D.mirror(args[1]); console.log(`${c.green('✓')} ${m.path} ${c.dim(m.created ? 'made' : 'up to date')}`); return; }
        if (args[0] === 'mirrors') {
          const root = path.join(process.env.OX_HOME || path.join(os.homedir(), '.ox'), 'git-mirrors');
          const walk = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.name.endsWith('.git') ? [path.join(d, e.name)] : e.isDirectory() ? walk(path.join(d, e.name)) : [])); } catch { return []; } };
          const list = walk(root);
          console.log(list.length ? list.map((x) => path.relative(root, x)).join('\n') : c.dim('no mirrors yet: ox git clone <url> makes one'));
          return;
        }
        console.error('usage: ox git clone <url> [dir] [--shared] | ox git mirror <url> | ox git mirrors'); process.exitCode = 3;
      } catch (e) { console.error(c.red(e.message)); process.exitCode = 1; }
      return;
    }
    case 'serve':
      await cmdServe(args);
      return;
    case 'ipc':
      await cmdIpc(args);
      return;
    case 'listen': {
      const { execFileSync } = await import('node:child_process');
      const readline = await import('node:readline');
      let audio = '';
      const rl = readline.createInterface({ input: process.stdin });
      for await (const line of rl) { audio += line; }
      rl.close();
      if (!audio.trim()) {
        console.log(c.dim('usage: echo "<base64 audio>" | ox listen'));
        console.log(c.dim('  or: ox listen <path-to-audio-file>'));
        return;
      }
      let input = audio.trim();
      if (!/^[\w+/=]+$/.test(input)) {
        // Assume it's a file path
        const fs = await import('node:fs');
        if (fs.existsSync(input)) {
          input = fs.readFileSync(input).toString('base64');
        } else {
          console.log(c.red('✗ input must be base64 audio or a file path'));
          return;
        }
      }
      try {
        const whisper = execFileSync('whisper', ['--file', '-', '--json'], {
          input,
          timeout: 60000,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        const parsed = JSON.parse(whisper.toString());
        console.log(parsed.text || '(no speech detected)');
      } catch {
        try {
          const out = execFileSync('whisper', ['--file', '-', '--model', 'base'], {
            input,
            timeout: 60000,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          console.log(out.toString().trim());
        } catch (e) {
          console.log(c.red(`✗ whisper transcription failed: ${e?.message ?? e}`));
          console.log(c.dim('  Install: pip install openwhispr-stt'));
          console.log(c.dim('  Or set VOICE_LOCAL_ONLY=0 for cloud STT'));
        }
      }
      return;
    }
    case 'island': {
      const { cmdIsland } = await import('./island.js');
      process.exitCode = await cmdIsland(args);
      return;
    }
    case 'plugin':
    case 'plugins': {
      process.exitCode = await cmdPlugin(args);
      return;
    }
    case 'clicky': {
      const action = String(args[0] ?? '').trim().toLowerCase();
      if (action === 'onboard') {
        const { clickyOnboard } = await import('./clicky-onboard.js');
        const result = clickyOnboard(process.cwd());
        console.log(c.bold('ox clicky onboarding'));
        console.log(c.dim(`  state: ${JSON.stringify(result.state)}`));
        for (const step of result.steps) {
          console.log(`  ${step.id}: ${step.title}`);
          console.log(`    ${step.body}`);
          if (step.action) console.log(`    → ${step.action}`);
        }
        console.log(c.green(`✓ ${result.walk.done ? 'all steps complete' : `${result.walk.remaining()} steps remaining`}`));
        return;
      }
      if (action === 'start' || action === '') {
        const { createClicky } = await import('./clicky.js');
        const engine = createClicky(process.cwd());
        const started = engine.start();
        console.log(c.green(`✓ clicky mode started (${started.mode})`));
        console.log(c.dim('  modes: guide | assist | autopilot'));
        console.log(c.dim('  use: ox clicky onboard'));
        return;
      }
      if (action === 'stop') {
        const { createClicky } = await import('./clicky.js');
        const engine = createClicky(process.cwd());
        engine.stop();
        console.log(c.green('✓ clicky mode stopped'));
        return;
      }
      if (action === 'status') {
        const { createClicky } = await import('./clicky.js');
        const engine = createClicky(process.cwd());
        const s = engine.getStatus();
        console.log(`clicky: ${s.active ? c.green('active') : c.dim('stopped')} · mode: ${s.mode}`);
        return;
      }
      console.log(c.bold('ox clicky — voice + operator mode'));
      console.log(c.dim('  ox clicky start     start clicky mode'));
      console.log(c.dim('  ox clicky stop      stop clicky mode'));
      console.log(c.dim('  ox clicky status    show status'));
      console.log(c.dim('  ox clicky onboard   run permissions checklist'));
      return;
    }
    case 'voice': {
      const action = String(args[0] ?? '').trim().toLowerCase();
      // How ox SOUNDS: Kokoro's natural voice (src/kokoro.js).
      if (action === 'install') {
        const k = await import('./kokoro.js');
        console.log(`${c.bold('Natural voice:')} Kokoro-82M (Apache-2.0), offline, into ${k.VOICE_DIR()}`);
        for (const s of k.installSteps()) console.log(c.dim(`  · ${s.what}`));
        try { k.installKokoro(); console.log(`${c.green('✓')} ready. Try: ox speak "Hello, I am ox."`); }
        catch (e) { process.stderr.write(`${c.red('✗')} ${e.message}\n`); process.exitCode = 1; }
        return;
      }
      if (action === 'voices') {
        const k = await import('./kokoro.js');
        if (!k.kokoroStatus().ready) { console.log('Kokoro is not set up: ox voice install'); process.exitCode = 3; return; }
        try { const v = await k.kokoroVoices(); for (const id of v) console.log(`${id.padEnd(14)} ${c.dim(k.VOICE_LABELS[id] ?? '')}`); console.log(c.dim(`pick one: ox speak --voice ${k.DEFAULT_VOICE} "…"  or OX_TTS_VOICE`)); }
        finally { k.stopKokoro(); }
        return;
      }
      if (action === '' || action === 'status' || action === 'setup' || action === 'test') {
        const done = await cmdVoiceDictation(action || 'status', args.slice(1));
        if (done) return;
      }
      if (action === 'start' || action === 'stop') {
        // Talking to ox is OX Buddy in the island (hold Ctrl-Option-Space), with
        // the dictation pipeline in src/dictation.js. There is no separate
        // background voice process to start or stop.
        console.log(`${c.bold('Talk to ox:')} start ox in a project, then hold ⌃⌥Space (or click the mic in the notch island).`);
        console.log(c.dim('  island not running? ox island · accuracy: ox voice setup · what is in use: ox voice status'));
        return;
      }
      const tmpl = getTemplate('voice');
      if (tmpl) {
        console.log(`${c.bold(tmpl.title)}`);
        console.log(c.dim(tmpl.desc));
        console.log(c.dim(`risk: ${tmpl.risk}`));
        console.log(c.dim(`entry: ${tmpl.entry().command}`));
        console.log(c.dim(tmpl.setup));
      } else {
        console.log(c.dim('voice template not found'));
      }
      return;
    }
    case 'plan-cache': {
      const sub = String(args[0] ?? '').toLowerCase();
      if (sub === '--help' || sub === '-h') { console.log('usage: ox plan-cache [clear]  — the saved plan templates ox reuses for similar tasks'); return; }
      if (sub === 'clear') { clearPlanCache(); console.log(c.green('✓ plan cache cleared')); return; }
      const cache = getPlanCache();
      const list = cache.templates || [];
      console.log(`plan cache: ${list.length} template(s)`);
      for (const t of list.slice(-10)) {
        console.log(`  ${t.id} · ${t.taskType} · used ${t.successCount}x · ${t.keywords.join(', ')}`);
      }
      return;
    }
    case 'hmem': {
      const rest2 = args.slice(1).join(' ').trim();
      const hm = createHierarchicalMemory(loadConfig().cwd);
      if (rest2) {
        hm.addSubgoal(rest2);
        console.log(c.green(`✓ added subgoal: ${rest2}`));
      } else {
        const ctx2 = hm.getWorkingContext();
        console.log(ctx2.text || '(empty working memory)');
        console.log(c.dim(`\n${ctx2.activeCount} active, ${ctx2.observationCount} recent observations, ${ctx2.tokenCount} est tokens`));
      }
      return;
    }
    case 'reason': {
      console.log('reasoning digests: use /reason in-session to inspect the live ReasoningDigest');
      return;
    }
    case 'toc': {
      const text = JSON.stringify([]).slice(0, 8000);
      const result = await tocComp({ content: text });
      console.log(`TOC-Comp: ${result.originalTokens} → ${result.compressedTokens} tokens (${result.ratio.toFixed(2)}x)`);
      if (result.compressed) console.log(c.dim(result.compressed.slice(0, 400)));
      return;
    }
    case 'benchmark': {
      const sub = String(args[0] ?? '').trim().toLowerCase();
      if (sub === 'list') {
        const { AGENT_BENCHMARKS } = await import('./benchmark.js');
        console.log(`available benchmarks: ${AGENT_BENCHMARKS.map(b => b.name).join(', ')}`);
        return;
      }
      console.log(c.dim('usage: ox benchmark list'));
      return;
    }
    case 'platform': {
      const { createPlatform } = await import('./platform.js');
      const p = createPlatform();
      console.log(c.bold('ox platform'));
      console.log(`  voice: ${Object.keys(p.voice).join(', ')}`);
      console.log(`  video: ${Object.keys(p.video).join(', ')}`);
      console.log(`  skills: ${Object.keys(p.skills).join(', ')}`);
      console.log(`  benchmark: ${Object.keys(p.benchmark).join(', ')}`);
      console.log(c.dim(`  backend: ${p.backend?.name || 'auto-detecting'}`));
      return;
    }
    case 'voice': {
      const tmpl = getTemplate('voice');
      if (tmpl) {
        console.log(`${c.bold(tmpl.title)}`);
        console.log(c.dim(tmpl.desc));
        console.log(c.dim(`risk: ${tmpl.risk}`));
        console.log(c.dim(`entry: ${tmpl.entry().command}`));
        console.log(c.dim(tmpl.setup));
      } else {
        console.log(c.dim('voice template not found'));
      }
      return;
    }
    case 'video': {
      // ox video <op> <file> …: edit a video here (src/video-edit.js).
      // ox video explain "<title>" "Step: what happens" … : an explainer video from steps (ManimGX's idea).
      if (args[0] === 'explain') {
        const V = await import('./video-edit.js');
        const oi = args.indexOf('--out');
        const rest = args.slice(1).filter((a, i, l) => a !== '--out' && l[i - 1] !== '--out');
        const [title, ...steps] = rest;
        if (!title || steps.length < 2) { console.error('usage: ox video explain "<title>" "Step one: what happens" "Step two: …" [--out file.mp4]'); process.exitCode = 3; return; }
        try { const r = await V.explainerVideo(title, steps, { out: oi >= 0 ? path.resolve(args[oi + 1]) : null }); console.log(`${c.green('✓')} ${r.file} ${c.dim(`(${r.slides} slides, ${r.seconds} s)`)}`); }
        catch (e) { console.error(c.red(e.message)); process.exitCode = 1; }
        return;
      }
      // ox video animate <video|transcript|"script"> : scene-by-scene motion animations (Flick's idea; src/animate.js).
      if (args[0] === 'animate') {
        const A = await import('./animate.js');
        const rest = args.slice(1);
        const flag = (n) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
        const valued = new Set(['--out', '--aspect', '--bg', '--fg', '--accent', '--logo', '--font', '--redo', '--save', '--as']);
        const pos = rest.filter((a, i) => !a.startsWith('--') && !valued.has(rest[i - 1]));
        const step = (what, detail) => console.log(c.dim(`${what} ${detail ?? ''}`));
        try {
          if (rest.includes('--list')) {
            const saved = A.savedAnimations();
            console.log(`templates: ${A.TEMPLATES.join(', ')}`);
            console.log(saved.length ? `saved: ${saved.map((s) => `${s.name} (from ${s.from})`).join(', ')}` : c.dim('saved: none yet (ox video animate --save <scene> <folder>)'));
            return;
          }
          if (flag('--save')) { const r = A.saveAnimation(path.resolve(pos[0] ?? '.'), flag('--save'), flag('--as')); console.log(`${c.green('✓')} saved ${r.name} ${c.dim(r.file)}`); return; }
          if (flag('--redo')) {
            const r = await A.renderSpec(path.resolve(pos[0] ?? '.'), { only: flag('--redo') === 'all' ? null : flag('--redo').split(','), onStep: step, sfx: !rest.includes('--no-sfx') });
            for (const s of r.scenes) console.log(`  ${s.name} ${c.dim(s.file)}`);
            console.log(`${c.green('✓')} ${r.all}`);
            return;
          }
          const source = pos.length === 1 && fs.existsSync(pos[0]) ? path.resolve(pos[0]) : pos.join(' ');
          if (!source) { console.error('usage: ox video animate <video | transcript.txt | "the script"> [--aspect 9:16|16:9|1:1|4:5] [--bg #hex --fg #hex --accent #hex --logo file --font name] [--plan-only] [--no-model] [--no-sfx] [--out dir]\n       ox video animate --redo <scene>[,<scene>] <folder>    re-render after editing scene-spec.json\n       ox video animate --save <scene> <folder> [--as name]  keep a scene\'s animation for later runs\n       ox video animate --list'); process.exitCode = 3; return; }
          const plan = rest.includes('--no-model') ? null : async (system, user) => {
            const { workingModelSpec } = await import('./working-model.js');
            const { quickText } = await import('./quick-text.js');
            const cfg = loadConfig();
            return (await quickText(resolveBot(await workingModelSpec(cfg, { say: () => {} }), cfg), { system, user, maxTokens: 2500 })).text;
          };
          const r = await A.animate(source, { out: flag('--out') ? path.resolve(flag('--out')) : null, aspect: flag('--aspect') ?? '9:16', brand: { bg: flag('--bg'), fg: flag('--fg'), accent: flag('--accent'), logo: flag('--logo') ? path.resolve(flag('--logo')) : null, font: flag('--font') }, plan, render: !rest.includes('--plan-only'), sfx: !rest.includes('--no-sfx'), onStep: step });
          console.log(fs.readFileSync(r.plan, 'utf8'));
          for (const s of r.scenes) console.log(`  ${s.name} ${c.dim(`${s.seconds}s · ${s.file}`)}`);
          console.log(r.all ? `${c.green('✓')} ${r.all}` : `${c.green('✓')} plan ready: ${r.dir} (render it: ox video animate --redo all ${r.dir})`);
        } catch (e) { console.error(c.red(e.message)); process.exitCode = 1; }
        return;
      }
      const ops = ['transcribe', 'captions', 'cut', 'speed', 'vertical', 'highlights', 'gif', 'polish', 'understand'];
      if (ops.includes(args[0])) {
        const { editVideoTool } = await import('./tools/video.js');
        const [op, file, ...rest] = args;
        const flag = (n) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
        const pos = rest.filter((a, i) => !a.startsWith('--') && !(rest[i - 1] ?? '').startsWith('--'));
        if (!file) { console.error(`usage: ox video ${op} <file> ${op === 'cut' ? '<start> [end]' : op === 'speed' ? '<factor>' : op === 'highlights' ? '"<what is talked about>"' : op === 'vertical' ? '[9:16|1:1]' : ''}`); process.exitCode = 3; return; }
        const r = await editVideoTool({ op, file: path.resolve(file), start: flag('--start') ?? (op === 'cut' ? pos[0] : undefined), end: flag('--end') ?? (op === 'cut' ? pos[1] : undefined), factor: op === 'speed' ? Number(pos[0] ?? 2) : undefined, aspect: op === 'vertical' ? pos[0] : undefined, query: op === 'highlights' ? pos.join(' ') : undefined });
        console.log(r.isError ? c.red(r.content) : r.content.replace(/^edit_video: /, `${c.green('✓')} `));
        if (r.isError) process.exitCode = 1;
        return;
      }
      const tmpl = getTemplate('video');
      if (tmpl) {
        console.log(`${c.bold(tmpl.title)}`);
        console.log(c.dim(tmpl.desc));
        console.log(c.dim(`risk: ${tmpl.risk}`));
        console.log(c.dim(`entry: ${tmpl.entry().command}`));
        console.log(c.dim(tmpl.setup));
      } else {
        console.log(c.dim('video template not found'));
      }
      return;
    }
    case 'aas': {
      const action = String(args[0] ?? '').trim().toLowerCase();
      const restArgs = args.slice(1);
      try {
        if (action === 'search') {
          const { searchAasSkills, scanSkillsDir, mergeCatalogs, AAS_HOSTS } = await import('./aas-catalog.js');
          const catalog = mergeCatalogs(scanSkillsDir(process.cwd()), []);
          const query = restArgs.join(' ');
          const results = searchAasSkills(catalog, query);
          if (!results.length) {
            console.log(c.dim(`no matches for '${query}'`));
            return;
          }
          for (const r of results) {
            console.log(`${c.bold(r.id)}  ${c.dim(r.risk)}  ${r.description}`);
          }
          return;
        }
        if (action === 'stack' || action === 'validate') {
          const ids = (restArgs[0] ?? '').split(',').map(s => s.trim()).filter(Boolean);
          if (!ids.length) {
            console.log(c.red('✗ usage: ox aas stack <id1,id2,...>'));
            process.exitCode = 3;
            return;
          }
          const validation = validateStack(ids, []);
          if (!validation.ok) {
            console.log(c.red(`✗ invalid stack: ${validation.errors.join(', ')}`));
            process.exitCode = 1;
            return;
          }
          console.log(formatStack(validation.stack));
          return;
        }
        if (action === 'plan') {
          const target = restArgs[0];
          if (!target) {
            console.log(c.red('✗ usage: ox aas plan <host>'));
            process.exitCode = 3;
            return;
          }
          const plan = aasBuildPlan([], [], target);
          console.log(aasFormatPlan(plan));
          return;
        }
        if (action === 'hosts') {
          console.log(formatHostList());
          return;
        }
        if (action === 'install') {
          const host = restArgs[0];
          if (!host) {
            console.log(c.red('✗ usage: ox aas install <host>'));
            process.exitCode = 3;
            return;
          }
          const preview = previewInstall({ host, skills: [] });
          console.log(preview.command);
          if (preview.warnings?.length) {
            for (const w of preview.warnings) console.log(c.yellow(`⚠ ${w}`));
          }
          console.log(c.dim('antigravity: this command modifies the host config — review before running'));
          return;
        }
        if (action === 'audit') {
          const dir = restArgs[0] ?? process.cwd();
          const report = auditSkills([dir]);
          console.log(formatAuditReport(report));
          return;
        }
        if (action === 'mcp') {
          const mcp = new AASCoreMcp();
          console.log('AAS MCP Tools:');
          for (const t of AAS_MCP_TOOLS) {
            console.log(`  ${t.name}: ${t.description}`);
          }
          console.log(c.dim(`max stack size: ${MAX_STACK_SIZE}`));
          return;
        }
        const { scanSkillsDir: scan, mergeCatalogs: merge, AAS_HOSTS: hosts } = await import('./aas-catalog.js');
        const local = scan(process.cwd());
        const catalog = merge(local, []);
        console.log(c.bold('AAS Status'));
        console.log(`  catalog skills: ${catalog.length}`);
        console.log(`  hosts: ${Object.keys(hosts).length}`);
        console.log(c.dim('  run: ox aas search <query> | ox aas hosts | ox aas install <host>'));
      } catch (err) {
        console.log(c.red(`✗ ${err?.message ?? err}`));
        process.exitCode = 1;
      }
      return;
    }

    case 'brain': {
      const action = String(args[0] ?? '').trim().toLowerCase();
      const restArgs = args.slice(1);
      try {
        if (action === 'research') {
          // A real research run: a headless agent with web_search/web_fetch,
          // primary sources, inline citations, saved under .agent/research/.
          const topic = restArgs.filter((a) => !a.startsWith('--')).join(' ');
          if (!topic) { console.log(c.red('✗ usage: ox brain research <topic> [--max-cost <usd>]')); process.exitCode = 3; return; }
          const slug = topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'research';
          const file = path.join('.agent', 'research', `${new Date().toISOString().slice(0, 10)}-${slug}.md`);
          const prompt = [
            `Research this topic: ${topic}`,
            'Use web_search to find sources and web_fetch to read at least three primary or authoritative ones (official docs, papers, maintainers) - not summaries of summaries.',
            'Write the findings as Markdown with inline citations like [1], a "Sources" list of the URLs you actually read, and an "Open questions" section for what the sources do not settle.',
            `Save the report with write_file to ${file}, then reply with a five-line summary.`,
          ].join('\n');
          const mi = restArgs.indexOf('--max-cost');
          const childArgs = [path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ox.js'), '-p', prompt, '-y', '--sandbox', 'workspace', ...(mi >= 0 ? ['--max-cost', restArgs[mi + 1]] : [])];
          const { spawn } = await import('node:child_process');
          const code = await new Promise((resolve) => spawn(process.execPath, childArgs, { stdio: 'inherit' }).on('close', resolve));
          if (code === 0 && fs.existsSync(file)) console.log(c.green(`\n✓ report: ${file}`));
          else if (code === 0) console.log(c.yellow('\nthe run finished but did not save a report'));
          process.exitCode = code ?? 1;
          return;
        }
        const researchDir = path.join(process.cwd(), '.agent', 'research');
        const reports = (() => {
          try { return fs.readdirSync(researchDir).filter((f) => f.endsWith('.md')).sort().reverse(); } catch { return []; }
        })();
        if (action === 'gaps') {
          // The "Open questions" each report ended with.
          let any = false;
          for (const f of reports) {
            const md = fs.readFileSync(path.join(researchDir, f), 'utf8');
            const m = /^#+\s*Open questions\s*\n([\s\S]*?)(?=^#+\s|(?![\s\S]))/im.exec(md);
            const items = (m?.[1] ?? '').split('\n').map((l) => l.replace(/^[-*\d.)\s]+/, '').trim()).filter(Boolean);
            if (!items.length) continue;
            any = true;
            console.log(c.bold(f.replace(/\.md$/, '')));
            for (const it of items.slice(0, 8)) console.log(`  ${c.yellow('○')} ${it}`);
          }
          if (!any) console.log(c.dim('no open questions yet — run: ox brain research <topic>'));
          return;
        }
        if (action === 'synthesize') {
          const topic = restArgs.join(' ');
          if (!topic) { console.log(c.red('✗ usage: ox brain synthesize <topic>')); process.exitCode = 3; return; }
          if (!reports.length) { console.log(c.dim('no reports to synthesize yet — run: ox brain research <topic>')); return; }
          const slug = topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'synthesis';
          const out = path.join('.agent', 'research', `${new Date().toISOString().slice(0, 10)}-synthesis-${slug}.md`);
          const prompt = `Read the research reports in .agent/research/ that bear on: ${topic}\nSynthesize them into one Markdown report: what the sources agree on, where they conflict, and what is still open, keeping their citations. Save it with write_file to ${out}, then reply with a five-line summary.`;
          const { spawn } = await import('node:child_process');
          const ox = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ox.js');
          const code = await new Promise((resolve) => spawn(process.execPath, [ox, '-p', prompt, '--yes-edits'], { stdio: 'inherit' }).on('close', resolve));
          if (code === 0 && fs.existsSync(out)) console.log(c.green(`\n✓ synthesis: ${out}`));
          process.exitCode = code ?? 1;
          return;
        }
        console.log(c.bold('research'));
        if (!reports.length) console.log(c.dim('  no reports yet'));
        for (const f of reports.slice(0, 15)) console.log(`  ${f}`);
        console.log(c.dim('  ox brain research <topic> | ox brain gaps | ox brain synthesize <topic>'));
      } catch (err) {
        console.log(c.red(`✗ ${err?.message ?? err}`));
        process.exitCode = 1;
      }
      return;
    }
    case 'kanban': {
      const action = String(args[0] ?? '').trim().toLowerCase();
      const restArgs = args.slice(1);
      // The board view of the task board (src/tasks.js): one store, two views.
      if (action === 'add') {
        const title = restArgs.join(' ');
        if (!title) { console.log(c.red('✗ usage: ox kanban add <title>')); process.exitCode = 3; return; }
        const task = addTask({ title });
        console.log(c.green(`✓ created task ${task.id}: ${task.title}`));
        return;
      }
      if (action === '' || action === 'list' || action === 'board') {
        const tasks = listTasks();
        if (!tasks.length) { console.log(c.dim('the board is empty — ox kanban add <title>, or ox task add')); return; }
        const columns = [['to do', ['pending']], ['doing', ['running']], ['review', ['in_review']], ['blocked', ['blocked']], ['done', ['done']], ['failed', ['failed', 'cancelled']]];
        for (const [label, statuses] of columns) {
          const col = tasks.filter((t) => statuses.includes(t.status));
          if (!col.length) continue;
          console.log(c.bold(`${label} (${col.length})`));
          for (const t of col) console.log(`  ${c.dim(t.id)} ${t.title}${t.assignee ? c.dim(` · ${t.assignee}`) : ''}`);
        }
        return;
      }
      if (action === 'swarm') {
        console.log(c.dim('ox kanban swarm is replaced by real runs: ox task next (an agent takes the next ready task),'));
        console.log(c.dim('ox auto "<goal>" (a long run that plans and verifies), or ox arena (several models on one task).'));
        return;
      }
      console.log(c.dim('usage: ox kanban [list] | ox kanban add <title>   (the same board as: ox task)'));
      return;
    }
    case 'memory': {
      // What ox remembers (src/memory-graph.js): about you, and about this project.
      const mg = await import('./memory-graph.js');
      const project = args.includes('--project');
      const rest = args.filter((a) => a !== '--project');
      const [sub, ...words] = rest;
      const userFile = mg.memoryFile('user');
      const projFile = mg.memoryFile('project', { cwd: process.cwd() });
      const file = project ? projFile : userFile;
      const day = mg.fmtDay;
      const row = (m) => `${c.dim(m.id)}  ${m.text}  ${c.dim(`${m.kind} · ${day(m.createdAt)}${m.strength > 1 ? ` · said ${m.strength}×` : ''}${m.updates ? ' · replaced an older fact' : ''}${m.expiresAt ? ` · until ${day(m.expiresAt)}` : ''}`)}`;
      if (!sub) {
        const p = mg.profile({ file: userFile });
        console.log(c.bold('What ox remembers about you'));
        if (!p.total) console.log(c.dim('  nothing yet — tell ox things like "I prefer pnpm" or "call me Sai", or: ox memory add "<fact>"'));
        if (p.stable.length) { console.log(c.dim('\n  always')); for (const m of p.stable) console.log(`  ${row(m)}`); }
        if (p.lately.length) { console.log(c.dim('\n  lately')); for (const m of p.lately) console.log(`  ${row(m)}`); }
        const pp = mg.profile({ file: projFile });
        if (pp.total) console.log(c.dim(`\n  and ${pp.total} about this project — ox memory all --project`));
        return;
      }
      if (sub === 'recall' || sub === 'search') {
        const q = words.join(' ');
        const hits = [...mg.recall(q, { file: projFile, k: 6 }), ...mg.recall(q, { file: userFile, k: 6 })];
        if (!hits.length) { console.log(c.dim('nothing remembered about that')); return; }
        for (const m of hits) console.log(row(m));
        return;
      }
      if (sub === 'add') {
        const r = mg.remember(words.join(' '), { file, scope: project ? 'project' : 'user', source: 'cli' });
        if (r.op === 'refused') { console.log(c.red(r.reason)); process.exitCode = 1; return; }
        console.log(`${r.op === 'update' ? c.yellow('updated') : r.op === 'noop' ? c.dim('already known — made stronger') : c.green('remembered')}  ${r.memory.text}${r.previous ? c.dim(`  (replaces: ${r.previous.text})`) : ''}`);
        return;
      }
      if (sub === 'history') {
        const chain = mg.history(words[0] ?? '', { file: userFile }).length ? mg.history(words[0], { file: userFile }) : mg.history(words[0] ?? '', { file: projFile });
        if (!chain.length) { console.log(c.red(`no memory ${words[0] ?? ''}`)); process.exitCode = 1; return; }
        for (const m of chain) console.log(`${m.latest === false ? c.dim(`${day(m.validFrom)} → ${m.validTo ? day(m.validTo) : ''}`) : c.green(`${day(m.validFrom)} → now`)}  ${m.text}`);
        return;
      }
      if (sub === 'forget') {
        const gone = mg.forget(words[0] ?? '', { file: userFile }) ?? mg.forget(words[0] ?? '', { file: projFile });
        console.log(gone ? `${c.green('forgotten')}  ${gone.text}  ${c.dim('(kept on disk, never shown to a model again)')}` : c.red(`no memory ${words[0] ?? ''}`));
        if (!gone) process.exitCode = 1;
        return;
      }
      if (sub === 'all') {
        const all = mg.load(file).sort((a, b) => b.createdAt - a.createdAt);
        if (!all.length) { console.log(c.dim('nothing remembered yet')); return; }
        for (const m of all) console.log(`${m.state !== 'active' ? c.dim(`[${m.state}] `) : m.latest === false ? c.dim('[replaced] ') : ''}${row(m)}`);
        return;
      }
      console.log(SUB_USAGE.memory);
      process.exitCode = 2;
      return;
    }
    case 'hf': {
      // Open models from Hugging Face, downloaded through Ollama (src/hf-models.js).
      const hf = await import('./hf-models.js');
      const [sub, ...rest] = args;
      try {
        if (sub === 'search') {
          for (const m of await hf.searchModels(rest.join(' '))) console.log(`${c.bold(m.repo)}  ${c.dim(`${m.downloads} downloads${m.runtime !== 'ollama' ? ` · needs ${m.runtime}, not Ollama` : ''}`)}`);
          return;
        }
        if (sub === 'files') {
          for (const f of await hf.modelFiles(rest[0] ?? '')) console.log(`${String(f.quant ?? f.file).padEnd(10)} ${String(f.sizeGB).padStart(6)} GB  ${f.fits ? c.green('fits') : c.red('too big for this machine')}  ${c.dim(`ox hf pull ${rest[0]}:${f.quant}`)}`);
          return;
        }
        if (sub === 'pull') {
          const [repo, quant] = String(rest[0] ?? '').split(':');
          let shown = -1;
          const r = await hf.pullModel(repo, quant || null, { onProgress: (p) => { const pct = p.total ? Math.floor((p.completed / p.total) * 100) : null; if (pct != null && pct >= shown + 10) { shown = pct; process.stderr.write(c.dim(`  ${pct}%\n`)); } } });
          console.log(`${c.green('downloaded')} ${r.model}\n${c.dim(`use it: ox --bot ${r.bot}   (or pick it in the app)`)}`);
          return;
        }
      } catch (e) { console.log(c.red(e.message)); process.exitCode = 1; return; }
      console.log(SUB_USAGE.hf); process.exitCode = 2;
      return;
    }
    case 'build': {
      // A business requirement → a spec with acceptance criteria → tests first
      // → code until the tests pass → each criterion traced to its test
      // (src/build-spec.js).
      if (!args.length || args[0] === '--help' || args[0] === 'help') {
        console.log(`${c.bold('ox build')} "<requirement>": from a business requirement to code proven to meet it`);
        console.log(c.dim('  1. a spec: acceptance criteria AC-1… (Given/When/Then), constraints, out of scope, open questions → .agent/specs/'));
        console.log(c.dim('  2. tests first, one per criterion, named with its id   3. code until the test command passes'));
        console.log(c.dim('  4. a trace: each criterion\'s tests run on their own: passes, fails, or no test'));
        console.log(c.dim('  --spec-only   stop after the spec (review it, then: ox build --from-spec <id>)'));
        console.log(c.dim('  --bot <model> -y   as for any run.   ox spec trace [id]: the trace again, any time'));
        return;
      }
      const B = await import('./build-spec.js');
      const cwd = process.cwd();
      const val = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
      const bot = val('--bot') ?? val('--model');
      const fromSpec = val('--from-spec');
      const yolo = args.includes('-y') || args.includes('--yes');
      const requirement = args.filter((a, i) => !a.startsWith('-') && !['--bot', '--model', '--from-spec'].includes(args[i - 1])).join(' ').trim();
      const config = loadConfig({ cwd });
      const tests = B.detectTests(cwd);
      let spec;
      if (fromSpec) {
        spec = B.loadSpec(cwd, fromSpec);
        if (!spec) { process.stderr.write(`ox build: no spec ${fromSpec} in .agent/specs\n`); process.exitCode = 2; return; }
      } else {
        if (!requirement) { process.stderr.write('ox build: say what to build, in your words\n'); process.exitCode = 2; return; }
        const { workingModelSpec } = await import('./working-model.js');
        const { quickText } = await import('./quick-text.js');
        let target;
        try { target = resolveBot(await workingModelSpec(config, { explicit: bot }), config); }
        catch (e) { process.stderr.write(`ox build: ${e.message}\n`); process.exitCode = 2; return; }
        process.stderr.write(c.dim(`· writing the spec with ${target.bot ?? target.model} (reading the project: ${tests.framework})\n`));
        let text = '';
        try { text = (await quickText(target, { system: B.SPEC_SYSTEM, user: `Requirement:\n${requirement}\n\nProject map:\n${B.projectContext(cwd)}`, maxTokens: 2500 })).text; }
        catch (e) { process.stderr.write(`ox build: the spec could not be written: ${e.message}\n`); process.exitCode = 1; return; }
        try { spec = B.saveSpec(cwd, { ...B.parseSpec(text), requirement }); }
        catch (e) { process.stderr.write(`ox build: ${e.message}\n${c.dim(String(text).slice(0, 400))}\n`); process.exitCode = 1; return; }
      }
      console.log(B.specMarkdown(spec));
      console.log(c.dim(`spec saved: .agent/specs/${spec.id}.md`));
      if (args.includes('--spec-only')) return;
      const { brief, contract } = B.buildBrief(spec, tests);
      await runPrint(brief, config, { yolo, verify: true, bot, goalContract: contract });
      const t = B.traceSpec(cwd, spec, { tests });
      console.log(`\n${B.formatTrace(spec, t)}`);
      if (t.passed < t.rows.length) process.exitCode = 1;
      return;
    }
    case 'port': {
      // Move a project to another language, module by module, leaves first,
      // keeping every external factor (src/port.js).
      const P = await import('./port.js');
      const val = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
      const src = args.find((a, i) => !a.startsWith('-') && !['--to', '--out', '--bot', '--model', '--only'].includes(args[i - 1]));
      if (!src || args.includes('--help')) {
        console.log(`${c.bold('ox port')} <project> --to <py|js|ts|go|rs|java|rb> [--out <dir>]: move a project to another language`);
        console.log(c.dim('  --inventory     what it is made of: modules in dependency order, libraries, external factors (no model)'));
        console.log(c.dim('  --plan-only     write .agent/port/plan.json and stop     --only <n>   port the next n modules'));
        console.log(c.dim('  --check         the external factors the port no longer mentions'));
        console.log(c.dim('  Each module: ported with its tests, which must pass before the next; resumable (the plan remembers)'));
        return;
      }
      const inv = P.inventory(src);
      if (!inv.lang) { process.stderr.write(`ox port: no source code found in ${src}\n`); process.exitCode = 2; return; }
      if (args.includes('--inventory')) { console.log(P.formatInventory(inv)); return; }
      const to = val('--to');
      if (!to || !P.LANGS[to]) { process.stderr.write(`ox port: --to one of ${Object.keys(P.LANGS).join(', ')}\n`); process.exitCode = 2; return; }
      const out = path.resolve(val('--out') ?? `${path.resolve(src)}-${to}`);
      let plan = P.loadPlan(src);
      if (!plan || plan.to !== to || plan.out !== out) { plan = P.makePlan(inv, { to, out }); P.savePlan(plan); }
      if (args.includes('--check')) {
        const missing = P.factorsMissing(inv, out);
        console.log(missing.length ? `${missing.length} external factor${missing.length === 1 ? '' : 's'} the port does not mention:\n${missing.map((f) => `  ${f.kind} ${f.name} (used in ${f.where.join(', ')})`).join('\n')}` : 'Every environment variable, file, endpoint, port and command of the original appears in the port.');
        if (missing.length) process.exitCode = 1;
        return;
      }
      console.log(P.formatInventory(inv));
      console.log(c.dim(`\nplan: .agent/port/plan.json · ${plan.steps.filter((s) => s.status === 'done').length}/${plan.steps.length} done · into ${out}`));
      if (args.includes('--plan-only')) return;
      fs.mkdirSync(out, { recursive: true });
      const testCmd = { py: 'python3 -m pytest -q', js: 'node --test', ts: 'npx tsx --test', go: 'go test ./...', rs: 'cargo test', java: 'mvn -q test', rb: 'bundle exec rspec' }[to];
      const limit = Number(val('--only') ?? Infinity);
      const yolo = args.includes('-y') || args.includes('--yes');
      const bot = val('--bot') ?? val('--model');
      const here = process.cwd();
      let n = 0;
      for (const step of plan.steps) {
        if (step.status === 'done' || n >= limit) continue;
        n++;
        console.log(c.bold(`\n— ${n}. ${step.file}`));
        process.chdir(out);
        const config = loadConfig({ cwd: out });
        process.exitCode = 0;
        await runPrint(P.moduleBrief(inv, plan, step, { testCmd }), config, { yolo, verify: true, bot, goalContract: { outcome: `${step.file} ported with its behaviour`, verification: `gate: ${testCmd}` } });
        process.chdir(here);
        step.status = process.exitCode ? 'failed' : 'done';
        step.at = new Date().toISOString();
        P.savePlan(plan);
        if (step.status === 'failed') { console.log(c.red(`stopped at ${step.file}: fix it, then run the same command to go on`)); break; }
      }
      const missing = P.factorsMissing(inv, out);
      console.log(`\n${plan.steps.filter((s) => s.status === 'done').length}/${plan.steps.length} modules ported.${missing.length ? ` ${missing.length} external factor(s) not yet in the port: ${missing.map((f) => `${f.kind} ${f.name}`).join(', ')}` : ' Every external factor of the original appears in the port.'}`);
      return;
    }
    case 'secure': {
      // A security scan of code (src/security-scan.js): offline, every finding
      // with its CWE and a fix. --diff: only the lines you changed.
      if (args[0] === '--help' || args[0] === 'help') {
        console.log(`${c.bold('ox secure')}: find security problems in code (injection, XSS, path traversal, SSRF, secrets, weak crypto, TLS off…), JS/TS, Python, Go, Java, PHP, Ruby, shell`);
        console.log(c.dim('  ox secure                 this folder'));
        console.log(c.dim('  ox secure src app.py      files and folders'));
        console.log(c.dim('  ox secure --diff          only the lines changed since the last commit (and new files)'));
        console.log(c.dim('  ox secure --json          machine-readable; --fail-on high|medium|low sets the exit code'));
        console.log(c.dim('  The agent runs it on the files it edits and fixes what it finds. Silence a line with a comment: ox-secure-ignore: <why>'));
        return;
      }
      const S = await import('./security-scan.js');
      const json = args.includes('--json');
      const fi = args.indexOf('--fail-on');
      const failOn = fi >= 0 ? String(args[fi + 1] ?? 'high') : 'high';
      const paths = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--fail-on');
      let r;
      try { r = args.includes('--diff') ? S.scanDiff({ cwd: process.cwd() }) : S.scanPaths(paths.length ? paths : ['.'], { cwd: process.cwd() }); }
      catch (e) { process.stderr.write(`ox secure: ${e.message}\n`); process.exitCode = 2; return; }
      if (json) console.log(JSON.stringify(r, null, 2));
      else console.log(S.formatReport(r));
      const rank = { high: 0, medium: 1, low: 2 };
      if (r.findings.some((f) => rank[f.severity] <= (rank[failOn] ?? 0) && !f.test)) process.exitCode = 1;
      return;
    }
    case 'graph': {
      // The project as a graph you query instead of grepping (src/code-graph.js,
      // graphify's idea, ox's own zero-dependency implementation).
      const G = await import('./code-graph.js');
      const [verb = 'build', ...rest] = args;
      if (verb === '--help' || verb === 'help') {
        console.log(`${c.bold('ox graph')}: map this project's code (files, functions, classes, imports, calls) into a graph, with no model`);
        console.log(c.dim('  ox graph                     build it: .agent/graph/graph.json, GRAPH_REPORT.md, graph.html'));
        console.log(c.dim('  ox graph update              rebuild, re-reading only the files that changed'));
        console.log(c.dim('  ox graph query "<question>"  the part of the graph a question is about'));
        console.log(c.dim('  ox graph path A B            how A reaches B (--directed: follow edge direction)'));
        console.log(c.dim('  ox graph explain X           what X is and what it is connected to (--all)'));
        console.log(c.dim('  ox graph report | open       print the report | open graph.html'));
        console.log(c.dim('  Every edge says how it was found: EXTRACTED (in the source) or INFERRED (resolved by ox).'));
        return;
      }
      const cwd = process.cwd();
      const json = rest.includes('--json');
      const words = rest.filter((a) => !a.startsWith('--'));
      if (verb === 'build' || verb === 'update' || verb === '.') {
        const { graph, paths } = G.writeGraph(cwd, { update: verb === 'update' });
        const st = graph.stats;
        if (json) { console.log(JSON.stringify({ stats: st, communities: graph.communities.length, paths }, null, 2)); return; }
        console.log(`${st.files} files · ${st.symbols} functions and classes · ${st.edges} edges (${st.extracted} extracted, ${st.inferred} inferred) · ${graph.communities.length} subsystems · ${st.ms} ms${st.reused ? ` · ${st.reused} files unchanged` : ''}`);
        console.log(c.dim(`  most connected: ${G.godNodes(graph, 5).map((n) => n.name).join(', ')}`));
        console.log(c.dim(`  ${path.relative(cwd, paths.report)} · ${path.relative(cwd, paths.html)} · ${path.relative(cwd, paths.json)}`));
        return;
      }
      if (verb === 'report') { const g = G.ensureGraph(cwd); console.log(G.graphReport(g)); return; }
      if (verb === 'open') {
        const p = G.graphPaths(cwd);
        if (!fs.existsSync(p.html)) G.writeGraph(cwd);
        const { osCmd } = await import('./tools/operator.js');
        const cmd = osCmd('open_path', p.html);
        if (cmd) (await import('node:child_process')).spawnSync(cmd[0], cmd.slice(1), { stdio: 'ignore' });
        console.log(p.html);
        return;
      }
      const g = G.ensureGraph(cwd);
      let r;
      if (verb === 'query') r = G.queryGraph(g, words.join(' '));
      else if (verb === 'path') r = words.length >= 2 ? G.shortestPath(g, words[0], words[1], { directed: rest.includes('--directed') }) : { found: false, text: 'usage: ox graph path "<from>" "<to>"' };
      else if (verb === 'explain') r = G.explainNode(g, words.join(' '), { all: rest.includes('--all') });
      else { process.stderr.write(`ox graph: unknown "${verb}" (ox graph help)\n`); process.exitCode = 2; return; }
      if (json) console.log(JSON.stringify({ ...r, text: undefined, path: r.path?.map((n) => n.id), node: r.node?.id, seeds: r.seeds?.map((n) => n.id), nodes: r.nodes?.map((n) => n.id), links: undefined, edges: r.edges?.length }, null, 2));
      else console.log(r.text);
      if (r.found === false) process.exitCode = 1;
      return;
    }
    case 'transfer':
    case 'office': {
      // The 3D office (the-delegation): every live agent at the desk of what it is doing.
      let port = null;
      for (const f of ['serve.json', 'app.json']) {
        try { const d = JSON.parse(fs.readFileSync(path.join(process.env.OX_HOME || path.join(os.homedir(), '.ox'), f), 'utf8')); try { process.kill(d.pid, 0); port = d.port; break; } catch {} } catch {}
      }
      if (!port) { console.error('ox office needs ox running: ox serve (or open OX.app, or the island starts it)'); process.exitCode = 1; return; }
      const url = `http://127.0.0.1:${port}/office`;
      const { spawnSync } = await import('node:child_process');
      spawnSync(process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open', [url]);
      console.log(url);
      return;
    }
    case 'make': {
      // Vovy's "build me a … with Claude": src/make-app.js. Each step is shown in
      // the notch (this command is a session there), the agent works in its own
      // Terminal tab, and the app opens when it is done.
      const M = await import('./make-app.js');
      const val = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
      const idea = args.filter((a, i) => !a.startsWith('--') && !['--with', '--dir'].includes(args[i - 1])).join(' ').trim();
      if (!idea || idea === 'help') { console.log(`${c.bold('ox make')} "<what to build>" [--with claude|codex] [--dir <folder>]: a new project, the idea as a full brief, the agent in a new Terminal tab, the app opened when it is done`); return; }
      const I = await import('./ipc.js');
      const key = `make-${M.slugOf(M.nameOf(idea))}-${Date.now().toString(36)}`;
      let server = null;
      try { server = I.createIpcServer({ socketPath: I.socketPathFor(key), sessionId: key, meta: { cwd: process.cwd(), bot: 'ox make', model: val('--with') ?? 'claude' } }); } catch {}
      let n = 0;
      const say = (step, done = false) => {
        console.log(`${done ? c.green('✓') : c.dim('·')} ${step}`);
        try {
          // narrate: the island shows these steps under the closed notch (Vovy's step line).
          if (!done) server?.broadcast({ type: 'tool-start', id: `m${++n}`, name: 'make', argsPreview: step, narrate: true });
          else { server?.broadcast({ type: 'tool-start', id: `m${++n}`, name: 'make', argsPreview: step, narrate: true }); server?.broadcast({ type: 'tool-end', id: `m${n}`, name: 'make', isError: false, narrate: true }); }
        } catch {}
      };
      try {
        const r = await M.make(idea, { builder: val('--with') ?? 'claude', dir: val('--dir') ? path.resolve(val('--dir')) : null, say });
        try { server?.broadcast({ type: 'text-delta', text: r.opened ? `${r.name} is live ✓` : `${r.name}: still being built in ${r.dir}` }); server?.broadcast({ type: 'turn-end', stopReason: 'end_turn' }); } catch {}
        if (r.opened) console.log(c.dim(`  ${r.entry}`));
      } catch (e) { console.error(c.red(e.message)); process.exitCode = 1; try { server?.broadcast({ type: 'error', error: e.message }); } catch {} }
      await new Promise((res) => setTimeout(res, 6000));
      try { server?.broadcast({ type: 'final' }); server?.close?.(); } catch {}
      return;
    }
    case 'handoff': {
      // Carry a session from one AI tool to another (src/session-transfer.js):
      // other tools' stores are only read; the target gets a handoff file and
      // is started through its own command line, or resumes its own session.
      const T = await import('./session-transfer.js');
      const flagVal = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
      const valueFlags = new Set(['--to', '--company', '--tool']);
      const positional = args.filter((a, i) => !a.startsWith('--') && !valueFlags.has(args[i - 1]));
      const here = args.includes('--here') ? process.cwd() : null;
      if (positional[0] === 'help' || args.includes('--help')) {
        console.log(`${c.bold('ox transfer')}: carry a session from one AI tool to another, without touching either tool's own files`);
        console.log(c.dim('  ox transfer list [--here] [--tool claude]      recent sessions of Claude Code, Codex, Hermes and ox'));
        console.log(c.dim('  ox transfer <from> --to <tool>                 from: latest | claude | codex:<id> | hermes:<id> | ox:<id>'));
        console.log(c.dim(`  targets: ${T.TARGETS.join(', ')}`));
        console.log(c.dim('  --here   only sessions from this folder     --print   show the command instead of starting the tool'));
        console.log(c.dim('  --company <id>   the Paperclip company (or PAPERCLIP_COMPANY_ID)'));
        console.log(c.dim('  The handoff is written to .agent/handoff/ in the project; the same tool resumes its own session.'));
        return;
      }
      if (positional[0] === 'list' || positional[0] === 'ls') {
        const tool = flagVal('--tool');
        const rows = T.listSessions({ cwd: here, limit: 25, ...(tool ? { tools: [T.toolName(tool)] } : {}) });
        if (args.includes('--json')) { console.log(JSON.stringify(rows.map(({ ref, ...r }) => r), null, 2)); return; }
        if (!rows.length) { console.log(`no sessions found${here ? ' for this folder' : ''}`); return; }
        for (const r of rows) console.log(`${r.tool.padEnd(7)} ${String(r.id).slice(0, 12).padEnd(13)} ${new Date(r.updatedAt).toISOString().slice(0, 16).replace('T', ' ')}  ${(r.title ?? '—').slice(0, 56).padEnd(57)} ${c.dim((r.cwd ?? '').replace(os.homedir(), '~'))}`);
        console.log(c.dim('\n  ox transfer <tool>:<id> --to <claude|codex|hermes|ox|gemini|cursor|paperclip|file>'));
        return;
      }
      const to = flagVal('--to');
      if (!to) { process.stderr.write('ox transfer: say where to: --to claude | codex | hermes | ox | gemini | cursor | paperclip | file (ox transfer help)\n'); process.exitCode = 2; return; }
      let session, handoff, plan;
      try {
        const entry = T.findSession(positional[0] ?? 'latest', { cwd: here });
        session = T.readSession(entry);
        handoff = T.writeHandoff(session);
        plan = T.deliveryPlan(session, to, handoff, { company: flagVal('--company') ?? undefined });
      } catch (e) { process.stderr.write(`ox transfer: ${e.message}\n`); process.exitCode = 1; return; }
      const from = `${T.TOOLS[session.tool].label} session ${String(session.id).slice(0, 12)}`;
      console.log(`${from}: ${session.messages.length} messages, ${session.files.length} files changed${session.cwd ? `, in ${session.cwd.replace(os.homedir(), '~')}` : ''}`);
      console.log(c.dim(`  handoff: ${handoff.md.replace(os.homedir(), '~')}`));
      const q = (a) => (/^[\w./:@%+=,-]+$/.test(a) ? a : `'${String(a).replace(/'/g, "'\\''")}'`);
      if (plan.kind === 'file') return;
      if (plan.kind === 'import') {
        const r = T.importToOx(session, { handoff });
        console.log(`imported into ox: ${c.bold(`ox --resume ${r.id}`)}`);
        return;
      }
      if (plan.kind === 'paperclip') {
        if (!plan.cmd) { console.log(`${plan.note}; the handoff above is ready to attach.`); process.exitCode = 1; return; }
        if (!T.onPath('paperclipai')) { console.log(`Paperclip's CLI is not installed here (npm install -g paperclipai). Then: paperclipai issue create -C ${q(plan.args[3])} --title ${q(plan.title)} --description "$(cat ${q(handoff.md)})"`); process.exitCode = 1; return; }
        const r = (await import('node:child_process')).spawnSync(plan.cmd, plan.args, { cwd: plan.cwd, encoding: 'utf8', timeout: 60000 });
        if (r.status === 0) console.log(`Paperclip task created: ${(r.stdout || '').trim().split('\n').slice(-1)[0] ?? plan.title}`);
        else { process.stderr.write(`ox transfer: paperclipai failed: ${(r.stderr || r.stdout || '').trim().slice(0, 300)}\n`); process.exitCode = 1; }
        return;
      }
      const shown = `cd ${q(plan.cwd)} && ${[plan.cmd, ...plan.args].map(q).join(' ')}`;
      if (args.includes('--print') || !process.stdout.isTTY) { console.log(shown); return; }
      if (!T.onPath(plan.cmd)) { console.log(`${plan.cmd} is not installed here; when it is: ${shown}`); process.exitCode = 1; return; }
      console.log(c.dim(`  ${plan.kind === 'resume' ? plan.note : `starting ${T.TOOLS[T.toolName(to)].label} in ${plan.cwd.replace(os.homedir(), '~')}`}`));
      const r = (await import('node:child_process')).spawnSync(plan.cmd, plan.args, { cwd: plan.cwd, stdio: 'inherit' });
      process.exitCode = r.status ?? 0;
      return;
    }
    case 'statusline': {
      // Claude Code's status-line command (src/statusline.js): records your
      // plan limits for the island, then shows the status line you had.
      const { runStatusline } = await import('./statusline.js');
      const chunks = [];
      for await (const c of process.stdin) chunks.push(c);
      process.stdout.write(runStatusline(Buffer.concat(chunks).toString('utf8')));
      return;
    }
    case 'mcp-mac': {
      // ox's everyday Mac actions as an MCP server (src/mac-mcp.js), for a plan's own CLI.
      (await import('./mac-mcp.js')).serveMacMcp();
      await new Promise(() => {});
      return;
    }
    case 'dictionary': {
      // Words dictation gets wrong, and snippets (src/dictionary.js; the island uses it too).
      const D = await import('./dictionary.js');
      const d = D.loadDictionary();
      const [verb = 'list', ...rest] = args;
      const usage = 'usage: ox dictionary list | add "<heard>" "<meant>" | snippet "<phrase>" "<text>" | remove "<word>" | test "<sentence>"';
      if (verb === 'list') {
        const r = Object.entries(d.replace), s = Object.entries(d.snippets);
        if (!r.length && !s.length) { console.log(`nothing yet. ${usage}`); return; }
        for (const [a, b] of r) console.log(`  ${a} → ${b}`);
        for (const [a, b] of s) console.log(`  ${c.dim('snippet')} ${a} → ${b.length > 60 ? `${b.slice(0, 57)}…` : b}`);
        console.log(c.dim(`  ${D.DICT_FILE()}`));
        return;
      }
      if ((verb === 'add' || verb === 'snippet') && rest.length >= 2) {
        const [from, ...to] = rest;
        (verb === 'add' ? d.replace : d.snippets)[from.trim()] = to.join(' ').trim();
        D.saveDictionary(d);
        console.log(`${verb === 'add' ? 'replace' : 'snippet'}: ${from.trim()} → ${to.join(' ').trim()}`);
        return;
      }
      if (verb === 'remove' && rest[0]) {
        const k = rest.join(' ').trim();
        const had = k in d.replace || k in d.snippets;
        delete d.replace[k]; delete d.snippets[k];
        D.saveDictionary(d);
        console.log(had ? `removed ${k}` : `no entry ${k}`);
        return;
      }
      if (verb === 'test' && rest.length) { console.log(D.applyDictionary(rest.join(' '), d)); return; }
      process.stderr.write(`${usage}\n`); process.exitCode = 2;
      return;
    }
    case 'flow':
    case 'flows': {
      // ox Flows: automations like n8n's, native (src/flows.js).
      const F = await import('./flows.js');
      const [verb = 'list', ...rest] = args;
      const id = rest[0];
      const fail = (m) => { process.stderr.write(`ox: ${m}\n`); process.exitCode = 1; };
      const showRun = (r) => {
        console.log(`${c.bold(r.name ?? r.flow)} ${r.status === 'ok' ? 'ran' : r.status} in ${((r.ms ?? 0) / 1000).toFixed(1)} s`);
        for (const s of r.steps ?? []) console.log(`  ${s.status === 'ok' ? '✓' : s.status === 'stopped' ? '■' : '✗'} ${s.name.padEnd(12)} ${c.dim(`${s.type} · ${s.ms} ms${s.tokens ? ` · ${s.tokens} tok` : ''}`)}  ${String(s.out ?? s.error ?? '').replace(/\s+/g, ' ').slice(0, 90)}`);
      };
      try {
        if (verb === 'list') {
          const all = F.listFlows();
          if (!all.length) { console.log('no flows yet. Describe one: ox flow new "every day at 8am, tell me the top Hacker News story"'); return; }
          for (const f of all) console.log(`${f.id.padEnd(24)} ${String(f.trigger?.type ?? 'manual').padEnd(8)} ${f.trigger?.every ?? ''}${f.enabled === false ? c.dim(' (off)') : ''}  ${c.dim(`${f.steps.length} steps`)}`);
          return;
        }
        if (verb === 'show') { const f = F.loadFlow(id ?? ''); if (!f) return fail(`no flow ${id}`); console.log(JSON.stringify(f, null, 2)); return; }
        if (verb === 'run') {
          const ii = rest.indexOf('--input');
          const input = ii >= 0 ? JSON.parse(rest[ii + 1] ?? 'null') : null;
          const r = await F.runFlow(id ?? '', { input, trigger: 'manual' });
          showRun(r);
          if (r.status === 'failed') process.exitCode = 1;
          return;
        }
        if (verb === 'new') {
          const text = rest.join(' ').trim();
          if (!text) return fail('usage: ox flow new "<what it should do, and when>"');
          const draft = await F.draftFlow(text);
          // A dry run of what only reads (GET calls, extracts): a draft's mistakes show now.
          const problems = await F.checkFlow(draft);
          const saved = F.saveFlow({ ...draft, ...(problems.length ? { enabled: false } : {}) });
          console.log(`${c.bold(`saved ${saved.id}`)} (${saved.trigger.type}${saved.trigger.every ? `, ${saved.trigger.every}` : ''}${problems.length ? ', off until fixed' : ''}):`);
          for (const s of saved.steps) console.log(`  ${s.name.padEnd(12)} ${s.type}  ${c.dim(String(s.url ?? s.prompt ?? s.path ?? s.text ?? s.value ?? '').slice(0, 80))}`);
          if (problems.length) console.log(`${c.bold('check found:')}\n${problems.map((p) => `  ✗ ${p}`).join('\n')}`);
          else console.log('check: every GET answered and every extract found something');
          console.log(c.dim(`try it: ox flow run ${saved.id} · change it: ox flow show ${saved.id} > f.json, edit, ox flow add f.json · remove: ox flow rm ${saved.id}`));
          return;
        }
        if (verb === 'templates') {
          // n8n templates (Zie619/n8n-workflows, MIT) to import as flows.
          const N = await import('./n8n-import.js');
          const list = await N.searchTemplates(args.slice(1).join(' '), { limit: 25 });
          if (!list.length) { console.log(c.dim('no template matches those words')); return; }
          for (const t of list) console.log(`${t.name.padEnd(60).slice(0, 60)} ${c.dim(`ox flow import ${t.path}`)}`);
          return;
        }
        if (verb === 'import') {
          if (!id) return fail('usage: ox flow import <n8n.json | workflows/…json template> [--name N]');
          const N = await import('./n8n-import.js');
          const wf = fs.existsSync(id) ? JSON.parse(fs.readFileSync(id, 'utf8')) : await N.fetchTemplate(id);
          const ni = args.indexOf('--name');
          const r = N.convert(wf, { name: ni >= 0 ? args[ni + 1] : null });
          console.log(`${c.bold(r.flow.name)}: ${r.converted} step(s) converted${r.skipped.length ? `, ${r.skipped.length} not (ox has no step for them yet)` : ''}`);
          for (const st of r.flow.steps) console.log(`  ${c.green('✓')} ${st.type.padEnd(7)} ${st.name}`);
          for (const k of r.skipped) console.log(`  ${c.yellow('–')} ${k.type.padEnd(14)} ${k.node}`);
          if (r.problems.length) { console.log(c.red(`not saved: ${r.problems.join('; ')}`)); process.exitCode = 1; return; }
          const saved = F.saveFlow(r.flow);
          console.log(`saved ${saved.id} (off: check it with ox flow show ${saved.id}, run it with ox flow run ${saved.id}, then ox flow on ${saved.id})`);
          return;
        }
        if (verb === 'add') {
          if (!id) return fail('usage: ox flow add <flow.json>');
          const saved = F.saveFlow(JSON.parse(fs.readFileSync(id, 'utf8')));
          console.log(`saved ${saved.id}${saved.trigger.type === 'webhook' ? `\n  webhook: POST /ox/flows/hook/${saved.id}?secret=${saved.trigger.secret}` : ''}`);
          return;
        }
        if (verb === 'rm' || verb === 'remove') { console.log(F.removeFlow(id ?? '') ? `removed ${id}` : `no flow ${id}`); return; }
        if (verb === 'on' || verb === 'off') {
          const f = F.loadFlow(id ?? '');
          if (!f) return fail(`no flow ${id}`);
          F.saveFlow({ ...f, enabled: verb === 'on' });
          console.log(`${id} is ${verb}`);
          return;
        }
        if (verb === 'runs') {
          const rows = F.flowRuns({ id: id ?? null, limit: 15 });
          if (!rows.length) { console.log('no runs yet'); return; }
          for (const r of rows) console.log(`${r.at.slice(0, 16).replace('T', ' ')}  ${String(r.flow).padEnd(20)} ${r.status.padEnd(7)} ${String(r.trigger).padEnd(8)} ${r.error ? c.dim(r.error.slice(0, 80)) : ''}`);
          return;
        }
        return fail('usage: ox flow list | new "<description>" | run <id> [--input JSON] | show <id> | add <file.json> | runs [id] | on|off <id> | rm <id>');
      } catch (e) { return fail(e.message); }
    }
    case 'system1': {
      // Fast typed decisions about a message (Laya, src/system1.js).
      const S = await import('./system1.js');
      const [verb, ...rest] = args;
      if (verb === 'install') {
        try { const st = S.installSystem1({ log: (l) => console.log(l) }); console.log(st.ready ? `System 1 is ready (${st.dir})` : 'not ready'); }
        catch (e) { process.stderr.write(`ox: ${e.message}\n`); process.exitCode = 1; }
        return;
      }
      if (verb === 'try') {
        const text = rest.join(' ').trim();
        if (!text) { process.stderr.write('usage: ox system1 try "<message>"\n'); process.exitCode = 2; return; }
        if (!S.system1Enabled()) { console.log('System 1 is not installed: ox system1 install'); return; }
        const t0 = Date.now();
        try { await S.warmSystem1(); } catch (e) { process.stderr.write(`ox: ${e.message}\n`); process.exitCode = 1; return; }
        const loaded = Date.now() - t0;
        const r = await S.classifyTurn(text, { timeoutMs: 20000 });
        console.log(r ? `${c.bold(r.kind)}${r.confidence != null ? ` ${(r.confidence * 100).toFixed(0)}%` : ''} · needs a plan ${r.plan != null ? `${(r.plan * 100).toFixed(0)}%` : '?'} · ${r.ms} ms ${c.dim(`(model loaded in ${(loaded / 1000).toFixed(1)} s)`)}` : 'no answer');
        S.stopSystem1();
        return;
      }
      const st = S.system1Status();
      console.log(st.ready
        ? `System 1: ready${st.model ? '' : ' (the checkpoint downloads on first use)'} · ${st.dir}\n  try: ox system1 try "what's the weather in Paris"`
        : `System 1: not installed (about 1.1 GB: PyTorch and the laya-multilingual checkpoint)\n  install: ox system1 install`);
      return;
    }
    case 'evolve': {
      // ox improves ox (src/evolve.js): an attempt in its own worktree, judged by
      // the unit suite against the current version; nothing merges on its own.
      const E = await import('./evolve.js');
      const [verb, id] = args;
      try {
        if (verb === 'list') {
          const rows = E.archive();
          if (!rows.length) { console.log('no attempts yet: ox evolve "<what to make better>"'); return; }
          for (const r of rows.slice(0, 20)) console.log(`${r.id}  ${String(r.state).padEnd(9)} ${String(r.goal ?? '').slice(0, 60)}${r.why ? c.dim(`  ${r.why}`) : ''}`);
          return;
        }
        if (verb === 'failures') {
          const f = E.failures();
          if (!f.length) { console.log('no recorded failures'); return; }
          for (const g of f.slice(0, 15)) console.log(`${String(g.count).padStart(3)}×  ${g.sig}${c.dim(`  (ox ${g.example.command})`)}`);
          return;
        }
        if (verb === 'diff') { if (!id) throw new Error('usage: ox evolve diff <id>'); process.stdout.write(E.diff(id)); return; }
        if (verb === 'accept') { if (!id) throw new Error('usage: ox evolve accept <id>'); const a = E.accept(id); console.log(`accepted ${a.id}: your checkout now has it`); return; }
        if (verb === 'reject') { if (!id) throw new Error('usage: ox evolve reject <id>'); E.reject(id); console.log(`rejected ${id}`); return; }
        const bi = args.indexOf('--bot'), mi = args.indexOf('--max-cost');
        // Only the flags that are there, and their values: an absent flag is -1,
        // and -1 + 1 is 0, the goal itself (`ox evolve "<goal>"` was dropped).
        const skip = new Set([...(bi >= 0 ? [bi, bi + 1] : []), ...(mi >= 0 ? [mi, mi + 1] : [])]);
        const goal = args.filter((a, i) => !skip.has(i) && !a.startsWith('--')).join(' ');
        const r = await E.evolve({ goal, bot: bi >= 0 ? args[bi + 1] : null, maxCost: mi >= 0 ? Number(args[mi + 1]) || 2 : 2, log: (l) => process.stderr.write(`${c.dim(l)}\n`) });
        if (!r.id) { console.log(r.why); return; }
        console.log(r.accepted
          ? `${c.bold(`attempt ${r.id} measured better`)}: ${r.why}\n  look: ox evolve diff ${r.id}\n  keep: ox evolve accept ${r.id}   drop: ox evolve reject ${r.id}`
          : `attempt ${r.id} not kept: ${r.why}`);
      } catch (e) { process.stderr.write(`ox: ${e.message}\n`); process.exitCode = 1; }
      return;
    }
    case 'update': {
      // What is new upstream; --apply fast-forwards to it.
      const E = await import('./evolve.js');
      const u = E.updateCheck();
      if (u.kind !== 'git') { console.log(u.message); if (u.kind === 'error') process.exitCode = 1; return; }
      if (!u.incoming.length) { console.log(`up to date with ${u.upstream}`); return; }
      console.log(`${u.incoming.length} new from ${u.upstream}:\n${u.incoming.slice(0, 15).map((l) => `  ${l}`).join('\n')}`);
      if (!args.includes('--apply')) { console.log(c.dim('bring them in: ox update --apply')); return; }
      try { E.updateApply(); console.log('updated'); } catch (e) { process.stderr.write(`ox: ${e.message}\n`); process.exitCode = 1; }
      return;
    }
    case 'name': {
      // What ox is called (src/identity.js): the prompt, the app and the island.
      const { assistantName, setAssistantName } = await import('./identity.js');
      const words = args.filter((a) => !a.startsWith('-'));
      if (args.includes('--reset')) { setAssistantName(null); console.log('name: ox (the default)'); return; }
      if (!words.length) { console.log(assistantName()); return; }
      try { console.log(`name: ${setAssistantName(words.join(' '))} — say it while you talk to it`); }
      catch (e) { process.stderr.write(`ox: ${e.message}\n`); process.exitCode = 3; }
      return;
    }
    case 'usage': {
      if (args[0] === 'plans') {
        // How much of each plan you pay for is used (src/plan-usage.js).
        const P = await import('./plan-usage.js');
        for (const p of P.planUsage()) {
          if (!p.windows.length) { console.log(`${c.bold(p.label)}  ${c.dim(p.missing ?? 'no data')}`); continue; }
          const w = p.windows.map((x) => `${x.name} ${Math.round(x.usedPercent)}%${x.resetsAt ? c.dim(` (resets ${new Date(x.resetsAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })})`) : ''}`).join('  ·  ');
          console.log(`${c.bold(p.label)}${p.plan ? c.dim(` ${p.plan} plan`) : ''}  ${w}${p.reached ? c.red(`  limit reached (${p.reached})`) : ''}`);
        }
        return;
      }
      // Where the tokens went (src/usage-log.js).
      const { summarize } = await import('./usage-log.js');
      const di = args.indexOf('--days');
      const days = di >= 0 ? Math.max(1, Number(args[di + 1]) || 30) : 30;
      const U = summarize({ days });
      if (args.includes('--json')) { console.log(JSON.stringify(U, null, 2)); return; }
      const fmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
      const money = (x) => (x == null ? c.dim('unpriced') : x < 0.01 ? `$${x.toFixed(4)}` : `$${x.toFixed(2)}`);
      console.log(`${c.bold(`Last ${days} day${days === 1 ? '' : 's'}`)}  ${fmt(U.total.in)} in · ${fmt(U.total.out)} out · ${U.total.runs} runs · ${money(U.total.cost)}`);
      for (const [title, rows] of [['model', U.byModel], ['agent', U.byAgent], ['where', U.bySurface], ['project', U.byProject]]) {
        if (!rows.length) continue;
        console.log(c.dim(`\n  by ${title}`));
        for (const r of rows.slice(0, 12)) console.log(`  ${String(r.key).padEnd(28)} ${fmt(r.in).padStart(8)} in ${fmt(r.out).padStart(8)} out  ${money(r.cost)}`);
      }
      if (!U.total.runs) console.log(c.dim('no runs recorded yet — every run from now on is kept in ~/.ox/usage.jsonl'));
      return;
    }
    case 'create': {
      // OX Studio from the terminal (src/media-studio.js).
      const ms = await import('./media-studio.js');
      const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
      const all = (n) => args.flatMap((a, i) => (a === n && args[i + 1] ? [args[i + 1]] : []));
      if (args.includes('--models')) {
        const only = args[args.indexOf('--models') + 1];
        for (const [id, p] of Object.entries(ms.PROVIDERS)) {
          if (only && !only.startsWith('--') && only !== id) continue;
          console.log(`${c.bold(p.label)} ${c.dim(`--provider ${id}${p.key ? ` · key ${p.key} ${process.env[p.key] ? c.green('set') : c.yellow('not set')}` : ' · no key'}${p.anyModel ? ' · any model id' : ''}`)}`);
          for (const m of p.models()) {
            const full = id === 'higgsfield' ? ms.getModel(m.id) : null;
            console.log(`  ${m.id.padEnd(24)} ${c.dim(`${m.surface}${full ? ` · inputs: ${Object.keys(full.roles).join(', ') || 'prompt only'} · settings: ${Object.keys(full.settings).join(', ')}` : ''}`)}`);
          }
        }
        return;
      }
      if (args.includes('--history')) {
        for (const r of ms.history({ limit: 30 })) console.log(`${r.status === 'completed' ? c.green('✓') : c.yellow(r.status ?? '?')} ${c.dim(r.id)} ${r.label ?? r.model}  ${String(r.prompt ?? '').slice(0, 60)}  ${c.dim((r.files ?? [])[0] ?? '')}`);
        return;
      }
      const VALUED = new Set(['--provider', '--model', '--set', '--start', '--end', '--ref', '--video', '--audio', '--edit']);
      const prompt = args.filter((a, i) => !a.startsWith('--') && !VALUED.has(args[i - 1])).join(' ');
      if (!prompt) { console.log(SUB_USAGE.create); process.exitCode = 2; return; }
      const settings = {};
      for (const kv of all('--set')) { const [k, ...v] = kv.split('='); settings[k] = v.join('='); }
      const media = {};
      for (const [f, role] of [['--start', 'start'], ['--end', 'end'], ['--ref', 'reference'], ['--video', 'video'], ['--audio', 'audio']]) if (all(f).length) media[role] = all(f);
      // --edit <image>: one prompt edits that picture (Krea), on a provider that edits.
      if (flag('--edit')) media.edit = [path.resolve(flag('--edit'))];
      const edits = !!media.edit;
      const provider = flag('--provider') ?? (edits ? ((await import('./tools/media.js')).pick({ kind: 'image', edit: true }).provider ?? 'openai') : 'higgsfield');
      const model = flag('--model') ?? (provider === 'higgsfield' ? 'soul-2' : provider === 'openai' ? 'gpt-image-2' : provider === 'fal' ? (edits ? 'fal-ai/flux-pro/kontext' : 'fal-ai/flux/schnell') : provider === 'openrouter' ? 'google/gemini-2.5-flash-image' : 'local');
      // Settings from the command line are text; the catalogue turns numbers and switches back.
      if (provider === 'higgsfield') {
        const m = ms.getModel(model);
        for (const [k, f] of Object.entries(m.settings)) if (settings[k] != null && f.type === 'range') settings[k] = Number(settings[k]);
      }
      try {
        let last = '';
        const r = await ms.generate({ provider, model, prompt, settings, media, onStatus: (s) => { if (s.status !== last) { last = s.status; process.stderr.write(c.dim(`  ${s.status}\n`)); } } });
        if (r.status !== 'completed') { console.log(c.red(`${r.status}${r.error ? `: ${r.error}` : ''}`)); process.exitCode = 1; return; }
        for (const f of r.files) console.log(c.green(f));
        if (!r.files.length) for (const u of r.urls) console.log(u);
      } catch (e) { console.log(c.red(e.message)); process.exitCode = 1; }
      return;
    }
    case 'market': {
      // Search and install published skills and plugins (src/market.js).
      const mk = await import('./market.js');
      if (args[0] === 'add') {
        try { const list = await mk.addCatalog(args[1] ?? ''); console.log(c.green(`catalogues: ${list.join(', ')}`)); } catch (e) { console.log(c.red(e.message)); process.exitCode = 1; }
        return;
      }
      if (args[0] === 'install') {
        const target = String(args[1] ?? '');
        const at = target.match(/^([\w.-]+)@([\w.-]+\/[\w.-]+)$/);
        try {
          const r = await mk.install(at ? { name: at[1], catalog: at[2], force: args.includes('--force') } : { repo: target, force: args.includes('--force') });
          console.log(r.ok ? c.green(r.message) : c.red(r.message));
          if (!r.ok) process.exitCode = 1;
        } catch (e) { console.log(c.red(e.message)); process.exitCode = 1; }
        return;
      }
      const r = await mk.search(args.join(' '));
      if (r.featured?.length) {
        console.log(c.dim('  featured (licences checked)'));
        for (const f of r.featured) console.log(`${f.installed ? c.green('✓') : ' '} ${c.bold(f.name)} ${c.dim(`[${f.kind}, ${f.license}]`)}  ${c.dim(f.description.slice(0, 90))}  ${c.dim(`ox market install ${f.name}`)}`);
        console.log('');
      }
      for (const p of r.plugins.slice(0, 25)) console.log(`${p.installed ? c.green('✓') : ' '} ${c.bold(p.name)}${p.category ? c.dim(` [${p.category}]`) : ''}  ${c.dim(p.description.slice(0, 90))}  ${c.dim(`ox market install ${p.name}@${p.catalog}`)}`);
      if (r.repos.length) console.log(c.dim('\n  from GitHub (topic: agent-skills)'));
      for (const x of r.repos.slice(0, 15)) console.log(`${x.installed ? c.green('✓') : ' '} ${c.bold(x.repo)} ${c.dim(`★${x.stars}`)}  ${c.dim(x.description.slice(0, 80))}`);
      for (const e of r.errors) console.log(c.yellow(e));
      if (!r.plugins.length && !r.repos.length) console.log(c.dim('nothing found'));
      return;
    }
    case 'hook': {
      // Run by Claude Code on each event (src/agent-hooks.js). Never fails the
      // agent: any problem prints nothing and Claude Code carries on as usual.
      try {
        const ah = await import('./agent-hooks.js');
        let raw = '';
        for await (const chunk of process.stdin) raw += chunk;
        const out = await ah.handleHook(args[0] ?? 'claude', raw, { event: args[1] ?? null });
        if (out) process.stdout.write(`${out}\n`);
      } catch {}
      return;
    }
    case 'hook-relay': {
      const ah = await import('./agent-hooks.js');
      const { server } = ah.runRelay({ agent: args[0] ?? 'claude', sessionId: args[1] ?? 'default', cwd: process.cwd() });
      await new Promise((resolve) => { server.on('close', resolve); server.on('error', resolve); });
      return;
    }
    case 'hooks': {
      const ah = await import('./agent-hooks.js');
      const sub = args[0] ?? 'status';
      const agent = args[1] ?? 'claude';
      if (sub === 'status') {
        for (const [id, a] of Object.entries(ah.AGENTS)) {
          let on = false;
          try { on = ah.installed(JSON.parse(fs.readFileSync(a.settings(), 'utf8')), id); } catch {}
          console.log(`${on ? c.green('connected') : c.dim('not connected')}  ${a.label.padEnd(12)} ${c.dim(`ox hooks install ${id}  ·  ${a.settings()}`)}`);
        }
        return;
      }
      if (sub === 'safe') {
        // Read-only calls (ls, git status, reading files) allowed without asking; risky ones still wait.
        if (args[1] === 'on' || args[1] === 'off') ah.setAutoSafe(args[1] === 'on');
        console.log(`safe commands run on their own: ${ah.autoSafe() ? c.green('on') : c.yellow('off')}  ${c.dim('(only reading: ls, cat, git status/log/diff, rg… never chained or redirected)')}`);
        return;
      }
      if (sub !== 'install' && sub !== 'uninstall') { console.log(SUB_USAGE.hooks); process.exitCode = 2; return; }
      let plan;
      try { plan = ah.planInstall(agent, { remove: sub === 'uninstall' }); } catch (e) { console.log(c.red(e.message)); process.exitCode = 1; return; }
      if (!plan.changed) { console.log(c.dim(sub === 'install' ? `already connected — ${ah.AGENTS[agent].label} sessions show in OX Island` : 'nothing to remove')); return; }
      console.log(`${sub === 'install' ? 'Connect' : 'Disconnect'} ${ah.AGENTS[agent].label} ${sub === 'install' ? 'to' : 'from'} OX Island — this is the change to ${plan.file}:`);
      const before = new Set(plan.beforeText.split('\n'));
      const after = new Set(plan.afterText.split('\n'));
      for (const l of plan.beforeText.split('\n')) if (!after.has(l) && l.trim()) console.log(c.red(`- ${l}`));
      for (const l of plan.afterText.split('\n')) if (!before.has(l) && l.trim()) console.log(c.green(`+ ${l}`));
      if (!args.includes('--yes')) { console.log(c.dim(`apply it: ox hooks ${sub} ${agent} --yes  (the current file is backed up first)`)); return; }
      try {
        const backup = ah.applyInstall(plan);
        console.log(c.green(sub === 'install' ? `connected — new ${ah.AGENTS[agent].label} sessions show in OX Island, and you can answer its permission requests there` : 'disconnected'));
        if (backup) console.log(c.dim(`backup: ${backup}`));
        if (sub === 'install' && ah.AGENTS[agent].after) console.log(c.yellow(ah.AGENTS[agent].after));
      } catch (e) { console.log(c.red(e.message)); process.exitCode = 1; }
      return;
    }
    case 'speak': {
      // ox's voice: Kokoro when set up, else the system voice; VoxCPM to clone (src/tts.js).
      const tts = await import('./tts.js');
      const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
      if (args[0] === '--help' || args[0] === 'help') {
        console.log(`${c.bold('ox speak')}: say something out loud`);
        console.log(c.dim('  ox speak "hello"                          Kokoro\'s natural voice when set up (ox voice install), else the system voice'));
        console.log(c.dim('  ox speak "hello" --voice bm_george        another Kokoro voice (ox voice voices)'));
        console.log(c.dim('  ox speak "hello" --engine voxcpm          VoxCPM2 (natural, 30 languages) when installed'));
        console.log(c.dim('  ox speak "hello" --voice me.wav           clone the voice in a reference clip (VoxCPM)'));
        console.log(c.dim('  ox speak "hello" --out hello.wav          write a WAV instead of playing'));
        console.log(c.dim('  ox speak --engines                        what is available here'));
        return;
      }
      if (args[0] === '--engines') {
        const e = tts.engines();
        console.log(`system voice: ${e.system ? c.green(e.system) : c.red('none found')}`);
        console.log(`Kokoro:       ${e.kokoro ? c.green('ready') : c.dim(`not set up: ${e.install.kokoro}`)}`);
        console.log(`VoxCPM:       ${e.voxcpm ? c.green('installed') : c.dim(`not installed: ${e.install.voxcpm}`)}`);
        return;
      }
      const VALUED = new Set(['--engine', '--voice', '--out', '--model']);
      const text = args.filter((a, i) => !a.startsWith('--') && !VALUED.has(args[i - 1])).join(' ');
      const r = await tts.speak(text, { engine: flag('--engine') ?? 'auto', voice: flag('--voice') ?? null, out: flag('--out') ?? null, model: flag('--model') ?? null });
      console.log(r.ok ? c.dim(`${r.message} (${r.engine})`) : c.red(r.message));
      if (!r.ok) process.exitCode = 1;
      (await import('./kokoro.js')).stopKokoro();
      return;
    }
    case 'app': {
      // ox in its own window: the same ox as the terminal (src/app.js).
      const a = await import('./app.js');
      const action = String(args[0] ?? '').toLowerCase();
      if (action === '--help' || action === 'help') {
        console.log(`${c.bold('ox app')} — ox in its own window (macOS app; an app window on Windows/Linux)`);
        console.log(c.dim('  ox app              open it, working in this folder'));
        console.log(c.dim('  ox app install      macOS: put OX.app in ~/Applications (Spotlight, Launchpad, Dock)'));
        console.log(c.dim('  ox app stop         stop the app\'s server'));
        console.log(c.dim('  Same agents, modes, approvals and sessions as the terminal; runs show in the island.'));
        return;
      }
      try {
        if (action === '--print-url') { const st = await a.ensureServer({ cwd: process.cwd() }); console.log(st.url); return; }
        if (action === 'stop') { console.log(a.stopServer() ? c.green('stopped') : c.dim('it was not running')); return; }
        if (action === 'install') {
          if (process.platform !== 'darwin') { console.log(c.dim('on Windows and Linux, ox app opens an app window; pin it to the taskbar from there')); return; }
          const dest = a.installMacApp();
          console.log(dest ? c.green(`installed: ${dest} — find "ox" in Spotlight or Launchpad`) : c.red('could not build OX.app (needs Xcode or the Command Line Tools: xcode-select --install)'));
          if (!dest) process.exitCode = 1;
          return;
        }
        await a.openApp({ cwd: process.cwd() });
      } catch (e) {
        console.log(c.red(String(e?.message ?? e)));
        process.exitCode = 1;
      }
      return;
    }
    case 'watch': {
      const w = await import('./watch.js');
      const action = String(args[0] ?? 'list').toLowerCase();
      const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
      if (action === '--help' || action === 'help') {
        console.log(`${c.bold('ox watch')} — tell me when a page changes, shows something, or a price drops`);
        console.log(c.dim('  ox watch add <url> [--contains "<text>" | --missing "<text>" | --price-below <n>] [--every 30m] [--label <name>]'));
        console.log(c.dim('  ox watch list | remove <id> | check   (check now)'));
        console.log(c.dim('  ox watch start | stop                 the background checker (once a minute, due watches only)'));
        console.log(c.dim('  alerts: a desktop notification, and your phone if ox gateway telegram is paired. No AI, no key.'));
        return;
      }
      if (action === 'add') {
        try {
          const added = w.addWatch({ url: args[1], contains: flag('--contains'), missing: flag('--missing'), priceBelow: flag('--price-below'), every: flag('--every') ?? '30m', label: flag('--label') });
          console.log(c.green(`watching: ${w.describe(added)}`));
          if (!w.watcherPid()) console.log(c.dim('  start the background checker with: ox watch start   (or check now: ox watch check)'));
        } catch (e) { console.log(c.red(e.message)); process.exitCode = 3; }
        return;
      }
      if (action === 'remove' || action === 'rm') {
        const list = w.loadWatches();
        const keep = list.filter((x) => x.id !== args[1]);
        w.saveWatches(keep);
        console.log(keep.length < list.length ? c.green(`removed ${args[1]}`) : c.red(`no watch ${args[1] ?? ''}`));
        return;
      }
      if (action === 'check') {
        const alerts = await w.checkWatches({ force: true });
        for (const x of w.loadWatches()) console.log(`  ${w.describe(x)}`);
        console.log(alerts.length ? c.yellow(`${alerts.length} alert(s) sent`) : c.dim('no alerts'));
        return;
      }
      if (action === 'start') { const r = w.startWatcher(); console.log(r.already ? c.dim(`already checking (pid ${r.pid})`) : c.green(`checking in the background (pid ${r.pid}) — ox watch stop to stop`)); return; }
      if (action === 'stop') { console.log(w.stopWatcher() ? c.green('stopped') : c.dim('it was not running')); return; }
      if (action === 'loop') { await w.watchLoop(); return; }
      const list = w.loadWatches();
      if (!list.length) { console.log(c.dim('no watches — ox watch add <url> --price-below 99')); return; }
      for (const x of list) console.log(`  ${w.describe(x)}`);
      console.log(c.dim(w.watcherPid() ? 'checking in the background' : 'not checking in the background — ox watch start'));
      return;
    }
    case 'do': {
      // Small tasks with no AI and no internet (src/offline.js).
      const { doOffline } = await import('./offline.js');
      const json = args.includes('--json');
      const dryRun = args.includes('--dry-run');
      const text = args.filter((a) => a !== '--json' && a !== '--dry-run').join(' ').trim();
      if (!text || text === '--help') {
        console.log(`${c.bold('ox do')} — small tasks, no AI and no internet needed`);
        console.log(c.dim('  ox do "open notes"           ox do "search best ramen near me"'));
        console.log(c.dim('  ox do "timer 25 minutes"     ox do "remind me in 10 minutes to stretch"'));
        console.log(c.dim('  ox do "note buy milk"        ox do "what is 18% of 240"'));
        console.log(c.dim('  ox do "screenshot"           ox do "volume 30"   ox do "mute"   ox do "time"'));
        console.log(c.dim('  anything bigger needs a model: ox -p "..."'));
        if (!text) process.exitCode = 3;
        return;
      }
      const r = doOffline(text, { dryRun });
      if (json) console.log(JSON.stringify(r));
      else console.log(r.handled ? (r.ok === false ? c.red(r.message) : r.message) : c.dim(r.message));
      if (!r.handled) process.exitCode = 2;
      else if (r.ok === false) process.exitCode = 1;
      return;
    }
    case 'awake': {
      const aw = await import('./awake.js');
      const a = String(args[0] ?? '').toLowerCase();
      if (a === '--help' || a === 'help') {
        console.log(`${c.bold('ox awake')} — keep the computer awake for your agents`);
        console.log(c.dim('  ox already keeps it awake while it works (a -p run, ox auto, a chat turn). OX_NO_AWAKE=1 turns that off.'));
        console.log(c.dim('  ox awake 2h | 30m | 1d   hold it awake for a while, even with no ox running'));
        console.log(c.dim('  ox awake off             let it sleep again'));
        console.log(c.dim('  ox awake --lid           how to keep running with the lid closed'));
        return;
      }
      if (a === '--lid' || a === 'lid') { for (const l of aw.lidHelp()) console.log(l); return; }
      if (a === 'off' || a === 'stop') {
        console.log(aw.stopTimed() ? c.green('ok — the computer can sleep again') : c.dim('nothing was being held'));
        return;
      }
      if (a) {
        const secs = aw.parseDuration(a);
        if (!secs) { console.log(c.red(`not a duration: '${args[0]}' (try 45m, 2h, 1d; at most 7d)`)); process.exitCode = 3; return; }
        try {
          const t = aw.startTimed(secs);
          console.log(c.green(`awake until ${t.until.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${secs >= 86400 ? ` (${t.until.toLocaleDateString()})` : ''}`) + c.dim(' — ox awake off to stop early; the screen can still turn off'));
        } catch (e) { console.log(c.red(e.message)); process.exitCode = 1; }
        return;
      }
      const st = aw.status();
      console.log(st.timed ? `awake until ${st.timed.until.toLocaleString()}` : c.dim('no timed hold — ox still keeps the computer awake while it works'));
      if (st.lidSleepDisabled) console.log(c.yellow('sleep is disabled system-wide (pmset disablesleep 1): turn it back on with  sudo pmset -a disablesleep 0'));
      return;
    }
    case 'mail': {
      // The same checks as the agent's mail tool; from here it only ever makes
      // a draft, so sending stays a click in Mail.
      const { mail_accounts, mail_compose, parseAccounts, ACCOUNTS_SCRIPT } = await import('./tools/mail.js');
      const action = String(args[0] ?? '').toLowerCase();
      const json = args.includes('--json');
      if (action === 'accounts') {
        if (json) {
          const { spawnSync: run } = await import('node:child_process');
          const r = run('osascript', ACCOUNTS_SCRIPT.flatMap((l) => ['-e', l]), { encoding: 'utf8', timeout: 60_000 });
          if (r.status !== 0) { console.log(JSON.stringify({ error: (r.stderr || 'osascript failed').trim() })); process.exitCode = 1; return; }
          console.log(JSON.stringify({ accounts: parseAccounts(r.stdout) }));
          return;
        }
        const r = await mail_accounts({}, {});
        console.log(r.content);
        if (r.isError) process.exitCode = 1;
        return;
      }
      if (action === 'draft') {
        const opt = { to: [], attachments: [] };
        for (let i = 1; i < args.length; i++) {
          const a = args[i];
          const v = args[i + 1];
          if (a === '--json') continue;
          if (v === undefined) { console.log(c.red(`${a} needs a value`)); process.exitCode = 3; return; }
          if (a === '--from') opt.from = v;
          else if (a === '--to') opt.to.push(...v.split(','));
          else if (a === '--subject') opt.subject = v;
          else if (a === '--body') opt.body = v;
          else if (a === '--attach') opt.attachments.push(v);
          else { console.log(c.red(`unknown flag ${a}`)); process.exitCode = 3; return; }
          i++;
        }
        const r = await mail_compose({ ...opt, send: false }, { cwd: process.cwd() });
        if (json) console.log(JSON.stringify({ ok: !r.isError, message: r.content }));
        else console.log(r.isError ? c.red(r.content) : r.content);
        if (r.isError) process.exitCode = 1;
        return;
      }
      console.log(`${c.bold('ox mail')} — email through the Mail app, from the account you name`);
      console.log(c.dim('  ox mail accounts [--json]'));
      console.log(c.dim('  ox mail draft --from <your address> --to <a,b> [--subject s] [--body t] [--attach file]...'));
      console.log(c.dim('  drafts only: you press Send in Mail. In chat, ox can send after you approve.'));
      if (action && action !== 'help' && action !== '--help') process.exitCode = 3;
      return;
    }
    case 'connect': {
      const { checkAll, checkCli, allClis } = await import('./subscriptions.js');
      let config = {};
      try { config = loadConfig(); } catch {}
      const id = String(args[0] ?? '').toLowerCase().replace(/-plan$/, '');
      if (id === '--help' || id === 'help') {
        console.log(`${c.bold('ox connect')} — use a subscription you already pay for`);
        console.log(c.dim('  ox hands the turn to the vendor\'s own signed-in CLI; it never reads or copies your login.'));
        console.log(c.dim('  ox connect            every supported CLI and whether it works here'));
        console.log(c.dim('  ox connect <name>     one of them, with what to do next'));
        return;
      }
      if (id && !allClis(config)[id]) {
        console.log(c.red(`no CLI '${id}' — one of: ${Object.keys(allClis(config)).join(', ')}`));
        console.log(c.dim('add your own in config: subscriptions: { name: { bin, args: [..., "{prompt}"] } }'));
        process.exitCode = 3;
        return;
      }
      const rows = id ? [checkCli(id, config)] : checkAll(config);
      if (!id) console.log(c.bold('plans you can use with ox') + c.dim('  (ox runs the vendor\'s own CLI; your login stays with it)'));
      for (const r of rows) {
        const name = `${r.id}-plan`.padEnd(16);
        if (r.works) console.log(`${c.green('●')} ${name}${r.label} ${c.dim(r.version ?? '')}`);
        else if (r.installed) console.log(`${c.yellow('○')} ${name}${r.label} ${c.yellow('installed but not working')}`);
        else console.log(`${c.dim('·')} ${c.dim(name + r.label)}`);
        if (id || r.installed) {
          if (r.works) console.log(c.dim(`    use: ox --bot ${r.id}-plan   (or /bot ${r.id}-plan in chat) · not signed in yet? ${r.login}`));
          else if (r.installed) console.log(c.dim(`    ${r.problem} → ${r.fix}`));
          else console.log(c.dim(`    install: ${r.fix} · then ${r.login}`));
        }
      }
      if (!id) {
        const n = rows.filter((r) => r.works).length;
        console.log(c.dim(`\n${n} ready. ox connect <name> shows how to install or fix one.`));
      }
      return;
    }
    case 'arena': {
      const usageLine = 'usage: ox arena "<task>" --bots a,b[,c] [--test "<command>"] [--max-cost <usd>] [--apply]';
      if (!args.length || args.includes('--help') || args.includes('-h')) {
        console.log(`${c.bold('ox arena')} — the same task, several models, one winner\n  ${usageLine}`);
        console.log(c.dim('  each bot works in its own git worktree; the winner passes --test, then succeeded, then changed least, then cost least.'));
        console.log(c.dim('  patches are kept in ~/.ox/arena/<run>/; --apply applies the winner to this project.'));
        if (!args.length) process.exitCode = 3;
        return;
      }
      const { parseArenaArgs, runArena } = await import('./arena.js');
      try {
        const opts = parseArenaArgs(args);
        console.log(c.dim(`arena: ${opts.bots.join(' vs ')} on "${truncate(opts.task, 60)}"`));
        const res = await runArena(opts, { cwd: process.cwd(), log: (l) => console.log(c.dim(l)) });
        console.log(c.bold('\narena results'));
        for (const [i, e] of res.entries.entries()) {
          const mark = res.winner === e ? c.green('★') : ' ';
          const tests = e.test === null ? '' : e.test ? c.green(' tests pass') : c.red(' tests fail');
          const cost = e.costUsd != null ? ` $${e.costUsd.toFixed(4)}` : '';
          console.log(`${mark} ${i + 1}. ${e.bot.padEnd(16)} ${e.ok ? c.green('ok') : c.red('failed')}${tests} · ${e.files} file(s) ${e.changedLines} line(s) · ${e.seconds}s${cost}${e.error ? c.dim(`  ${e.error}`) : ''}`);
        }
        if (!res.winner) console.log(c.yellow('\nno bot produced a usable change'));
        else if (res.winner.applied) console.log(c.green(`\n✓ applied ${res.winner.bot}'s change to this project`));
        else if (res.winner.applied === false) console.log(c.red(`\n✗ could not apply ${res.winner.bot}'s change: ${res.winner.applyError}`));
        else console.log(c.dim(`\nwinner: ${res.winner.bot} · apply it: git apply "${res.winner.patch}"  (or rerun with --apply)`));
        console.log(c.dim(`patches: ${res.patchDir}`));
      } catch (err) {
        process.stderr.write(`${c.red(`✗ ${err.message}`)}\n`);
        process.exitCode = 3;
      }
      return;
    }
    case 'gateway': {
      // Talk to ox from a chat app. Telegram is real end to end; it used to
      // print "gateway started" for a list of platform names it never connected.
      const action = String(args[0] ?? '').trim().toLowerCase();
      const tg = await import('./telegram-gateway.js');
      const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
      if (action === 'telegram') {
        const saved = tg.loadState();
        const token = flag('--token') ?? process.env.TELEGRAM_BOT_TOKEN ?? saved.token;
        const mode = flag('--mode') ? normalizeMode(flag('--mode')) : null;
        if (flag('--mode') && !mode) { console.log(c.red(`--mode must be one of: auto, ${MODE_NAMES.join(', ')}`)); process.exitCode = 3; return; }
        const ac = new AbortController();
        process.on('SIGINT', () => { ac.abort(); process.exit(0); });
        try {
          await tg.runTelegramGateway({ token, cwd: path.resolve(flag('--cwd') ?? process.cwd()), agent: flag('--agent') ?? null, mode, signal: ac.signal });
        } catch (e) {
          console.log(c.red(String(e?.message ?? e)));
          process.exitCode = 1;
        }
        return;
      }
      if (action === 'discord') {
        const dc = await import('./discord-gateway.js');
        const saved = dc.loadState();
        const token = flag('--token') ?? process.env.DISCORD_BOT_TOKEN ?? saved.token;
        const mode = flag('--mode') ? normalizeMode(flag('--mode')) : null;
        if (flag('--mode') && !mode) { console.log(c.red(`--mode must be one of: auto, ${MODE_NAMES.join(', ')}`)); process.exitCode = 3; return; }
        const ac = new AbortController();
        process.on('SIGINT', () => { ac.abort(); process.exit(0); });
        try {
          await dc.runDiscordGateway({ token, cwd: path.resolve(flag('--cwd') ?? process.cwd()), agent: flag('--agent') ?? null, mode, signal: ac.signal });
        } catch (e) {
          console.log(c.red(String(e?.message ?? e)));
          process.exitCode = 1;
        }
        return;
      }
      if (action === 'slack') {
        const sl = await import('./slack-gateway.js');
        const saved = sl.loadState();
        const appToken = flag('--app-token') ?? process.env.SLACK_APP_TOKEN ?? saved.appToken;
        const botToken = flag('--bot-token') ?? process.env.SLACK_BOT_TOKEN ?? saved.botToken;
        const mode = flag('--mode') ? normalizeMode(flag('--mode')) : null;
        if (flag('--mode') && !mode) { console.log(c.red(`--mode must be one of: auto, ${MODE_NAMES.join(', ')}`)); process.exitCode = 3; return; }
        const ac = new AbortController();
        process.on('SIGINT', () => { ac.abort(); process.exit(0); });
        try {
          await sl.runSlackGateway({ appToken, botToken, cwd: path.resolve(flag('--cwd') ?? process.cwd()), agent: flag('--agent') ?? null, mode, signal: ac.signal });
        } catch (e) {
          console.log(c.red(String(e?.message ?? e)));
          process.exitCode = 1;
        }
        return;
      }
      if (action === 'unpair') {
        const which = String(args[1] ?? 'all').toLowerCase();
        if (which === 'all' || which === 'telegram') { const st = tg.loadState(); delete st.owner; tg.saveState(st); }
        if (which === 'all' || which === 'discord') { const dc = await import('./discord-gateway.js'); const st = dc.loadState(); delete st.owner; dc.saveState(st); }
        if (which === 'all' || which === 'slack') { const sl = await import('./slack-gateway.js'); const st = sl.loadState(); delete st.owner; sl.saveState(st); }
        console.log(c.green('unpaired — the next start of the gateway prints a new pairing code'));
        return;
      }
      const st = tg.loadState();
      const dst = (await import('./discord-gateway.js')).loadState();
      const line = (name, s) => `  ${name}: ${s.token ? 'set up' : 'not set up'}${s.owner ? `, paired with ${s.owner}` : s.token ? ', not paired yet' : ''}`;
      console.log(`${c.bold('ox gateway')} — talk to ox from your phone`);
      console.log(c.dim('  ox gateway telegram --token <token from @BotFather> [--cwd <project>] [--mode <mode>] [--agent <name>]'));
      console.log(c.dim('  ox gateway discord  --token <bot token from discord.com/developers> [--cwd <project>] [--mode <mode>] [--agent <name>]'));
      console.log(c.dim('  ox gateway slack    --app-token xapp-… --bot-token xoxb-… (api.slack.com/apps, Socket Mode) [--cwd <project>] [--mode <mode>] [--agent <name>]'));
      console.log(c.dim('  ox gateway unpair [telegram|discord|slack]'));
      console.log(line('telegram', st));
      console.log(line('discord', dst));
      const sst = (await import('./slack-gateway.js')).loadState();
      console.log(line('slack', { ...sst, token: sst.appToken && sst.botToken }));
      console.log(c.dim('  Each message runs ox in your project; approvals come as Allow/Deny buttons. Pair first: the code is printed when the gateway starts.'));
      return;
    }
    case 'cron': {
      // The historical name, kept working over the same store. See cmdCron in
      // daemon-cmd.js for what stays legacy (free-text cadence, `scheduled job
      // <id>`, `ran job <id>`, an armed row on `add`) and what does not.
      return cmdCron(args);
    }
    case 'backend': {
      const action = String(args[0] ?? '').trim().toLowerCase();
      const manager = createBackendManager(process.cwd());
      if (action === 'list' || action === '') {
        const { dockerProblem, DEFAULT_DOCKER_IMAGE } = await import('./docker-backend.js');
        const problem = dockerProblem();
        console.log(c.bold('where the agent\'s commands run (--backend)'));
        console.log(`  ${c.green('✓')} local   on this machine (default)`);
        console.log(problem
          ? `  ${c.dim('✗')} docker  ${c.dim(problem)}`
          : `  ${c.green('✓')} docker  in a container with this project at /workspace (default image ${DEFAULT_DOCKER_IMAGE}; docker:<image>, docker:<image>:offline)`);
        return;
      }
      console.log(c.dim('usage: ox backend list'));
      return;
    }
    case 'inspect': {
      const report = inspectProject(process.cwd());
      console.log(formatInspect(report));
      return;
    }
    case 'acp': {
      const sub = String(args[0] ?? '').trim().toLowerCase();
      if (sub === 'server') {
        const task = makeTask({ kind: 'code' });
        const choice = pickModel({ task, env: process.env });
        if (!choice) {
          process.stderr.write(c.red('✗ no reachable provider; set an API key or OX_OLLAMA_AVAILABLE=1\n'));
          process.exitCode = 3;
          return;
        }
        // Human-facing lines (ox logo, wordmark, provider note) go to stderr:
        // stdout stays strictly JSON-RPC 2.0, because the first stdout line is
        // parsed as the initialize RESPONSE by clients such as Zed. The banner
        // takes stream: stderr so its colour gate reads stderr's isTTY — under
        // an editor stdout is the RPC pipe, and the mark should still light up
        // in the agent log panel (and stay plain inside `2>log` files).
        process.stderr.write(oxBanner({ version: VERSION, stream: process.stderr }) + '\n');
        process.stderr.write(c.dim(`ACP server starting on stdio (provider: ${choice.provider}/${choice.model})...\n`));
        const server = createAcpServer(null, { target: choice, cwd: process.cwd(), config: loadConfig() });
        server.start();
        return;
      }
      console.log(c.dim('usage: ox acp server'));
      return;
    }
    case 'bundles': {
      const action = String(args[0] ?? '').trim().toLowerCase();
      const mgr = createBundleManager(process.cwd());
      if (action === 'list') {
        const bundles = listBundles(mgr);
        if (!bundles.length) { console.log(c.dim('no bundles defined')); return; }
        for (const b of bundles) console.log(`  ${b.name}: ${b.skillCount} skills — ${b.description}`);
        return;
      }
      console.log(c.dim('usage: ox bundles list'));
      return;
    }
    case 'index': {
      const action = String(args[0] ?? '').trim().toLowerCase();
      const idx = createCodebaseIndex(process.cwd());
      if (action === 'build') {
        console.log(c.dim('indexing codebase...'));
        idx.indexDirectory(process.cwd());
        try { idx.save(); } catch (err) {
          console.log(c.red('✗ failed to persist index: ' + (err?.message ?? err)));
          process.exitCode = 1;
          return;
        }
        const stats = idx.getIndexStats();
        console.log(c.green(`✓ indexed: ${stats.files} files, ${stats.terms} terms`));
        return;
      }
      if (action === 'search') {
        const query = args.slice(1).join(' ');
        if (!query) { console.log(c.red('✗ usage: ox index search <query>')); process.exitCode = 3; return; }
        const results = idx.search(query, 10);
        console.log(formatSearchResults(results));
        return;
      }
      console.log(c.dim('usage: ox index build | ox index search <query>'));
      return;
    }
    case 'voice-mode': {
      // The old name: the same as ox voice.
      const done = await cmdVoiceDictation('status', []);
      if (done) console.log(c.dim('\nTalk to ox: hold ⌃⌥Space with the island running (ox island).'));
      return;
    }
    case 'refine': {
      console.log(renderRefineCommand(args.join(' '), { cwd: process.cwd(), color: c }));
      return;
    }
    case 'self-improve': {
      // The real learning loop (src/skill-drafts.js). It used to run a cycle
      // that invented a proposal when it found none and counted "pending" as
      // applied.
      const sd = await import('./skill-drafts.js');
      const action = String(args[0] ?? 'status').trim().toLowerCase();
      const cwd = process.cwd();
      if (action === 'run') {
        const r = await sd.learnFromProject(cwd, { sessionsDir: path.join(os.homedir(), '.ox', 'sessions') });
        console.log(`read ${r.read} session(s) from this project · ${r.lessons} new lesson(s) for procedural memory · ${r.drafted.length} skill draft(s)${r.drafted.length ? `: ${r.drafted.join(', ')}` : ''}`);
        if (r.drafted.length) console.log(c.dim('review: ox self-improve drafts · keep one: ox self-improve accept <name>'));
        return;
      }
      if (action === 'drafts' || action === 'status') {
        const drafts = sd.listDrafts(cwd);
        if (!drafts.length) console.log(c.dim('no skill drafts here — ox drafts one when a run finishes a task in several good steps (or: ox self-improve run)'));
        for (const d of drafts) console.log(`  ${d.name}  ${c.dim(`${d.steps} steps · from session ${d.from} · .agent/skill-drafts/${d.name}/SKILL.md`)}`);
        return;
      }
      if (action === 'accept' || action === 'reject') {
        const name = args[1];
        if (!name) { console.log(c.red(`usage: ox self-improve ${action} <name>`)); process.exitCode = 3; return; }
        const ok = action === 'accept' ? sd.acceptDraft(cwd, name) : sd.rejectDraft(cwd, name);
        console.log(ok ? c.green(action === 'accept' ? `kept: .agents/skills/${name} — ox loads it from now on` : `dropped ${name}`) : c.red(`no draft '${name}'`));
        if (!ok) process.exitCode = 3;
        return;
      }
      console.log(c.dim('usage: ox self-improve run | drafts | accept <name> | reject <name>'));
      return;
    }
    case 'verify': { const v = createVerifier(process.cwd()); const report = await v.verify('project verification', null, {}); console.log(formatVerificationReport(report)); return; }
    case 'spec': { const action = String(args[0] ?? '').trim().toLowerCase(); const restArgs = args.slice(1); const st = createSpecTracker(process.cwd()); if (action === 'create') { const title = restArgs.join(' '); if (!title) { console.log(c.red('usage: ox spec create <title>')); return; } const spec = st.createSpec(title, []); console.log(c.green('created spec ' + spec.id + ': ' + spec.title)); return; } if (action === 'list') { const specs = st.listSpecs(); if (!specs.length) { console.log(c.dim('no specs')); return; } for (const s of specs) console.log('  ' + s.id + ' ' + s.title); return; } if (action === 'trace' || action === 'show') { const B = await import('./build-spec.js'); const spec = B.loadSpec(process.cwd(), restArgs[0] ?? null); if (!spec) { console.log(c.dim('no spec in .agent/specs (ox build "<requirement>" writes one)')); return; } if (action === 'show') { console.log(B.specMarkdown(spec)); return; } const t = B.traceSpec(process.cwd(), spec); console.log(B.formatTrace(spec, t)); if (t.passed < t.rows.length) process.exitCode = 1; return; } console.log(c.dim('usage: ox spec create <title> | ox spec list | ox spec show [id] | ox spec trace [id]')); return; }
    case 'arch': {
      const action = String(args[0] ?? '').trim().toLowerCase();
      const restArgs = args.slice(1);
      const am = createArchMemory(process.cwd());
      if (action === 'record') {
        const component = restArgs[0];
        const decision = restArgs.slice(1).join(' ');
        if (!component) { console.log(c.red('usage: ox arch record <component> <decision>')); return; }
        am.recordArchitecture(component, decision || '', '');
        console.log(c.green('recorded architecture for ' + component));
        return;
      }
      if (action === 'list') {
        const comps = am.listComponents();
        if (!comps.length) { console.log(c.dim('no components')); return; }
        for (const c of comps) console.log('  ' + c.id + ' ' + c.name);
        return;
      }
      // `ox arch context` -- the decisions, as one budgeted block. `record` and
      // `list` write and enumerate but never read the reasoning back out, so a
      // decision could be stored and never consulted.
      //
      // --max is in CHARACTERS, not tokens: it is passed straight through to
      // exportArchitectureContext()'s maxTokens parameter, which compares and
      // slices on string length. When the budget is smaller than the record the
      // block is hard-truncated mid-string -- that is the function's existing
      // behaviour and this flag does not change it -- so the header line above
      // reports both lengths so the reader can see when a cut happened.
      if (action === 'context') {
        let maxChars = 4000;
        const mi = restArgs.indexOf('--max');
        if (mi !== -1) {
          const n = Number(restArgs[mi + 1]);
          if (Number.isFinite(n) && n > 0) maxChars = Math.floor(n);
        }
        const comps = am.listComponents();
        if (!comps.length) { console.log(c.dim('no components recorded — `ox arch record <component> <decision>`')); return; }
        const block = exportArchitectureContext(am.architecture(), maxChars);
        const raw = am.exportArchitecture();
        console.log(c.dim(`# ${comps.length} component(s), ${raw.length} chars total, ${block.length} emitted (cap ${maxChars})`));
        console.log(block);
        return;
      }
      console.log(c.dim('usage: ox arch record <component> <decision> | ox arch list | ox arch context [--max n]'));
      return;
    }
    case 'regression': { const action = String(args[0] ?? '').trim().toLowerCase(); const restArgs = args.slice(1); const rg = createRegressionGuard(process.cwd()); if (action === 'snapshot') { const label = restArgs.join(' ') || ('snap-' + Date.now()); const snap = rg.snapshot(label); console.log(c.green('snapshot ' + snap.id + ': ' + snap.label)); return; } if (action === 'list') { const snaps = rg.listSnapshots(); if (!snaps.length) { console.log(c.dim('no snapshots')); return; } for (const s of snaps) console.log('  ' + s.id + ' ' + s.label); return; } console.log(c.dim('usage: ox regression snapshot <label> | ox regression list')); return; }
    case 'review': { const target = args.join(' '); if (!target) { console.log(c.red('usage: ox review <file>')); return; } const cr = createCodeReviewer(process.cwd()); try { const review = cr.reviewFile(target); console.log(formatReviewReport(review.findings)); } catch (err) { console.log(c.red('error: ' + (err?.message ?? err))); } return; }
    case 'workflow': { const action = String(args[0] ?? '').trim().toLowerCase(); const restArgs = args.slice(1); const wf = createTeamWorkflows(process.cwd()); if (action === 'list') { const workflows = wf.listWorkflows(); if (!workflows.length) { console.log(c.dim('no workflows')); return; } for (const w of workflows) console.log('  ' + w.id + ' ' + w.name); return; } console.log(c.dim('usage: ox workflow list')); return; }
    case 'model': {
      const action = String(args[0] ?? '').trim().toLowerCase();
      const restArgs = args.slice(1);
      if (action === 'list') {
        const candidates = listCandidates({}, process.env);
        console.log(c.bold('available models'));
        // listCandidates() returns { bot, model, provider } -- there is no `id`
        // field, so the old `m.id` read printed "undefined" for every candidate.
        // bot is genuinely null for an OX_MODEL that matches no preset, so it is
        // reported as n/a rather than filled in with something invented.
        for (const m of candidates.slice(0, 25)) console.log(`  ${m.model} ${c.dim('(' + (m.bot ?? 'n/a') + ' \u00b7 ' + (m.provider ?? 'n/a') + ')')}`);
        return;
      }
      if (action === 'pick') {
        const task = makeTask({ kind: restArgs.join(' ') || 'code' });
        const choice = pickModel({ task, env: process.env });
        console.log(formatModelRecommendation(choice));
        return;
      }
      console.log(c.dim('usage: ox model list | ox model pick <task>'));
      return;
    }
    case 'models': {
      const hubSub = String(args[0] ?? '').toLowerCase();
      if (['hw', 'hardware', 'recommend', 'search', 'pull'].includes(hubSub)) {
        process.exitCode = await cmdModelHub(hubSub, args.slice(1));
        return;
      }
      const candidates = listCandidates({}, process.env);
      console.log(c.bold('models'));
      // Same shape bug as `ox model list`: listCandidates() yields
      // { bot, model, provider }, never `id`, so `m.id` printed "undefined" per
      // candidate. Print the fields that exist; null bot is reported honestly.
      if (!candidates.length) {
        console.log(c.dim('  no models configured'));
        return;
      }
      for (const m of candidates.slice(0, 15)) {
        console.log(`  ${m.model} ${c.dim('(' + (m.bot ?? 'n/a') + ' \u00b7 ' + (m.provider ?? 'n/a') + ')')}`);
      }
      console.log(c.dim('find open models that fit this machine: ox models recommend [--task code|general|small] \u00b7 ox models hw \u00b7 ox models search <q> \u00b7 ox models pull <repo>'));
      return;
    }
    case 'bench': {
      const action = String(args[0] ?? '').trim().toLowerCase();
      const restArgs = args.slice(1);
      if (action === 'list') {
        console.log(c.bold('benchmarks'));
        for (const b of MODEL_BENCHMARKS) console.log(`  ${b.name}: ${b.description}`);
        return;
      }
      if (action === 'run') {
        const modelIds = restArgs.length ? restArgs : ['claude-opus-5', 'gpt-5.6-sol'];
        const benchmarker = createModelBenchmarker(modelIds);
        console.log(c.dim('running benchmarks...'));
        const results = await benchmarker.runAll();
        console.log(benchmarker.formatReport(results));
        // Say out loud how much of the table is blank, and why — a table of `n/a`
        // that looks like a table of scores is its own kind of fabrication.
        const unmeasured = results.filter((r) => r.score == null).length;
        if (unmeasured) {
          console.log(c.dim(`n/a = unmeasured (${unmeasured}/${results.length}). These suites have no runnable driver in this repo; no estimated score is substituted.`));
        }
        return;
      }
      console.log(c.dim('usage: ox bench list | ox bench run [models...]'));
      return;
    }
    case 'local': {
      await cmdLocal(args);
      return;
    }
  }
}

async function runPrint(prompt, config, opts, initialMessages = []) {
  try {
    const { code } = await runHeadless({ prompt, config, opts, initialMessages });
    process.exitCode = code;
  } catch (err) {
    process.stderr.write(`${c.red(`✗ ${err?.message ?? err}`)}\n`);
    process.exitCode = err?.exitCode ?? 1;
  } finally {
    // The run is over: drop the GUI bridge (and its socket file) here rather
    // than waiting for 'exit', which the bridge's own client sockets would
    // otherwise prevent from ever arriving.
    closeIpcBridge();
  }
}

async function repl(config, opts, flags) {
  const budget = createCostBudget({ config, maxCostUsd: opts.maxCostUsd });
  return budget.run(() => replWithBudget(config, opts, flags, budget));
}

async function replWithBudget(config, opts, flags, budget) {
  let target;
  try {
    const { workingModelSpec } = await import('./working-model.js');
    target = resolveBot(await workingModelSpec(config, { explicit: opts.bot || opts.model || null }), config);
  } catch (err) {
    process.stderr.write(`${c.red(`✗ ${err?.message ?? err}`)}\n`);
    process.stderr.write(
      `${c.dim(`available bots: ${listBots(config).map(([n]) => n).join(', ')}`)}\n`
    );
    process.exitCode = 3;
    return;
  }
  const assembled = await assembleCtx({ config, target, opts });
  // `systemPrompt` is the exact prompt assembleCtx built for this run, so the
  // /context breakdown measures the same object the agent sends rather than a
  // reconstruction of it.
  const { ctx, skills, hub, systemPrompt: assembledSystemPrompt } = assembled;
  let auxTarget = resolveAuxTarget(config);

  let messages = [];
  let session = null;
  // `state` is declared below, and a resumed goal is read here, so the recovered
  // values live in these locals first and are folded into `state` as soon as it
  // exists. Assigning to `state` from up here is a TDZ crash on every --resume.
  let resumedGoal = null;
  let resumedGoalTerminal = null;
  if (flags.resume) {
    const f = sessionFileFromRef(flags.resume);
    if (!f) {
      process.stderr.write(`${c.red(`✗ no session '${flags.resume}'`)}\n`);
      process.exitCode = 3;
      await cleanupCtx(assembled);
      return;
    }
    if (!applyResumeGuards(f, { sandboxProfile: opts.sandbox, rewind: flags.rewind })) {
      process.exitCode = 4;
      await cleanupCtx(assembled);
      return;
    }
    session = { file: f, id: idFromSessionFile(f) };
    ({ messages, goal: resumedGoal, goalTerminal: resumedGoalTerminal } = loadResumedSession(
      f,
      session.id,
      (n) => `resumed session ${session.id} (${n} messages)`
    ));
    reportResumedGoal(resumedGoal, resumedGoalTerminal);
  } else if (flags.cont) {
    const f = latestSessionFile(config.cwd);
    if (f) {
      if (!applyResumeGuards(f, { sandboxProfile: opts.sandbox, rewind: flags.rewind })) {
        process.exitCode = 4;
        await cleanupCtx(assembled);
        return;
      }
      session = { file: f, id: idFromSessionFile(f) };
      ({ messages, goal: resumedGoal, goalTerminal: resumedGoalTerminal } = loadResumedSession(
        f,
        session.id,
        (n) => `continued session ${session.id} (${n} messages)`
      ));
      reportResumedGoal(resumedGoal, resumedGoalTerminal);
    }
  }
  if (!session) {
    session = createSession(config.cwd, { bot: target.model, provider: target.provider });
    // Wave5a A: pin the effective sandbox profile for this session.
    if (opts.sandbox) {
      appendEvent(session, { t: 'sandbox', profile: opts.sandbox.name ?? 'off', degraded: !!opts.sandbox.degraded });
    }
  }
  // Wave5a A: the sandbox profile travels in ctx so tool spawns enforce it.
  if (opts.sandbox && !ctx.sandbox) ctx.sandbox = opts.sandbox;
  if (opts.backend && !ctx.backend) ctx.backend = opts.backend;
  // Wave5a F: audit rows carry the session id.
  ctx.sessionId = session.id;

  // One ticker for the whole REPL session, so the live agent set is a property
  // of the session rather than of a turn: a subagent spawned in turn 1 and
  // still running in turn 3 is one agent, and `/agents` reads the same set the
  // terminal lines are counting.
  const subagentTicker = new SubagentTicker();

  // Every agent's tokens and cost across this REPL session (/cost).
  const sessionLedger = createLedger();
  const state = {
    busy: false,
    exiting: false,
    currentAbort: null,
    lastSigintAt: 0,
    tokensIn: 0,
    tokensOut: 0,
    auxIn: 0,
    auxOut: 0,
    costUsd: 0,
    budgetStopped: false,
    fallbackWarned: false,
    files: new Set(),
    firstUser: null,
    lastAssistant: '',
    lastEventWasError: false,
    // Full payload the agent last sent (history + tool schemas); null until
    // the agent reports one, so the meter falls back to a local estimate.
    contextTokens: null,
    contextSchemas: null,
    // Last segmentation the AGENT measured for a real request. Preferred over
    // any local reconstruction, because it reflects the per-turn system prompt
    // (scoped by @path refs) rather than the session-wide one.
    contextBreakdown: null,
    // Verification default mirrors the headless entrypoint: explicit --verify
    // or config defaultVerify. /verify still toggles per session; auto runs
    // remain unconditionally verified in headless.
    verify: !!opts.verify,
    maxMode: resolveMaxMode(opts.maxMode ?? config.maxMode),
    mode: normalizeMode(opts.mode ?? config.mode) ?? 'code',
    baseApprovalMode: ctx.approval === 'plan' ? 'default' : ctx.approval,
    goalContract: null,
    // The persistent goal lives here for the run and on disk between runs. It is
    // restored from the transcript on resume and never kept in memory alone.
    goal: resumedGoal,
    goalTerminal: resumedGoalTerminal,
    goalSig: '',
    gates: new Map(),
    titled: false,
  };

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: c.cyan('❯ ') });
  const currentBotLabel = () => `${target.bot ?? target.model}/${target.provider}`;
  const currentAuxLabel = () => (auxTarget ? `${auxTarget.bot ?? auxTarget.model}/${auxTarget.provider}` : null);

  const syncSpend = () => {
    const spend = budget.snapshot();
    state.tokensIn = spend.inputTokens;
    state.tokensOut = spend.outputTokens;
    state.costUsd = spend.costUsd;
  };

  async function finalizeAndExit() {
    if (state.exiting) return;
    state.exiting = true;
    try {
      writeEpisode(config.cwd, {
        goal: state.firstUser,
        outcome: state.lastAssistant,
        files: [...state.files],
        lessons: [],
      });
    } catch {}
    try {
      writeSessionNote(config.cwd, {
        phase: 'session-end',
        status: state.lastEventWasError ? 'error' : 'ok',
        goal: state.firstUser,
        files: [...state.files],
        decisions: state.lastAssistant ? [truncate(state.lastAssistant, 300)] : [],
        tokensIn: state.tokensIn,
        tokensOut: state.tokensOut,
        costUsd: state.costUsd,
        model: target.model,
      });
    } catch {}
    try {
      await cleanupCtx(assembled);
    } catch {}
    const costPart = state.costUsd > 0 ? ` · ${formatCost(state.costUsd)}` : '';
    console.log(c.dim(`\nsession ${session.id}${costPart} · bye`));
    try {
      rl.close();
    } catch {}
    // A connected GUI learns the session is over while it can still read it.
    closeIpcBridge();
    process.exit(0);
  }

  const baseApprove = ctx.requestApproval;
  // Trust is read LIVE from ctx each call: `/trust` mutates ctx.trustLevel
  // mid-session, and a closed-over startup value would silently ignore it.
  const resolveTrust = () => ctx.trustLevel || config.trustLevel || 'strict';
  ctx.requestApproval = createTrustApprovalWrapper({
    checkTrust,
    baseApprove,
    resolveTrust,
    ctx,
    pause: () => rl.pause(),
    resume: () => rl.resume(),
  });

  async function doCompact() {
    if (messages.length < 3) {
      console.log(c.dim('nothing to compact'));
      return;
    }
    const { keepTurns } = compactionKnobs(config);
    const { head, toSummarize, tail } = pureCompact(messages, keepTurns);
    if (toSummarize.length < 2) {
      console.log(c.dim('nothing to compact'));
      return;
    }
    const transcript = toSummarize
      .map((m) => {
        const role = m?.role ?? '?';
        if (Array.isArray(m?.tool_calls) && m.tool_calls.length) {
          return `[${role}] called tools: ${m.tool_calls
            .map((cc) => `${cc?.function?.name ?? '?'}(${truncate(cc?.function?.arguments ?? '', 200)})`)
            .join('; ')}`;
        }
        if (role === 'tool') return `[tool result for ${m?.tool_call_id ?? '?'}] ${truncate(m?.content ?? '', 400)}`;
        const body = typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? '');
        return `[${role}] ${truncate(body, 2000)}`;
      })
      .join('\n');
    const prompt = buildSummarizePrompt(transcript, { wordBudget: compactionPassKnobs(config).wordBudget });
    const ac = new AbortController();
    state.currentAbort = ac;
    let summary = '';
    try {
      for await (const rawEv of streamVia(auxTarget ?? target, {
        model: (auxTarget ?? target).model,
        messages: [{ role: 'user', content: prompt }],
        signal: ac.signal,
      })) {
        const t = typeof rawEv === 'string' ? rawEv : rawEv?.text ?? rawEv?.content ?? '';
        if (typeof t === 'string' && t) {
          summary += t;
          streamText(t);
        }
      }
    } catch (err) {
      if (!ac.signal.aborted) console.log(renderError(err));
    } finally {
      streamText('\n');
      state.currentAbort = null;
    }
    summary = summary.trim();
    if (!summary) {
      console.log(c.red('✗ compaction failed — history unchanged'));
      return;
    }
    // The schemas are re-sent every turn and survive compaction, so report
    // both terms: the delta is history only, the total is the real payload.
    const schemas = state.contextSchemas ?? 0;
    const before = schemas + estimateTokens(JSON.stringify(messages));
    messages = [...head, { role: 'user', content: `[ox: summary of earlier conversation turns]\n${summary}` }, ...tail];
    const after = schemas + estimateTokens(JSON.stringify(messages));
    console.log(c.dim(`compacted ${before} → ${after} tokens`));
  }

  async function runTurn(text, extra = {}) {
    if (state.firstUser == null) state.firstUser = text;
    // Wave5a D: a user message beginning a turn drops a rewind point.
    try {
      appendEvent(session, { t: 'rewind-point', id: nextRewindId(session.file), label: String(text).slice(0, 40) });
    } catch {}
    appendEvent(session, { t: 'user', text });
    messages.push({ role: 'user', content: text, ...(extra.images?.length ? { images: extra.images } : {}) });
    // Preferences and facts you state about yourself go to ox's memory.
    if (process.env.OX_LEARN !== '0') {
      try {
        const { learnFromMessages } = await import('./memory-graph.js');
        const learned = learnFromMessages([{ role: 'user', content: text }], { source: session?.file ? path.basename(session.file) : 'repl' });
        if (learned.length) console.log(c.dim(`· remembered: ${learned.map((r) => `"${r.memory.text}"${r.op === 'update' ? ` (replaces "${r.previous.text}")` : ''}`).join('; ')}`));
      } catch {}
    }
    const ac = new AbortController();
    state.currentAbort = ac;
    state.lastEventWasError = false;
    const turnLedger = createLedger();
    let extraGuidance = extra.guidance ?? '';
    if (state.maxMode > 1) {
      try {
        const mm = await runMaxModePlanning({
          target,
          goal: text,
          n: state.maxMode,
          signal: ac.signal,
          cwd: config.cwd,
          auxTarget,
          overrides: config?.modelOverrides,
        });
        state.tokensIn += mm.usage.inputTokens;
        state.tokensOut += mm.usage.outputTokens;
        if (mm.aux) {
          state.auxIn += mm.auxUsage.inputTokens;
          state.auxOut += mm.auxUsage.outputTokens;
        }
        syncSpend();
        if (mm.candidates > 0) {
          process.stdout.write(
            `${c.dim(`· max-mode: ${mm.candidates} plans considered, using #${mm.chosen}`)}\n`
          );
        }
        if (mm.plan) extraGuidance = [extraGuidance, `[SELECTED PLAN]\n${mm.plan}`].filter(Boolean).join('\n\n');
      } catch {}
    }
    // Awake for the length of the turn, so a long one survives the idle timer.
    const releaseAwake = holdAwake({ config });
    const turnMode = resolveTurnMode(state.mode, text);
    ctx.mode = turnMode.mode;
    if (turnMode.routed) process.stdout.write(`${c.dim(`· auto → ${turnMode.mode} (${turnMode.reason})`)}\n`);
    try {
      for await (const ev of runAgent({
        target,
        auxTarget,
        messages,
        ctx,
        config,
        signal: ac.signal,
        verify: state.verify,
        extraGuidance,
        ...(state.goalContract ? { goalContract: state.goalContract } : {}),
        ...(state.goal ? { goal: state.goal } : {}),
      })) {
        turnLedger.feed(ev);
        sessionLedger.feed(ev);
        switch (ev.type) {
          case 'text-delta':
            streamText(ev.text);
            break;
          case 'tool-start': {
            let args = {};
            try {
              args = JSON.parse(ev.argsPreview ?? '{}');
            } catch {}
            if (typeof args.path === 'string') state.files.add(args.path);
            process.stdout.write(`\n${renderToolStart(ev.name, args)}\n`);
            break;
          }
          case 'tool-end': {
            const snip = `${ev.ms}ms · ${ev.bytes}b`;
            process.stdout.write(`${renderToolEnd(ev.name, { content: snip }, ev.isError)}\n`);
            if (ev.name === 'show_ui' && ev.meta?.canvas?.text) {
              process.stdout.write(`\n${ev.meta.canvas.text}\n`);
              if (ev.meta.canvas.actions?.length) process.stdout.write(`${c.dim('  type a number to press a button · /ui to redraw')}\n`);
            }
            appendEvent(session, {
              t: 'tool-result',
              callId: ev.id,
              name: ev.name,
              isError: ev.isError,
              content: snip,
            });
            break;
          }
          // Subagent lifecycle. The ticker owns the agent set and decides what
          // is worth PRINTING; this only relays. Progress events that change
          // nothing visible return an empty count line, which is what keeps a
          // long subagent from scrolling the terminal.
          case 'subagent-spawn':
          case 'subagent-start':
          case 'subagent-progress':
          case 'subagent-end': {
            const out = subagentTicker.apply(ev);
            if (out.line) process.stdout.write(`\n${out.line}\n`);
            if (out.count) process.stdout.write(`${out.count}\n`);
            if (out.becameEmpty) process.stdout.write(`${c.dim('  no subagents running')}\n`);
            if (ev.type === 'subagent-end') {
              appendEvent(session, {
                t: 'subagent',
                id: ev.id,
                status: ev.status,
                elapsedMs: ev.elapsedMs,
                filesTouched: ev.filesTouched ?? [],
                lessonsCount: ev.lessonsCount ?? 0,
                error: ev.error ?? null,
              });
            }
            break;
          }
          case 'reflection':
            process.stdout.write(`${dimItalic(`  ~ ${ev.text} (attempt ${ev.count})`)}\n`);
            break;
          case 'continuation-retry':
            process.stdout.write(`${c.yellow(`· stream dropped (${ev.reason}) — retry ${ev.attempt}/${3}`)}\n`);
            break;
          case 'warning':
            process.stdout.write(`${c.yellow(`! ${ev.text ?? ev.message}`)}\n`);
            break;
          case 'continued':
            process.stdout.write(`${c.dim(`· output truncated by length — auto-continued (round ${ev.round})`)}\n`);
            break;
          case 'fallback':
            if (!state.fallbackWarned) {
              state.fallbackWarned = true;
              process.stdout.write(`${c.yellow(`· primary provider unhealthy, using ${ev.to}`)}\n`);
            }
            break;
          case 'compaction':
            process.stdout.write(
              `${c.dim(`· context compacted ${ev.from} → ${ev.to} tokens${ev.savedTokens > 0 ? ` (saved ${ev.savedTokens})` : ''}`)}\n`
            );
            process.stdout.write(
              `${c.dim(`  ${ev.messagesSummarized} messages summarized into 1, ${ev.messagesKept} kept · summarized by ${ev.compactionModel ?? ev.model ?? 'the main model'}${ev.compactionModelSource && ev.compactionModelSource !== 'main' ? ` (${ev.compactionModelSource})` : ''} · compaction ${ev.index ?? 1} of ${ev.cap ?? '?'} this run · /context for the breakdown`)}\n`
            );
            // Persist the audit record in the transcript so the compaction is
            // auditable after the run, not just while it is on screen.
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
            break;
          case 'tool-narrowing':
            process.stdout.write(`${c.dim(`· tool offer narrowed to ${ev.offered} of ${ev.total} for this turn`)}\n`);
            break;
          case 'context-estimate':
            state.contextTokens = ev.tokens ?? null;
            state.contextSchemas = ev.schemaTokens ?? null;
            break;
          case 'context-breakdown':
            state.contextBreakdown = {
              segments: ev.segments,
              total: ev.total,
              window: ev.window,
              windowPct: ev.windowPct,
              largest: ev.largest,
              threshold: ev.threshold,
              messageCount: ev.messageCount,
              summaryPrefix: ev.summaryPrefix,
            };
            break;
          case 'approval':
            if (ev.decision === 'auto') {
              process.stdout.write(`${c.dim(`· auto · read-only — ${ev.detail ?? ev.name}`)}\n`);
            }
            break;
          case 'verification':
            process.stdout.write(
              ev.complete
                ? `${c.dim(`· verified complete (round ${ev.round})`)}\n`
                : `${c.yellow(`· verification round ${ev.round}: incomplete — ${ev.gaps}`)}\n`
            );
            break;
          case 'usage':
            if (ev.aux) {
              state.auxIn += ev.inputTokens ?? 0;
              state.auxOut += ev.outputTokens ?? 0;
            } else {
              state.tokensIn += ev.inputTokens ?? 0;
              state.tokensOut += ev.outputTokens ?? 0;
            }
            syncSpend();
            break;
          case 'assistant-turn': {
            const m = ev.message;
            appendEvent(session, {
              t: 'assistant',
              text: typeof m?.content === 'string' ? m.content : '',
              tool_calls: Array.isArray(m?.tool_calls) ? m.tool_calls : [],
            });
            break;
          }
          case 'final': {
            const m = ev.message;
            state.lastAssistant = typeof m?.content === 'string' ? m.content : '';
            const rec = { t: 'assistant', text: state.lastAssistant };
            if (Array.isArray(m?.tool_calls)) rec.tool_calls = m.tool_calls;
            appendEvent(session, rec);
            streamText('\n');
            // F5 auto-title: one aux call at the FIRST assistant final.
            if (!state.titled && state.lastAssistant.trim()) {
              state.titled = true;
              try {
                const title = await draftTitle(auxTarget ?? target, { text: state.lastAssistant, signal: ac.signal });
                if (title) {
                  appendEvent(session, { t: 'title', title });
                  process.stdout.write(`${c.dim(`· session titled: ${title}`)}\n`);
                }
              } catch {}
            }
            break;
          }
          case 'gate':
            state.gates.set(ev.cmd, { ok: !!ev.ok, exit: ev.exit ?? null, unchanged: !!ev.unchanged });
            process.stdout.write(
              ev.ok
                ? `${c.green(`· gate ok — ${ev.cmd}`)}\n`
                : `${c.yellow(`· gate FAILED — ${ev.cmd} (exit ${ev.exit ?? 'null'})${ev.unchanged ? ' (state unchanged since last failure)' : ''}`)}\n`
            );
            break;
          case 'gate-exhausted':
            process.stdout.write(`${c.yellow(`· gate retry budget exhausted — continuing to verifier: ${ev.pending.join(', ')}`)}\n`);
            break;
          case 'history':
            messages = ev.messages.filter((m) => m?.role !== 'system');
            break;
          case 'error':
            state.lastEventWasError = true;
            if (ac.signal.aborted) process.stdout.write(`${c.dim('^C interrupted')}\n`);
            else process.stdout.write(`${renderError(new Error(ev.error))}\n`);
            break;
        }
      }
    } catch (err) {
      state.lastEventWasError = true;
      if (err?.code === 'OX_BUDGET_STOP' && state.goal) {
        // Hitting --max-cost is not finishing the work. The goal stays ACTIVE and
        // says why the run ended, because a cut-short run and a finished one
        // look identical from the outside otherwise.
        const note = err.message ?? '';
        const stopped = noteGoalStop(state.goal, budget.reason ?? 'budget', note);
        state.goal = persistGoal(session, stopped.goal, 'stopped') ?? state.goal;
        state.goalSig = progressSignature(state.goal);
        process.stdout.write(`${c.yellow(`· goal is still ACTIVE — stopped for budget (${state.goal.stopReason}), not completion`)}\n`);
      }
      if (ac.signal.aborted || err?.name === 'AbortError') process.stdout.write(`${c.dim('^C interrupted')}\n`);
      else process.stdout.write(`${renderError(err)}\n`);
    } finally {
      state.currentAbort = null;
      releaseAwake();
    }
    // Delegated turns end with who spent what (/cost shows the whole session).
    if (turnLedger.hasSubagents()) process.stdout.write(`${renderLedger(turnLedger, { dim: c.dim, bold: c.bold })}\n`);
    // The agent reports the FULL payload it sends; measuring `messages` here
    // ignored the tool schemas (and the system message) and under-reported.
    const estTokens = state.contextTokens ?? estimateTokens(JSON.stringify(messages));
    const window = resolveModelWindow({ model: target.model, configWindow: config.modelWindow });
    process.stdout.write(
      `\n${renderMeter({ estTokens, budget: window, costUsd: state.costUsd, model: target.model, providerName: target.provider })}\n`
    );
    syncGoalAfterTurn();
  }

  // Pulls the model's own checklist (todo_write, the existing mechanism) into the
  // goal, re-proves every completed item against what actually happened this
  // turn, and appends one transcript event only when the proven snapshot moved.
  // A turn that changed nothing therefore costs nothing on disk.
  function goalEvidence() {
    return [...harvestEvidence(messages), ...evidenceFromGates(state.gates)];
  }

  function syncGoalAfterTurn() {
    if (!state.goal || state.goal.status !== GOAL_STATUS.ACTIVE) return;
    const merged = mergeGoalTodos(state.goal, ctx?.sessionState);
    if (!merged) return;
    const proven = proveGoalItems(merged, goalEvidence());
    if (!proven) return;
    const sig = progressSignature(proven);
    if (sig === state.goalSig) return;
    state.goal = persistGoal(session, proven, 'progress') ?? proven;
    state.goalSig = sig;
    const p = goalProgress(proven);
    process.stdout.write(
      `${c.dim(`· goal ${p.done}/${p.total} proven done${p.unverified ? ` · ${p.unverified} unverified` : ''}${p.blocked ? ` · ${p.blocked} blocked` : ''}${p.pending ? ` · ${p.pending} pending` : ''}`)}\n`
    );
  }

  async function slashCommand(rawLine) {
    const parts = rawLine.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const rest = rawLine.slice(cmd.length).trim();
    switch (cmd) {
      case '/help':
        console.log(slashHelp(rest));
        return;
      case '/bot':
      case '/model': {
        if (!rest) {
          console.log(`${c.bold(currentBotLabel())} — switch with ${cmd} <name|provider:model>`);
          console.log(c.dim(`bots: ${listBots(config).map(([n]) => n).join(', ')}`));
          return;
        }
        try {
          target = resolveBot(rest, config);
          console.log(c.dim(`switched to ${currentBotLabel()} (conversation kept)`));
        } catch (err) {
          console.log(c.red(`✗ ${err?.message ?? err}`));
        }
        return;
      }
      case '/cost': {
        syncSpend();
        const est = state.contextTokens ?? estimateTokens(JSON.stringify(messages));
        const schemaNote = state.contextSchemas ? ` (incl ${state.contextSchemas} tool-schema tokens)` : '';
        const spend = state.costUsd > 0 ? ` · ${formatCost(state.costUsd)}` : '';
        const auxSpend =
          state.auxIn || state.auxOut
            ? ` · aux ${state.auxIn}/${state.auxOut} tok${currentAuxLabel() ? ` (${currentAuxLabel()})` : ''}`
            : '';
        console.log(
          `${est} est context tokens${schemaNote} · in ${state.tokensIn} / out ${state.tokensOut} tok${spend}${auxSpend} · ${currentBotLabel()}`
        );
        // Per-agent breakdown once there is more than the main agent to show.
        if (sessionLedger.rows().length > 1) console.log(renderLedger(sessionLedger, { dim: c.dim, bold: c.bold }));
        return;
      }
      case '/soul': {
        const p = loadPersona({ cwd: config.cwd, enabled: config.soul !== false });
        console.log(`soul (persona): ${p.enabled === false ? c.yellow('disabled') : c.green('enabled')} ${c.dim('(disable via "soul": false in ~/.ox/config.json)')}`);
        console.log(`  ${p.paths.home}: ${p.found.home ? `loaded, ${p.sizes.home} chars` : 'not found'}`);
        console.log(`  ${p.paths.cwd}: ${p.found.cwd ? `loaded, ${p.sizes.cwd} chars` : 'not found'}`);
        if (p.truncated) console.log(c.dim('  truncated to 4000 chars per file'));
        if (!p.found.home && !p.found.cwd) console.log(c.dim('  (no persona sources found)'));
        return;
      }
      case '/auxbot': {
        if (!rest) {
          if (currentAuxLabel()) {
            console.log(c.bold(`aux bot: ${currentAuxLabel()}`), c.dim('— compaction, verifier and max-mode calls use it'));
          } else {
            console.log(c.dim('aux bot: none — cheap calls use the main bot; set with /auxbot <name|provider:model>'));
          }
          return;
        }
        try {
          auxTarget = resolveBot(rest, config);
          console.log(c.dim(`aux bot set to ${currentAuxLabel()} — compaction, verifier and max-mode calls will use it`));
        } catch (err) {
          console.log(c.red(`✗ ${err?.message ?? err}`));
        }
        return;
      }
      case '/compact':
        await doCompact();
        return;
      case '/context': {
        // Prefer the agent's own measurement of the last real request; only
        // reconstruct locally when no turn has gone out yet, and say so, so the
        // number is never quietly a different thing from what is labelled.
        const measured = state.contextBreakdown;
        const bd = measured ?? buildContextReport({
          systemPrompt: assembledSystemPrompt,
          messages,
          tools: listToolSchemas(ctx),
          window: resolveModelWindow({ model: target.model, configWindow: config.modelWindow }),
          model: target.model,
          threshold: compactionKnobs(config).compactAt,
        });
        const choice = compactionModelChoice(config, { aux: auxTarget, main: target });
        console.log(
          formatContextBreakdown(bd, {
            model: target.model,
            compactionModel: choice,
            note: measured
              ? 'measured on the last request the agent sent'
              : 'no request sent yet — measured from the assembled prompt and current conversation',
          })
        );
        return;
      }
      case '/clear':
        messages = [];
        console.log(c.dim('context cleared (session file kept)'));
        return;
      case '/mode': {
        const want = rest.trim().toLowerCase();
        if (!want) {
          for (const m of ['auto', ...MODE_NAMES]) {
            const desc = m === 'auto' ? 'picks one of the modes below for each message, and says which' : MODES[m].desc;
            console.log(`${m === state.mode ? c.green('●') : ' '} ${m.padEnd(12)}${c.dim(desc)}`);
          }
          console.log(c.dim('/mode <name> to switch'));
          return;
        }
        const m = normalizeMode(want);
        if (!m) { console.log(c.red(`no mode '${want}' — one of: auto, ${MODE_NAMES.join(', ')}`)); return; }
        state.mode = m;
        console.log(c.green(`mode: ${m}`) + c.dim(m === 'auto' ? ' — each message is routed; the pick is shown' : ` — ${MODES[m].desc}`));
        return;
      }
      case '/plan': {
        if (rest.trim()) {
          console.log(c.dim('building plan...'));
          const planResult = await planFirstBuildPlan({
            task: rest,
            ctx,
            config,
            target,
            cwd: config.cwd,
          });
          console.log(formatPlan(planResult.plan));
          savePlan(planResult.plan, { cwd: config.cwd });
          return;
        }
        ctx.approval = ctx.approval === 'plan' ? state.baseApprovalMode : 'plan';
        console.log(
          ctx.approval === 'plan'
            ? c.yellow('plan mode ON — tools are read-only')
            : c.dim(`plan mode OFF — approvals: ${ctx.approval}`)
        );
        return;
      }
      case '/tools': {
        const schemas = listToolSchemas(ctx);
        if (!schemas.length) {
          console.log(c.dim('no tools available'));
          return;
        }
        for (const s of schemas) {
          const first = String(s.description ?? '').split(/(?<=\.)\s/)[0] ?? '';
          console.log(`${s.name} — ${truncate(first, 110)}`);
        }
        return;
      }
      case '/memory':
        console.log(loadMemoryBlock(config.cwd) || '(empty)');
        return;
      case '/memory-loss':
        cmdMemoryLoss(rest.trim() ? rest.trim().split(/\s+/) : []);
        return;
      case '/pcache': {
        const sub = rest.trim().toLowerCase();
        if (sub === 'clear') { clearPlanCache(); console.log(c.green('✓ plan cache cleared')); return; }
        const cache = getPlanCache();
        const list = cache.templates || [];
        console.log(`plan cache: ${list.length} template(s)`);
        for (const t of list.slice(-10)) {
          console.log(`  ${t.id} · ${t.taskType} · used ${t.successCount}x · ${t.keywords.join(', ')}`);
        }
        return;
      }
      case '/hmem': {
        const hm = createHierarchicalMemory(config.cwd);
        if (rest.trim()) {
          hm.addSubgoal(rest.trim());
          console.log(c.green(`✓ added subgoal: ${rest.trim()}`));
        } else {
          const ctx2 = hm.getWorkingContext();
          console.log(ctx2.text || '(empty working memory)');
          console.log(c.dim(`\n${ctx2.activeCount} active, ${ctx2.observationCount} recent observations, ${ctx2.tokenCount} est tokens`));
        }
        return;
      }
      case '/reason': {
        console.log(c.dim('reasoning digests compress historical reasoning; use /toc for TOC-Comp compression'));
        return;
      }
      case '/toc': {
        const text = JSON.stringify(messages || []).slice(0, 8000);
        const result = await tocComp({ content: text });
        console.log(`TOC-Comp: ${result.originalTokens} → ${result.compressedTokens} tokens (${result.ratio.toFixed(2)}x)`);
        if (result.compressed) console.log(c.dim(result.compressed.slice(0, 400)));
        return;
      }
      case '/voice': {
        if (!hub) {
          console.log(c.dim('no MCP servers configured'));
          return;
        }
        const rows = hub.status().filter((r) => r.server === 'voice' || r.server.includes('voice'));
        if (!rows.length) {
          console.log(c.dim('no voice MCP server configured (add with: ox mcp add voice)'));
          return;
        }
        for (const r of rows) {
          const dot = r.status === 'ok' ? c.green('●') : c.yellow('●');
          console.log(`${dot} ${r.server}: ${r.status} (${r.tools} tools)`);
          if (r.stderrTail) console.log(c.dim(truncate(r.stderrTail, 300)));
        }
        const tmpl = getTemplate('voice');
        if (tmpl) {
          console.log(c.dim(`\ntools: ${tmpl.name} — ${tmpl.title}`));
          console.log(c.dim(tmpl.desc));
        }
        return;
      }
      case '/video': {
        if (!hub) {
          console.log(c.dim('no MCP servers configured'));
          return;
        }
        const rows = hub.status().filter((r) => r.server === 'video' || r.server.includes('video'));
        if (!rows.length) {
          console.log(c.dim('no video MCP server configured (add with: ox mcp add video)'));
          return;
        }
        for (const r of rows) {
          const dot = r.status === 'ok' ? c.green('●') : c.yellow('●');
          console.log(`${dot} ${r.server}: ${r.status} (${r.tools} tools)`);
          if (r.stderrTail) console.log(c.dim(truncate(r.stderrTail, 300)));
        }
        const tmpl = getTemplate('video');
        if (tmpl) {
          console.log(c.dim(`\ntools: ${tmpl.name} — ${tmpl.title}`));
          console.log(c.dim(tmpl.desc));
        }
        return;
      }
      case '/benchmark': {
        const { AGENT_BENCHMARKS, formatReport, computeStats } = await import('./benchmark.js');
        const sub = rest.trim().toLowerCase();
        if (sub === 'list' || !sub) {
          console.log(c.bold('available benchmarks:'));
          for (const b of AGENT_BENCHMARKS) {
            console.log(`  ${b.name} — ${b.description} (${b.taskCount} tasks)`);
          }
          return;
        }
        console.log(c.dim('run benchmarks via: ox benchmark run <name>'));
        return;
      }
      case '/platform': {
        const { createPlatform } = await import('./platform.js');
        const p = createPlatform();
        console.log(c.bold('ox platform status'));
        console.log(`  voice: ${Object.keys(p.voice).join(', ')}`);
        console.log(`  video: ${Object.keys(p.video).join(', ')}`);
        console.log(`  skills: ${Object.keys(p.skills).join(', ')}`);
        console.log(`  benchmark: ${Object.keys(p.benchmark).join(', ')}`);
        console.log(c.dim(`  backend: ${p.backend?.name || 'auto-detecting'}`));
        return;
      }
      case '/clone': {
        await cmdClone(rest.split(/\s+/));
        return;
      }
      case '/skill': {
        if (!rest) {
          console.log(
            skills.length ? c.dim(`skills: ${skills.map((s) => s.name).join(', ')}`) : c.dim('no skills found')
          );
          return;
        }
        const body = readSkillBody(rest, skills);
        if (body == null) {
          console.log(c.red(`✗ no skill '${rest}'`));
          return;
        }
        const viewed = skills.find((s) => s.name.toLowerCase() === rest.trim().toLowerCase());
        if (viewed?.dir) {
          try {
            recordSkillView(viewed.name, viewed.dir);
          } catch {}
        }
        // Read-side screen. The body IS the instructions this skill contributes,
        // and the line below turns it into a user message -- so every character
        // reaches the provider now and is replayed for the rest of the session.
        // renderSkillIndex screens the frontmatter; this screens the body, which
        // is the same third-party trust surface and a much bigger one.
        const head = `[skill loaded: ${rest}]`;
        const screened = screenSkillBody(body, viewed);
        // A skill whose every line tripped the screen has nothing left to
        // contribute. Pushing `[skill loaded: x]` with an empty body would read
        // to the model as a skill that loaded and had nothing to say, which is
        // worse than not loading it: report the refusal and push nothing.
        if (screened.fullyWithheld) {
          process.stderr.write(`${c.red(`✗ ${withheldSkillBodyNotice(viewed)}`)}\n`);
          process.stderr.write(`${c.dim('nothing was pushed into context; /skill was a no-op.')}\n`);
          return;
        }
        // Withheld lines are announced where the model reads them too, so the
        // prompt itself never silently omits part of the skill. The notice is the
        // shared short variant and carries no credential text.
        const notice = screened.withheld ? shortWithheldNotice(screened.withheld, 'skill line') : null;
        messages.push({ role: 'user', content: [head, notice, screened.body].filter((x) => x != null).join('\n') });
        appendEvent(session, { t: 'user', text: head, skill: rest });
        if (screened.withheld) {
          process.stderr.write(
            c.yellow(
              `ox: warning: ${screened.withheld} line${screened.withheld === 1 ? '' : 's'} of skill '${rest}' ` +
                'withheld by the read-side screen (credential or injection shape). ' +
                'The SKILL.md on disk is UNCHANGED -- inspect it yourself.'
            )
          );
        }
        console.log(c.dim(`skill '${rest}' loaded into context`));
        return;
      }
      case '/mcp': {
        if (!hub) {
          console.log(c.dim('no MCP servers configured'));
          return;
        }
        if (rest.split(/\s+/)[0] === 'restart') {
          const name = rest.slice('restart'.length).trim();
          const names = Object.keys(config.mcpServers ?? {});
          if (!name || !names.includes(name)) {
            console.log(c.red(`✗ /mcp restart needs a configured server name (${names.join(', ') || 'none'})`));
            return;
          }
          try {
            await hub.restart(name);
            const row = hub.status().find((r) => r.server === name);
            console.log(c.dim(`restarted ${name} — ${row?.status ?? '?'} (${row?.tools ?? 0} tools)`));
          } catch (err) {
            console.log(renderError(err));
          }
          return;
        }
        const rows = hub.status();
        if (!rows.length) {
          console.log(c.dim('no MCP servers configured'));
          return;
        }
        for (const r of rows) {
          const dot = r.status === 'ok' ? c.green('●') : c.yellow('●');
          console.log(`${dot} ${r.server}: ${r.status} (${r.tools} tools)`);
          if (r.stderrTail) console.log(c.dim(truncate(r.stderrTail, 300)));
        }
        return;
      }
      case '/session':
        console.log(`${session.id}\n${session.file}\n${messages.length} messages in context`);
        return;
      case '/resume': {
        if (!rest) {
          console.log(c.dim('usage: /resume <id|path>'));
          return;
        }
        const f = sessionFileFromRef(rest);
        if (!f) {
          console.log(c.red(`✗ no session '${rest}'`));
          return;
        }
        try {
          const id = idFromSessionFile(f);
          const loaded = loadResumedSession(f, id, (n) => `resumed ${id} — ${n} messages in context`);
          messages = loaded.messages;
          // /resume switches transcripts, so the goal must switch with it: a goal
          // from the previous transcript is not a goal in this one.
          state.goal = loaded.goal;
          state.goalTerminal = loaded.goalTerminal;
          state.goalSig = progressSignature(loaded.goal);
          session = { file: f, id };
          reportResumedGoal(state.goal, state.goalTerminal);
        } catch (err) {
          console.log(renderError(err));
        }
        return;
      }
      case '/goal': {
        const verb = rest.trim().toLowerCase();
        // Lifecycle verbs come FIRST. `/goal done` is a lifecycle command, not an
        // objective to set -- reading it as text would silently create a goal
        // called "done", which is the worst possible outcome for a command whose
        // whole job is to be unambiguous.
        if (!verb) {
          console.log(renderGoalReport(state.goal, { terminal: state.goalTerminal }));
          if (state.goal && state.goalContract) console.log(c.dim(renderContractBlock(state.goalContract)));
          return;
        }
        if (['done', 'complete', 'finish', 'completed'].includes(verb)) {
          if (!state.goal) {
            console.log(c.red('✗ no active goal to complete'));
            return;
          }
          const res = completeGoal(state.goal, goalEvidence());
          if (!res.goal) {
            console.log(c.red(`✗ ${res.refusal}`));
            return;
          }
          // Refusal also persists the RE-PROVEN record, so a claim that turned out
          // to be unevidenced is recorded as unverified rather than quietly kept.
          state.goal = persistGoal(session, res.goal, res.refusal ? 'unproven' : 'done') ?? res.goal;
          state.goalSig = progressSignature(state.goal);
          if (res.refusal) {
            console.log(c.yellow(renderCompletionRefusal(res)));
            return;
          }
          console.log(c.green(`✓ goal complete — ${state.goal.objective}`));
          console.log(c.dim('  it will not resume; /goal clear to remove it, /goal <text> for a new one'));
          return;
        }
        if (['pause', 'hold'].includes(verb)) {
          const res = pauseGoal(state.goal);
          if (!res.goal) {
            console.log(c.red(`✗ ${res.refusal}`));
            return;
          }
          state.goal = persistGoal(session, res.goal, 'paused') ?? res.goal;
          state.goalSig = progressSignature(state.goal);
          console.log(res.note ? c.dim(res.note) : c.green(`◼ goal paused — kept, not pursued: ${state.goal.objective}`));
          return;
        }
        if (['resume', 'start', 'continue'].includes(verb)) {
          const res = resumeGoal(state.goal);
          if (!res.goal) {
            console.log(c.red(`✗ ${res.refusal}`));
            return;
          }
          state.goal = persistGoal(session, res.goal, 'resumed') ?? res.goal;
          state.goalSig = progressSignature(state.goal);
          console.log(res.note ? c.dim(res.note) : c.green(`● goal active — ${state.goal.objective}`));
          return;
        }
        if (['clear', 'drop', 'cancel'].includes(verb)) {
          const res = clearGoal(state.goal);
          if (!res.goal) {
            console.log(c.dim(res.refusal));
            return;
          }
          // The terminal record is what makes a resume report "previous goal
          // cleared" instead of resurrecting it.
          persistGoal(session, res.goal, 'cleared');
          state.goal = null;
          state.goalTerminal = { status: GOAL_STATUS.CLEARED, objective: res.goal.objective, at: res.goal.clearedAt };
          state.goalSig = '';
          console.log(c.green(`✓ goal cleared — ${res.goal.objective}`));
          return;
        }
        // Set a new goal. The credential screen runs BEFORE anything is created
        // or written, so a refused objective leaves no record anywhere.
        const made = createGoal({ objective: rest, contract: state.goalContract, store: session.file });
        if (made.refusal) {
          console.log(c.yellow(`✗ ${made.refusal}`));
          return;
        }
        state.goal = persistGoal(session, made.goal, 'set') ?? made.goal;
        state.goalTerminal = null;
        state.goalSig = progressSignature(state.goal);
        console.log(c.green(`✓ goal set — kept across turns, compaction and resume`));
        console.log(`  ${state.goal.objective}`);
        console.log(c.dim('  keep the checklist current with todo_write; /goal to see progress, /goal done when it is actually finished'));
        // The goal CONTRACT is a separate, per-call thing and is still drafted
        // here: it enables the verifier and shell quality gates. Drafting failure
        // no longer throws the goal away, because the goal is not the contract.
        console.log(c.dim('drafting goal contract via aux model…'));
        let contract = null;
        try {
          contract = await draftContract(auxTarget ?? target, { goal: rest });
        } catch {}
        if (!contract) {
          console.log(c.yellow('⚠ contract drafting failed — goal is still active (verifier unchanged)'));
          return;
        }
        state.goalContract = contract;
        state.goal = persistGoal(session, { ...state.goal, contract }, 'contract') ?? state.goal;
        state.gates = new Map();
        if (!state.verify) {
          state.verify = true;
          console.log(c.dim('verifier ON — contracts are enforced with verification'));
        }
        console.log(c.green('✓ goal contract set:'));
        console.log(renderContractBlock(contract));
        return;
      }
      case '/subgoal': {
        if (!state.goalContract) {
          console.log(c.red('✗ no goal contract — set one first with /goal <text>'));
          return;
        }
        if (!rest) {
          console.log(c.dim('usage: /subgoal <criterion> — appended to the verification field'));
          return;
        }
        state.goalContract = applySubgoal(state.goalContract, rest);
        state.gates = new Map();
        console.log(c.dim(`verification now: ${state.goalContract.verification}`));
        return;
      }
      case '/gates': {
        const contractGates = state.goalContract ? parseGates(state.goalContract) : [];
        if (!contractGates.length) {
          console.log(c.dim('no gates configured (add `gate: <cmd>` segments to the verification field)'));
          return;
        }
        for (const cmd of contractGates) {
          const st = state.gates.get(cmd);
          if (!st) console.log(`  · ${c.dim('pending')} ${cmd}`);
          else if (st.ok) console.log(`  ${c.green('✓ passed')} ${cmd}`);
          else
            console.log(
              `  ${c.red('✗ failed')} ${cmd} (exit ${st.exit ?? 'null'})${st.unchanged ? c.dim(' (state unchanged since last failure)') : ''}`
            );
        }
        return;
      }
      case '/fork': {
        try {
          session = forkSession(session.file);
          console.log(c.dim(`forked → new session ${session.id}`));
        } catch (err) {
          console.log(renderError(err));
        }
        return;
      }
      case '/rewind': {
        if (!rest) {
          const pts = rewindPoints(session.file);
          if (!pts.length) {
            console.log(c.dim('(no rewind points yet — they drop at the start of every user turn)'));
            return;
          }
          console.log(c.bold('rewind points'));
          for (const p of pts) console.log(`  ${padCell(String(p.id), 4)} ${p.label}`);
          return;
        }
        const n = Number(rest.trim());
        if (!Number.isInteger(n) || n < 1) {
          console.log(c.red(`✗ /rewind needs a rewind-point number, got '${rest}'`));
          return;
        }
        try {
          const pt = rewindTo(session.file, n);
          const rewound = loadSessionWithStatus(session.file);
          messages = replayMessages(rewound.messages);
          // A rewind is a conversation restore, so the goal follows the same rule:
          // if the goal was set after the rewind point it is now gone, and
          // pretending otherwise would report progress the transcript disowns.
          state.goal = rewound.goal ?? null;
          state.goalTerminal = rewound.goalTerminal ?? null;
          state.goalSig = progressSignature(state.goal);
          if (rewound.status === HISTORY_STATUS.UNAVAILABLE) warnMissingHistory(session.id, rewound.reason);
          reportResumedGoal(state.goal, state.goalTerminal);
          console.log(c.green(`✓ rewound to turn ${pt.id} ('${pt.label}')`));
          console.log(c.dim('conversation-only restore — files on disk were NOT reverted'));
        } catch (err) {
          console.log(renderError(err));
        }
        return;
      }
      case '/sandbox': {
        const sp = ctx.sandbox ?? opts.sandbox ?? null;
        if (!rest) {
          if (!sp || sp.kind === 'off') {
            console.log(c.dim('sandbox: off (start with --sandbox <off|workspace|read-only|strict> to enforce)'));
          } else {
            const backend = sandboxBackendFor(sp);
            console.log(
              `${c.bold(`sandbox: ${sp.name}`)} · kind ${sp.kind} · backend ${backend} · ` +
                `${sp.degraded || backend === 'none' ? c.yellow('DEGRADED (userspace confinement)') : c.green('OS-enforced')} · env ${sp.env_mode ?? 'core'}`
            );
            console.log(c.dim(`pinned for this session — switching mid-session is refused (resume rule)`));
            // "OS-enforced" on its own would overclaim: name the fields this
            // backend could not express (Linux allow-lists, macOS per-host
            // rules) and the layer that does enforce the allow-list.
            const gaps = (sp.restrict_network === true || (sp.network_allow ?? []).length > 0 || (sp.read_only ?? []).length > 0)
              ? prepareSandbox(sp).gaps
              : { unapplied: [], notes: [] };
            if (gaps?.unapplied?.length) {
              console.log(c.yellow(`not enforceable on the '${backend}' backend: ${gaps.unapplied.join(', ')}`));
              for (const note of gaps.notes ?? []) console.log(c.dim(`  • ${note}`));
            }
            // The policy lists themselves. A read_only entry that is loaded but
            // unenforced must be visible here even when no gap is reported —
            // "the profile never mentioned my path" is exactly how the literal
            // read_only bug hid for so long.
            for (const field of ['read_only', 'read_write', 'deny']) {
              const list = sp[field] ?? [];
              if (list.length > 0) {
                console.log(c.dim(`${field} (${list.length}): ${list.join('  ')}`));
              }
            }
            if ((sp.network_allow ?? []).length > 0) {
              console.log(
                c.dim(
                  `network_allow (${sp.network_allow.length}): enforced IN-PROCESS for ox's own web tools — ` +
                    "not a kernel rule, and it does not pin a name's future DNS answers"
                )
              );
            }
            for (const w of sp.warnings ?? []) console.log(c.yellow(w));
          }
          return;
        }
        const currentName = sp?.name ?? 'off';
        if (rest === currentName) {
          console.log(c.dim(`sandbox '${rest}' is already the active profile`));
          return;
        }
        console.log(
          c.red(`✗ refusing to switch sandbox profile mid-session — pinned '${currentName}'`) +
            c.dim(` (start a fresh session with --sandbox ${rest})`)
        );
        return;
      }
      case '/verify': {
        state.verify = !state.verify;
        console.log(
          state.verify
            ? c.dim('verify ON — an independent auditor judges goal completion each final answer')
            : c.dim('verify OFF — no completion auditing')
        );
        return;
      }
      case '/verify-status': {
        console.log(c.dim(`verify: ${state.verify ? 'ON' : 'OFF'} — ${state.verify ? 'an independent auditor judges goal completion each final answer' : 'no completion auditing'} (default from ${opts.verify ? '--verify or config defaultVerify' : 'no config default; enable with --verify or defaultVerify'})`));
        return;
      }
      case '/max': {
        const arg = rest.trim().split(/\s+/)[0] ?? '';
        if (!arg) {
          console.log(
            state.maxMode > 1
              ? c.dim(`max-mode ON — ${state.maxMode} planning passes per run (disable with /max off)`)
              : c.dim('max-mode OFF — enable with /max <2..5>')
          );
          return;
        }
        const num = arg.toLowerCase() === 'off' ? 1 : Number(arg);
        if (arg.toLowerCase() !== 'off' && !Number.isFinite(num)) {
          console.log(c.red(`✗ /max needs a number 1-5 or 'off', got '${arg}'`));
          return;
        }
        state.maxMode = resolveMaxMode(num);
        console.log(
          state.maxMode > 1
            ? c.yellow(`⚠ max-mode ON — each prompt now runs ${state.maxMode} extra planning passes before the agent`)
            : c.dim('max-mode OFF')
        );
        return;
      }
      case '/yolo': {
        ctx.yolo = !ctx.yolo;
        console.log(
          ctx.yolo
            ? c.yellow('⚠ yolo ON — all tool approvals will be skipped')
            : c.dim('yolo OFF — approval prompts restored')
        );
        return;
      }
      case '/strict': {
        ctx.strictApprovals = !ctx.strictApprovals;
        console.log(
          ctx.strictApprovals
            ? c.yellow('strict approvals ON — every action prompts; read-only classifier disabled')
            : c.dim('strict approvals OFF — provably read-only bash commands auto-approve (still audited)')
        );
        return;
      }
      case '/trust': {
        const arg = rest.trim();
        if (!arg) {
          const cur = ctx.trustLevel || 'strict';
          const d = describeTrustLevel(cur);
          console.log(`${c.bold('trust level')}: ${cur} (${d.name})`);
          console.log(`  ${d.description}`);
          if (d.autoAllowed.length) console.log(`  auto-allowed: ${d.autoAllowed.join(', ')}`);
          if (d.requiresApproval.length) console.log(`  requires approval: ${d.requiresApproval.join(', ')}`);
          return;
        }
        const lower = arg.toLowerCase();
        if (!TRUST_LEVELS.includes(lower)) {
          console.log(c.red(`✗ /trust needs one of ${TRUST_LEVELS.join('|')}, got '${arg}'`));
          return;
        }
        const res = saveTrustLevel(lower);
        if (!res.saved) {
          console.log(c.red(`✗ ${res.error ?? 'failed to save trust level'}`));
          return;
        }
        ctx.trustLevel = lower;
        const d = describeTrustLevel(lower);
        console.log(`${c.green(`✓ trust level set to ${lower} (${d.name})`)}`);
        console.log(`  ${d.description}`);
        console.log(c.dim(`  persisted to ${res.path}`));
        return;
      }
      case '/doctor':
        // The REPL has no argv array in scope here, so the flags come off the
        // rest of the line. `/doctor --json` is the same report the subcommand
        // prints, which is the point: one implementation, two entry points.
        await cmdDoctor(rest.trim() ? rest.trim().split(/\s+/) : []);
        return;
      case '/exit':
      case '/quit':
        await finalizeAndExit();
        return;
      case '/agents': {
        // `/agents` with a VERB is the control surface; `/agents` on its own is
        // the read-only tree. Split here rather than inside the tree renderer so
        // the tree's output stays byte-identical to what it was before cancel and
        // steer existed.
        //
        //   /agents cancel <id>          stop one running subagent
        //   /agents steer  <id> <note>   redirect one running subagent
        //
        // Both resolve against THIS process's control records, which is the same
        // in-process doctrine the registry already follows: an id is live here or
        // it is not, and a descriptor on disk is never treated as proof that
        // anything is running.
        const [verb, ...verbArgs] = rest.trim().split(/\s+/).filter(Boolean);
        const verbLc = String(verb ?? '').toLowerCase();
        // NOT named `target`: the REPL already has a `target` in scope (the bot
        // this session is talking to), and shadowing it here would silently blank
        // the model line of the tree this command re-renders.
        const agentId = verbArgs[0] ?? '';
        if (verbLc === 'cancel' || verbLc === 'steer') {
          if (!agentId) {
            console.log(c.dim(`usage: /agents ${verbLc} <id>${verbLc === 'steer' ? ' <note>' : ''}`));
            console.log(c.dim(`  ${CANCEL_SEMANTICS}.`));
            return;
          }
          if (verbLc === 'cancel') {
            const res = cancelSubagent(agentId, { by: 'operator' });
            if (res.cancelled) console.log(c.yellow(`⚠ ${res.message}`));
            else console.log(c.dim(res.message));
            // The tree is re-rendered either way, because the point of the
            // command is the resulting STATE and reading it from the same
            // snapshot /agents already uses is what keeps the two from disagreeing.
            console.log(
              renderAgentTree({
                cwd: ctx?.cwd ?? config.cwd ?? process.cwd(),
                sessionId: ctx?.sessionId ?? null,
                model: [target?.bot, target?.model].filter(Boolean).join(':') || target?.provider || 'unknown model',
                snapshot: agentSnapshot({ cwd: ctx?.cwd ?? config.cwd ?? process.cwd() }),
                leadStatus: state.busy ? 'working' : null,
              })
            );
            return;
          }
          // steer. The note is the REST of the line, not one token: guidance
          // worth sending is not one word, and an operator who cannot send a
          // sentence will send "stop".
          const note = rest.trim().split(/\s+/).slice(2).join(' ').trim();
          if (!note) {
            console.log(c.dim('usage: /agents steer <id> <note>'));
            console.log(c.dim("  a steering note is queued in the target's mailbox and takes effect at its next turn boundary — it never interrupts a tool call."));
            return;
          }
          const res = steerSubagent(agentId, note, { by: 'operator' });
          if (res.ok) console.log(c.yellow(`⇢ ${res.message}`));
          else console.log(c.red(`✗ ${res.reason}`));
          return;
        }

        // The operator's question is "what is working, on what, and who is in
        // charge", so all three are answered here and nothing else is.
        //
        // The snapshot is the SAME object the live dashboard folds and the
        // terminal's count line is built from. There is no second source of
        // truth to drift: if `/agents` and the dashboard ever disagreed about
        // how many agents are running, one of them would be lying.
        const snapshot = agentSnapshot({ cwd: ctx?.cwd ?? config.cwd ?? process.cwd() });
        const leadStatus = state.busy
          ? 'working'
          : snapshot.activeCount > 0
            ? `working · ${snapshot.activeCount} subagent(s) active`
            : 'idle';
        console.log(
          renderAgentTree({
            cwd: ctx?.cwd ?? config.cwd ?? process.cwd(),
            sessionId: ctx?.sessionId ?? null,
            // The same bot:model shape the REPL header uses, with the
            // undefined cases collapsed rather than rendered as a bare ':'.
            model: [target.bot, target.model].filter(Boolean).join(':') || target.provider || 'unknown model',
            snapshot,
            leadStatus,
          })
        );
        // Only ever shown when there IS something to report. With no active and
        // no stale agents, `renderAgentTree` already said "no subagents
        // running" and a second line about a count of zero is noise.
        if (snapshot.recentFinished?.length) {
          const recent = snapshot.recentFinished.slice(-3).reverse();
          console.log(c.dim(`  recent: ${recent.map((r) => `${r.id} ${r.status} (${r.elapsedMs ?? 0}ms)`).join(' · ')}`));
        }
        if (snapshot.staleCount > 0) {
          console.log(
            c.yellow(
              `  ${snapshot.staleCount} descriptor(s) on disk still say 'running' with no live process — ` +
                'stale, not working (resume with the subagent tool, or clear .agent/_sub)'
            )
          );
        }
        // The cancel controls, plus the ONE qualification that has to travel with
        // them. Printed on every `/agents` with live agents -- not only when
        // someone has cancelled something -- because the moment a control needs
        // explaining is the moment the operator is looking for it.
        if (snapshot.activeCount > 0) {
          console.log(c.dim(`  /agents cancel <id>  ·  /agents steer <id> <note>  ·  ${CANCEL_SEMANTICS}.`));
        }
        return;
      }
      case '/team': {
        if (!rest.trim()) {
          console.log(c.dim('usage: /team <task description>'));
          return;
        }
        console.log(c.bold('orchestrating task with multi-agent team...'));
        for await (const ev of orchestrate({
          task: rest,
          config,
          target,
          cwd: ctx?.cwd,
          hooksConfig: ctx?.hooksConfig,
        })) {
          if (ev.type === 'plan') {
            console.log(c.dim(`plan: ${ev.steps.length} step(s) for goal: ${ev.goal}`));
            for (let i = 0; i < ev.steps.length; i++) {
              const s = ev.steps[i];
              console.log(c.dim(`  ${i + 1}. [${s.agent}] ${s.task}`));
            }
          } else if (ev.type === 'step-end') {
            const mark = ev.ok ? c.green('✓') : c.red('✗');
            console.log(`${mark} [${ev.step.agent}] ${ev.step.task}`);
            if (ev.error) console.log(c.red(`  error: ${ev.error}`));
          } else if (ev.type === 'review') {
            console.log(c.bold('review:'));
            console.log(ev.issues || '(no issues)');
          } else if (ev.type === 'final') {
            console.log(c.green(`✓ done: ${ev.stepsCompleted} step(s) completed`));
          } else if (ev.type === 'error') {
            console.log(c.red(`✗ ${ev.error}`));
          } else if (ev.type === 'warning') {
            console.log(c.yellow(`! ${ev.text ?? ev.message}`));
          }
        }
        return;
      }
      case '/init':
      case '/commit':
      case '/review':
      case '/test':
      case '/explain':
      case '/fix':
      case '/refactor':
      case '/doc':
      case '/migrate': {
        const cmdName = cmd.slice(1); // strip leading /
        const r = await handlePowerCommand(cmdName, rest, { cwd: ctx?.cwd, config });
        if (r.type === 'error') {
          console.log(c.red(`✗ ${r.payload}`));
        } else if (r.type === 'output') {
          console.log(r.payload);
        } else if (r.type === 'injected') {
          // Inject the payload as a user message and run a turn
          await runTurn(r.payload);
        }
        return;
      }
      case '/patterns': {
        const { proceduralStats, recallPatterns } = await import('./procedural-memory.js');
        const stats = proceduralStats({ cwd: ctx?.cwd });
        if (!stats.totalPatterns) {
          console.log(c.dim('no procedural patterns recorded yet — patterns are extracted from past sessions automatically'));
          return;
        }
        console.log(c.bold(`procedural memory: ${stats.totalPatterns} pattern(s) across ${Object.keys(stats.types).length} task type(s)`));
        for (const [t, c] of Object.entries(stats.types)) {
          const total = c.success + c.failed;
          const rate = total ? Math.round((c.success / total) * 100) : 0;
          console.log(`  ${t}: ${c.success} ✓ / ${c.failed} ✗ (${rate}% success)`);
        }
        const recent = recallPatterns({ cwd: ctx?.cwd, limit: 5 });
        for (const p of recent) {
          const mark = p.type === 'success' ? c.green('✓') : c.red('✗');
          console.log(`  ${mark} [${p.date}] (${p.taskType}) ${p.text}`);
        }
        return;
      }
      case '/reflect': {
        try {
          const result = await reflectSession({
            cwd: config.cwd,
            config,
            target,
            sessionSummary: {
              task: messages.length ? String(messages[0]?.content ?? '').slice(0, 200) : '',
              outcome: 'completed',
              events: [],
            },
          });
          console.log(c.green('✓ reflected: ' + result.recorded + ' pattern(s) recorded / ' + result.total + ' total'));
        } catch (err) {
          console.log(c.red('✗ reflection failed: ' + (err?.message ?? err)));
        }
      }
        return;
      case '/osint': {
        const args = rest.trim().split(/\s+/);
        const sub = args[0]?.toLowerCase();
        const target = args.slice(1).join(' ');
        if (!sub || !target) {
          console.log(c.dim('usage: /osint <command> <target>'));
          console.log(c.dim('commands: email, username, domain, ip, breach, shodan, vt, censys, abusedb, github, dns, dorks, footprint, paste, phone, whois, subdomain, url, sanctions'));
          return;
        }
        let result;
        try {
          switch (sub) {
            case 'email': result = await osint.searchEmail(target); break;
            case 'username': result = await osint.searchUsername(target); break;
            case 'domain': result = await osint.searchDomain(target); break;
            case 'ip': result = await osint.searchIP(target); break;
            case 'breach': result = await osint.searchBreach(target); break;
            case 'shodan': result = await osint.searchShodan(target); break;
            case 'vt': result = await osint.searchVirusTotal(target); break;
            case 'censys': result = await osint.searchCensys(target); break;
            case 'abusedb': result = await osint.searchAbuseIPDB(target); break;
            case 'github': result = await osint.searchGitHub(target); break;
            case 'dns': result = await osint.searchDNS(target); break;
            case 'dorks': result = osint.generateDorks(target); break;
            case 'footprint': result = await osint.searchFootprint(target); break;
            case 'paste': result = osint.searchPaste(target); break;
            case 'phone': result = await osint.searchPhone(target); break;
            case 'whois': result = await osint.searchWhois(target); break;
            case 'subdomain': result = await osint.searchSubdomain(target); break;
            case 'url': result = await osint.searchURL(target); break;
            case 'sanctions': result = await osint.sanctionsCheck(target); break;
            default:
              console.log(c.red(`✗ unknown osint command '${sub}'`));
              return;
          }
          if (result.ok) {
            console.log(JSON.stringify(result.data, null, 2));
          } else {
            console.log(c.red('✗ ' + result.error));
          }
        } catch (err) {
          console.log(c.red('✗ ' + (err?.message ?? err)));
        }
        return;
      }
      case '/profile': {
        const args = rest.trim().split(/\s+/);
        const sub = args[0]?.toLowerCase();
        const text = args.slice(1).join(' ');
        const cwd = config.cwd;
        if (!sub) {
          console.log(c.dim('usage: /profile <show|habit|preference|fact|project|task|state> [text]'));
          return;
        }
        try {
          switch (sub) {
            case 'show': {
              const profile = userProfile.loadProfile(cwd);
              const volatile = userProfile.loadVolatile(cwd);
              console.log(userProfile.formatProfileBlock(profile, volatile));
              return;
            }
            case 'habit': {
              if (!text) { console.log(c.dim('usage: /profile habit <text>')); return; }
              const profile = userProfile.loadProfile(cwd);
              if (!profile.habits.includes(text)) profile.habits.push(text);
              userProfile.saveProfile(cwd, profile);
              console.log(c.green('✓ habit added'));
              return;
            }
            case 'preference': {
              if (!text) { console.log(c.dim('usage: /profile preference <text>')); return; }
              userProfile.recordPreference(cwd, text);
              console.log(c.green('✓ preference added'));
              return;
            }
            case 'fact': {
              if (!text) { console.log(c.dim('usage: /profile fact <text>')); return; }
              const profile = userProfile.loadProfile(cwd);
              if (!profile.facts.includes(text)) profile.facts.push(text);
              userProfile.saveProfile(cwd, profile);
              console.log(c.green('✓ fact added'));
              return;
            }
            case 'project': {
              const volatile = userProfile.loadVolatile(cwd);
              volatile.project = text;
              userProfile.saveVolatile(cwd, volatile);
              console.log(c.green('✓ project set'));
              return;
            }
            case 'task': {
              const volatile = userProfile.loadVolatile(cwd);
              volatile.task = text;
              userProfile.saveVolatile(cwd, volatile);
              console.log(c.green('✓ task set'));
              return;
            }
            case 'state': {
              const volatile = userProfile.loadVolatile(cwd);
              volatile.state = text;
              userProfile.saveVolatile(cwd, volatile);
              console.log(c.green('✓ state set'));
              return;
            }
            default:
              console.log(c.red(`✗ unknown profile command '${sub}'`));
          }
        } catch (err) {
          console.log(c.red('✗ ' + (err?.message ?? err)));
        }
        return;
      }
      case '/aas': {
        const parts = rest.trim().split(/\s+/);
        const action = (parts[0] ?? '').toLowerCase();
        const args = parts.slice(1);
        try {
          if (!action || action === 'status') {
            const { scanSkillsDir: scan, mergeCatalogs: merge, AAS_HOSTS: hosts } = await import('./aas-catalog.js');
            const local = scan(config.cwd);
            const catalog = merge(local, []);
            console.log(c.bold('AAS Status'));
            console.log(`  catalog skills: ${catalog.length}`);
            console.log(`  hosts: ${Object.keys(hosts).length}`);
            console.log(c.dim('  /aas search <query> | /aas hosts | /aas install <host> | /aas audit <dir> | /aas mcp'));
            return;
          }
          if (action === 'search') {
            const query = args.join(' ');
            if (!query) {
              console.log(c.red('✗ usage: /aas search <query>'));
              return;
            }
            const { searchAasSkills, scanSkillsDir, mergeCatalogs, AAS_HOSTS } = await import('./aas-catalog.js');
            const catalog = mergeCatalogs(scanSkillsDir(config.cwd), []);
            const results = searchAasSkills(catalog, query);
            if (!results.length) {
              console.log(c.dim(`no matches for '${query}'`));
              return;
            }
            for (const r of results) {
              console.log(`${c.bold(r.id)}  ${c.dim(r.risk)}  ${r.description}`);
            }
            return;
          }
          if (action === 'hosts') {
            console.log(formatHostList());
            return;
          }
          if (action === 'install') {
            const host = args[0];
            if (!host) {
              console.log(c.red('✗ usage: /aas install <host>'));
              return;
            }
            const preview = previewInstall({ host, skills: [] });
            console.log(preview.command);
            if (preview.warnings?.length) {
              for (const w of preview.warnings) console.log(c.yellow(`⚠ ${w}`));
            }
            console.log(c.dim('antigravity: this command modifies the host config — review before running'));
            return;
          }
          if (action === 'audit') {
            const dir = args[0] ?? config.cwd;
            const report = auditSkills([dir]);
            console.log(formatAuditReport(report));
            return;
          }
          if (action === 'mcp') {
            const mcp = new AASCoreMcp();
            console.log('AAS MCP Tools:');
            for (const t of AAS_MCP_TOOLS) {
              console.log(`  ${t.name}: ${t.description}`);
            }
            console.log(c.dim(`max stack size: ${MAX_STACK_SIZE}`));
            return;
          }
          console.log(c.dim(`unknown /aas action '${action}' — try /aas search|hosts|install|audit|mcp|status`));
        } catch (err) {
          console.log(c.red(`✗ ${err?.message ?? err}`));
        }
        return;
      }

      // `/mem [query]` -- bare `/mem` is the tally; `/mem <query>` ranks the
      // store by TF-IDF. The ranker (searchMemory) is the reason the store is
      // worth keeping at all, and until now nothing could reach it: /mem could
      // count entries but never find one, so 87 records sat on disk that no
      // command could look up. Bare `/mem` is unchanged.
      case '/mem': {
        const store = createMemoryStore(config.cwd);
        const query = rest.trim();
        if (query) {
          const hits = store.search(query);
          if (!hits.length) {
            console.log(c.dim(`no memory entry matches ${JSON.stringify(query)}`));
            return;
          }
          console.log(c.bold(`memory: ${hits.length} match(es) for ${JSON.stringify(query)}`));
          for (const h of hits) {
            console.log(`  ${c.dim(`[${h.type}]`)} ${h.content}`);
            console.log(`      ${c.dim(`${h.score.toFixed(3)} · conf ${h.confidence} · ${h.source}`)}`);
          }
          return;
        }
        const stats = store.stats();
        console.log(c.bold(`memory: ${stats.entries} entries`));
        console.log(c.dim(`  types: ${JSON.stringify(stats.byType)}`));
        console.log(c.dim(`  last consolidated: ${stats.lastConsolidated || 'never'}`));
        return;
      }

      // `/learn [session-file]` -- distill a finished session into a verified skill.
      case '/learn': {
        const target = rest.trim() || process.env.OX_SESSION_FILE || '';
        if (!target) {
          console.log(c.dim('usage: /learn [session-file] — distill the latest session into a verified skill'));
          console.log(c.dim('  (session-file: absolute path, or a recent session id/name)'));
          return;
        }
        const abs = target.startsWith('/') ? target : path.resolve(config.cwd, target);
        const result = learnFromSession({ sessionFile: abs });
        if (!result.ok) {
          console.log(`${c.red('✗')} ${result.message}`);
          return;
        }
        console.log(`${c.green('✓ learned')} ${c.bold(result.name)} from ${path.basename(abs)}`);
        console.log(c.dim(`  lesson: "${result.message}"`));
        console.log(c.dim(`  skill:  ${result.file}`));
        return;
      }

      case '/brain': {
        const parts = rest.trim().split(/\s+/);
        const action = (parts[0] ?? '').toLowerCase();
        const topic = parts.slice(1).join(' ');
        if (action === 'research' && topic) {
          // In the chat it is a normal turn, on this session's model.
          const slug = topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'research';
          const file = path.join('.agent', 'research', `${new Date().toISOString().slice(0, 10)}-${slug}.md`);
          await runTurn([
            `Research this topic: ${topic}`,
            'Use web_search to find sources and web_fetch to read at least three primary or authoritative ones.',
            'Write the findings as Markdown with inline citations like [1], a "Sources" list of the URLs you read, and an "Open questions" section.',
            `Save the report with write_file to ${file}, then give me a five-line summary.`,
          ].join('\n'));
          return;
        }
        await runSubcommand('brain', action ? [action, ...parts.slice(1)] : []);
        return;
      }
      case '/kanban': {
        await runSubcommand('kanban', ['list']);
        return;
      }
      case '/gateway': {
        await runSubcommand('gateway', []);
        return;
      }
      case '/heartbeat': {
        // A heartbeat re-enters THIS session, so it is bound to this session's own
        // transcript file rather than to a reference the user has to supply. That
        // is the whole difference from `ox heartbeat start`: same lifecycle, same
        // stop conditions, no path to mistype.
        // The verb is the FIRST token, not the whole rest. `/schedule add 30s test`
        // and `/heartbeat every 5m` are several tokens, and taking all of them as
        // the verb made every verb that takes an argument unreachable — only the
        // bare, argument-less verbs could ever match.
        const parts = rest.trim() ? rest.trim().split(/\s+/) : [];
        const verb = (parts[0] ?? '').toLowerCase();
        const policy = readSchedulePolicy();
        if (!verb || verb === 'status') {
          const beats = listStoreSchedules().filter((x) => x.kind === 'heartbeat' && x.session === session.file);
          console.log(c.bold(`heartbeats on this session (${beats.length})`));
          if (!beats.length) console.log(c.dim('  none — /heartbeat every 5m'));
          for (const b of beats) {
            const state = b.runs >= b.maxRuns ? c.yellow('budget spent') : b.enabled ? c.green('active') : c.dim('disabled');
            console.log(`  ${b.id} ${padCell(b.cadence.description, 16)} ${padCell(`${b.runs}/${b.maxRuns}`, 8)} ${state} cap $${b.maxCostUsd}`);
            if (b.lastRun) console.log(c.dim(`    last: ${b.lastRun.state}${b.lastRun.note ? ` — ${b.lastRun.note}` : ''}`));
          }
          if (state?.goal) {
            const prog = renderGoalReport(state.goal, { terminal: null });
            console.log('');
            console.log(prog);
          } else {
            console.log('');
            console.log(c.dim('no active goal — a heartbeat advances a goal, so /goal <text> first.'));
          }
          if (!policy.optedIn) console.log(c.yellow('  the daemon is not opted in — `ox schedule opt-in`'));
          return;
        }
        if (verb === 'stop' || verb === 'clear' || verb === 'off') {
          const beats = listStoreSchedules().filter((x) => x.kind === 'heartbeat' && x.session === session.file && x.enabled);
          if (!beats.length) { console.log(c.dim('no active heartbeat on this session')); return; }
          for (const b of beats) {
            removeStoreSchedule(b.id);
            console.log(`${c.green('✓')} removed ${b.id} — no timer, no worker, nothing left running`);
          }
          return;
        }
        if (verb === 'help') {
          console.log([
            '/heartbeat                     this session: heartbeat state + goal progress',
            '/heartbeat every <30s|5m|2h>   re-enter this session on an interval and advance its goal',
            '/heartbeat at HH:MM            ...or at a time of day',
            '/heartbeat max-runs <n>        override the run budget (default 3)',
            '/heartbeat stop                remove every heartbeat on this session',
            '',
            'A heartbeat stops when the goal completes, when it is paused, or when its',
            'run budget is spent — so it cannot loop for ever.',
          ].join('\n'));
          return;
        }
        // `/heartbeat every 5m`, `/heartbeat at 09:00`, `/heartbeat max-runs 5`
        const everyIdx = parts.indexOf('every');
        const atIdx = parts.indexOf('at');
        const maxRunsIdx = parts.indexOf('max-runs');
        if (everyIdx === -1 && atIdx === -1 && maxRunsIdx === -1) {
          console.log(c.yellow(`unknown /heartbeat verb '${verb}' — try /heartbeat help`));
          return;
        }
        const cadenceInput = atIdx !== -1
          ? { kind: 'at', at: parts[atIdx + 1] }
          : everyIdx !== -1
            ? (() => { const p = parseScheduleInterval(parts[everyIdx + 1]); return p.refusal ? p : { kind: 'interval', everyMs: p.everyMs }; })()
            : { kind: 'interval', everyMs: 300000 };
        if (cadenceInput.refusal) { console.log(c.red(`✗ ${cadenceInput.refusal}`)); return; }
        if (!state?.goal) {
          console.log(c.yellow('✗ no active goal on this session — `/goal <text>` first. A heartbeat advances a goal; without one it would start unrelated work.'));
          return;
        }
        const made = addStoreSchedule({
          kind: 'heartbeat',
          prompt: `continue the persistent goal: ${state.goal.objective}`,
          cadence: cadenceInput,
          cwd: config.cwd,
          enabled: true,
          session: session.file,
          maxRuns: maxRunsIdx !== -1 ? Number(parts[maxRunsIdx + 1]) : undefined,
          goalBound: true,
        });
        if (made.refusal) { console.log(c.yellow(`✗ ${made.refusal}`)); return; }
        console.log(`${c.green('✓')} heartbeat ${c.bold(made.schedule.id)} on ${c.dim(path.basename(session.file))} — ${made.schedule.cadence.description}`);
        console.log(c.dim(`  goal     ${state.goal.objective}`));
        console.log(c.dim(`  stops    on completion, on pause, or after ${made.schedule.maxRuns} heartbeat(s) · cap $${made.schedule.maxCostUsd} (${made.schedule.costCapSource})`));
        if (!policy.optedIn) console.log(c.yellow('  the daemon is not opted in — `ox schedule opt-in` to let it fire'));
        return;
      }

      case '/cron':
      case '/schedule': {
        // Flags that consume the NEXT token. Anything else starting with `-` is
        // treated as a bare switch, so a flag ox does not know about still
        // reaches the privilege screen instead of being read as prompt text.
        const SCHEDULE_VALUE_FLAGS = new Set(['--every', '--at', '--max-cost', '--cwd', '--bot', '--model', '--max-runs']);
        // `/cron` is the historical name and `/schedule` the real one; both land
        // here. The old listing reported rows from `~/.ox/cron/jobs.json`, a store
        // whose timers were unref'd and whose only callback was `job.handlers?.run`
        // — a property nothing in the repository ever set, so every row ticked its
        // own counter and did nothing. That store is gone; this is the real one.
        // The verb is the FIRST token, not the whole rest. `/schedule add 30s test`
        // and `/heartbeat every 5m` are several tokens, and taking all of them as
        // the verb made every verb that takes an argument unreachable — only the
        // bare, argument-less verbs could ever match.
        const parts = rest.trim() ? rest.trim().split(/\s+/) : [];
        const verb = (parts[0] ?? '').toLowerCase();
        const policy = readSchedulePolicy();
        if (!verb || verb === 'list') {
          const all = listStoreSchedules();
          console.log(c.bold(`schedules (${all.length})`));
          if (!all.length) console.log(c.dim('  none — /schedule add 30m "<prompt>" --enable'));
          for (const s of all) {
            const cap = `$${s.maxCostUsd} ${s.costCapSource}`;
            // One helper, shared with `ox schedule list`: a disabled schedule and
            // an expired one-off get a plain sentence, never a stale timestamp.
            const st = scheduleNextRunStatus(s);
            const tone = st.state === 'disabled' ? c.dim : st.state === 'past' || st.state === 'none' ? c.yellow : c.dim;
            console.log(`  ${s.id} ${padCell(s.kind, 10)} ${s.enabled ? c.green('enabled') : c.dim('disabled')}  ${padCell(s.cadence.description, 16)} ${padCell(cap, 16)} ${tone(st.text)}`);
            console.log(c.dim(`      ${s.prompt}`));
            const lastAt = s.lastRun?.at ? new Date(s.lastRun.at).toISOString().replace('T', ' ').slice(0, 19) : null;
            console.log(c.dim(`      last: ${s.lastRun ? `${lastAt} — ${s.lastRun.state}${s.lastRun.note ? ` — ${s.lastRun.note}` : ''}` : 'never run'}${s.deferrals ? ` · ${s.deferrals} deferred` : ''}${s.misses ? ` · ${s.misses} missed` : ''}`));
          }
          if (!policy.optedIn) {
            console.log('');
            console.log(c.yellow('schedules are OFF for this daemon — `ox schedule opt-in` lets it dispatch anything.'));
          }
          return;
        }
        if (verb === 'add') {
          const everyIdx = parts.indexOf('--every');
          const atIdx = parts.indexOf('--at');
          // `add <cadence> <prompt>` — the bare form. Only consulted when no
          // cadence flag was given, and only the FIRST positional can be one, so
          // a cadence word later in the prompt is never stolen.
          let leadingCadence = null;
          if (atIdx === -1 && everyIdx === -1 && parts[1]) {
            const tok = parseScheduleCadenceToken(parts[1]);
            if (tok) leadingCadence = tok;
          }
          const cadenceInput = atIdx !== -1
            ? { kind: 'at', at: parts[atIdx + 1] }
            : everyIdx !== -1
              ? (() => { const p = parseScheduleInterval(parts[everyIdx + 1]); return p.refusal ? p : { kind: 'interval', everyMs: p.everyMs }; })()
              : leadingCadence ?? {};
          if (cadenceInput.refusal) { console.log(c.red(`✗ ${cadenceInput.refusal}`)); return; }
          // Prompt text is every token that is not a flag, not a flag's value, and
          // not the leading cadence. Walking the tokens is index-free, so an
          // off-by-one cannot quietly eat a word of the prompt.
          const promptParts = [];
          for (let i = leadingCadence ? 2 : 1; i < parts.length; i++) {
            const tok = parts[i];
            if (String(tok).startsWith('-')) {
              if (SCHEDULE_VALUE_FLAGS.has(tok)) i++;
              continue;
            }
            promptParts.push(tok);
          }
          const prompt = promptParts.join(' ').trim();
          const added = addStoreSchedule({
            prompt,
            cadence: cadenceInput,
            cwd: config.cwd,
            enabled: parts.includes('--enable'),
            flags: Object.fromEntries(parts.filter((a) => String(a).startsWith('-')).map((a) => [a.replace(/^--?/, ''), true])),
          });
          if (added.refusal) { console.log(c.yellow(`✗ ${added.refusal}`)); return; }
          console.log(`${c.green('✓')} schedule ${c.bold(added.schedule.id)} — ${added.schedule.cadence.description}`);
          const tail = added.schedule.enabled ? 'enabled' : `disabled — /schedule enable ${added.schedule.id}`;
          console.log(c.dim(`  cap $${added.schedule.maxCostUsd} (${added.schedule.costCapSource}) · ${tail}`));
          const st = scheduleNextRunStatus(added.schedule);
          if (st.state === 'past') console.log(c.yellow(`  ${st.text} — it was stored, but nothing will ever dispatch it`));
          if (!policy.optedIn) console.log(c.yellow('  the daemon is not opted in — `ox schedule opt-in`'));
          return;
        }
        if (['remove', 'rm', 'delete'].includes(verb)) {
          const res = removeStoreSchedule(parts[1]);
          if (!res.removed) { console.log(c.yellow(`✗ ${res.reason}`)); return; }
          console.log(`${c.green('✓')} removed ${res.id} — ${listStoreSchedules().length} left, nothing running`);
          return;
        }
        if (verb === 'enable' || verb === 'disable') {
          const res = updateStoreSchedule(parts[1], { enabled: verb === 'enable' });
          if (res.refusal) { console.log(c.yellow(`✗ ${res.refusal}`)); return; }
          console.log(`${c.green('✓')} ${verb === 'enable' ? 'enabled' : 'disabled'} ${res.schedule.id}`);
          if (verb === 'enable' && !policy.optedIn) console.log(c.yellow('  the daemon is not opted in — `ox schedule opt-in`'));
          return;
        }
        if (verb === 'run-now' || verb === 'run') {
          const id = parts[1];
          if (!id) { console.log(c.red('✗ usage: /schedule run-now <id>')); return; }
          const before = await inspectDaemon();
          let startedDaemon = false;
          if (before.state !== 'running') {
            const started = await startDaemon({ already: before });
            if (!started.started) { console.log(c.red(`✗ could not start the daemon: ${started.reason}`)); return; }
            startedDaemon = true;
          }
          const claim = claimScheduleThroughStore(id, { trigger: 'manual' });
          if (claim.refusal) { console.log(c.yellow(`✗ ${claim.refusal}`)); return; }
          const res = await controlRequestFromCli('schedule-run', { schedule: claim.schedule, trigger: 'manual' }, { timeoutMs: 8000 });
          if (!res.ok) { console.log(c.red(`✗ ${res.error}`)); return; }
          if (startedDaemon) console.log(c.dim('  started a supervisor for this (none was running)'));
          if (res.result?.stopped) { console.log(c.yellow(`heartbeat ${id} did not fire: ${res.result.reason}`)); return; }
          console.log(`${c.green('✓')} dispatched ${id} as worker ${c.bold(String(res.result?.workerId))}`);
          return;
        }
        if (verb === 'opt-in' || verb === 'on') {
          const p = writeSchedulePolicy({ optedIn: true });
          console.log(`${c.green('✓')} the daemon may now dispatch enabled schedules (max ${p.maxInFlight} in flight)`);
          return;
        }
        if (verb === 'opt-out' || verb === 'off') {
          writeSchedulePolicy({ optedIn: false });
          console.log(`${c.green('✓')} the daemon will dispatch nothing`);
          return;
        }
        if (verb === 'help') {
          console.log([
            '/schedule                                 list every schedule with its cap and last result',
            '/schedule add <cadence> "<text>"   cadence = 30s | 5m | 2h | 1d, or an ISO time',
            '                                  (2026-10-04T09:00:00Z) for a one-off',
            '/schedule add "<text>" --every <30s> --at HH:MM   the explicit-flag form, same thing',
            '/schedule enable <id> | /schedule disable <id>',
            '/schedule remove <id> | /schedule remove-all',
            '/schedule run-now <id>                    claim it and dispatch it through the daemon NOW',
            '/schedule opt-in | /schedule opt-out      the daemon-wide switch (OFF until you opt in)',
          ].join('\n'));
          return;
        }
        console.log(c.yellow(`unknown /schedule verb '${verb}' — try /schedule help`));
        return;
      }
      case '/inspect': {
        const report = inspectProject(config.cwd);
        console.log(formatInspect(report));
        return;
      }
      case '/bundles': {
        const mgr = createBundleManager(config.cwd);
        const bundles = listBundles(mgr);
        console.log(c.bold(`skill bundles (${bundles.length})`));
        for (const b of bundles) console.log(`  ${b.name}: ${b.skillCount} skills — ${b.description}`);
        if (!bundles.length) console.log(c.dim('  none defined'));
        return;
      }
      case '/index': {
        const idx = createCodebaseIndex(config.cwd);
        const stats = idx.getIndexStats();
        console.log(c.bold('codebase index'));
        console.log(`  files: ${stats.files}  terms: ${stats.terms}`);
        console.log(c.dim('  rebuild with: ox index build'));
        return;
      }
      case '/refine': {
        console.log(renderRefineCommand(rest, { cwd: config.cwd, color: c }));
        return;
      }
      case '/commands': {
        if (rest) { await runSubcommand('commands', rest.split(/\s+/)); return; }
        const S = await import('./slash-catalog.js');
        let group = '';
        for (const x of S.COMMANDS) {
          if (x.group !== group) { group = x.group; console.log(c.bold(group)); }
          console.log(`  ${x.usage.split(' ')[0].padEnd(13)}${c.dim(x.what)}`);
        }
        const all = [...listCustomCommands({ cwd: config.cwd }).entries()];
        if (all.length) {
          console.log(c.bold('Yours (.claude/commands, plugins)'));
          for (const [name, meta] of all.sort(([a], [b]) => a.localeCompare(b))) console.log(`  /${name}  ${c.dim(meta.source)}`);
        }
        console.log(c.dim('\n/<command> --help for its options · /commands install puts them in Claude Code and Codex too'));
        return;
      }
      case '/self-improve': {
        await runSubcommand('self-improve', rest.trim() ? rest.trim().split(/\s+/) : ['drafts']);
        return;
      }
      default: {
        // Custom commands: Claude Code-format prompt templates from
        // ~/.claude/commands, ./.claude/commands and plugins (/plugin:cmd).
        const custom = listCustomCommands({ cwd: config.cwd }).get(cmd.slice(1));
        if (custom) {
          console.log(c.dim(`· /${cmd.slice(1)} (${custom.source})`));
          await runTurn(await expandLlmsRefs(expandContextRefs(expandCommand(custom.file, rest), config.cwd)));
          return;
        }
        // Every ox command works here too: /browse, /studio, /theme, /library… (src/slash-catalog.js)
        const ox = (await import('./slash-catalog.js')).parse(rawLine);
        if (ox) {
          try { await runSubcommand(ox.cmd.name, ox.args); } catch (e) { console.log(c.red(`✗ ${e?.message ?? e}`)); }
          process.exitCode = 0;
          return;
        }
        console.log(c.dim(`unknown command '${cmd}' — try /help or /commands`));
      }
    }
  }

  // OX Canvas buttons: a bare number presses button N of the last canvas.
  // State changes and query re-runs redraw locally for zero tokens; asks and
  // mutations go back to the agent, so approvals still apply.
  async function pressCanvasButton(n) {
    const canvas = getCanvas(ctx.sessionId);
    const width = canvasWidth(ctx);
    const colors = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
    const action = canvas.render({ width, colors }).actions[n - 1];
    if (!action) return false;
    console.log(c.dim(`· ${action.label}`));
    const out = await canvas.act(action, readOnlyRunner(ctx));
    if (out.rerender) console.log(`\n${canvas.render({ width, colors }).text}\n`);
    if (out.open) console.log(c.dim(`open: ${out.open}`));
    if (out.ask) await runTurn(out.ask);
    else if (out.mutation) {
      await runTurn(`On the canvas I pressed "${action.label}". Run ${out.mutation.tool} with ${JSON.stringify(out.mutation.args)}, then refresh the canvas with show_ui (patch: true).`);
    }
    return true;
  }

  // OX Buddy: a question about the screen, typed (/screen) or spoken in the island.
  async function askBuddy(text, { imagePaths = [], voice = false } = {}) {
    let turn;
    try {
      turn = buddyTurn(text, { imagePaths, voice });
    } catch (err) {
      console.log(c.red(`✗ ${err?.message ?? err}`));
      return;
    }
    if (turn.images.length) console.log(c.dim(`· with your screen (${turn.images.length} image)`));
    await runTurn(text, turn);
  }

  // Lines typed while a turn runs (see rl.on('line') below).
  const queue = [];
  if (opts.ipcServer) {
    opts.ipcServer.on('user-message', function onIslandMessage(msg) {
      const { text, imagePaths, audioPath, voice } = msg;
      if (state.exiting) return;
      if (state.busy) {
        // Queued like typed lines: a spoken question is never lost.
        queue.push(() => onIslandMessage(msg));
        process.stdout.write(`${c.dim(`\n(island question queued: runs when this turn ends)`)}\n`);
        return;
      }
      state.busy = true;
      // Spoken: whisper on the recording when installed, then cleanup and
      // project-name correction (src/dictation.js), before the agent sees it.
      Promise.resolve(voice ? dictate({ text, audioPath, cwd: config.cwd }) : { text, via: null })
        .then((d) => {
          if (audioPath) fs.rm(audioPath, { force: true }, () => {});
          const said = d.text || text;
          process.stdout.write(`\n${c.bold(voice ? '🎙 you (island)' : 'you (island)')} ${said}${d.via === 'whisper' ? c.dim('  · whisper') : ''}\n`);
          return askBuddy(said, { imagePaths, voice });
        })
        .catch((err) => process.stdout.write(`${renderError(err)}\n`))
        .finally(() => {
          state.busy = false;
          if (!state.exiting) afterTurn();
        });
    });
  }

  async function handleInput(line) {
    if (line === '/island' || line.startsWith('/island ')) {
      const { cmdIsland } = await import('./island.js');
      await cmdIsland(line.split(/\s+/).slice(1).length ? line.split(/\s+/).slice(1) : ['status']);
      return;
    }
    if (line === '/screen' || line.startsWith('/screen ')) {
      const q = line.slice('/screen'.length).trim() || 'What am I looking at, and what should I do next?';
      let file;
      try {
        file = captureScreen();
      } catch (err) {
        console.log(c.red(`✗ ${err?.message ?? err}`));
        return;
      }
      await askBuddy(q, { imagePaths: [file] });
      try { fs.unlinkSync(file); } catch {}
      return;
    }
    if (/^\d{1,2}$/.test(line) && hasCanvas(ctx.sessionId) && (await pressCanvasButton(Number(line)))) return;
    if (line === '/ui' || line === '/canvas') {
      if (!hasCanvas(ctx.sessionId)) console.log(c.dim('no canvas yet: ask ox to show you something (a table, chart or dashboard)'));
      else console.log(`\n${getCanvas(ctx.sessionId).render({ width: canvasWidth(ctx), colors: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR }).text}\n`);
      return;
    }
    if (line.startsWith('/')) return slashCommand(line);
    if (line.startsWith('!')) {
      const shellCmd = line.slice(1).trim();
      if (!shellCmd) {
        console.log(c.dim('usage: !<shell command>'));
        return;
      }
      const res = await dispatchTool('bash', { command: shellCmd }, ctx);
      console.log(res.content);
      return;
    }
    // F4: expand @file / @dir/ / @git.diff references before the turn runs
    // (and before the user text is appended to the session).
    await runTurn(await expandLlmsRefs(expandContextRefs(line, config.cwd)));
  }

  if (process.stdout.isTTY && !process.env.OX_NO_BANNER) {
    // Animated particle swarm that converges into the ox mark. `intro()` takes
    // the static-banner path on its own when stdout is not a TTY, NO_COLOR is
    // set, or OX_NO_ANIM=1, so this is safe in every environment.
    //
    // readline already owns stdin by this point, so hold it off for the ~1s of
    // drawing: anything typed while we animate would be swallowed by a 'line'
    // listener that is not attached yet.
    rl.pause();
    try {
      await oxIntro({ small: false });
    } finally {
      rl.resume();
    }
    console.log('');
  }
  console.log(
    `${c.bold(`ox · ${currentBotLabel()}`)} ${c.dim('· /help for commands')} ${c.dim(`· session ${session.id}`)}`
  );
  rl.prompt();

  rl.on('SIGINT', () => {
    const now = Date.now();
    const doublePress = now - state.lastSigintAt < 3000;
    state.lastSigintAt = now;
    if (!state.busy || doublePress) void finalizeAndExit();
    else state.currentAbort?.abort();
  });
  rl.on('close', () => {
    void finalizeAndExit();
  });
  // Type-ahead: a line typed while a turn runs is queued, not dropped, and runs
  // when the turn ends (in order). Ctrl-C stops the current turn; the queue
  // then continues.
  queue.length = 0;
  function runLine(line) {
    state.busy = true;
    Promise.resolve(handleInput(line))
      .catch((err) => {
        process.stdout.write(`${renderError(err)}\n`);
      })
      .finally(() => {
        state.busy = false;
        if (!state.exiting) afterTurn();
      });
  }
  // Every turn (typed, or asked from the island) ends here: run the next
  // queued line, or give the prompt back.
  function afterTurn() {
    const next = queue.shift();
    if (typeof next === 'function') {
      next();
    } else if (next !== undefined) {
      process.stdout.write(`${c.dim(`▸ ${truncate(next, 80)}`)}\n`);
      runLine(next);
    } else {
      rl.prompt();
    }
  }
  rl.on('line', (raw) => {
    const line = raw.trim();
    if (state.exiting) return;
    if (!line) {
      if (!state.busy) rl.prompt();
      return;
    }
    if (state.busy) {
      queue.push(line);
      process.stdout.write(`${c.dim(`\n(queued${queue.length > 1 ? ` ×${queue.length}` : ''}: runs when this turn ends · ctrl-c stops the turn)`)}\n`);
      return;
    }
    runLine(line);
  });
}

// Wave5a A/D: shared resume guards — sandbox pin compatibility check first
// (fail-closed, exit 4), then an optional --rewind <n> applied BEFORE replay.
// Returns true when the caller may proceed.
function applyResumeGuards(sessionFile, { sandboxProfile, rewind } = {}) {
  if (sandboxProfile) {
    try {
      // Status-aware read: an unreadable transcript must not hard-refuse the
      // resume here - the call site reports the degraded load honestly instead.
      // A readable pin still mismatches and refuses as before, and
      // OX_STRICT_READ=1 still throws. A pin we cannot read simply cannot
      // mismatch; the run proceeds and says the history was NOT read.
      const pinned = assertSandboxPinCompatible(loadSessionWithStatus(sessionFile).messages, sandboxProfile.name);
      if (pinned && !!pinned.degraded !== !!sandboxProfile.degraded) {
        process.stderr.write(
          `${c.yellow(`⚠ session was pinned with degraded=${!!pinned.degraded}; this run is degraded=${!!sandboxProfile.degraded}`)}\n`
        );
      }
    } catch (err) {
      process.stderr.write(`${c.red(`✗ ${err?.message ?? err}`)}\n`);
      process.exitCode = err?.exitCode ?? 4;
      return false;
    }
  }
  if (rewind != null) {
    try {
      const pt = rewindTo(sessionFile, rewind);
      console.log(c.dim(`rewound to turn ${pt.id} ('${pt.label}') — conversation-only restore; files on disk were NOT reverted`));
    } catch (err) {
      process.stderr.write(`${c.red(`✗ ${err?.message ?? err}`)}\n`);
      process.exitCode = err?.exitCode ?? 4;
      return false;
    }
  }
  return true;
}

// The subset of a `-p` invocation that a supervised worker must reproduce. Built
// from the PARSED flags rather than from raw argv, so a detached run can never
// inherit an argument that the foreground path would have rejected or that only
// makes sense for the process that prints the result. `--cwd` is deliberately
// absent: the supervisor spawns the worker with `config.cwd` as its cwd, which is
// the same resolved directory `--cwd` would have produced.
function detachPassthrough(flags) {
  const out = [];
  const push = (name, value) => { if (value != null) out.push(value === true ? name : `${name}=${value}`); };
  push('--bot', flags.bot);
  push('--model', flags.model);
  push('--aux-bot', flags.auxBot);
  // `!= null` first: Number(null) is 0, so a bare Number.isFinite check would
  // happily forward `--max-cost=null` to the worker and make every detached run
  // die on an unknown flag.
  if (flags.maxCostUsd != null && Number.isFinite(Number(flags.maxCostUsd))) out.push(`--max-cost=${flags.maxCostUsd}`);
  if (flags.maxMode != null && Number.isFinite(Number(flags.maxMode))) out.push(`--max-mode=${flags.maxMode}`);
  push('--routing', flags.routingStrategy);
  push('--trust', flags.trust);
  push('--sandbox', flags.sandbox);
  if (flags.json) out.push('--json');
  if (flags.verify) out.push('--verify');
  if (flags.yesEdits) out.push('--yes-edits');
  if (flags.yolo) out.push('-y');
  if (flags.plan) out.push('--plan');
  push('--mode', flags.mode);
  push('--agent', flags.agent);
  if (flags.strictApprovals) out.push('--strict-approvals');
  if (flags.sideEffectsOk) out.push('--side-effects-ok');
  if (flags.repoMap) out.push('--repo-map');
  return out;
}

export async function main(argv = []) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  // Incognito: works with any command. Nothing about you is read in and nothing
  // is kept — no transcript (it lives in a temp folder until exit), no memory,
  // no learning, no usage record.
  const incog = args.indexOf('--incognito');
  if (incog >= 0) {
    args.splice(incog, 1);
    process.env.OX_INCOGNITO = '1';
    if (process.stderr.isTTY) process.stderr.write(`${c.dim('◐ incognito — nothing from this session is saved, and ox does not use what it remembers about you')}\n`);
  }
  // F5: `ox sessions resume <id|title-prefix>` is sugar for `ox --resume <ref>`.
  if (String(args[0]).toLowerCase() === 'sessions' && String(args[1] ?? '').toLowerCase() === 'resume') {
    args.splice(0, 2, '--resume');
  }
  if (args.length && !String(args[0]).startsWith('-')) {
    const sub = args[0];
    if (SUBCOMMANDS.has(sub)) {
      await runSubcommand(sub, args.slice(1));
      return;
    }
    const near = closestCommand(sub);
    process.stderr.write(`ox: unknown command '${sub}'${near ? ` (did you mean 'ox ${near}'?)` : ''}\n\n`);
    usage();
    process.exitCode = 3;
    return;
  }
  const flags = {
    json: false,
    cont: false,
    verify: false,
    resume: null,
    bot: null,
    model: null,
    auxBot: null,
    maxCostUsd: null,
    maxMode: null,
    routingStrategy: null,
    orchestrate: false,
    yesEdits: false,
    yolo: false,
    plan: false,
    strictApprovals: false,
    sideEffectsOk: false,
    cwd: null,
    sandbox: null,
    rewind: null,
    selfImprove: false,
    repoMap: false,
    // `--context` => print the per-segment context breakdown and exit (no LLM call)
    contextReport: false,
    trust: null,
    // `--ipc` => true (default socket) | '--ipc=<path>' => that path | null
    ipc: null,
    // `--detach` runs the -p session as a worker under the supervisor and
    // returns immediately. `--daemon-worker <id>` is the INTERNAL inverse: it is
    // what the supervisor adds when it spawns that worker, and it is refused
    // unless a live supervisor with a matching instance id launched this process.
    detach: false,
    daemonWorker: null,
  };
  let print = false;
  const words = [];
  const needValue = (flag, i) => {
    const v = args[i + 1];
    if (v === undefined) {
      process.stderr.write(`ox: ${flag} needs a value\n\n`);
      usage();
      process.exitCode = 3;
      return null;
    }
    return v;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    // `--ipc` and `--ipc=<path>` are handled before the switch because the
    // switch matches whole tokens only. The value form must be `=`: a bare
    // `--ipc <path>` would eat the next argument, which is a prompt word.
    if (a === '--ipc' || String(a).startsWith('--ipc=')) {
      const inline = String(a).slice('--ipc='.length);
      flags.ipc = inline === '' ? true : inline;
      continue;
    }
    if (a === '--daemon-worker' || String(a).startsWith('--daemon-worker=')) {
      const inline = String(a).slice('--daemon-worker='.length);
      flags.daemonWorker = inline === '' ? needValue(a, i) : inline;
      if (flags.daemonWorker === null) return;
      if (inline === '') i++;
      continue;
    }
    if (a === '--detach') {
      flags.detach = true;
      continue;
    }
    switch (a) {
      case '-p':
      case '--print':
        print = true;
        break;
      case '--json':
        flags.json = true;
        break;
      case '-c':
      case '--continue':
        flags.cont = true;
        break;
      case '--resume': {
        const v = needValue(a, i);
        if (v === null) return;
        flags.resume = v;
        i++;
        break;
      }
      case '--bot': {
        const v = needValue(a, i);
        if (v === null) return;
        flags.bot = v;
        i++;
        break;
      }
      // A question about the screen, answered to be spoken with marks drawn over it
      // (src/buddy.js buddyGuidance): the island's screen route passes it.
      case '--buddy':
        flags.buddy = true;
        break;
      // Documented for `ox -p` (and used by the island's "write it for me"), but
      // this loop never took it: `ox -p "…" --image shot.png` printed the help.
      case '--image': {
        const v = needValue(a, i);
        if (v === null) return;
        (flags.images ??= []).push(v);
        i++;
        break;
      }
      case '--model': {
        const v = needValue(a, i);
        if (v === null) return;
        flags.model = v;
        i++;
        break;
      }
      case '--aux-bot':
      case '--auxbot': {
        const v = needValue(a, i);
        if (v === null) return;
        flags.auxBot = v;
        i++;
        break;
      }
      case '--max-cost': {
        const v = needValue(a, i);
        if (v === null) return;
        i++;
        const n = Number(v);
        if (!v.trim() || !Number.isFinite(n) || n < 0) {
          process.stderr.write(`ox: --max-cost needs a finite nonnegative number, got '${v}'\n\n`);
          usage();
          process.exitCode = 3;
          return;
        }
        flags.maxCostUsd = n;
        break;
      }
      case '--max-mode': {
        const v = needValue(a, i);
        if (v === null) return;
        i++;
        const n = Number(v);
        if (!Number.isFinite(n)) {
          process.stderr.write(`ox: --max-mode needs a number (2-5; <=1 disables), got '${v}'\n\n`);
          usage();
          process.exitCode = 3;
          return;
        }
        flags.maxMode = n;
        break;
      }
      case '--routing': {
        const v = needValue(a, i);
        if (v === null) return;
        i++;
        const valid = ['pinned', 'cost', 'quality', 'fast'];
        const lower = String(v).toLowerCase().trim();
        if (!valid.includes(lower)) {
          process.stderr.write(`ox: --routing needs one of ${valid.join('|')}, got '${v}'\n\n`);
          usage();
          process.exitCode = 3;
          return;
        }
        flags.routingStrategy = lower;
        break;
      }
      case '--verify':
        flags.verify = true;
        break;
      case '--yes-edits':
        flags.yesEdits = true;
        break;
      case '--strict-approvals':
        flags.strictApprovals = true;
        break;
      case '--orchestrate':
        flags.orchestrate = true;
        break;
      case '-y':
      case '--dangerously-skip-approvals':
        flags.yolo = true;
        break;
      case '--plan':
        flags.plan = true;
        break;
      case '--agent': {
        const v = needValue(a, i);
        if (v === null) return;
        flags.agent = v;
        i++;
        break;
      }
      case '--mode': {
        const v = needValue(a, i);
        if (v === null) return;
        if (!normalizeMode(v)) { process.stderr.write(`${c.red(`✗ --mode must be one of: auto, ${MODE_NAMES.join(', ')}`)}\n`); process.exitCode = 3; return; }
        flags.mode = normalizeMode(v);
        i++;
        break;
      }
      case '--side-effects-ok':
        flags.sideEffectsOk = true;
        break;
      case '--repo-map':
        flags.repoMap = true;
        break;
      case '--context':
        flags.contextReport = true;
        break;
      case '--self-improve':
        flags.selfImprove = true;
        break;
      case '--sandbox': {
        const v = needValue(a, i);
        if (v === null) return;
        flags.sandbox = v;
        i++;
        break;
      }
      case '--backend': {
        const v = needValue(a, i);
        if (v === null) return;
        flags.backend = v;
        i++;
        break;
      }
      case '--rewind': {
        const v = needValue(a, i);
        if (v === null) return;
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1) {
          process.stderr.write(`ox: --rewind needs a rewind-point number (see /rewind), got '${v}'\n\n`);
          usage();
          process.exitCode = 3;
          return;
        }
        flags.rewind = n;
        i++;
        break;
      }
      case '--cwd': {
        const v = needValue(a, i);
        if (v === null) return;
        flags.cwd = v;
        i++;
        break;
      }
      case '--trust': {
        const v = needValue(a, i);
        if (v === null) return;
        const lower = String(v).toLowerCase().trim();
        if (!TRUST_LEVELS.includes(lower)) {
          process.stderr.write(`invalid trust level "${v}". Valid: ${TRUST_LEVELS.join(', ')}\n`);
          usage();
          process.exitCode = 3;
          return;
        }
        flags.trust = lower;
        i++;
        break;
      }
      case '-h':
      case '--help':
        usage();
        return;
      case '--version':
      case '-v':
        printVersion();
        return;
      default:
        if (String(a).startsWith('-')) {
          process.stderr.write(`ox: unknown flag '${a}'\n\n`);
          usage();
          process.exitCode = 3;
          return;
        }
        if (print) words.push(a);
        else {
          process.stderr.write(`ox: unexpected argument '${a}' (use -p for one-shot prompts)\n\n`);
          usage();
          process.exitCode = 3;
          return;
        }
    }
  }
  const config = loadConfig({
    cwd: flags.cwd ? path.resolve(flags.cwd) : undefined,
    auxBot: flags.auxBot,
    routingStrategy: flags.routingStrategy,
    maxCostUsd: flags.maxCostUsd,
  });
  config.selfImprove = flags.selfImprove;
  // A custom agent supplies the bot, mode and instructions the flags did not.
  if (flags.agent) {
    const agentDef = loadAgent(flags.agent);
    if (!agentDef) {
      process.stderr.write(`${c.red(`✗ no agent '${flags.agent}'`)} — make one with: ox agent new ${flags.agent} --bot <bot> --mode <mode> --prompt "<instructions>"\n`);
      process.exitCode = 3;
      return;
    }
    config.agentDef = agentDef;
    if (!flags.bot && !flags.model) flags.bot = agentBotSpec(agentDef) ?? undefined;
    if (!flags.mode && agentDef.mode) flags.mode = normalizeMode(agentDef.mode) ?? undefined;
  }
  config.repoMap = flags.repoMap || config.repoMap;
  const trustResolved = resolveTrustLevel({ config, env: process.env, flags });
  config.trustLevel = trustResolved.level;
  config.trustSource = trustResolved.source;
  // Wave5a A: resolve the effective sandbox profile up front (fail-closed on
  // bad custom profiles, exit 4 naming file+line) and warn loudly when the OS
  // backend is missing so the run degrades to userspace confinement.
  let sandboxProfile;
  try {
    sandboxProfile = resolveSandbox({ flag: flags.sandbox, config });
  } catch (err) {
    process.stderr.write(`${c.red(`✗ ${err?.message ?? err}`)}\n`);
    process.exitCode = err?.exitCode ?? 4;
    return;
  }
  if (sandboxProfile.kind !== 'off' && sandboxProfile.degraded && sandboxBackendFor(sandboxProfile) === 'none') {
    process.stderr.write(
      `ox: WARNING — no OS sandbox backend (sandbox-exec/bwrap) for profile '${sandboxProfile.name}'; ` +
        'falling back to userspace confinement (degraded)\n'
    );
  }
  // --ipc: bind the GUI bridge for the lifetime of THIS run. It is started
  // before the first model call (a client must be able to attach and be ready
  // for the first approval) and closed on every exit path, SIGINT included.
  let ipcServer = null;
  // OX Island is running: give this run its own socket so it shows up in the
  // notch (and can be approved from there) without the user passing --ipc.
  let forIsland = false;
  if (!flags.ipc && !flags.daemonWorker && islandRunning()) {
    flags.ipc = socketPathFor(`run-${process.pid}`);
    forIsland = true;
  }
  if (flags.ipc) {
    const socketPath = path.resolve(flags.ipc === true ? ipcDefaultSocketPath() : flags.ipc);
    try {
      ipcServer = await startIpcBridge({ socketPath, cwd: config.cwd, spec: flags.bot || flags.model || undefined });
      // The island discovers sockets asynchronously; give it a moment to say
      // 'ready' so the very first approval of a fast run can reach the notch.
      if (forIsland) await waitForReadyClient(ipcServer, 2000);
      // A launcher that starts this run and then connects to it (the phone
      // gateway) asks the run to wait for it, so the first approval reaches
      // that client instead of a terminal nobody is at.
      const waitMs = Number(process.env.OX_IPC_WAIT_CLIENT_MS);
      if (Number.isFinite(waitMs) && waitMs > 0) await waitForReadyClient(ipcServer, Math.min(waitMs, 60_000));
    } catch (err) {
      process.stderr.write(`${c.red(`✗ ${err?.message ?? err}`)}\n`);
      process.exitCode = 4;
      return;
    }
  }
  if (flags.detach && !print) {
    process.stderr.write('ox: --detach runs a -p session in the background (try: ox -p "your task" --detach)\n');
    process.exitCode = 3;
    return;
  }
  if (flags.daemonWorker && flags.ipc) {
    // The worker binds its OWN session socket, and two ipc servers in one run
    // would mean two approval bridges over one loop. Refuse rather than pick.
    process.stderr.write('ox: --daemon-worker manages its own session socket; --ipc cannot be combined with it\n');
    process.exitCode = 3;
    return;
  }
  // --backend (or config "backend"): where the agent's commands run.
  let backend = null;
  try {
    backend = parseBackendSpec(flags.backend ?? config.backend ?? process.env.OX_BACKEND);
  } catch (e) {
    process.stderr.write(`ox: ${e.message}\n`);
    process.exitCode = 3;
    return;
  }
  const opts = {
    ipcServer,
    backend,
    images: flags.images ?? [],
    json: flags.json,
    yolo: flags.yolo,
    verify: flags.verify || config.defaultVerify === true,
    yesEdits: flags.yesEdits,
    planMode: flags.plan,
    mode: flags.mode,
    strictApprovals: flags.strictApprovals,
    maxCostUsd: flags.maxCostUsd,
    maxMode: flags.maxMode,
    bot: flags.bot,
    model: flags.model,
    sideEffectsOk: flags.sideEffectsOk,
    sandbox: sandboxProfile,
    repoMap: flags.repoMap,
    trust: trustResolved.level,
  };
  // `--context`: the non-interactive twin of `/context`. No LLM call is made —
  // it measures the payload a first request WOULD send: the assembled system
  // prompt, the tool-schema array, and any resumed conversation.
  if (flags.contextReport) {
    let ctxTarget;
    try {
      ctxTarget = resolveBot(flags.bot || flags.model || defaultBotSpec(config), config);
    } catch (err) {
      process.stderr.write(`${c.red(`✗ ${err?.message ?? err}`)}\n`);
      process.exitCode = 3;
      return;
    }
    let assembledCtx = null;
    let seeded = [];
    try {
      if (flags.resume) {
        const f = sessionFileFromRef(flags.resume);
        if (f) seeded = replayMessages(loadSessionWithStatus(f).messages);
      } else if (flags.cont) {
        const f = latestSessionFile(config.cwd);
        if (f) seeded = replayMessages(loadSessionWithStatus(f).messages);
      }
      assembledCtx = await assembleCtx({ config, target: ctxTarget, opts });
      const auxForReport = resolveAuxTarget(config);
      const bd = buildContextReport({
        systemPrompt: assembledCtx.systemPrompt,
        messages: seeded,
        tools: listToolSchemas(assembledCtx.ctx),
        window: resolveModelWindow({ model: ctxTarget.model, configWindow: config.modelWindow }),
        model: ctxTarget.model,
        threshold: compactionKnobs(config).compactAt,
      });
      const choice = compactionModelChoice(config, { aux: auxForReport, main: ctxTarget });
      if (flags.json) {
        console.log(
          JSON.stringify({
            t: 'context-breakdown',
            model: ctxTarget.model,
            provider: ctxTarget.provider ?? null,
            source: 'pre-request',
            ...contextBreakdownToJson(bd, {
              compactionModel: choice.model,
              compactionModelSource: choice.source,
              separateCompactionModel: choice.separateFromMain,
            }),
          })
        );
      } else {
        console.log(
          formatContextBreakdown(bd, {
            model: ctxTarget.model,
            compactionModel: choice,
            note: `no request sent — measured from the assembled prompt${seeded.length ? ' + resumed conversation' : ''}`,
          })
        );
      }
    } catch (err) {
      process.stderr.write(`${c.red(`✗ ${err?.message ?? err}`)}\n`);
      process.exitCode = 1;
      return;
    } finally {
      await cleanupCtx(assembledCtx);
    }
    if (ipcServer) await closeIpcBridge();
    return;
  }
  if (print && flags.buddy) {
    const { buddyGuidance, pngSize } = await import('./buddy.js');
    let size = null;
    try { size = pngSize(fs.readFileSync(flags.images?.[0])); } catch {}
    words.push(`\n\n${buddyGuidance({ size, voice: true })}`);
  }
  if (print) {
    let initialMessages = [];
    if (flags.resume) {
      const f = sessionFileFromRef(flags.resume);
      if (!f) {
        process.stderr.write(`${c.red(`✗ no session '${flags.resume}'`)}\n`);
        process.exitCode = 3;
        return;
      }
      if (applyResumeGuards(f, { sandboxProfile, rewind: flags.rewind })) {
        initialMessages = replayMessages(loadSessionWithStatus(f).messages);
      } else {
        return;
      }
    } else if (flags.cont) {
      const f = latestSessionFile(config.cwd);
      if (f) {
        if (applyResumeGuards(f, { sandboxProfile, rewind: flags.rewind })) {
          initialMessages = replayMessages(loadSessionWithStatus(f).messages);
        } else {
          return;
        }
      }
    }
    if (flags.plan && words.join(' ').trim()) {
        // --plan exists so a human reviews the plan before it is applied. On a
        // non-TTY stdin there is no human, and the gate below cannot run: this
        // used to fall through to the else branch, print "non-interactive:
        // continuing with plan", and apply the plan with NO gate at all — a
        // bypass that contradicted src/plan-first.js (which declines a non-TTY
        // stdin unless autoApprove) and read, directly under the
        // "Approve (A) · Edit (E) · Reject (R) · Skip (S)" menu, as though the
        // plan had been checked. Fail closed instead, and fail before the model
        // call so a refused run costs nothing and leaves no saved plan behind.
        //
        // The one way through unattended is the flag the parser actually
        // accepts: -y / --dangerously-skip-approvals. There is no --yolo flag.
        // Without a terminal there is no review, but nothing is applied either:
        // the run below is in plan mode (opts.planMode), where every write and
        // command is refused at dispatch. So the plan is built and saved, the
        // run stays read-only, and the output says nobody reviewed it.
        const unreviewedReadOnly = !process.stdin.isTTY && !flags.yolo;
        let pfTarget;
        try {
          pfTarget = resolveBot(opts.bot || opts.model || defaultBotSpec(config), config);
        } catch (err) {
          process.stderr.write(`${c.red(`✗ ${err?.message ?? err}`)}\n`);
          process.exitCode = 3;
          return;
        }
        console.log(c.dim('building plan...'));
        const planResult = await planFirstBuildPlan({
          task: words.join(' '),
          ctx: {},
          config,
          target: pfTarget,
          cwd: config.cwd,
        });
        console.log(formatPlan(planResult.plan));
        if (process.stdin.isTTY) {
          const review = await interactivePlanReview(planResult.plan, { autoApprove: !!flags.yolo });
          if (review.action === 'reject') {
            console.log(c.dim('plan rejected — exiting'));
            process.exitCode = 4;
            return;
          }
          if (review.action === 'edit') {
            console.log('Edit mode: type your changes');
          }
        } else if (unreviewedReadOnly) {
          console.log(c.yellow('non-interactive: nobody reviewed this plan — it is saved, and the run stays read-only (plan mode), so nothing is changed.'));
          console.log(c.dim('  Review it from a terminal, or run without --plan to carry it out.'));
        } else {
          // -y / --dangerously-skip-approvals: interactivePlanReview would
          // short-circuit, so no gate ran and no human saw this plan. Say that;
          // do not imply a review happened.
          console.log(c.yellow('non-interactive: plan review SKIPPED — no gate ran, nobody approved this plan.'));
          console.log(c.dim('  -y / --dangerously-skip-approvals: tool approvals are skipped too.'));
        }
        savePlan(planResult.plan, { cwd: config.cwd });
      }
      // --daemon-worker: this process WAS spawned by the supervisor. Same run,
      // two additions (a session socket and a transcript); see daemon-worker.js.
      if (flags.daemonWorker) {
        const res = await runDaemonWorker({
          workerId: flags.daemonWorker,
          prompt: words.join(' '),
          config,
          opts,
          initialMessages,
          flags,
        });
        process.exitCode = res.code ?? 0;
        return;
      }
      // --detach: hand the session to the supervisor and return. The supervisor
      // is started here if it is not already up, and startDetachedRun says so
      // rather than letting the run look like it vanished.
      if (flags.detach) {
        const started = await startDetachedRun({
          prompt: words.join(' '),
          cwd: config.cwd,
          passthrough: detachPassthrough(flags),
          bot: flags.bot,
          model: flags.model,
          json: flags.json,
        });
        if (!started.ok) {
          process.stderr.write(`${c.red(`✗ ${started.error}`)}\n`);
          process.exitCode = 1;
          return;
        }
        await reportDetachedRun({
          workerId: started.workerId,
          startedDaemon: started.startedDaemon,
          json: flags.json,
        });
        return;
      }
      await runPrint(words.join(' '), config, opts, initialMessages);
    return;
  }
  await repl(config, opts, flags);
}


