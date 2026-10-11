import {
  readFileTool,
  writeFileTool,
  editFileTool,
  listDirTool,
  globTool,
  grepTool,
} from './fs.js';
import { bashTool } from './exec.js';
import { todoWriteTool } from './todo.js';
import { estimateTokens } from '../context.js';
import { subagentToolSchema, makeSubagentToolHandler } from '../subagent.js';
import {
  open_app, open_url, open_path, open_window, type_text, screenshot, notify,
  OPERATOR_TOOL_SCHEMAS,
} from './operator.js';
import { webFetchTool, webSearchTool, WEB_TOOL_SCHEMAS, WEB_TOOLS } from './web.js';
import { webTaskTool, WEB_TASK_TOOL_SCHEMAS, WEB_TASK_TOOLS } from './web-task.js';
import { critiqueTool, CRITIQUE_TOOL_SCHEMAS, CRITIQUE_TOOLS } from './critique.js';
import { agentMessagingToolSchemas, AGENT_MESSAGE_TOOLS } from '../agent-teams.js';

export const TOOL_IMPLS = {
  read_file: readFileTool,
  write_file: writeFileTool,
  edit_file: editFileTool,
  list_dir: listDirTool,
  glob: globTool,
  grep: grepTool,
  bash: bashTool,
  todo_write: todoWriteTool,
  open_app,
  open_url,
  open_path,
  open_window,
  type_text,
  screenshot,
  notify,
  web_fetch: webFetchTool,
  web_search: webSearchTool,
  critique: critiqueTool,
  web_task: webTaskTool,
};

const PLAN_READ_ONLY = ['read_file', 'list_dir', 'glob', 'grep', 'todo_write'];

export const BUILTIN_SCHEMAS = [
  ...OPERATOR_TOOL_SCHEMAS,
  ...WEB_TOOL_SCHEMAS,
  ...WEB_TASK_TOOL_SCHEMAS,
  ...CRITIQUE_TOOL_SCHEMAS,
  {
    name: 'read_file',
    description:
      'Read a text file from disk. Returns the requested window of content prefixed with the path (relative to the cwd when inside it) and totalLines; output is capped at 100,000 characters with a [truncated] notice.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path; relative paths resolve against the workspace cwd.' },
        offset: { type: 'integer', minimum: 1, description: '1-based line number to start reading from.' },
        limit: { type: 'integer', minimum: 1, description: 'Maximum number of lines to return.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description:
      "Create or overwrite a file with complete new content. Parent directories are created automatically. Overwriting an existing file shows a unified diff and requires user approval unless yolo mode or accept-edits approval is active; brand-new files skip the gate.",
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File to create or overwrite; relative paths resolve against the workspace cwd.' },
        content: { type: 'string', description: 'Complete new file contents.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description:
      "Replace text inside an existing file. Matching is exact-substring first; if there is no exact hit, a whitespace-tolerant fuzzy match is attempted (CRLF and space/tab runs normalized) while untouched regions stay byte-identical. When old_string matches more than once without replace_all:true the tool errors, listing each match's line number — include more surrounding context to disambiguate.",
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File to edit; relative paths resolve against the workspace cwd.' },
        old_string: { type: 'string', description: 'Exact text to replace.' },
        new_string: { type: 'string', description: 'Replacement text.' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence instead of erroring on multiples.' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'list_dir',
    description:
      "Recursive directory tree. Args: path (absolute or relative to the workspace cwd; defaults to the cwd). Skips .git and node_modules, lists directories with a trailing '/', caps output at 500 entries.",
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory to list; relative paths resolve against the workspace cwd.' },
        depth: { type: 'integer', minimum: 0, description: 'Maximum recursion depth (default 2).' },
      },
    },
  },
  {
    name: 'glob',
    description:
      "Find files by pattern. Supports ** (any depth), * (within a segment), ? (single char) and {a,b} alternation. Args: path (absolute or relative search root, defaults to cwd). Skips .git/node_modules, returns sorted paths (relative to cwd when inside it), caps at 1000 results.",
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: "Glob pattern, e.g. '**/*.ts' or 'src/*.{js,mjs}'." },
        path: { type: 'string', description: 'Search root; relative paths resolve against the workspace cwd.' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'grep',
    description:
      "Search file contents with a regular expression. Args: pattern (JS regex source), path (absolute or relative root directory or single file, defaults to cwd). Skips .git, node_modules and binary files; each match renders as 'path:line:text' (path relative to cwd when inside it) with the text capped at 200 chars; caps at 200 matches with a truncation note.",
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression to match.' },
        path: { type: 'string', description: 'File or directory to search; relative paths resolve against the workspace cwd.' },
        include: { type: 'string', description: "Filename glob filter, e.g. '*.md'." },
        ignoreCase: { type: 'boolean', description: 'Case-insensitive matching.' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'bash',
    description:
      "Run a shell command in the workspace via $SHELL -lc. stdout/stderr are captured separately (empty sections omitted) with the combined output capped at 25,000 characters plus a truncation marker; on timeout the process gets SIGTERM then SIGKILL after 3s and isError is set. Non-zero exit codes set isError. ox refuses some destructive commands before execution, reporting why.",
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute.' },
        timeout_ms: { type: 'integer', minimum: 1, description: 'Timeout in milliseconds (default 120000).' },
      },
      required: ['command'],
    },
  },
  {
    name: 'todo_write',
    description:
      "Maintain your ordered task list for the current session; replaces the entire list each call. Each todo needs a non-empty content string and a status; priority is optional. When the status is blocked, blockedReason must say what is blocking it. Returns the rendered checklist with progress counts. Mark an item completed only when real work demonstrates it; an item with no supporting tool call stays unverified.",
    input_schema: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: 'Task description.' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'blocked', 'completed'] },
              blockedReason: { type: 'string', description: 'Required when status is blocked: what is stopping this item.' },
              priority: { type: 'string', enum: ['high', 'medium', 'low'] },
            },
            required: ['content', 'status'],
          },
        },
      },
      required: ['todos'],
    },
  },
];

function normalizeMcpResult(result) {
  if (result == null) return { content: '' };
  if (typeof result === 'string') return { content: result };
  let content;
  if (Array.isArray(result.content)) {
    content = result.content
      .map((c) => (typeof c === 'string' ? c : c?.text ?? c?.data ?? ''))
      .filter(Boolean)
      .join('\n');
  } else if (result.content != null) {
    content = String(result.content);
  } else {
    try {
      content = JSON.stringify(result);
    } catch {
      content = String(result);
    }
  }
  const out = { content: String(content ?? '') };
  if (result.isError === true) out.isError = true;
  return out;
}

export function listToolSchemas(ctx = {}, strictSchemas = false) {
  const strict =
    strictSchemas === true ||
    (strictSchemas === undefined &&
      (ctx?.strictSchemas === true || ctx?.tools?.strictSchemas === true));

  // Subagent contexts pass a pre-filtered tool set via ctx.allTools or
  // ctx.subagentTools. Use it directly to avoid re-adding 'subagent' and to
  // preserve report_result injection.
  if (Array.isArray(ctx.allTools) && ctx.allTools.length > 0) {
    return strict ? ctx.allTools.map((s) => applyStrictSchema(s, true)) : ctx.allTools;
  }
  if (Array.isArray(ctx.subagentTools) && ctx.subagentTools.length > 0) {
    return strict ? ctx.subagentTools.map((s) => applyStrictSchema(s, true)) : ctx.subagentTools;
  }

  let schemas = [...BUILTIN_SCHEMAS];
  if (Array.isArray(ctx.mcpTools)) {
    for (const t of ctx.mcpTools) {
      if (!t || typeof t.name !== 'string') continue;
      const qualified = `mcp__${t.server ?? 'server'}__${t.name}`;
      schemas.push({
        name: qualified,
        description:
          typeof t.description === 'string' && t.description.trim()
            ? `[MCP:${t.server}] ${t.description}`
            : `[MCP:${t.server}] tool '${t.name}' (no description provided by server).`,
        input_schema: t.input_schema ?? t.inputSchema ?? { type: 'object', properties: {} },
      });
    }
  }
  if (ctx.memory && typeof ctx.memory.schemas === 'function') {
    try {
      const extra = ctx.memory.schemas();
      if (Array.isArray(extra)) {
        for (const s of extra) {
          if (s && typeof s.name === 'string' && !schemas.some((x) => x.name === s.name)) {
            schemas.push(s);
          }
        }
      }
    } catch {}
  }
  // Wave 6b: subagent tool — available unless explicitly disabled for this ctx.
  if (ctx.enableSubagents !== false && !schemas.some((x) => x.name === 'subagent')) {
    schemas.push(subagentToolSchema());
  }
  // Agent-to-agent messaging: the mailbox in src/agent-teams.js finally gets a
  // sender and a reader. Available unless explicitly disabled, and only wired when
  // a handler is actually installed on ctx — offering the schemas with nothing
  // behind them is exactly the "a feature that reads as a feature but is not one"
  // defect this wiring exists to close, so the offer follows the handler.
  if (ctx.enableAgentMessaging !== false && typeof ctx.agentTeamsHandler === 'function') {
    for (const s of agentMessagingToolSchemas()) {
      if (!schemas.some((x) => x.name === s.name)) schemas.push(s);
    }
  }
  return strict ? schemas.map((s) => applyStrictSchema(s, true)) : schemas;
}

// Small-model competence guard: keep the tool-schema block inside a fraction
// of the model's context window. Stages: (1) no-op when already under
// budget*0.25; (2) clip descriptions to 160 chars and drop non-required
// input_schema properties; (3) if still over, cap the selection to the core
// priority tools plus as many mcp/memory tools as fit (first-N order).
export const TOOL_PRUNE_PRIORITY = Object.freeze([
  'read_file',
  'edit_file',
  'write_file',
  'bash',
  'grep',
  'glob',
  'list_dir',
  'todo_write',
  'subagent', // delegation primitive — must survive narrowing
  'report_result', // subagent completion signal — must survive narrowing
]);

const PRUNE_DESC_CAP = 160;
const PRUNE_SHARE = 0.25;


// Apply strict mode to a schema without changing which fields are required.
function applyStrictSchema(schema, strict) {
  if (!strict || !schema || typeof schema !== 'object') return schema;
  const field = ['input_schema', 'inputSchema', 'parameters'].find(
    (key) => schema[key] && typeof schema[key] === 'object'
  );
  if (!field) return schema;

  const cloned = JSON.parse(JSON.stringify(schema[field]));
  function makeStrict(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
    if (obj.type === 'object' || (obj.properties && typeof obj.properties === 'object')) {
      obj.additionalProperties = false;
      for (const child of Object.values(obj.properties ?? {})) makeStrict(child);
    }
    if (obj.type === 'array' && obj.items) makeStrict(obj.items);
  }
  makeStrict(cloned);
  return { ...schema, [field]: cloned };
}

function clipDescription(d) {
  const s = String(d ?? '');
  return s.length <= PRUNE_DESC_CAP ? s : `${s.slice(0, PRUNE_DESC_CAP)}…`;
}

export function pruneToolSchemas(schemas, budgetTokens, strict = false) {
  if (!Array.isArray(schemas)) return schemas;
  const list = schemas.filter((s) => s && typeof s === 'object');
  const budget = Number(budgetTokens);
  if (list.length === 0 || !Number.isFinite(budget) || budget <= 0) return schemas;
  const cap = Math.max(8_000, Math.floor(budget)) * PRUNE_SHARE;
  if (estimateTokens(JSON.stringify(list)) <= cap) return schemas;

  // Stage 1: short descriptions + required-only properties.
  const slim = list.map((s) => {
    const is = s.input_schema && typeof s.input_schema === 'object' ? s.input_schema : null;
    let inputSchema = is;
    if (is && is.properties && typeof is.properties === 'object' && Object.keys(is.properties).length > 0) {
      const required = Array.isArray(is.required) ? is.required : [];
      const kept = {};
      for (const k of required) {
        if (is.properties[k] !== undefined) kept[k] = is.properties[k];
      }
      inputSchema = { ...is, properties: kept };
    }
    return { ...s, description: clipDescription(s.description), input_schema: inputSchema };
  });
  if (estimateTokens(JSON.stringify(slim)) <= cap) return slim;

  // Stage 2: core priority tools always survive; remaining slots go to the
  // first mcp/memory tools that still fit.
  const byName = new Map();
  const anonymous = [];
  for (const s of slim) {
    if (typeof s.name === 'string' && s.name && !byName.has(s.name)) byName.set(s.name, s);
    else anonymous.push(s);
  }
  const keep = [];
  for (const name of TOOL_PRUNE_PRIORITY) {
    const s = byName.get(name);
    if (s) {
      keep.push(s);
      byName.delete(name);
    }
  }
  for (const s of [...byName.values(), ...anonymous]) {
    const candidate = [...keep, s];
    if (estimateTokens(JSON.stringify(candidate)) <= cap) keep.push(s);
  }
  return keep;
}

// ---- wave5b H: relevance-based tool-offer narrowing --------------------------
// Selection is a function of the message, not a fixed allowlist. CORE always
// ships; every other group (memory, desktop/operator, mcp/skill) ships only when
// the message carries that group's keyword signal. A cut is refused outright when
// it saves less than NARROW_MIN_SAVING tokens, or when it would drop a tool from
// a group this message is obviously about.

export const NARROW_THRESHOLD = 12;
export const NARROW_FLOOR = 4;
// A lossy cut must buy at least this many tokens or the offer ships unchanged.
export const NARROW_MIN_SAVING = 50;

// CORE: always kept. Same set as the prune priority list, so the delegation
// primitive (subagent) and the subagent completion signal (report_result)
// survive narrowing too.
export const NARROW_CORE_TOOLS = Object.freeze([...TOOL_PRUNE_PRIORITY]);

// Keywords match case-insensitively as whole words; entries of >=5 chars also
// match inflected forms by prefix ("remind" -> "reminded", "screen" ->
// "screenshot"). Entries containing a space match as a padded phrase.
const STEM_MIN = 5;

export const MEMORY_KEYWORDS = Object.freeze([
  'remember', 'recall', 'recalled', 'memories', 'memory', 'note', 'notes',
  'jot', 'save', 'store', 'stores', 'discuss', 'last', 'time', 'previously',
  'known', 'fact', 'facts', 'remind',
]);

// Desktop/operator capability — a group the core coding tools cannot replace.
export const OPERATOR_TOOLS = Object.freeze([
  'open_app', 'open_url', 'open_path', 'open_window', 'type_text', 'screenshot', 'notify',
]);

export const OPERATOR_KEYWORDS = Object.freeze([
  'open', 'launch', 'browse', 'browser', 'url', 'http', 'finder', 'folder',
  'window', 'app', 'type', 'click', 'screenshot', 'screen', 'capture',
  'notify', 'notification', 'remind',
]);

// Network capability - a group the core coding tools cannot replace. NOT core:
// a web tool is relevant to many prompts but not all of them, and both schemas
// ride every turn otherwise. Narrowing is the right lever because it is
// per-message; the prune-priority list is a fixed budget tier and putting them
// there would make them unconditional.
// The list was entirely developer vocabulary (releases, changelogs, CVEs,
// upstream) plus generic web nouns, which left the plain everyday case -- "what
// is the weather" -- with no signal at all and no web tools offered. The last
// row is that gap, closed narrowly.
//
// Deliberately NOT added, because each widens the set of turns that ship two
// extra schemas without adding a web intent this list did not already cover:
//   score, stock, definition, price -- collide with this agent's own working
//     vocabulary ("relevance score", "tool definitions"), so they would fire on
//     coding prompts rather than on web prompts;
//   what is / how to -- match nearly every prompt there is.
export const WEB_KEYWORDS = Object.freeze([
  'web', 'search', 'google', 'lookup', 'searching', 'url', 'link', 'links',
  'page', 'website', 'online', 'internet', 'docs', 'documentation', 'browse',
  'fetch', 'latest', 'current', 'version', 'versions', 'release', 'releases',
  'notes', 'changelog', 'api', 'reference', 'cve', 'vulnerability',
  'advisory', 'issue', 'issues', 'github', 'stackoverflow', 'overflow',
  'news', 'article', 'articles', 'blog', 'quote', 'citation', 'cite', 'source',
  'upstream', 'published', 'announcement', 'postmortem',
  // Everyday asks that only the network can answer. All >= STEM_MIN, so the
  // inflected forms land too ("forecasts", "recipes", "translated").
  'weather', 'forecast', 'temperature', 'recipe', 'translate', 'wikipedia',
  'directions',
]);

export const WEB_TASK_KEYWORDS = Object.freeze([
  'task', 'tasks', 'book', 'booking', 'schedule', 'scheduling',
  'fill', 'filling', 'form', 'forms', 'order', 'ordering',
  'reserve', 'reservation', 'purchase', 'buy', 'checkout',
  'automate', 'automation', 'browser', 'webtask', 'web_task',
]);

// Agent-to-agent messaging - a group nothing else on this offer can replace: no
// file, socket or HTTP call reaches another agent's context, because the mailbox
// IS the channel.
//
// NOT core, and deliberately so. src/agent-teams.js was left out of
// TOOL_PRUNE_PRIORITY / NARROW_CORE_TOOLS on purpose, so these two schemas ride
// this keyword group exactly like memory_*, operator, web and critique do: they
// ship on a turn that is about agents, and are withheld on a turn that is not.
// Adding them to the core set instead would put two schemas on every prompt in
// the codebase to serve a capability most turns have no use for.
export const AGENT_KEYWORDS = Object.freeze([
  'agent', 'agents', 'subagent', 'subagents', 'teammate', 'teammates',
  'mailbox', 'message', 'messages', 'msg', 'steer', 'steering', 'coordinate',
  'coordinating', 'collaborate', 'handoff', 'hand-off', 'peer', 'peers',
  'worker', 'workers', 'lead', 'orchestrate', 'orchestrating',
  // Delegation vocabulary. `subagent` is a CORE tool, so a turn that says
  // "delegate this" is ALWAYS about spawning a worker -- which is exactly the
  // turn where the lead is about to need an address to message it, and the turn
  // where the mailbox being withheld would make a working feature look broken.
  'delegate', 'delegates', 'delegated', 'delegating', 'delegation',
  'spawn', 'spawns', 'spawned', 'spawning',
]);

// Cross-model review - a group the core coding tools cannot replace, and one
// that costs a second paid call. NOT core, for two reasons: it is relevant to
// review-ish prompts rather than every prompt, and unlike a web tool it SPENDS
// MONEY on every invocation. Carrying it on every turn would offer an
// expensive action that most turns have no use for.
export const CRITIQUE_KEYWORDS = Object.freeze([
  'critique', 'critic', 'critiques', 'second opinion', 'second-opinion',
  'review', 'reviewed', 'reviews', 'reviewing', 'reviewer',
  'wrong', 'mistake', 'mistakes', 'bug', 'bugs', 'buggy', 'defect', 'defects',
  'incorrect', 'broken', 'sanity', 'sanity-check', 'double-check', 'recheck',
  'second-guess', 'peer', 'independent', 'adversarial', 'audit',
  'assume', 'assumption', 'assumptions', 'verify', 'verified',
]);

// Returns the keyword that fired, or null. Whole-word match, plus prefix match
// for long keywords so morphology ("discussed", "screenshot") still lands.
function keywordSignal(message, keywords) {
  const text = String(message ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (!text) return null;
  const padded = ` ${text} `;
  const words = text.split(' ');
  for (const kw of keywords) {
    if (kw.includes(' ')) {
      if (padded.includes(` ${kw} `)) return kw;
      continue;
    }
    for (const w of words) {
      if (w === kw) return kw;
      if (kw.length >= STEM_MIN && w.length > kw.length && w.startsWith(kw)) return kw;
    }
  }
  return null;
}

const STOPWORDS = new Set([
  'this', 'that', 'with', 'from', 'your', 'have', 'when', 'what', 'will',
  'would', 'could', 'should', 'been', 'were', 'their', 'them', 'then',
  'than', 'they', 'these', 'those', 'into', 'also', 'only', 'over',
  'under', 'about', 'which', 'there', 'where', 'just', 'like', 'more',
  'most', 'many', 'much', 'very', 'some', 'such', 'each', 'here', 'being',
  'does', 'doing', 'done', 'want', 'need', 'must', 'make', 'made', 'using',
  'used', 'uses',
]);

export function significantKeywords(text) {
  const seen = new Set();
  const out = [];
  for (const raw of String(text ?? '').toLowerCase().split(/[^a-z0-9_-]+/)) {
    if (raw.length < 4 || STOPWORDS.has(raw) || seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

function indexEntries(skillIndex) {
  return String(skillIndex ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('-'))
    .map((l) => l.replace(/^-\s*/, ''));
}

// Tools declared by relevant skills: a skill-index line earns its match when it
// either NAMES an available tool or shares >=2 significant keywords with the
// message. The two are alternatives — requiring both meant only keyword-stuffed
// index lines ever unlocked anything, and MCP tools were dropped ~always.
export function relevantSkillToolNames({ skillIndex = '', message = '', available = [] } = {}) {
  const msgKw = significantKeywords(message);
  if (!msgKw.length) return [];
  const avail = new Set((Array.isArray(available) ? available : []).filter(Boolean));
  const msgSet = new Set(msgKw);
  const out = new Set();
  for (const entry of indexEntries(skillIndex)) {
    const searchable = entry.replace(/\(read path[^)]*\)\s*$/, '');
    const declared = searchable.toLowerCase().split(/[^a-z0-9_-]+/).filter((w) => avail.has(w));
    const shared = significantKeywords(searchable).filter((k) => msgSet.has(k)).length;
    if (!declared.length && shared < 2) continue;
    for (const w of declared) out.add(w);
  }
  return [...out];
}

// True when the candidate cut would drop a tool from a group this message is
// about. Such a cut is refused — a dropped tool the request needs is silently
// unsatisfiable, which is worse than carrying the bytes.
function dropsRelevantTool(schemas, filtered, { memoryOn, operatorOn, webOn, webTaskOn, critiqueOn, agentOn, skillNames }) {
  const kept = new Set(filtered.map((s) => s?.name));
  const skillSet = new Set(skillNames);
  for (const s of schemas) {
    const n = s?.name;
    if (typeof n !== 'string' || kept.has(n)) continue;
    if (memoryOn && n.startsWith('memory_')) return true;
    if (operatorOn && OPERATOR_TOOLS.includes(n)) return true;
    if (webOn && WEB_TOOLS.includes(n)) return true;
    if (webTaskOn && WEB_TASK_TOOLS.includes(n)) return true;
    if (critiqueOn && CRITIQUE_TOOLS.includes(n)) return true;
    if (agentOn && AGENT_MESSAGE_TOOLS.includes(n)) return true;
    if (skillSet.has(n)) return true;
  }
  return false;
}
export function narrowToolSchemas(schemas, { message = '', relevantSkillTools, strict = false } = {}) {
  if (!Array.isArray(schemas)) return schemas;
  if (schemas.length <= NARROW_THRESHOLD) return schemas;
  const names = schemas.map((s) => s?.name).filter((n) => typeof n === 'string');
  const skillNames =
    typeof relevantSkillTools === 'string'
      ? relevantSkillToolNames({ skillIndex: relevantSkillTools, message, available: names })
      : (Array.isArray(relevantSkillTools) ? relevantSkillTools : []).filter((t) => typeof t === 'string');
  const memoryOn = keywordSignal(message, MEMORY_KEYWORDS) !== null;
  const operatorOn = keywordSignal(message, OPERATOR_KEYWORDS) !== null;
  const webOn = keywordSignal(message, WEB_KEYWORDS) !== null;
  const webTaskOn = keywordSignal(message, WEB_TASK_KEYWORDS) !== null;
  const critiqueOn = keywordSignal(message, CRITIQUE_KEYWORDS) !== null;
  // `agentOn` keeps the mailbox for a LEAD whose own turn is about agents. A
  // SUBAGENT needs it unconditionally, and the offer says which one this is:
  // report_result is injected by runSubagent and is subagent-only (it is absent
  // from every main-path offer), so its presence identifies the offer.
  //
  // The reason is not convenience. A subagent's task text was written by the
  // PARENT, so it almost never contains an agent keyword -- "check the migration"
  // mentions nothing about mailboxes -- and a keyword cut would withhold the
  // mailbox from precisely the workers that were spawned to be messaged. A worker
  // that structurally cannot see the mailbox it is meant to poll is the same
  // unreachability defect as having no mailbox at all. The cost is two schemas on
  // a subagent turn, which runSubagent's `always` set already pays for.
  const isSubagentOffer = names.includes('report_result');
  const agentOn = isSubagentOffer || keywordSignal(message, AGENT_KEYWORDS) !== null;
  const keep = new Set(NARROW_CORE_TOOLS);
  for (const t of skillNames) keep.add(t);
  for (const n of names) {
    if (memoryOn && n.startsWith('memory_')) keep.add(n);
    if (operatorOn && OPERATOR_TOOLS.includes(n)) keep.add(n);
    if (webOn && WEB_TOOLS.includes(n)) keep.add(n);
    if (webTaskOn && WEB_TASK_TOOLS.includes(n)) keep.add(n);
    if (critiqueOn && CRITIQUE_TOOLS.includes(n)) keep.add(n);
    if (agentOn && AGENT_MESSAGE_TOOLS.includes(n)) keep.add(n);
  }
  const filtered = schemas.filter((s) => typeof s?.name === 'string' && keep.has(s.name));
  if (filtered.length < NARROW_FLOOR) return schemas;
  if (filtered.length === schemas.length) return schemas;
  if (dropsRelevantTool(schemas, filtered, { memoryOn, operatorOn, webOn, webTaskOn, critiqueOn, agentOn, skillNames })) return schemas;
  const saved =
    estimateTokens(JSON.stringify(schemas)) - estimateTokens(JSON.stringify(filtered));
  if (saved < NARROW_MIN_SAVING) return schemas;
  if (strict) return filtered.map(s => applyStrictSchema(s, true));
  return filtered;
}

export async function dispatchTool(name, args, ctx = {}) {
  try {
    if (typeof name !== 'string' || name === '') {
      return { content: 'dispatchTool: a tool name is required.', isError: true };
    }
    const planMode = (ctx?.approval ?? 'default') === 'plan';
    if (planMode && !PLAN_READ_ONLY.includes(name)) {
      return {
        content: `${name}: plan mode is read-only. Toggle plan mode off to run this tool.`,
        isError: true,
      };
    }
    if (name.startsWith('memory_')) {
      if (typeof ctx?.memory?.dispatch !== 'function') {
        return { content: `${name}: memory subsystem unavailable in this context.`, isError: true };
      }
      const raw = await ctx.memory.dispatch(name, args ?? {});
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const out = { content: String(raw.content ?? '') };
        if (raw.isError === true) out.isError = true;
        return out;
      }
      return { content: String(raw ?? '') };
    }
    if (name.startsWith('mcp__')) {
      if (typeof ctx?.mcpCall !== 'function') {
        return { content: `${name}: MCP unavailable — no MCP client is connected.`, isError: true };
      }
      const raw = await ctx.mcpCall(name, args ?? {}, ctx);
      return normalizeMcpResult(raw);
    }
    // Wave 6b: subagent delegation — spawn a nested agent loop.
    if (name === 'subagent') {
      if (typeof ctx?.subagentHandler !== 'function') {
        return { content: 'subagent: subagent support is not configured in this context.', isError: true };
      }
      return ctx.subagentHandler(args ?? {}, ctx);
    }
    // Agent-to-agent messaging. Routed through a ctx handler for the same reason
    // `subagent` is: these tools have no business being a bare impl, because who
    // is calling is the load-bearing part of the call. The handler derives the
    // sender and the mailbox from ctx, so the model cannot address a mailbox that
    // is not its own by any argument it can pass.
    if (name === 'agent_message.send' || name === 'agent_observe') {
      if (typeof ctx?.agentTeamsHandler !== 'function') {
        return { content: `${name}: agent-to-agent messaging is not configured in this context.`, isError: true };
      }
      return ctx.agentTeamsHandler(name, args ?? {}, ctx);
    }
    // Wave 6b: subagent completion signal — report_result is intercepted by the
    // subagent loop; here it just acknowledges so the model can finish cleanly.
    // The output is written into the mutable _resultBox on ctx (by reference —
    // survives the toolCtx shallow-copy) so the enclosing subagent loop can
    // capture it (the tool-end event does not carry result content).
    if (name === 'report_result') {
      const output = args?.output ?? '';
      if (ctx && ctx._resultBox) ctx._resultBox.output = String(output);
      return { content: JSON.stringify({ reported: true, output: String(output).slice(0, 4000) }) };
    }
    const impl = TOOL_IMPLS[name];
    if (!impl) {
      return {
        content: `Unknown tool '${name}'. Available tools: ${Object.keys(TOOL_IMPLS).join(', ')}.`,
        isError: true,
      };
    }
    const result = await impl(args ?? {}, ctx ?? {});
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      const out = { content: String(result.content ?? '') };
      if (result.isError === true) out.isError = true;
      if (result.meta !== undefined) out.meta = result.meta;
      // Forwarded, not recomputed here: the tool knows which path it resolved
      // and wrote, and re-deriving it from `args.path` in the dispatcher would
      // report the ARGUMENT rather than the file. This is what finally puts a
      // real path on the tool-end event, and so into a subagent's
      // filesTouched accumulator, which had been reading a field nothing wrote.
      if (Array.isArray(result.filesTouched) && result.filesTouched.length) {
        out.filesTouched = [...result.filesTouched];
      }
      return out;
    }
    return { content: String(result ?? '') };
  } catch (e) {
    return { content: String((e && e.message) || e), isError: true };
  }
}
