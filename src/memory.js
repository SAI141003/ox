import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendJsonlCapped, auditEnabled, auditFilePath } from './audit.js';
// The loss ledger: one append-only row per archived / evicted / refused artefact.
// See src/memory-loss.js for why the ARCHIVE primitives live here instead (they
// need screenPersistText) and why this module holds no dependency on us.
import {
  recordLoss,
  agentOverflowDir,
  projectKeyFor,
  lossLedgerPath,
  readLossLedger,
  formatLossReport,
  lossStats,
  resetLossStats,
  ARCHIVE_ROOT,
} from './memory-loss.js';

export const MEMORY_DIR = '.agent';
export const MEMORY_INDEX = 'MEMORY.md';
export const MAX_INDEX_LINES = 150;
export const MAX_INDEX_BYTES = 20 * 1024;
export const MAX_EPISODE_LINES = 40;
export const MAX_AGENT_DIR_BYTES = 500 * 1024;
export const MAX_CHECKPOINTS = 20;
export const MAX_CHECKPOINT_LINES = 60;

const MEMORY_TYPES = ['user', 'feedback', 'project', 'lesson'];
const ENTRY_RE = /^(?:\[(\d{4}-\d{2}-\d{2})\])?\[(user|feedback|project|lesson)\]\s*(.+?)(?:\s*->\s*(topics\/[^\s]+))?\s*$/;
const DATE_PREFIX_RE = /^\[(\d{4}-\d{2}-\d{2})\]/;
const SEARCH_RESULT_CAP = 30;

function err(message) {
  return { content: message, isError: true };
}

function ok(content) {
  return { content };
}

// ---- persistence screen (credentials + injection payloads) ----------------
// `.agent/MEMORY.md` is re-injected into EVERY prompt (loadMemoryBlock ->
// buildSystemPrompt), so anything stored here is permanent and replayable. Two
// classes of content are refused outright:
//
//   1. credentials -- a pasted key would be persisted forever and echoed back
//      into every future turn and every transcript sharing the repo.
//   2. prompt-injection payloads -- a poisoned memory replays its instruction
//      on every later turn.
//
// Both checks are deliberately high-confidence: a pattern fires only on a
// credential SHAPE (known provider prefix, JWT, PEM block, long bearer token,
// or a secret-ish name bound to a long opaque value), never on a bare keyword.
// Statements that only NAME a credential ("the api key lives in the vault") and
// ordinary prose that happens to use a loaded word ("the tokenizer splits on
// whitespace") stay storable. Rejections name the pattern class and never echo
// the offending text back to the caller.
// A value bound to a secret-ish name only counts as a credential when it looks
// RANDOM. Without this gate the assignment pattern eats ordinary engineering
// prose: "the token = config.getToken()", "password: process.env.DB_PASSWORD",
// "the api key is OPENAI_API_KEY", "the token count is 4096". Real pasted
// secrets are long and either carry digits or are long opaque runs; code
// references, ENV names and bare numbers are not.
function looksOpaqueCredentialValue(v) {
  const s = String(v ?? '');
  if (s.length < 12) return false;
  if (/^[0-9]+$/.test(s)) return false; // a budget, a count, a unix timestamp
  if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(s)) return false; // ENV_VAR_NAME
  if (/^[A-Z][A-Z0-9]{11,}$/.test(s)) return false; // SCREAMING_CONSTANT / placeholder
  if (/^[a-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(s)) return false; // process.env.FOO
  if (/^[a-z]+(?:-[a-z]+)+$/.test(s)) return false; // hyphenated English ("well-known")
  if (/\d/.test(s) && s.length >= 16) return true; // 9f8b7a6c5d4e3f2a1b0c9d8e7f6a5b4c3d
  if (s.length >= 20) return true; // opaque alphabetic run
  return false;
}

// `sk-` tails are hyphenated too, so a year in a hyphenated slug can look like
// a key ("sk-learning-platform-2024-notes-2024"). Require the FINAL
// dash-separated segment to be a long opaque run carrying a digit.
function providerKeyTailOk(m) {
  const tail = String(m?.[1] ?? '');
  const seg = tail.slice(tail.lastIndexOf('-') + 1);
  return seg.length >= 16 && /\d/.test(seg) && /[A-Za-z]/.test(seg);
}

// Same idea for `Bearer <value>`: prose after the word "bearer" is lowercase
// English, a real token is not.
function bearerValueOk(m) {
  const v = String(m?.[1] ?? '');
  return /\d/.test(v) || (/[a-z]/.test(v) && /[A-Z]/.test(v));
}

const SECRET_PATTERNS = [
  // sk- family (OpenAI / OpenRouter / Anthropic). A digit inside the tail is
  // required, which keeps hyphenated English ("sk-learn-the-library") out.
  {
    label: "a provider API key (an 'sk-' key)",
    re: /\bsk-(?:or-v1-|ant-api\d{2}-|proj-)?([A-Za-z0-9_-]{20,})/,
    guard: providerKeyTailOk,
  },
  { label: 'a GitHub token (ghp_/gho_/ghu_/ghs_/ghr_ or github_pat_)', re: /\b(?:gh[pours]_|github_pat_)[A-Za-z0-9_]{30,}/ },
  { label: 'a GitLab personal access token (glpat-)', re: /\bglpat-[A-Za-z0-9_-]{20,}/ },
  { label: 'a Google API key (AIza...)', re: /\bAIza[0-9A-Za-z_-]{30,}/ },
  { label: 'an AWS access key id (AKIA/ASIA...)', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { label: 'a Groq API key (gsk_...)', re: /\bgsk_[A-Za-z0-9]{20,}/ },
  { label: 'an xAI API key (xai-...)', re: /\bxai-[A-Za-z0-9]{20,}/ },
  { label: 'a JSON Web Token (eyJ...header.payload.signature)', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { label: 'a PEM private key block', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  {
    label: 'an Authorization bearer token',
    re: /\bBearer\s+([A-Za-z0-9._~+/=-]{20,})/i,
    guard: bearerValueOk,
  },
  {
    label: 'a secret assigned inline (a secret-ish name bound to a long opaque value)',
    re: /\b(?:api[\s_-]?keys?|apikeys?|secret[\s_-]?keys?|secrets?|access[\s_-]?keys?|auth[\s_-]?tokens?|access[\s_-]?tokens?|refresh[\s_-]?tokens?|session[\s_-]?tokens?|bearer[\s_-]?tokens?|client[\s_-]?secrets?|private[\s_-]?keys?|passwords?|passwd|pwd|tokens?)\b\s*(?:[:=]|\bis\b|\bwas\b)\s*["'`]?([A-Za-z0-9_./+=-]{12,})/i,
    guard: (m) => looksOpaqueCredentialValue(m?.[1]),
  },
];

const INJECTION_PATTERNS = [
  {
    label: 'a prompt-injection instruction ("ignore previous instructions")',
    re: /\bignore\s+(?:all\s+|any\s+)?(?:of\s+)?(?:the\s+)?(?:previous|prior|above|earlier|preceding|foregoing)\s+(?:instructions?|prompts?|rules?|directions?|messages?|context)\b/i,
  },
  {
    label: 'a prompt-injection instruction ("disregard your ...")',
    re: /\bdisregard\s+(?:all\s+|any\s+)?(?:of\s+)?your\s+(?:previous\s+|prior\s+|original\s+|earlier\s+|system\s+)?(?:instructions?|rules?|guidelines?|directives?|training|programming|purpose)\b/i,
  },
  { label: 'a prompt-injection instruction ("system prompt:")', re: /\bsystem\s+prompt\s*:/i },
  {
    // "you are now" alone is ordinary prose ("you are now able to run the
    // suite"); the injection form is always a role/mode handover, so require
    // the article or the preposition that introduces one.
    label: 'a prompt-injection instruction ("you are now ...")',
    re: /\byou\s+are\s+now\s+(?:an?\s+|in\s+|operating\s+|running\s+|acting\s+|role[\s-]?playing\s+|playing\s+)/i,
  },
];

// Returns null when the text is safe, otherwise `{ kind, label }` describing the
// class that matched. The offending text is never included, so a caller can
// surface the reason without leaking the secret into the transcript.
export function screenMatch(text) {
  const s = String(text ?? '');
  if (!s.trim()) return null;
  for (const { re, label, guard } of SECRET_PATTERNS) {
    const m = s.match(re);
    if (m && (!guard || guard(m))) return { kind: 'secret', label };
  }
  for (const { re, label, guard } of INJECTION_PATTERNS) {
    const m = s.match(re);
    if (m && (!guard || guard(m))) return { kind: 'injection', label };
  }
  return null;
}

// Returns null when the text is safe to persist, otherwise an actionable
// reason that names the pattern class. `field` is only used for wording; the
// matched text is never included, so the caller cannot leak the secret back
// into the transcript by logging this message.
//
// `store` names the artefact the text would land in, so a refusal points at the
// file the caller actually wrote instead of always blaming .agent/MEMORY.md. It
// is a NOUN PHRASE for the one shared sentence below, not a second message: the
// pattern tables stay the single source of truth and no other module re-derives
// this wording. The default keeps the .agent/MEMORY.md refusal byte-identical to
// what it has always been.
export function screenPersistText(text, field = 'statement', store = '.agent/MEMORY.md') {
  const hit = screenMatch(text);
  if (!hit) return null;
  if (hit.kind === 'secret') {
    return (
      `refusing to store: the ${field} looks like it contains ${hit.label}. ` +
      `${store} is re-injected into every prompt, so a stored credential would be replayed forever. ` +
      'Store a pointer to where it lives instead (e.g. "the OpenAI key lives in the vault"), never the value.'
    );
  }
  return (
    `refusing to store: the ${field} looks like it contains ${hit.label}. ` +
    'Persisted memory is replayed into every future turn, so instruction-shaped text is refused here.'
  );
}

// ---- read-side screening ---------------------------------------------------
// The write screen only protects memories written AFTER it shipped. Entries
// pasted into `.agent/MEMORY.md` before it existed are still on disk, still
// re-injected every turn by loadMemoryBlock, and still leak. So the SAME
// screen is applied to every read.
//
// Behaviour for a failing entry: SKIP it, never inject it, never echo it --
// and never rewrite or delete the file. Deleting is not ours to do: the user
// may want to inspect what was stored, and a read path that mutates state
// makes the audit log lie. Read-time filtering is the safe choice.
//
// A skip is never silent: the withheld count is returned in the rendered
// block/result, counted in `memoryScreenStats()`, and appended to the OX_AUDIT
// JSONL ledger (`t: 'memory-screen'`), which is the existing debug channel.
const screenStats = { withheld: 0, reads: 0 };

export function memoryScreenStats() {
  return { withheld: screenStats.withheld, reads: screenStats.reads };
}

export function resetMemoryScreenStats() {
  screenStats.withheld = 0;
  screenStats.reads = 0;
}

function recordReadScreen(source, where, count) {
  screenStats.reads += 1;
  if (!count) return;
  screenStats.withheld += count;
  try {
    if (auditEnabled()) {
      appendJsonlCapped(auditFilePath(), {
        ts: new Date().toISOString(),
        t: 'memory-screen',
        event: 'read-withheld',
        where: String(where ?? ''),
        source: String(source ?? ''),
        count,
      });
    }
  } catch {}
}

function withheldNotice(count, source) {
  return (
    `[memory-screen] withheld ${count} line${count === 1 ? '' : 's'} from ${source}: ` +
    'credential or prompt-injection shape, screened on read. ' +
    'The file on disk is UNCHANGED and was not shown here -- inspect and remove it yourself.'
  );
}

// Short form of the same notice, for prompts that carry it on EVERY call and
// cannot afford the long main-path wording (the subagent system prompt). Same
// facts: a count, the reason class, and that the file on disk is untouched.
//
// `unit` names WHAT was withheld, for read paths whose unit is not a line of a
// memory file (a replayed session message, a skill). It defaults to 'line', so
// every existing call site stays byte-identical; the wording is still assembled
// here and never re-derived at the call site.
export function shortWithheldNotice(count, unit = 'line') {
  const noun = `${unit}${count === 1 ? '' : 's'}`;
  return (
    `[memory-screen] withheld ${count} ${noun} (credential or injection shape); ` +
    'not shown here, file on disk unchanged.'
  );
}

// The one entry point every read path in the codebase must go through. The
// subagent-scoped index (.agent/_sub/<id>/MEMORY.md) is re-injected into that
// subagent's system prompt on every call, so it leaks exactly like the main
// one; it screens with THIS function rather than re-deriving the patterns.
// Returns { kept, withheld }; the caller renders (kept, withheld) its own way.
export function screenReadLines(lines, source, where) {
  return screenLines(lines, source, where);
}

// Line-level so one bad entry cannot poison a whole block, and so free-form
// lines that are not typed entries are screened too.
function screenLines(lines, source, where) {
  const kept = [];
  let withheld = 0;
  for (const line of lines) {
    if (screenMatch(line)) {
      withheld += 1;
      continue;
    }
    kept.push(line);
  }
  recordReadScreen(source, where, withheld);
  return { kept, withheld };
}

// The one entry point for a read path that screens DISCRETE TEXTS and needs the
// per-item verdict instead of a kept list. screenReadLines drops a failing line
// and keeps the rest, which is right for a block of prose but wrong for a
// structured record: dropping one item would shift its neighbours and, for a
// session replay, orphan a tool_call from its tool result. So this returns one
// boolean per input IN ORDER, plus the aggregate count, and the caller rewrites
// only the failing field. Same counters, same OX_AUDIT ledger, one record per
// read -- so a resume that withholds three messages logs count:3, not three
// rows.
export function screenReadTexts(texts, source, where) {
  const list = Array.isArray(texts) ? texts : [];
  const flags = [];
  let withheld = 0;
  for (const t of list) {
    if (screenMatch(t)) {
      flags.push(false);
      withheld += 1;
      continue;
    }
    flags.push(true);
  }
  recordReadScreen(source, where, withheld);
  return { flags, withheld };
}

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function normalizeText(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokensOf(s) {
  return new Set(normalizeText(s).split(' ').filter(Boolean));
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

function similarStatements(a, b) {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (!na || !nb) return false;
  if (na.includes(nb) || nb.includes(na)) return true;
  return jaccard(tokensOf(na), tokensOf(nb)) > 0.8;
}

function slugify(text, fallback) {
  const slug = normalizeText(text)
    .split(' ')
    .filter(Boolean)
    .slice(0, 6)
    .join('-')
    .slice(0, 60)
    .replace(/^-+|-+$/g, '');
  return slug || fallback;
}

function agentDir(cwd) {
  return path.join(path.resolve(cwd), MEMORY_DIR);
}

function indexPath(cwd) {
  return path.join(agentDir(cwd), MEMORY_INDEX);
}

function topicsDir(cwd) {
  return path.join(agentDir(cwd), 'topics');
}

function episodesDir(cwd) {
  return path.join(agentDir(cwd), 'episodes');
}

function parseIndex(text) {
  const entries = [];
  const lines = String(text ?? '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(ENTRY_RE);
    if (!m) continue;
    entries.push({
      line: i,
      date: m[1] ?? null,
      type: m[2],
      statement: m[3].trim(),
      target: m[4] ?? null,
      raw: lines[i],
    });
  }
  return entries;
}

function readIndexLines(cwd) {
  try {
    return fs.readFileSync(indexPath(cwd), 'utf8').split('\n');
  } catch {
    return [];
  }
}

// EXACT recursive size of a directory tree. It used to `break` once the running
// total passed MAX_AGENT_DIR_BYTES, which made the returned number approximate --
// it could stop at 600KB or at 5MB, depending on readdir order -- so a cap
// decision was being made on a number that was not the size of the directory.
// There is no early exit now: this is only ever called on .agent/ (kilobytes),
// and an honest number is worth a full walk.
export function dirSizeBytes(dir) {
  let total = 0;
  let dirents;
  try {
    dirents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const d of dirents) {
    const full = path.join(dir, d.name);
    try {
      if (d.isDirectory()) total += dirSizeBytes(full);
      else if (d.isFile()) total += fs.statSync(full).size;
    } catch {}
  }
  return total;
}

function appendTopicDetail(cwd, target, detail) {
  const d = String(detail ?? '').replace(/\s+$/, '');
  if (!d.trim()) return;
  const file = path.join(agentDir(cwd), target);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let existing = '';
  try {
    existing = fs.readFileSync(file, 'utf8');
  } catch {}
  const lead = existing ? (existing.endsWith('\n') ? '\n' : '\n\n') : '';
  fs.appendFileSync(file, `${lead}[${today()}] ${d}\n`);
}

function renderEntryLine(entry) {
  const prefix = entry.date ? `[${entry.date}]` : '';
  const arrow = entry.target ? ` -> ${entry.target}` : '';
  return `${prefix}[${entry.type}] ${entry.statement}${arrow}`;
}

function capsHint(lines, bytes) {
  if (lines <= MAX_INDEX_LINES && bytes <= MAX_INDEX_BYTES) return '';
  return `\n[MEMORY.md over cap (${lines} lines / ${(bytes / 1024).toFixed(1)}KB of max ${MAX_INDEX_LINES} lines / ${MAX_INDEX_BYTES / 1024}KB) — prune with /memory]`;
}

// READ PATH. This block is re-injected into EVERY system prompt
// (headless.js -> buildSystemPrompt, cli.js `/memory`), so anything on disk here
// reaches the model on every single turn. Read-time screening closes the gap
// for memories written before the write screen existed: a failing line is
// withheld from the model, counted, and reported -- but the file is left alone.
export function loadMemoryBlock(cwd) {
  let text;
  try {
    text = fs.readFileSync(indexPath(cwd), 'utf8').replace(/\s+$/, '');
  } catch {
    return '';
  }
  const { kept, withheld } = screenLines(text.split('\n'), `.agent/${MEMORY_INDEX}`, 'loadMemoryBlock');
  const keptText = kept.join('\n');
  const lines = keptText.split('\n');
  let block = keptText;
  if (lines.length > MAX_INDEX_LINES || Buffer.byteLength(keptText, 'utf8') > MAX_INDEX_BYTES) {
    // NOT silent destruction: this truncates what is INJECTED INTO THE PROMPT,
    // not what is on disk. The file keeps every line; memory_get and
    // memory_list still return the whole index. The marker below is the visible
    // notice, and memory_add's capsHint tells the writer the cap was hit.
    //
    // SEAM, deliberately left for a later task: this slices by ARRAY POSITION,
    // so the lines that stop being injected are the ones earliest in the file,
    // not the least relevant ones. That is a token-waste problem, not a
    // retention problem — nothing is lost either way. Ranking here (newest
    // first, or entry type / target relevance) would change which lines the
    // model sees; it must NOT be conflated with the retention work, and it must
    // never be implemented as a delete.
    block = lines.slice(0, MAX_INDEX_LINES).join('\n') + '\n[MEMORY.md truncated — prune with /memory]';
  }
  return withheld ? `${block}\n${withheldNotice(withheld, `.agent/${MEMORY_INDEX}`)}` : block;
}

function resolveTarget(argsTopic, fallbackSeed, type) {
  const t = typeof argsTopic === 'string' ? argsTopic.trim() : '';
  if (t) return `topics/${slugify(t, type)}.md`;
  if (type === 'lesson') return 'topics/gotchas.md';
  return `topics/${slugify(fallbackSeed, type)}.md`;
}

function addMemory(cwd, args = {}) {
  const type = typeof args.type === 'string' ? args.type.trim().toLowerCase() : '';
  if (!MEMORY_TYPES.includes(type)) {
    return err(`memory_add: 'type' must be one of ${MEMORY_TYPES.join(', ')}.`);
  }
  const statement = String(args.statement ?? '').replace(/\s+/g, ' ').trim();
  if (!statement) {
    return err("memory_add: 'statement' is required and must be non-empty.");
  }
  // Screen BOTH persisted fields: `statement` lands in the always-injected
  // MEMORY.md index, `detail` lands in the topic note memory_get can replay.
  for (const [field, value] of [['statement', statement], ['detail note', args.detail]]) {
    const blocked = screenPersistText(value, field);
    if (blocked) return err(`memory_add: ${blocked}`);
  }
  const lines = readIndexLines(cwd);
  const entries = parseIndex(lines.join('\n'));
  const match = entries.find((en) => en.type === type && similarStatements(statement, en.statement));

  let target;
  let updated = false;
  if (match) {
    updated = true;
    target = resolveTarget(args.topic, statement, type);
    lines[match.line] = renderEntryLine({ date: today(), type, statement, target });
  } else {
    target = resolveTarget(args.topic, statement, type);
    lines.push(renderEntryLine({ date: today(), type, statement, target }));
  }

  try {
    fs.mkdirSync(topicsDir(cwd), { recursive: true });
    fs.writeFileSync(indexPath(cwd), lines.join('\n').replace(/\n*$/, '\n'));
  } catch (e) {
    return err(`memory_add: cannot write index: ${String((e && e.message) || e)}`);
  }
  appendTopicDetail(cwd, target, args.detail);

  let hint = '';
  try {
    const after = fs.readFileSync(indexPath(cwd), 'utf8');
    hint = capsHint(after.split('\n').filter((l) => l.trim()).length, Buffer.byteLength(after, 'utf8'));
  } catch {}
  const verb = updated ? 'updated existing entry (dedupe match)' : 'added entry';
  return ok(`memory_add: ${verb}: [${type}] ${statement} -> ${target}${hint}`);
}

function memoryList(cwd) {
  let entries;
  try {
    entries = parseIndex(fs.readFileSync(indexPath(cwd), 'utf8'));
  } catch {
    return ok('Memory is empty (.agent/MEMORY.md does not exist yet).');
  }
  if (!entries.length) return ok('Memory is empty (.agent/MEMORY.md has no typed entries).');
  // Same read-side screen: memory_list output is pasted straight into context.
  const { kept, withheld } = screenLines(entries.map((e) => e.raw), `.agent/${MEMORY_INDEX}`, 'memory_list');
  const visible = parseIndex(kept.join('\n'));
  if (!visible.length) {
    return ok(
      `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} on disk, all withheld by the read-side screen:\n` +
        withheldNotice(withheld, `.agent/${MEMORY_INDEX}`)
    );
  }
  const byType = {};
  for (const e of visible) (byType[e.type] ??= []).push(e);
  const sections = MEMORY_TYPES.filter((t) => byType[t]).map((t) => {
    const rows = byType[t].map((e) => `- [${t}]${e.date ? ` [${e.date}]` : ''} ${e.statement}${e.target ? ` -> ${e.target}` : ''}`);
    return `${t} (${byType[t].length}):\n${rows.join('\n')}`;
  });
  const head = `${visible.length} entr${visible.length === 1 ? 'y' : 'ies'}`;
  const tail = withheld ? `\n${withheldNotice(withheld, `.agent/${MEMORY_INDEX}`)}` : '';
  return ok(`${head}:\n${sections.join('\n')}${tail}`);
}

function topicFileFor(cwd, rawTopic) {
  const base = path.basename(String(rawTopic ?? '').trim()).replace(/\.md$/, '').trim();
  if (!base || base.startsWith('.')) return null;
  return path.join(topicsDir(cwd), `${base}.md`);
}

function memoryGet(cwd, args = {}) {
  const topic = args?.topic;
  if (topic !== undefined && topic !== null && String(topic).trim() !== '') {
    const file = topicFileFor(cwd, topic);
    if (!file) return err(`memory_get: invalid topic '${String(topic)}'.`);
    let body = '';
    try {
      body = fs.readFileSync(file, 'utf8').replace(/\s+$/, '');
    } catch {
      return err(`memory_get: no topic note '${String(topic)}' (${file}).`);
    }
    const rel = `.agent/${path.relative(path.resolve(cwd), file).split(path.sep).join('/')}`;
    const { kept, withheld } = screenLines(body.split('\n'), rel, 'memory_get topic note');
    const keptText = kept.join('\n').replace(/\s+$/, '');
    // A withheld entry must be announced, not silently swallowed: the caller
    // asked for this content, so pretending it does not exist is a lie.
    if (withheld) {
      return ok(
        (keptText ? `${keptText}\n\n` : '') + withheldNotice(withheld, rel)
      );
    }
    if (!keptText) return ok(`Topic note '${String(topic)}' exists but is empty.`);
    return ok(keptText);
  }
  try {
    const text = fs.readFileSync(indexPath(cwd), 'utf8').replace(/\s+$/, '');
    if (!text) return ok('Memory index is empty.');
    const { kept, withheld } = screenLines(text.split('\n'), `.agent/${MEMORY_INDEX}`, 'memory_get index');
    const keptText = kept.join('\n').replace(/\s+$/, '');
    if (withheld) {
      return ok((keptText ? `${keptText}\n\n` : '') + withheldNotice(withheld, `.agent/${MEMORY_INDEX}`));
    }
    return ok(keptText || 'Memory index is empty.');
  } catch {
    return ok('Memory index is empty.');
  }
}

function recencyDate(line, filePath) {
  const fromName = path.basename(filePath).match(/^(\d{4}-\d{2}-\d{2})/);
  if (fromName) return fromName[1];
  const fromLine = String(line).match(DATE_PREFIX_RE);
  if (fromLine) return fromLine[1];
  try {
    const mtime = fs.statSync(filePath).mtime;
    const p = (n) => String(n).padStart(2, '0');
    return `${mtime.getFullYear()}-${p(mtime.getMonth() + 1)}-${p(mtime.getDate())}`;
  } catch {
    return '0000-00-00';
  }
}

function collectAgentFiles(dir, out = []) {
  let dirents;
  try {
    dirents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of dirents) {
    const full = path.join(dir, d.name);
    if (d.isDirectory()) collectAgentFiles(full, out);
    else if (d.isFile()) out.push(full);
  }
  return out;
}

function memorySearch(cwd, args = {}) {
  const query = String(args?.query ?? '').trim();
  if (!query) return err("memory_search: 'query' is required.");
  const root = agentDir(cwd);
  const needle = query.toLowerCase();
  const hits = [];
  let withheldHits = 0;
  for (const file of collectAgentFiles(root)) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const rel = `.${path.sep}${path.relative(path.resolve(cwd), file)}`;
    // The PATH is part of the result body (`${h.file}:${h.line}: ${h.text}`) and is
    // just as model-visible as the line. Stores that derive a filename from
    // supplied text -- .agent/episodes/ (writeEpisode) and .agent/notes/
    // (writeSessionNote) -- would otherwise hand the model a credential through
    // the name even after the line itself is screened. Screen the name too, and
    // count a withheld name in the same tally so the count stays truthful.
    const badPath = Boolean(screenMatch(rel));
    if (badPath) withheldHits += 1;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].toLowerCase().includes(needle)) continue;
      // A grep hit is still a model-visible read. Keep the line OUT of the
      // result body but keep it in the count, so the tally stays truthful.
      const hit = screenMatch(lines[i]);
      withheldHits += hit ? 1 : 0;
      hits.push({
        file: badPath ? STORED_PATH_WITHHELD : rel,
        line: i + 1,
        text: hit ? '[withheld by memory read-side screen — credential/injection shape, see file]' : lines[i].trim().slice(0, 200),
        date: recencyDate(lines[i], file),
      });
    }
  }
  recordReadScreen(root, 'memory_search', withheldHits);
  if (!hits.length) return ok(`No matches for '${query}' under ${root}.`);
  hits.sort((a, b) => b.date.localeCompare(a.date) || a.file.localeCompare(b.file) || a.line - b.line);
  const top = hits.slice(0, SEARCH_RESULT_CAP);
  const notes = [];
  if (hits.length > SEARCH_RESULT_CAP) notes.push(`[${hits.length - SEARCH_RESULT_CAP} more matches omitted]`);
  if (withheldHits) notes.push(withheldNotice(withheldHits, `.agent/** (${root})`));
  const tail = notes.length ? `\n${notes.join('\n')}` : '';
  return ok(
    `${hits.length} match(es), most recent first:\n${top
      .map((h) => `${h.file}:${h.line}: ${h.text}`)
      .join('\n')}${tail}`
  );
}

function schemas() {
  return [
    {
      name: 'memory_list',
      description:
        'List every typed entry in persistent project memory (.agent/MEMORY.md), grouped by type (user | feedback | project | lesson) with pointers to their topic notes. Entries with credential or prompt-injection shape are withheld and reported as a count.',
      input_schema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'memory_get',
      description:
        "Read memory content. Args: topic (optional string) — a topic note name like 'gotchas' returns that note's full markdown; omitted or empty returns the MEMORY.md index itself. Lines with credential or prompt-injection shape are WITHHELD and the result says how many — they are never echoed, and the file on disk is left unchanged.",
      input_schema: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: "Topic note name (e.g. 'gotchas'); omit to get the whole index." },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'memory_add',
      description:
        "Persist one durable fact to project memory. Args: type ('user'|'feedback'|'project'|lesson'), statement (REQUIRED one-line fact), topic (optional slug naming topics/<slug>.md), detail (optional longer markdown appended to the topic note). Similar statements UPDATE the existing entry in place instead of duplicating; a prune reminder appears when the 150-line / 20KB cap is exceeded. Credentials (provider keys, JWTs, PEM blocks, bearer tokens, inline secret assignments) and prompt-injection payloads are REFUSED with an error — store a pointer to where the credential lives, never the value.",
      input_schema: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['user', 'feedback', 'project', 'lesson'] },
          statement: { type: 'string', description: 'One-line fact, phrased as a complete statement.' },
          topic: { type: 'string', description: 'Optional topic slug; defaults are derived from the statement.' },
          detail: { type: 'string', description: 'Optional long-form detail appended to the topic note.' },
        },
        required: ['type', 'statement'],
        additionalProperties: false,
      },
    },
    {
      name: 'memory_search',
      description:
        'Grep across everything under .agent/ (index, topic notes, episodes) ranked by date-prefix recency, most recent first. Args: query (REQUIRED substring, case-insensitive).',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Case-insensitive substring to search for.' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  ];
}

export function createMemoryApi(cwd) {
  const root = path.resolve(cwd);
  async function dispatch(name, args = {}) {
    try {
      switch (name) {
        case 'memory_list':
          return memoryList(root);
        case 'memory_get':
          return memoryGet(root, args ?? {});
        case 'memory_add':
          return addMemory(root, args ?? {});
        case 'memory_search':
          return memorySearch(root, args ?? {});
        default:
          return err(
            `Unknown memory tool '${name}'. Available: memory_list, memory_get, memory_add, memory_search.`
          );
      }
    } catch (e) {
      return err(`memory: ${String((e && e.message) || e)}`);
    }
  }
  return {
    schemas,
    dispatch,
    recordLesson(text) {
      try {
        const t = String(text ?? '').trim();
        if (!t) return err('recordLesson: lesson text is required.');
        return addMemory(root, { type: 'lesson', statement: t, topic: 'gotchas', detail: t });
      } catch (e) {
        return err(`recordLesson: ${String((e && e.message) || e)}`);
      }
    },
  };
}

function metaLineFor(meta, date) {
  const m = meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : {};
  const bits = [];
  const scoreRaw = Number(m.score);
  if (m.score != null && Number.isFinite(scoreRaw)) {
    bits.push(`score: ${Math.min(10, Math.max(0, scoreRaw))}`);
  }
  if (m.verified) bits.push(`verified: ${date}`);
  return bits.length ? `- ${bits.join(' · ')}` : null;
}

// ---- write screen for episodes ---------------------------------------------
//
// .agent/episodes/ is the other store in this module that took supplied text
// unscreened, and it is the one with the LEAST controlled input: both callers
// (cli.js finalizeAndExit, headless.js) pass `goal: state.firstUser` -- the
// user's own first prompt, verbatim -- and `outcome: state.lastAssistant`, the
// last assistant message, verbatim. Those are exactly the strings a pasted
// credential arrives in.
//
// The leak here is worse than the one .agent/notes/ had, in two ways:
//
//   1. `goal` is slugified into the FILENAME (slugify: first 6 words, lowercased,
//      non-alphanumerics dropped, 60-char cap), so credential material lands in a
//      path -- and `ls .agent/episodes/` is a reader.
//   2. Unlike .agent/notes/, this directory HAS a model-visible reader today.
//      `memory_search` is a TOOL (memory.js): it walks the whole `.agent/` tree
//      with collectAgentFiles, episodes included, and returns each hit's RELATIVE
//      PATH in the result body. A credential in a filename is therefore not just
//      on disk, it is in a tool result. Its hit TEXT is screened on read (see
//      memorySearch); its hit PATH is what this write screen exists to stop from
//      existing at all, and screenStoredPath closes the gap for artefacts that
//      were written before this shipped.
//
// The refusal comes from the shared screenPersistText, so it names the pattern
// class and never the matched text, and it goes to stderr because both callers
// are fire-and-forget (`try { writeEpisode(...) }` -- a returned string would be
// silently discarded). Refusal is ALL-OR-NOTHING, not field-level withholding: a
// credential in the outcome refuses the whole episode rather than storing the
// goal with the outcome blanked. writeSessionNote still returns a bare boolean;
// only writeEpisode grew a result object, because only writeEpisode can now
// answer 'written, or archived, or refused -- and why'.
const EPISODE_STORE = 'the episode (.agent/episodes/)';

function episodeRefusal(field, text) {
  const reason = screenPersistText(text, field, EPISODE_STORE);
  if (!reason) return null;
  try {
    // The shared sentence ends "replayed forever", which is true for the memory
    // index and only half true here: memory_search screens hit TEXT on read, so
    // a body credential would be withheld rather than replayed. The FILENAME is
    // the part with no read-side screen, so the accurate clause is added here
    // rather than forking the message -- forking it would fork the pattern-class
    // wording and its never-echo-the-secret guarantee along with it.
    process.stderr.write(
      `ox: warning: ${reason} This store is refused because the credential would sit in a plaintext file AND in that ` +
        "file's own name, and the memory_search tool echoes each hit's path straight back to the model.\n"
    );
  } catch {}
  return reason;
}

// The path form of the same protection, for a read that has ALREADY found a
// stored artefact. It never prints the path either, so naming the offending file
// would not re-introduce what the write screen refused.
//
// This matters because most write screens protect the BODY and not the NAME: a
// store whose filename is derived from supplied text (episodes, and the session
// notes fixed just above) can hold a key in its path. memory_search prints that
// path to the model, so an artefact written before its write screen shipped
// would otherwise still be readable -- through its own name.
const STORED_PATH_WITHHELD = '[path withheld by memory read-side screen — credential/injection shape, see file]';
function screenStoredPath(rel) {
  return screenMatch(rel) ? STORED_PATH_WITHHELD : rel;
}

// ---- archive primitives ----------------------------------------------------
//
// Every place the memory subsystem used to DELETE or DROP something now MOVES it
// here instead. Two rules govern all of them:
//
//   1. NEVER DESTROY. There is no path through these functions that removes a
//      byte without its bytes already existing at the destination. The copy is
//      made FIRST and the source removed SECOND, so a crash in between leaves a
//      duplicate rather than a hole. Duplicates are recoverable; holes are not.
//
//   2. AN ARCHIVE IS STILL A PERSISTENCE SURFACE. Every archive write goes
//      through screenPersistText exactly like a primary write, and the screen is
//      a REQUIRED argument rather than an option, so a new caller cannot forget
//      it. A refusal does NOT mean "archive it anyway" -- it means KEEP THE
//      ORIGINAL WHERE IT IS and record the refusal. That is the honest outcome:
//      the artefact stays exactly as visible and as recoverable as it was before
//      the cap fired, and the refusal is a ledger row plus a stderr notice.
//
// ARCHIVE_NOTE / honest bound: archiving trades disk for recall, it does not
// bound disk. .agent/notes/archive/ and .agent/archive/ live INSIDE .agent/, so
// MAX_AGENT_DIR_BYTES no longer caps the size of a project tree -- it now only
// decides where a NEW episode is written. A project that never prunes will grow.
// That is a deliberate trade: an unbounded tree is recoverable, a silently
// truncated one is not.

// A consistent, human-visible notice. Every archive/eviction path emits one, so
// the loss is observable without knowing to go and read the ledger.
export function lossNotice(text) {
  try {
    process.stderr.write(`ox: memory-loss: ${text}\n`);
  } catch {}
}

// The ledger, re-exported from this module so sibling memory modules
// (procedural-memory.js) query and report the SAME file with the SAME idiom
// rather than each importing their own copy of the path.
export { recordLoss, lossLedgerPath, readLossLedger, formatLossReport, lossStats, resetLossStats, ARCHIVE_ROOT };

function archiveFileName(name) {
  return `${isoStamp()}-${name}`;
}

// First free path in `dir`, so two artefacts taken in the same millisecond do
// not overwrite each other. Bounded, with a last-resort timestamp.
//
// It returns a FULL PATH, always joined to `dir`. It used to return a BARE name
// and leave the join to each caller, and the two callers disagreed:
// persistArchived joined, writeSessionNote did not. So every session note was
// written to process.cwd() instead of .agent/notes/ -- writeSessionNote returned
// true, nothing landed where it claimed, and the repository root collected
// thousands of note files. A name that only one caller must remember to join is
// a landmine; the join happens here, once, for every caller.
function uniquePathIn(dir, name) {
  const free = (candidate) => !fs.existsSync(path.join(dir, candidate));
  if (free(name)) return path.join(dir, name);
  const m = name.match(/^(.*?)(\.[A-Za-z0-9]+)?$/);
  const base = m[1];
  const ext = m[2] || '';
  for (let i = 1; i < 10000; i++) {
    const cand = `${base}-${i}${ext}`;
    if (free(cand)) return path.join(dir, cand);
  }
  return path.join(dir, `${base}-${Date.now()}${ext}`);
}

// Write `content` into `destDir` as a named archive, screening it first.
// Returns { archived: true, path, bytes } or { archived: false, reason, bytes }.
// Never throws.
export function persistArchived(content, {
  destDir,
  name,
  label,
  screenStore,
  store,
  event,
  reason,
  artifact = null,
  detail = null,
}) {
  const text = String(content ?? '');
  const bytes = Buffer.byteLength(text, 'utf8');

  const refusal = screenPersistText(text, label, screenStore);
  if (refusal) {
    // Keep the original in place. Record the PATTERN CLASS only -- the matched
    // text never reaches the ledger, the notice, or the caller.
    const cls = (screenMatch(text)?.label ?? 'persistence screen').slice(0, 120);
    recordLoss({ store, event, action: 'kept', reason: 'screen-refused', artifact, detail: cls, bytes });
    return { archived: false, reason: 'screen-refused', detail: cls, bytes };
  }

  let dest;
  try {
    fs.mkdirSync(destDir, { recursive: true });
    dest = uniquePathIn(destDir, archiveFileName(name));
    fs.writeFileSync(dest, text, { mode: 0o600 });
  } catch (e) {
    const why = 'archive-unwritable';
    recordLoss({ store, event, action: 'kept', reason: why, artifact, detail, bytes });
    return { archived: false, reason: why, bytes, error: String((e && e.message) || e) };
  }

  recordLoss({ store, event, action: 'archived', reason, artifact, archive: dest, bytes, detail });
  return { archived: true, path: dest, bytes };
}

// Move an existing file into an archive directory. Copy first, remove second, so
// there is no instant at which the bytes exist nowhere. `screen` is mandatory:
// archiveFile without a screenStore is a caller bug and refuses.
export function archiveFile(src, { destDir, label, screenStore, store, event, reason, detail = null }) {
  if (typeof screenStore !== 'string' || !screenStore) {
    return { archived: false, reason: 'no-screen-supplied', kept: true, source: src };
  }
  let content;
  try {
    content = fs.readFileSync(src);
  } catch {
    return { archived: false, reason: 'unreadable-source', kept: true, source: src };
  }
  const res = persistArchived(content, {
    destDir,
    name: path.basename(src),
    label,
    screenStore,
    store,
    event,
    reason,
    artifact: src,
    detail,
  });
  if (!res.archived) return { ...res, kept: true, source: src };
  let bytes = 0;
  try {
    bytes = fs.statSync(src).size;
  } catch {}
  try {
    fs.rmSync(src, { force: true });
  } catch {
    // The bytes are in the archive, so nothing is lost -- but the copy is a
    // duplicate the operator has to know about.
    lossNotice(`${src} was archived but could not be removed from its original location; ` +
      `it now exists in BOTH places (${res.path}).`);
    return { ...res, removed: false, source: src };
  }
  return { ...res, removed: true, source: src, bytes: bytes || res.bytes };
}

// Every file under `dir`, as paths relative to `dir`. Symlinks are not followed,
// so a link pointing outside the skill cannot smuggle bytes into the archive.
function listFilesRecursively(dir, prefix = '', out = []) {
  let dirents;
  try {
    dirents = fs.readdirSync(path.join(dir, prefix), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of dirents) {
    const rel = prefix ? `${prefix}/${d.name}` : d.name;
    if (d.isDirectory()) listFilesRecursively(dir, rel, out);
    else if (d.isFile()) out.push(rel);
  }
  return out;
}

// Archive a directory that is about to be replaced. Every file is copied (and
// screened) FIRST; only when all of them are safely archived is the source tree
// removed. One unarchivable file and nothing at all is removed. Never throws.
function archiveSkillDir(dir, { store, event, reason }) {
  const files = listFilesRecursively(dir);
  if (!files.length) {
    // An empty directory destroys nothing, so removing it needs no archive.
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
    return { archived: true, dir: null, files: [] };
  }
  const destDir = path.join(ARCHIVE_ROOT, 'skills', path.basename(dir), isoStamp());
  const copied = [];
  for (const rel of files) {
    const src = path.join(dir, ...rel.split('/'));
    let content;
    try {
      content = fs.readFileSync(src);
    } catch {
      return { archived: false, reason: 'unreadable-source', kept: true };
    }
    const res = persistArchived(content, {
      destDir,
      // Flattened: one archive directory per skill, one file per archived file.
      name: rel.replace(/[\\/]/g, '_'),
      label: 'replaced skill file',
      screenStore: 'the promoted skill (~/.agents/skills)',
      store,
      event,
      reason,
      artifact: src,
    });
    if (!res.archived) return { archived: false, reason: res.reason, kept: true };
    copied.push(res.path);
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Nothing is lost — the bytes are in the archive — but the operator now has a
    // duplicate they need to know about.
    lossNotice(`${dir} was archived to ${destDir} but could not be removed; the skill now exists in BOTH places.`);
    return { archived: true, dir: destDir, files: copied, removed: false };
  }
  return { archived: true, dir: destDir, files: copied, removed: true };
}

// Episodes are one-per-file by construction now (see uniqueEpisodePath), so a
// name can only be taken by an earlier episode from the same date with the same
// goal slug -- which is exactly the collision that used to overwrite it.
function uniqueEpisodePath(dir, base) {
  const first = path.join(dir, `${base}.md`);
  if (!fs.existsSync(first)) return first;
  for (let i = 2; i < 10000; i++) {
    const cand = path.join(dir, `${base}-${i}.md`);
    if (!fs.existsSync(cand)) return cand;
  }
  return path.join(dir, `${base}-${Date.now()}.md`);
}

// ---- writeEpisode ----------------------------------------------------------
//
// RETURN CONTRACT (this changed; the two callers are fire-and-forget and need no
// edit, but every test that asserted `=== true` / `=== false` does):
//
//   { status: 'written' | 'archived' | 'refused' | 'failed',
//     ok:      status === 'written' || status === 'archived',
//     path:    where the episode actually landed, or null,
//     reason:  machine token -- null on success,
//     detail:  the human sentence from the screen, when refused,
//     message: one line, always present }
//
// 'archived' is new and is the whole point: the .agent/ size cap used to
// `return false` and DROP the episode -- no file, no warning, no counter, no
// audit row, and a boolean the caller could not interpret. Now the cap ROUTES
// the episode to a real archive outside the capped directory and says so.
export function writeEpisode(cwd, { goal, outcome, files = [], lessons = [], meta = {} } = {}) {
  try {
    const root = path.resolve(cwd);
    const adir = agentDir(root);
    const adirBytes = dirSizeBytes(adir);
    const overCap = adirBytes > MAX_AGENT_DIR_BYTES;

    const date = today();
    const goalLine = String(goal ?? '').replace(/\s+/g, ' ').trim() || '(no goal recorded)';
    const outcomeLine = String(outcome ?? '').replace(/\s+/g, ' ').trim() || '(no outcome recorded)';
    const fileList = (Array.isArray(files) ? files : []).map((f) => String(f)).filter(Boolean);
    const lessonList = (Array.isArray(lessons) ? lessons : []).map((l) => String(l)).filter(Boolean);

    // ---- screen the BODY, before anything is created on disk ----
    // Each value is screened in the form actually written: the 300-char slice on
    // goal / outcome / lessons, and the UNSLICED file entry (the files block caps
    // the COUNT, not the length, so screening a slice there would miss key
    // material that lands on disk whole). Screening the raw input instead would
    // refuse an episode whose credential never made it past the cap. Every item
    // is screened, not just the kept ones: the 15-file / 10-lession / 40-line
    // trims are capacity decisions that depend on the current state of the store,
    // and a store that shrinks must not become a way to smuggle a secret past the
    // screen.
    for (const [field, value] of [
      ['episode goal', goalLine.slice(0, 300)],
      ['episode outcome', outcomeLine.slice(0, 300)],
    ]) {
      if (episodeRefusal(field, value)) return episodeRefusalResult(field, value);
    }
    for (const [field, items, cap] of [
      ['file path in the episode', fileList, 0],
      ['episode lesson', lessonList, 300],
    ]) {
      for (const item of items) {
        const itemText = cap ? String(item).slice(0, cap) : String(item);
        if (episodeRefusal(field, itemText)) return episodeRefusalResult(field, itemText);
      }
    }

    // ---- screen the FILENAME ----
    // Screening the goal is not enough on its own: the slug is a DIFFERENT string
    // (first 6 words, lowercased, non-alphanumerics dropped, 60-char cap) and it is
    // a path component that memory_search prints to the model. Refusing is the
    // honest answer, for the same reason the note fix refuses: slugify can move a
    // prefix such as `sk-` out of the 60-char window while leaving the tail inside
    // it, so no truncation of this string provably cannot leave key material
    // behind. A goal that screens clean slugifies clean, so this fires as a
    // backstop -- and when it does, no episode is written at all.
    const slug = slugify(String(goal ?? ''), 'session');
    if (episodeRefusal('episode filename', slug)) return episodeRefusalResult('episode filename', slug);

    const extraLine = metaLineFor(meta, date);

    let maxFiles = Math.min(fileList.length, 15);
    let maxLessons = Math.min(lessonList.length, 10);
    const blockLen = (nf, nl) => 7 + (extraLine ? 1 : 0) + (nf > 0 ? nf + 2 : 2) + (nl > 0 ? nl + 2 : 2);
    while ((maxFiles > 0 || maxLessons > 0) && blockLen(maxFiles, maxLessons) > MAX_EPISODE_LINES) {
      if (maxFiles >= maxLessons && maxFiles > 0) maxFiles--;
      else if (maxLessons > 0) maxLessons--;
      else break;
    }

    const lines = [
      `# Episode ${date}`,
      '',
      `- date: ${date}`,
      `- goal: ${goalLine.slice(0, 300)}`,
      `- outcome: ${outcomeLine.slice(0, 300)}`,
      ...(extraLine ? [extraLine] : []),
      '',
      '## Files touched',
    ];
    if (maxFiles > 0) for (const f of fileList.slice(0, maxFiles)) lines.push(`- ${f}`);
    else lines.push('(none)');
    lines.push('', '## Lessons');
    if (maxLessons > 0) for (const l of lessonList.slice(0, maxLessons)) lines.push(`- ${l.slice(0, 300)}`);
    else lines.push('(none)');
    lines.push('');

    // One episode per file, hard-capped at MAX_EPISODE_LINES. Nothing here reads
    // the previous version of this date+slug and rewrites it: a second episode
    // on the same date with the same goal slug used to OVERWRITE the first,
    // keeping only the last 39 lines and destroying the earlier content from
    // disk. Two files are strictly better than one truncated one, so distinct
    // episodes simply get distinct names (see uniqueEpisodePath).
    const block = lines.join('\n').split('\n').slice(0, MAX_EPISODE_LINES).join('\n');
    const body = block.endsWith('\n') ? block : `${block}\n`;

    // ---- the .agent/ size cap: ARCHIVE, never drop -----------------------
    // Past MAX_AGENT_DIR_BYTES the old code returned false and lost the
    // episode outright. It now goes to ~/.ox/archive/agent-overflow/<project>/
    // -- deliberately OUTSIDE .agent/, so the cap does not immediately push the
    // overflow back over the cap it just tripped.
    if (overCap) {
      const destDir = agentOverflowDir(projectKeyFor(root), 'episodes');
      const res = persistArchived(body, {
        destDir,
        name: `${date}-${slug}.md`,
        label: 'archived episode',
        screenStore: EPISODE_STORE,
        store: 'episodes',
        event: 'agent-dir-overflow',
        reason: `agent-dir-over-${Math.floor(MAX_AGENT_DIR_BYTES / 1024)}KB`,
        artifact: path.join(destDir, `${date}-${slug}.md`),
        detail: `adirBytes=${adirBytes}`,
      });
      if (!res.archived) {
        // Nothing was written and nothing was destroyed. The reason is
        // returned, counted and printed -- which is the entire difference
        // between this and the old `return false`.
        lossNotice(
          `refusing to write an episode: .agent/ is ${adirBytes} bytes (cap ${MAX_AGENT_DIR_BYTES}) ` +
            `and the archive write was refused (${res.reason}). NOTHING was written and NOTHING was lost. ` +
            'Prune or move .agent/ and retry.'
        );
        return {
          status: 'refused',
          ok: false,
          path: null,
          reason: res.reason,
          detail: res.detail ?? null,
          message: `episode refused: .agent/ over cap (${adirBytes} bytes) and archive write refused (${res.reason})`,
        };
      }
      lossNotice(
        `episode ARCHIVED, not dropped: .agent/ is ${adirBytes} bytes, over the ${MAX_AGENT_DIR_BYTES}-byte cap. ` +
          `Wrote to ${res.path} instead of dropping it. Ledger: ${lossLedgerPath()}`
      );
      return {
        status: 'archived',
        ok: true,
        path: res.path,
        reason: `agent-dir-over-${Math.floor(MAX_AGENT_DIR_BYTES / 1024)}KB`,
        detail: null,
        message: `episode archived to ${res.path} (.agent/ is over its size cap)`,
      };
    }

    const epDir = episodesDir(root);
    fs.mkdirSync(epDir, { recursive: true });
    const file = uniqueEpisodePath(epDir, `${date}-${slug}`);
    if (path.basename(file) !== `${date}-${slug}.md`) {
      // Distinct episodes never share a file, so nothing is overwritten. The
      // split is recorded because it is the visible trace of a collision the
      // old code resolved by destroying history.
      recordLoss({
        store: 'episodes',
        event: 'episode-name-taken',
        action: 'uniquified',
        reason: 'same-date-same-slug',
        artifact: file,
        detail: `base=${date}-${slug}`,
      });
    }
    fs.writeFileSync(file, body);
    return {
      status: 'written',
      ok: true,
      path: file,
      reason: null,
      detail: null,
      message: `episode written to ${file}`,
    };
  } catch (e) {
    const why = String((e && e.message) || e).slice(0, 160);
    recordLoss({ store: 'episodes', event: 'write-failed', action: 'refused', reason: 'io-error', detail: why });
    lossNotice(`episode NOT written (io-error): ${why}`);
    return { status: 'failed', ok: false, path: null, reason: 'io-error', detail: why, message: `episode failed: ${why}` };
  }
}

// A screen refusal, as a writeEpisode result. The reason token names the
// pattern CLASS and never the matched text, so the value is safe to log.
function episodeRefusalResult(field, text) {
  // The pattern CLASS, never the matched text: the result object is logged, so
  // it has to carry the same never-echo-the-secret guarantee as the message.
  const label = screenMatch(text)?.label ?? 'a refused persistence pattern';
  return {
    status: 'refused',
    ok: false,
    path: null,
    reason: 'screen-refused',
    detail: `${field}: ${label}`,
    message: `episode refused: the ${field} looks like ${label}; nothing was written`,
  };
}

// ---- episode listing + skill promotion (v0.2b) ----

function parseEpisodeText(text, fileName) {
  const lines = String(text ?? '').split('\n');
  const ep = { file: fileName, date: null, goal: '', outcome: '', score: null, verified: false, verifiedDate: null, lessons: [] };
  const nameDate = String(fileName ?? '').match(/^(\d{4}-\d{2}-\d{2})/);
  if (nameDate) ep.date = nameDate[1];
  let inLessons = false;
  for (const line of lines) {
    let m;
    if ((m = line.match(/^#\s*Episode\s+(.*)$/))) continue;
    else if ((m = line.match(/^-\s*date:\s*(.+?)\s*$/))) ep.date = m[1];
    else if ((m = line.match(/^-\s*goal:\s*(.+?)\s*$/))) ep.goal = m[1];
    else if ((m = line.match(/^-\s*outcome:\s*(.+?)\s*$/))) ep.outcome = m[1];
    else if (/^\s*##\s+Lessons/.test(line)) inLessons = true;
    else if (/^\s*##\s+/.test(line)) inLessons = false;
    else if (/^-\s*score:/.test(line)) {
      const s = Number(line.match(/^\s*-\s*score:\s*([\d.]+)/)?.[1]);
      if (Number.isFinite(s)) ep.score = Math.min(10, Math.max(0, s));
      const v = line.match(/verified:\s*([^\s·]+)\s*$/);
      if (v) {
        ep.verified = true;
        ep.verifiedDate = v[1];
      }
    } else if (/^-\s*verified:\s*(\S+)/.test(line) && !/score/.test(line)) {
      ep.verified = true;
      ep.verifiedDate = line.match(/^-\s*verified:\s*(\S+)/)[1];
    } else if (inLessons) {
      const b = line.match(/^\s*-\s+(.+?)\s*$/);
      if (b && b[1] !== '(none)') ep.lessons.push(b[1]);
    }
  }
  return ep;
}

export function listEpisodes(cwd) {
  const dir = episodesDir(path.resolve(cwd));
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort().reverse();
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    try {
      out.push(parseEpisodeText(fs.readFileSync(path.join(dir, f), 'utf8'), f));
    } catch {}
  }
  return out;
}

// THE EVIDENCE GATE, in one place.
//
// This predicate used to be an inline expression inside promoteEpisode. It is
// exported now because /refine (src/refine.js) has to judge its proposals by
// the SAME rule, and a second copy of the bar is exactly how a "continual
// harness" quietly becomes a weaker one: the promotion path would keep its
// check while the refinement path invented its own. Keeping the arithmetic here
// means a change to the bar is a one-line diff in one file, and `ox episode
// promote` and `/refine` cannot drift apart.
//
// Gate: >=1 lesson bullet AND (score >= 6 OR verified) unless force.
export function episodePromotionQualifies(ep) {
  return (ep?.lessons?.length ?? 0) >= 1 && ((ep?.score != null && ep.score >= 6) || ep?.verified);
}

// The refusal wording for an unqualified episode, shared for the same reason.
export function promotionRefusalReason(ep) {
  return (ep?.lessons?.length ?? 0) === 0
    ? 'it has no lesson bullets'
    : `its score is ${ep?.score ?? '(none)'} (< 6) and it is not verified`;
}

// Promotes one episode into ~/.agents/skills/<slug-from-goal>/SKILL.md.
export function promoteEpisode(cwd, ref, { force = false, home = os.homedir() } = {}) {
  const root = path.resolve(cwd);
  const dir = episodesDir(root);
  const r = String(ref ?? '').trim();
  if (!r) return { ok: false, kind: 'not-found', message: 'episode promote: an episode id or filename is required.' };

  let entries = [];
  try {
    entries = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch {
    return { ok: false, kind: 'not-found', message: `episode promote: no episodes under ${dir}.` };
  }
  const matches = entries.filter((f) => {
    const id = f.replace(/\.md$/, '');
    return f === r || f === `${r}.md` || f.startsWith(r) || id.includes(r);
  });
  if (matches.length === 0) {
    return { ok: false, kind: 'not-found', message: `episode promote: no episode matching '${r}' (try: ox episode ls).` };
  }
  if (matches.length > 1) {
    return { ok: false, kind: 'ambiguous', message: `episode promote: '${r}' is ambiguous: ${matches.join(', ')}.` };
  }

  const fileName = matches[0];
  let ep;
  try {
    ep = parseEpisodeText(fs.readFileSync(path.join(dir, fileName), 'utf8'), fileName);
  } catch (e) {
    return { ok: false, kind: 'not-found', message: `episode promote: cannot read ${fileName}: ${String((e && e.message) || e)}.` };
  }

  const qualified = episodePromotionQualifies(ep);
  if (!qualified && !force) {
    const why = promotionRefusalReason(ep);
    return {
      ok: false,
      kind: 'unqualified',
      message:
        `episode promote: refusing '${fileName}' — ${why}. ` +
        'Promotion needs at least 1 lesson bullet AND (score >= 6 OR verified). Re-run with --force to override.',
    };
  }

  const goal = ep.goal || '(promoted episode)';
  const name = slugify(goal, 'episode');
  const skillsRoot = path.join(path.resolve(home), '.agents', 'skills');
  const destDir = path.join(skillsRoot, name);
  const dest = path.join(destDir, 'SKILL.md');
  if (fs.existsSync(destDir)) {
    if (!force) {
      return {
        ok: false,
        kind: 'exists',
        message: `skill '${name}' already exists at ${destDir} — re-run with --force to overwrite.`,
      };
    }
    // --force used to be `fs.rmSync(destDir, { recursive: true, force: true })`:
    // a whole skill directory — a hand-edited SKILL.md and anything else dropped
    // beside it — destroyed by one flag, with no copy and no ledger row. The
    // replaced skill is now ARCHIVED first (copy, then remove).
    //
    // A refusal here does not fall back to "overwrite anyway". The operator asked
    // to overwrite, not to destroy, so if a file cannot be archived the promotion
    // refuses and the existing skill is left exactly as it was.
    const archived = archiveSkillDir(destDir, { store: 'skills', event: 'skill-replaced', reason: 'promote-force' });
    if (!archived.archived) {
      return {
        ok: false,
        kind: 'archive-refused',
        path: dest,
        message:
          `skill '${name}' exists at ${destDir} and could not be archived (${archived.reason}), ` +
          'so nothing was overwritten and nothing was deleted. Move or delete that directory yourself, then re-run.',
      };
    }
    lossNotice(
      `skill '${name}' was replaced by --force; the previous version was archived to ${archived.dir} ` +
        `(nothing destroyed). Ledger: ${lossLedgerPath()}`
    );
  }

  const description = goal.replace(/\s+/g, ' ').trim().slice(0, 300);
  const epDate = ep.date || today();
  const steps = ep.lessons
    .slice(0, 10)
    .map((l, i) => `${i + 1}. ${String(l).replace(/\s+/g, ' ').trim().slice(0, 300)}`)
    .join('\n');
  const md = [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    'metadata:',
    '  source: episode',
    `  date: ${epDate}`,
    '---',
    '',
    `# ${description}`,
    '',
    '## Steps',
    '',
    steps,
    '',
    '',
  ].join('\n');

  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(dest, md);
  return { ok: true, kind: 'promoted', path: dest, name, score: ep.score, verified: ep.verified, lessons: ep.lessons.length, date: epDate };
}

function notesDir(cwd) {
  return path.join(agentDir(cwd), 'notes');
}

function isoStamp(d = new Date()) {
  return d.toISOString().replace(/[:.]/g, '-');
}

function checkpointListBlock(lines, label, items, cap) {
  lines.push(`## ${label}`);
  const list = (Array.isArray(items) ? items : [])
    .map((x) => String(x).replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, cap);
  if (!list.length) lines.push('(none)');
  else for (const item of list) lines.push(`- ${item.slice(0, 300)}`);
}

// ---- write screen for session notes ----------------------------------------
//
// .agent/notes/ is the one persistence store in this module with NO screen, and
// it is the one whose text is least controlled: `goal` is the user's own first
// prompt, `decisions` / `errors` carry assistant text and tool error text, and
// `files` carries paths reported by tools. Every other store here (the memory
// index, procedural.md, the subagent descriptor) already refuses a credential on
// the way in.
//
// Nothing reads .agent/notes/ back into a prompt today — grep the tree: the
// directory is written, pruned and then left alone. So this is not closing a live
// prompt leak. It is closing the two things that make it one anyway: the
// credential lands in a PLAINTEXT FILE on disk, and it lands in the FILENAME,
// because the slug is derived from the goal text. A path is a leak waiting for a
// reader, and `ls .agent/notes/` (a human, an rsync, a backup, a glob) is a
// reader. The body and the slug are screened together for exactly that reason.
//
// The refusal message comes from the shared screenPersistText, so it names the
// pattern class and never the matched text; it is written to stderr because every
// caller of this function is fire-and-forget (`try { writeSessionNote(...) }`),
// so returning a string would be silently discarded. The boolean return is
// unchanged: `true` = written, `false` = refused or failed.
const NOTES_STORE = 'the session note (.agent/notes/)';

function noteRefusal(field, text) {
  const reason = screenPersistText(text, field, NOTES_STORE);
  if (!reason) return null;
  try {
    // The shared sentence ends "replayed forever", which is true for the memory
    // index and NOT for .agent/notes/ — nothing reads that directory back. Add
    // the accurate clause for this store rather than forking the message, which
    // would fork the pattern-class wording (and its never-echo-the-secret
    // guarantee) along with it.
    process.stderr.write(
      `ox: warning: ${reason} This store has no prompt reader today; it is refused because the credential ` +
        'would sit in a plaintext file and in that file\'s own name.\n'
    );
  } catch {}
  return reason;
}

// Exactly what the note will contain for one list item. checkpointListBlock
// collapses whitespace, trims and caps at 300 chars, so the screen has to see THAT
// string: screening the raw value would refuse a note whose credential never made
// it past the 300-char cap on the grounds that the raw string carried one.
function noteItemText(x) {
  return String(x ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
}

// Structured early session note (MiMo checkpoint-writer style). Fixed 11-field
// template, hard-capped at MAX_CHECKPOINT_LINES; keeps the newest
// MAX_CHECKPOINTS files and ARCHIVES the rest under notes/archive/. Never throws
// — callers may fire-and-forget it.
// Distinct from src/checkpoints.js (file-snapshot undo): notes live under
// .agent/notes/ so the two systems never collide on a directory name.
export function writeSessionNote(cwd, opts = {}) {
  try {
    const root = path.resolve(cwd ?? process.cwd());
    const goal = String(opts.goal ?? '').replace(/\s+/g, ' ').trim() || '(no goal recorded)';
    const status = String(opts.status ?? 'ok').replace(/\s+/g, ' ').trim() || 'ok';
    const phase = String(opts.phase ?? 'general').replace(/\s+/g, ' ').trim() || 'general';
    const model = String(opts.model ?? '(unknown)');
    const date = new Date().toISOString();
    const tokensIn = Number(opts.tokensIn) || 0;
    const tokensOut = Number(opts.tokensOut) || 0;
    const costRaw = Number(opts.costUsd);
    const costLine =
      opts.costUsd != null && Number.isFinite(costRaw) ? `$${costRaw.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}` : '(n/a)';

    // ---- screen the BODY, before anything is created on disk ----
    for (const [field, value] of [
      ['note goal', goal.slice(0, 300)],
      ['note status', status],
      ['note phase', phase],
      ['note model', model],
    ]) {
      if (noteRefusal(field, value)) return false;
    }
    for (const [field, items] of [
      ['file path in the note', opts.files],
      ['note decision', opts.decisions],
      ['note error', opts.errors],
      ['note next step', opts.nextSteps],
    ]) {
      for (const item of Array.isArray(items) ? items : []) {
        if (noteRefusal(field, noteItemText(item))) return false;
      }
    }

    // ---- screen the FILENAME ----
    // Screening the goal is not enough on its own: the slug is a DIFFERENT string
    // (first 6 whitespace-separated words, lowercased, non-alphanumerics dropped,
    // 60-char cap), and it is a path component, not body text — it shows up in
    // `ls`, in glob results and in any index that walks the directory. Refusing is
    // the honest answer: there is no truncation of this string that provably
    // cannot leave key material behind, because slugify can move a prefix such as
    // `sk-` out of the 60-char window while leaving the tail inside it. A goal
    // that screens clean slugifies clean, so this only fires as a backstop — and
    // when it does, no note is written at all.
    const slug = slugify(goal, 'checkpoint');
    if (noteRefusal('note filename', slug)) return false;

    const dir = notesDir(root);
    fs.mkdirSync(dir, { recursive: true });
    // isoStamp() has millisecond resolution, so two checkpoints in the same
    // millisecond with the same goal slug produced the SAME path and the second
    // write silently overwrote the first. Narrow, but it is a real loss path,
    // and a checkpoint is exactly the artefact an operator cannot reconstruct.
    const wanted = `${isoStamp()}-${slug}.md`;
    const file = uniquePathIn(dir, wanted);
    if (path.basename(file) !== wanted) {
      recordLoss({
        store: 'checkpoints',
        event: 'note-name-taken',
        action: 'uniquified',
        reason: 'same-ms-same-slug',
        artifact: file,
        detail: `base=${slug}`,
      });
    }

    const lines = [
      `# Checkpoint ${phase}`,
      '',
      `- Goal: ${goal.slice(0, 300)}`,
      `- Status: ${status}`,
      `- Phase: ${phase}`,
    ];
    checkpointListBlock(lines, 'Files touched', opts.files, 12);
    checkpointListBlock(lines, 'Decisions', opts.decisions, 8);
    checkpointListBlock(lines, 'Errors seen', opts.errors, 8);
    checkpointListBlock(lines, 'Next steps', opts.nextSteps, 8);
    lines.push(
      `- Tokens in-out: ${tokensIn} / ${tokensOut}`,
      `- Cost USD: ${costLine}`,
      `- Model: ${model}`,
      `- Date: ${date}`,
      ''
    );
    fs.writeFileSync(file, `${lines.slice(0, MAX_CHECKPOINT_LINES).join('\n')}\n`);

    // ---- keep the newest MAX_CHECKPOINTS, ARCHIVE the rest -----------------
    // This used to be `fs.rmSync(path.join(dir, victim), { force: true })`,
    // oldest-first, with no ledger row, no notice and no copy anywhere. The
    // store is currently sitting at exactly MAX_CHECKPOINTS notes, so the next
    // checkpoint deleted one for real.
    //
    // The archive lives at notes/archive/, a sibling of the note it came from,
    // so `ls .agent/notes/archive/` is the visible index of everything the cap
    // pushed out. (It is inside .agent/, so it also counts toward
    // MAX_AGENT_DIR_BYTES — see ARCHIVE_NOTE for why that trade is accepted.)
    //
    // If a note cannot be archived — unreadable, or a credential-shaped
    // artefact the screen refuses to move to a second path — it is KEPT and
    // the loop stops. Losing a note is never the fallback.
    const archiveDir = path.join(dir, 'archive');
    let entries = [];
    try {
      entries = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
    } catch {}
    let archivedCount = 0;
    while (entries.length > MAX_CHECKPOINTS) {
      const victim = entries.shift();
      const res = archiveFile(path.join(dir, victim), {
        destDir: archiveDir,
        label: 'archived checkpoint',
        screenStore: NOTES_STORE,
        store: 'checkpoints',
        event: 'checkpoint-evicted',
        reason: `over-${MAX_CHECKPOINTS}`,
      });
      if (!res.archived) {
        lossNotice(
          `kept ${victim} in place instead of archiving it (${res.reason}); ` +
            `${entries.length + 1} checkpoint(s) now exceed the ${MAX_CHECKPOINTS} cap and nothing was deleted.`
        );
        break;
      }
      archivedCount += 1;
    }
    if (archivedCount) {
      lossNotice(
        `archived ${archivedCount} checkpoint(s) past the ${MAX_CHECKPOINTS}-note cap → ${archiveDir} ` +
          `(nothing deleted). Ledger: ${lossLedgerPath()}`
      );
    }
    return true;
  } catch {
    return false;
  }
}
