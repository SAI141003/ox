// /refine -- evidence-backed refinement of SUPPLEMENTAL harness state, with
// snapshots and rollback.
//
// Adapted from PrimeIntellect-ai/prime-agent (MIT): "the harness can improve:
// /refine reviews the current trajectory and can apply small, evidence-backed
// updates to supplemental harness state. It never rewrites the immutable base
// system prompt, and recorded snapshots support rollback."
//
// Three rules make this safe rather than merely useful:
//
//  1. EVIDENCE. A proposal without a transcript quote is not a proposal. The
//     quote must actually appear in the transcript being refined, and it may be
//     scoped to one event index so "the error at [42]" is checkable rather than
//     vibes. Evidence is verified BEFORE the evidence gate runs, because a
//     quote that is not in the transcript proves nothing about quality.
//
//  2. ONE GATE. The quality bar is `episodePromotionQualifies` (src/memory.js),
//     the SAME predicate `ox episode promote` runs. It was extracted from
//     promoteEpisode's body precisely so this module cannot ship a second,
//     weaker copy: >=1 lesson AND (score >= 6 OR verified). Nothing here
//     re-derives the threshold.
//
//  3. STRUCTURAL IMMUTABILITY. There is no free-form path anywhere in this
//     module. A proposal names a CATEGORY and a target NAME; one of five
//     hardcoded resolvers turns that into exactly one writable path under the
//     workspace or the sandboxed home. On top of that, every raw target and
//     every resolved path is screened against IMMUTABLE_TARGETS (base system
//     prompt, sandbox profiles, trust levels, approval policy, cost caps,
//     credentials) and against the harness source tree. A refinement cannot
//     reach those files because no resolver can produce their path -- the
//     screen is the second line, not the first.
//
// SCOPE, stated so nobody has to guess: this refines the four SUPLEMENTAL
// stores Prime Agent names -- supplemental prompt guidance, memories, skill
// descriptions, subagent specs -- and, through a fifth category, AUTHORs one
// new skill from the same evidence, past the same gate, into the same directory
// `ox skill new` scaffolds. Authoring is bounded to a single SKILL.md under a
// size cap; /refine still does not review or package executable skills beyond
// that, and it does not decide any of its own proposals: `/refine apply`
// defaults to a dry run and a human (or an explicit apply) says yes.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MEMORY_INDEX,
  createMemoryApi,
  episodePromotionQualifies,
  promotionRefusalReason,
  screenPersistText,
} from './memory.js';
import { findSkillDir, parseSkillMd, NAME_RE } from './skills.js';
import { latestSessionFile, loadSession } from './session.js';

export const REFINE_STATE_DIRNAME = 'refine';
export const REFINE_HISTORY_NAME = 'history.jsonl';
export const REFINE_SNAPSHOT_DIRNAME = 'snapshots';

// The name of the gate in every verdict, so history and tests can point at the
// one rule that was consulted instead of trusting that a rule was consulted.
export const REFINE_GATE = 'promoteEpisode';

// The four categories that EDIT state which already exists.
//
// `new-skill` CREATES a file, so it lives in its own list rather than being
// folded in here. That is not bookkeeping: "refine what is already there" and
// "make something that was not there" have different failure modes, and the
// immutability argument for a file-creating category has to be read on its own.
// Callers that need "everything /refine accepts" want ALL_REFINE_CATEGORIES.
export const REFINE_CATEGORIES = Object.freeze([
  'supplemental-prompt',
  'memory',
  'skill-description',
  'subagent-spec',
]);

// Authoring from evidence. Same evidence, same gate, same screen -- new blast
// radius, so the extra refusals live with it (see newSkillNameRefusal and
// buildSkillMd below).
export const NEW_SKILL_CATEGORY = 'new-skill';
export const REFINE_CREATION_CATEGORIES = Object.freeze([NEW_SKILL_CATEGORY]);
export const ALL_REFINE_CATEGORIES = Object.freeze([...REFINE_CATEGORIES, ...REFINE_CREATION_CATEGORIES]);

// "Small and reviewable" has to be a number or it is a vibe. Each EDIT category
// is ONE line (or one field value) inside a hard cap: a reviewer reads a diff of
// two lines, not a new document.
//
// `new-skill` is the one category whose unit is a document, because a SKILL.md
// is a document. Its cap is therefore much larger and, deliberately, still a
// cap: a skill that needs 4000 characters is two skills, and a skill that needs
// 40,000 is a repository, not a refinement.
export const CATEGORY_LIMITS = Object.freeze({
  'supplemental-prompt': Object.freeze({ maxChars: 200, maxLines: 1 }),
  memory: Object.freeze({ maxChars: 240, maxLines: 1 }),
  'skill-description': Object.freeze({ maxChars: 300, maxLines: 1 }),
  'subagent-spec': Object.freeze({ maxChars: 300, maxLines: 1 }),
  'new-skill': Object.freeze({ maxChars: 4000, maxLines: 120 }),
});

// Fields that mean "here is the whole artifact". A refinement is a delta; a
// wholesale rewrite is a different operation with a different reviewer, and it
// is refused rather than quietly shrunk.
const WHOLESALE_FIELDS = ['content', 'body', 'file', 'path', 'raw', 'document', 'replaceAll', 'full'];

export const MEMORY_TYPES = Object.freeze(['user', 'feedback', 'project', 'lesson']);

// ---- immutable targets ------------------------------------------------------
//
// Each rule is (id, human label, segment predicate). The predicate runs on the
// RAW target string and again on the RESOLVED absolute path, so neither
// `system-prompt.js` nor `../ox/src/system-prompt.js` gets through.
//
// Matching is done on PATH SEGMENTS rather than on the whole string: a segment
// test cannot be defeated by a separator, and it does not fire on a substring
// that happens to sit inside an unrelated name.
const HARNESS_SRC_DIR = path.dirname(fileURLToPath(import.meta.url));

function segments(p) {
  return String(p ?? '')
    .split(/[\\/]+/)
    .filter(Boolean)
    .map((s) => s.toLowerCase());
}

function hasSegment(p, re) {
  return segments(p).some((s) => re.test(s));
}

const IMMUTABLE_RULES = [
  {
    id: 'base-system-prompt',
    label: 'the base system prompt',
    test: (p) => hasSegment(p, /^(base|master|main|root)[-_]?system[-_]?prompts?(\.[a-z0-9]+)?$|^system[-_]?prompts?(\.[a-z0-9]+)?$/),
  },
  {
    id: 'sandbox-profile',
    label: 'sandbox profiles',
    test: (p) => hasSegment(p, /^sandbox([-_](profiles?|policy|config))?(\.[a-z0-9]+)?$/),
  },
  {
    id: 'trust-level',
    label: 'trust levels',
    test: (p) => hasSegment(p, /^trust([-_](gate|levels?|policy|config))?(\.[a-z0-9]+)?$/),
  },
  {
    id: 'approval-policy',
    label: 'the approval policy',
    test: (p) => hasSegment(p, /^approvals?([-_](modes?|policy|config))?(\.[a-z0-9]+)?$/),
  },
  {
    id: 'cost-cap',
    label: 'cost caps',
    test: (p) => hasSegment(p, /^(cost|usage|budget)([-_](caps?|limits?|budgets?))?(\.[a-z0-9]+)?$/),
  },
  {
    id: 'api-key',
    label: 'API keys and credentials',
    test: (p) =>
      hasSegment(p, /^\.env(\.[a-z0-9]+)?$/) ||
      hasSegment(p, /^(auth|credential(s)?|secret(s)?|api[-_]?keys?|apikeys?|access[-_]?keys?|service[-_]?account|tokens?|keys?)(\.[a-z0-9]+)?$/) ||
      hasSegment(p, /\.(pem|p12|pfx|key)$/),
  },
  {
    id: 'harness-source',
    label: 'the ox harness source tree',
    // Nothing inside ox's own src/ is supplemental state, whatever it is
    // called. This compares the RESOLVED path against the directory this module
    // lives in, so a user project that happens to sit under a directory named
    // `src` is not mistaken for the harness.
    test: (p) => /(^|[\\/])src[\\/]/.test(p),
    resolvedTest: (p) => inside(p, HARNESS_SRC_DIR),
  },
];

// A proposal can name the forbidden thing in its CATEGORY instead of its target
// (`{ category: 'system-prompt' }`). That is a refusal too, and it says which.
const IMMUTABLE_CATEGORY_ALIASES = Object.freeze({
  'system-prompt': 'base-system-prompt',
  systemprompt: 'base-system-prompt',
  'base-system-prompt': 'base-system-prompt',
  sandbox: 'sandbox-profile',
  'sandbox-profile': 'sandbox-profile',
  'sandbox-profiles': 'sandbox-profile',
  trust: 'trust-level',
  'trust-level': 'trust-level',
  'trust-levels': 'trust-level',
  approval: 'approval-policy',
  'approval-policy': 'approval-policy',
  cost: 'cost-cap',
  'cost-cap': 'cost-cap',
  'cost-caps': 'cost-cap',
  budget: 'cost-cap',
  'api-key': 'api-key',
  'api-keys': 'api-key',
  apikey: 'api-key',
  auth: 'api-key',
  credential: 'api-key',
  credentials: 'api-key',
  secret: 'api-key',
  secrets: 'api-key',
  keys: 'api-key',
});

export const IMMUTABLE_TARGETS = Object.freeze(
  IMMUTABLE_RULES.map((r) => Object.freeze({ id: r.id, label: r.label }))
);

export function immutabilityVerdict(rawPath, { resolved = false } = {}) {
  const p = String(rawPath ?? '');
  if (!p.trim()) return null;
  for (const r of IMMUTABLE_RULES) {
    try {
      const hit = resolved && r.resolvedTest ? r.resolvedTest(p) : r.test(p);
      if (hit) return { id: r.id, label: r.label };
    } catch {}
  }
  return null;
}

// ---- paths ------------------------------------------------------------------

function stateDir(cwd) {
  return path.join(path.resolve(cwd), '.agent', REFINE_STATE_DIRNAME);
}

function historyPath(cwd) {
  return path.join(stateDir(cwd), REFINE_HISTORY_NAME);
}

function snapshotDir(cwd) {
  return path.join(stateDir(cwd), REFINE_SNAPSHOT_DIRNAME);
}

function isoStamp(d = new Date()) {
  return new Date(d).toISOString().replace(/[:.]/g, '-');
}

function readFileOr(file, fallback = null) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return fallback;
  }
}

// A skill/slug-shaped name. Used where the name becomes a PATH SEGMENT, so a
// `../` can never be smuggled through a target field.
function safeName(name) {
  const n = String(name ?? '').trim();
  return NAME_RE.test(n) ? n : null; // skills.js NAME_RE -- the loader's own rule
}

function inside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// ---- target resolution ------------------------------------------------------
//
// The ONLY place a writable path is produced. Five categories, five resolvers,
// five fixed roots. A target that does not resolve here does not get written.

export const SUPPLEMENTAL_FILE = '.ox.md'; // context.js INSTRUCTION_FILENAMES
export const REFINE_BLOCK_BEGIN = '<!-- ox:refine:begin -->';
export const REFINE_BLOCK_END = '<!-- ox:refine:end -->';

// Which root each category may write under. A skill description lives wherever
// the skill already lives (workspace or home); a subagent spec is home state by
// definition; the other two are per-project.
const CATEGORY_ROOTS = Object.freeze({
  'supplemental-prompt': Object.freeze(['cwd']),
  memory: Object.freeze(['cwd']),
  'skill-description': Object.freeze(['cwd', 'home']),
  'subagent-spec': Object.freeze(['home']),
  // Home only, and deliberately: this is the directory `ox skill new` scaffolds
  // and the one `episode promote` writes into, so a skill /refine authors is
  // discovered by exactly the scan a human-authored one is. Writing a second
  // copy into a project would create two skills with one name, which is the
  // duplicate this category refuses to produce.
  'new-skill': Object.freeze(['home']),
});

// The ONLY per-category operations /refine performs. Anything else is a bigger
// edit than a one-line refinement and is refused as out of policy.
const ALLOWED_OPERATIONS = Object.freeze({
  'supplemental-prompt': Object.freeze([]),
  memory: Object.freeze([]),
  'skill-description': Object.freeze(['set-description']),
  'subagent-spec': Object.freeze(['append-system-prompt', 'add-skill', 'remove-skill']),
  // The category IS the operation. There is no verb to allow, so an `operation`
  // field on a new-skill proposal is refused rather than ignored.
  'new-skill': Object.freeze([]),
});

// `replace` is NOT a general escape hatch: it is one boolean, it is only read by
// the new-skill resolver, and it is only honoured for a skill that already lives
// in the one directory this category writes. It exists so a human can say "yes,
// overwrite that one" out loud, which is the opposite of a silent duplicate.
export function resolveTarget({ cwd, home = os.homedir(), category, target, replace = false } = {}) {
  const root = path.resolve(cwd ?? process.cwd());
  const t = String(target ?? '').trim();

  // Screen the RAW target first. This is what makes a tampered
  // `target: 'src/system-prompt.js'` an explicit refusal instead of a silently
  // ignored field on an otherwise-valid proposal.
  const rawHit = immutabilityVerdict(t);
  if (rawHit) return refuseImmutable(rawHit, t);

  // And the category itself: `{ category: 'system-prompt' }` is naming the
  // forbidden thing, and is refused as that rather than as a typo.
  const alias = IMMUTABLE_CATEGORY_ALIASES[String(category ?? '').toLowerCase().trim()];
  if (alias) {
    const rule = IMMUTABLE_RULES.find((r) => r.id === alias);
    return refuseImmutable({ id: alias, label: rule?.label ?? alias }, String(category));
  }

  if (!ALL_REFINE_CATEGORIES.includes(category)) {
    return {
      ok: false,
      kind: 'unknown-category',
      message: `/refine: '${category ?? '(none)'}' is not a refinable category. Refusable categories: ${ALL_REFINE_CATEGORIES.join(', ')}.`,
    };
  }
  if (!t) {
    return { ok: false, kind: 'unknown-target', message: `/refine: ${category} needs a target name.` };
  }

  let abs = null;
  const extraPaths = [];
  let item = null;

  if (category === 'supplemental-prompt') {
    // One guidance file, one marked block. Refine can ADD a bullet between the
    // markers and can remove one on undo; it can never rewrite the file, and
    // it can never name a different file.
    abs = path.join(root, SUPPLEMENTAL_FILE);
    item = 'guidance-line';
  } else if (category === 'memory') {
    // memory.js owns the line format and the screen; refine hands it a
    // statement and captures the two files addMemory may touch.
    const type = memoryType(t);
    if (!MEMORY_TYPES.includes(type)) {
      return {
        ok: false,
        kind: 'unknown-target',
        message: `/refine: memory target must be one of ${MEMORY_TYPES.join('|')} (optionally '<type>/<topic>'), not '${t}'.`,
      };
    }
    const topic = memoryTopic(t, type);
    if (!topic) {
      return { ok: false, kind: 'unknown-target', message: `/refine: memory topic '${t}' is not a plain slug.` };
    }
    abs = path.join(root, '.agent', MEMORY_INDEX);
    extraPaths.push(path.join(root, '.agent', 'topics', `${topic}.md`));
    item = `${type}-entry`;
  } else if (category === 'skill-description') {
    const name = safeName(t);
    if (!name) {
      return { ok: false, kind: 'unknown-target', message: `/refine: '${t}' is not a skill name (lowercase [a-z0-9-]).` };
    }
    const dir = findSkillDir({ home, cwd: root }, name);
    if (!dir) {
      return {
        ok: false,
        kind: 'not-found',
        message: `/refine: no skill '${name}' in the skill scan roots. This category edits an EXISTING description; to author a new skill, propose category 'new-skill' with target '${name}'.`,
      };
    }
    abs = path.join(dir, 'SKILL.md');
    item = 'description';
  } else if (category === NEW_SKILL_CATEGORY) {
    // The one resolver that CREATES. Three refusals stand between a proposal and
    // a directory on disk, and all three are here rather than at the write, so
    // they are reported as themselves instead of as a failed write.
    const name = safeName(t);
    if (!name) {
      return {
        ok: false,
        kind: 'unknown-target',
        message: `/refine: '${t}' is not a skill name (lowercase [a-z0-9-]). new-skill names the skill it creates; there is no anonymous skill.`,
      };
    }
    const dir = path.join(path.resolve(home), '.agents', 'skills', name);
    abs = path.join(dir, 'SKILL.md');
    item = 'skill';

    // (1) The name is already taken in ANOTHER scan root. Creating a second
    // directory with the same name does not create a second skill: discoverSkills
    // keys by name and the later scan root wins, so one copy would be silently
    // invisible while `ox skill ls` still lists two. Refused regardless of
    // `replace` -- replacing a copy in a root /refine does not write is not
    // something a proposal can ask for.
    const found = findSkillDir({ home, cwd: root }, name);
    if (found && path.resolve(found) !== path.resolve(dir)) {
      return {
        ok: false,
        kind: 'duplicate-skill',
        message:
          `/refine: refusing to create '${name}' -- a skill with that name already exists at ${found}, ` +
          `a different scan root than the one new-skill writes (${dir}). Two directories with one name means one of them is ` +
          'invisible to the loader. Move or remove that skill yourself, then propose again.',
      };
    }
    // (2) The name is taken in the directory /refine writes. Overwriting is
    // never silent: without an explicit `replace: true` it is a refusal that
    // names the directory, and with it the prior bytes are snapshotted so undo
    // puts them back.
    if (fs.existsSync(dir)) {
      let isDir = false;
      try {
        isDir = fs.statSync(dir).isDirectory();
      } catch {}
      if (!isDir) {
        return {
          ok: false,
          kind: 'duplicate-skill',
          message: `/refine: refusing to create '${name}' -- ${dir} exists and is not a directory. Move it aside yourself.`,
        };
      }
      if (replace !== true) {
        return {
          ok: false,
          kind: 'duplicate-skill',
          message:
            `/refine: refusing to overwrite the existing skill '${name}' at ${dir}. /refine does not silently ` +
            'replace a skill a human may have hand-edited. Re-propose with replace: true to overwrite it (the current SKILL.md is ' +
            'snapshotted first and /refine undo restores it byte-for-byte), or use `ox skill rm` if you meant to delete it.',
        };
      }
    }
  } else {
    // subagent-spec
    const name = safeName(t);
    if (!name) {
      return { ok: false, kind: 'unknown-target', message: `/refine: '${t}' is not a subagent name (lowercase [a-z0-9-]).` };
    }
    abs = path.join(path.resolve(home), '.ox', 'agents', `${name}.json`);
    item = 'subagent-spec';
  }

  // Second line: the resolved path, not just the string the caller sent.
  const absHit = immutabilityVerdict(abs, { resolved: true });
  if (absHit) return refuseImmutable(absHit, abs);

  // Third line: the path must live under a root refine owns. This is what makes
  // the guarantee structural rather than conventional -- a bug in a resolver
  // still cannot produce a write outside these roots.
  const roots = CATEGORY_ROOTS[category].map((which) => (which === 'home' ? path.resolve(home) : root));
  if (!roots.some((r) => inside(abs, r))) {
    return {
      ok: false,
      kind: 'immutable',
      immutable: { id: 'out-of-root', label: 'a path outside the refinable roots' },
      message: `/refine: refusing '${abs}' -- a refinement may only touch supplemental state under ${roots.join(' or ')}.`,
    };
  }

  return { ok: true, path: abs, paths: [abs, ...extraPaths], item, category, target: t };
}

function refuseImmutable(hit, shown) {
  return {
    ok: false,
    kind: 'immutable',
    immutable: { id: hit.id, label: hit.label },
    message:
      `/refine: refusing to target ${hit.label} ('${shown}'). ` +
      '/refine may only refine supplemental prompt guidance, memories, skill descriptions and subagent specs, or author one new skill. ' +
      'The base system prompt, sandbox profiles, trust levels, the approval policy, cost caps, and credentials are not refinable.',
  };
}

// `type` or `type/topic`, defaulting to lesson/gotchas (memory.js's own default).
function memoryType(raw) {
  const head = String(raw ?? '').split('/')[0];
  return head ? head.toLowerCase() : null;
}

function memoryTopic(raw, type) {
  const parts = String(raw ?? '').split('/');
  const topic = (parts[1] ?? (type === 'lesson' ? 'gotchas' : type)).trim();
  return safeName(topic) ? topic : null;
}

// ---- evidence ---------------------------------------------------------------

export const EVIDENCE_MIN_CHARS = 12;

function normText(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

export function verifyEvidence(proposal, trajectory) {
  const ev = proposal?.evidence;
  const quote = normText(typeof ev === 'string' ? ev : ev?.quote);
  const base = '/refine: refusing this proposal';
  if (!quote) {
    return {
      ok: false,
      kind: 'no-evidence',
      message: `${base}: it carries no transcript evidence. Quote the trajectory line that justifies it (evidence: "..."). A proposal with no evidence is not a proposal.`,
    };
  }
  if (quote.length < EVIDENCE_MIN_CHARS) {
    return {
      ok: false,
      kind: 'no-evidence',
      message: `${base}: its evidence quote is ${quote.length} chars; a quote has to be long enough (>= ${EVIDENCE_MIN_CHARS}) to identify anything in the transcript.`,
    };
  }
  const hay = normText(trajectory?.text ?? '');
  if (!hay) {
    return {
      ok: false,
      kind: 'no-evidence',
      message: `${base}: there is no transcript to verify its evidence against. Pass a session file or the current trajectory.`,
    };
  }
  const offset = hay.indexOf(quote);
  if (offset < 0) {
    return {
      ok: false,
      kind: 'unverified-evidence',
      message: `${base}: its evidence quote does not appear in the transcript. Quoting something that never happened is the failure mode this check exists for.`,
    };
  }
  const at = typeof ev === 'object' && ev?.event != null ? Number(ev.event) : null;
  if (at != null) {
    const evs = trajectory?.events ?? [];
    if (!Number.isInteger(at) || at < 0 || at >= evs.length) {
      return {
        ok: false,
        kind: 'unverified-evidence',
        message: `${base}: it cites event ${ev?.event}, which is not an event in this transcript (${evs.length} events).`,
      };
    }
    if (!normText(eventLine(evs[at], at)).includes(quote)) {
      return {
        ok: false,
        kind: 'unverified-evidence',
        message: `${base}: it cites event ${at} but the quote is not inside that event.`,
      };
    }
  }
  return { ok: true, evidence: { quote, event: at, offset } };
}

// ---- smallness / policy -----------------------------------------------------

function wordSet(s) {
  return new Set(normText(s).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
}

export function checkSmallness(proposal) {
  const cat = proposal?.category;
  const limits = CATEGORY_LIMITS[cat];
  const label = cat ?? 'proposal';
  if (!limits) {
    return { ok: false, kind: 'unknown-category', message: `/refine: '${cat ?? '(none)'}' is not a refinable category.` };
  }
  if (proposal.operation != null) {
    const allowed = ALLOWED_OPERATIONS[cat] ?? [];
    const op = String(proposal.operation);
    if (!allowed.includes(op)) {
      return {
        ok: false,
        kind: 'out-of-policy',
        message:
          `/refine: out of policy -- operation '${op}' rewrites more than a ${label} refinement. ` +
          (allowed.length ? `Allowed here: ${allowed.join(', ')}.` : `No operation is allowed for ${label}; the text IS the change.`),
      };
    }
  }
  for (const f of WHOLESALE_FIELDS) {
    if (proposal[f] != null) {
      return {
        ok: false,
        kind: 'out-of-policy',
        message:
          `/refine: out of policy -- the proposal carries '${f}', which is a whole-artifact replacement. ` +
          '/refine applies small, reviewable deltas; a wholesale rewrite needs a human reviewer and is not applied here.',
      };
    }
  }
  const text = typeof proposal.text === 'string' ? proposal.text : '';
  const body = text.trim();
  if (!body) {
    return { ok: false, kind: 'out-of-policy', message: `/refine: out of policy -- a ${label} refinement needs non-empty 'text'.` };
  }
  const lines = body.split('\n').filter((l) => l.trim());
  if (lines.length > limits.maxLines) {
    return {
      ok: false,
      kind: 'out-of-policy',
      message:
        `/refine: out of policy -- a ${label} refinement is ${lines.length} lines; the cap is ${limits.maxLines}. ` +
        'Propose the one lesson the evidence supports, not a document.',
    };
  }
  if (body.length > limits.maxChars) {
    return {
      ok: false,
      kind: 'out-of-policy',
      message: `/refine: out of policy -- a ${label} refinement is ${body.length} chars; the cap is ${limits.maxChars}.`,
    };
  }
  return { ok: true, text: body, limits };
}

// A skill description is an EDIT to an existing string, not a new one. If the
// proposal keeps less than half of what was there, it is a rewrite wearing a
// delta's clothes.
export function checkDescriptionDelta(before, after) {
  const oldText = normText(before);
  const newText = normText(after);
  if (oldText.length < 40) return { ok: true };
  const oldWords = wordSet(oldText);
  const newWords = wordSet(newText);
  let kept = 0;
  for (const w of oldWords) if (newWords.has(w)) kept += 1;
  const ratio = oldWords.size ? kept / oldWords.size : 0;
  if (ratio < 0.5) {
    return {
      ok: false,
      kind: 'out-of-policy',
      message:
        `/refine: out of policy -- the proposed description keeps only ${Math.round(ratio * 100)}% of the words it replaces. ` +
        'That is a wholesale rewrite, not a small edit. Reword the line that was wrong instead of replacing the whole description.',
    };
  }
  return { ok: true };
}

// ---- trajectory -------------------------------------------------------------

const SKIP_KEYS = new Set(['t']);

function flattenValue(v, cap = 400) {
  if (v == null) return '';
  if (typeof v === 'string') return normText(v).slice(0, cap);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return normText(JSON.stringify(v)).slice(0, cap);
}

// One searchable line per event. Evidence quotes are matched against THIS, so
// a quote can only ever point at something the transcript really recorded.
export function eventLine(ev, i) {
  const parts = [];
  for (const k of Object.keys(ev ?? {})) {
    if (SKIP_KEYS.has(k)) continue;
    const v = flattenValue(ev[k]);
    if (v) parts.push(`${k}=${v}`);
  }
  return `[${i}] ${String(ev?.t ?? '?')} ${parts.join(' ')}`.replace(/\s+/g, ' ').trim();
}

export function renderTrajectory(events = []) {
  return events.map((ev, i) => eventLine(ev, i)).join('\n');
}

export function loadTrajectory({ cwd, home = os.homedir(), sessionFile = null, events = null } = {}) {
  if (Array.isArray(events)) {
    return { file: null, events, text: renderTrajectory(events) };
  }
  const root = path.resolve(cwd ?? process.cwd());
  const file = sessionFile ?? latestSessionFile(root) ?? latestSessionFile();
  if (!file) return { file: null, events: [], text: '' };
  let evs = [];
  try {
    evs = loadSession(file);
  } catch {
    return { file, events: [], text: '' };
  }
  return { file, events: evs, text: renderTrajectory(evs) };
}

// ---- the heuristic proposer -------------------------------------------------
//
// Evidence first: every proposal here is minted from a line that is really in
// the transcript, so `evidence.quote` is that line and `evidence.event` is its
// index. There is nothing to fabricate, which is the point -- if the transcript
// shows no failure, /refine proposes nothing.

const FAILURE_HINTS = [
  { re: /permission|denied|forbidden|EACCES|not permitted/i, hint: 'check approval and the path before retrying' },
  { re: /not found|no such file|ENOENT|does not exist/i, hint: 'verify the path with list_dir/glob before reading' },
  { re: /timeout|timed out|ETIMEDOUT/i, hint: 'narrow the scope or raise the timeout, do not re-run it unchanged' },
  { re: /EADDRINUSE|port already in use|EEXIST/i, hint: 'pick a free port instead of restarting the same one' },
  { re: /Cannot find module/i, hint: 'confirm the dependency is installed before importing it' },
];

function hintFor(text) {
  for (const h of FAILURE_HINTS) if (h.re.test(text)) return h.hint;
  return 'vary the approach; never repeat an identical failed call';
}

function failureLines(events) {
  const out = [];
  events.forEach((ev, i) => {
    const isErr = ev?.t === 'tool-result' ? ev.isError === true : null;
    const errText = typeof ev?.error === 'string' && ev.error ? ev.error : null;
    if (!isErr && !errText) return;
    const body = errText ?? flattenValue(ev?.content, 200);
    if (!body) return;
    out.push({ i, line: eventLine(ev, i), name: String(ev?.name ?? 'the tool'), body });
  });
  return out;
}

export function proposeRefinements({ trajectory, limit = 3 } = {}) {
  const events = trajectory?.events ?? [];
  const proposals = [];
  const seen = new Set();
  const failures = failureLines(events);

  for (const f of failures) {
    const key = `${f.name}:${hintFor(f.body)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const hint = hintFor(f.body);
    const text = `When ${f.name} fails, ${hint}`.slice(0, CATEGORY_LIMITS['supplemental-prompt'].maxChars);
    proposals.push({
      category: 'supplemental-prompt',
      target: 'tool-failures',
      text,
      rationale: `${f.name} failed in the trajectory and the failure class is repeatable.`,
      evidence: { quote: f.line, event: f.i },
    });
    if (proposals.length >= limit) break;
  }

  // A tool that failed more than once earns its own lesson, whatever the
  // individual errors said.
  const counts = new Map();
  for (const f of failures) counts.set(f.name, (counts.get(f.name) ?? 0) + 1);
  for (const [name, n] of counts) {
    if (n < 2) continue;
    const first = failures.find((f) => f.name === name);
    proposals.push({
      category: 'memory',
      target: 'lesson/gotchas',
      text: `${name} failed ${n} times in one session; ${hintFor(first.body)}`,
      rationale: `Repeat failure in the trajectory: ${name} x${n}.`,
      evidence: { quote: first.line, event: first.i },
    });
    break;
  }

  return proposals;
}

export function loadProposalFile(file) {
  const text = readFileOr(file);
  if (text == null) return { ok: false, message: `/refine: cannot read proposals from ${file}.` };
  try {
    const parsed = JSON.parse(text);
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.proposals) ? parsed.proposals : null;
    if (!list) return { ok: false, message: `/refine: ${file} must be a JSON array of proposals, or {"proposals": [...]}.` };
    return { ok: true, proposals: list };
  } catch (e) {
    return { ok: false, message: `/refine: ${file} is not valid JSON: ${String((e && e.message) || e)}` };
  }
}

// ---- planning (pure: computes new content, writes nothing) -------------------

function upsertBlock(existing, bullet) {
  const line = `- ${bullet}`;
  const head = existing == null ? '' : existing;
  const begin = head.indexOf(REFINE_BLOCK_BEGIN);
  const end = head.indexOf(REFINE_BLOCK_END);
  if (begin >= 0 && end > begin) {
    const inner = head.slice(begin + REFINE_BLOCK_BEGIN.length, end);
    if (inner.split('\n').some((l) => l.trim() === line)) return { text: head, unchanged: true };
    const block = `${REFINE_BLOCK_BEGIN}\n${inner.replace(/\n*$/, '\n')}${line}\n${REFINE_BLOCK_END}`;
    return { text: head.slice(0, begin) + block + head.slice(end + REFINE_BLOCK_END.length), unchanged: false };
  }
  const sep = head && !head.endsWith('\n') ? '\n' : '';
  return {
    text: `${head}${sep}${begin < 0 ? '\n' : ''}${REFINE_BLOCK_BEGIN}\n${line}\n${REFINE_BLOCK_END}\n`,
    unchanged: false,
  };
}

function setDescription(raw, next) {
  const m = raw.match(/^([ \t]*description:[ \t]*)(.*)$/m);
  if (!m) return null;
  const line = `${m[1]}${next.replace(/\s+/g, ' ').trim()}`;
  const end = m.index + m[0].length;
  return raw.slice(0, m.index) + line + raw.slice(end);
}

function currentDescription(raw) {
  return raw.match(/^description:[ \t]*(.*)$/m)?.[1] ?? '';
}

function patchSubagentSpec(raw, proposal, text) {
  let spec;
  try {
    spec = JSON.parse(raw);
  } catch {
    return { error: 'the subagent spec is not valid JSON; refusing to rewrite a file refine cannot parse.' };
  }
  const op = String(proposal.operation ?? 'append-system-prompt');
  const next = { ...spec };
  if (op === 'append-system-prompt') {
    const base = String(spec.systemPrompt ?? '').replace(/\s+$/, '');
    next.systemPrompt = base ? `${base}\n${text}` : text;
    next.updatedAt = new Date().toISOString();
    return { value: JSON.stringify(next, null, 2) + '\n' };
  }
  if (op === 'add-skill' || op === 'remove-skill') {
    const want = safeName(String(proposal.skill ?? proposal.target ?? ''));
    const list = Array.isArray(spec.skills) ? spec.skills.slice() : [];
    const has = list.includes(want);
    if (op === 'add-skill') {
      if (!want) return { error: `add-skill needs a lowercase [a-z0-9-] skill name, not '${proposal.skill ?? proposal.target}'.` };
      if (has) return { unchanged: true };
      list.push(want);
    } else {
      if (!has) return { unchanged: true };
      list.splice(list.indexOf(want), 1);
    }
    next.skills = list;
    next.updatedAt = new Date().toISOString();
    return { value: JSON.stringify(next, null, 2) + '\n' };
  }
  return { error: `operation '${op}' is not refinable. /refine edits only: append-system-prompt, add-skill, remove-skill.` };
}

// Refuses a proposal that tries to move a subagent's provider/model/baseUrl or
// MCP wiring. Those are harness configuration, not a supplemental spec.
const SUBAGENT_HARNESS_FIELDS = Object.freeze([
  'provider',
  'model',
  'baseUrl',
  'mcpServers',
  'apiKey',
  'costCap',
  'sandbox',
  'trust',
  'approval',
]);

function subagentFieldRefusal(proposal) {
  for (const f of SUBAGENT_HARNESS_FIELDS) {
    if (proposal[f] != null) {
      return {
        ok: false,
        kind: 'out-of-policy',
        message:
          `/refine: out of policy -- '${f}' is harness configuration ` +
          `(${/^(provider|model|baseUrl)$/.test(f) ? 'provider wiring' : f === 'apiKey' ? 'a credential' : 'policy/cost state'}), ` +
          'not a supplemental subagent spec. /refine refuses it.',
      };
    }
  }
  return { ok: true };
}

// ---- authoring a new skill -------------------------------------------------
//
// A skill is a document, so this one does not set a line in an existing file: it
// composes a whole SKILL.md and proves, BEFORE a byte is written, that the real
// loader will accept it. "A skill the scanner does not discover is not a skill" --
// so the check is parseSkillMd (src/skills.js), the same function discoverSkills
// calls, not a second, kinder front-matter reader written here.

const NEW_SKILL_MIN_DESC = 16; // short enough to type, long enough to be a description
const NEW_SKILL_MAX_DESC = 300; // the same cap skill-description edits to

function normalizeDescription(raw) {
  return String(raw ?? '').replace(/\s+/g, ' ').trim();
}

// The checks worth making in words, before the parser's verdict is turned into
// a message. parseYamlish has no quoting rules a free-text description can rely
// on, so anything it would mangle is caught by the round-trip below.
function descriptionShapeProblem(desc) {
  if (!desc) {
    return (
      'it carries no `description`. A SKILL.md with no description in its front matter is SKIPPED by the loader ' +
      '(src/skills.js: "missing description in front matter"), so /refine will not create a skill nothing can find'
    );
  }
  if (desc.length < NEW_SKILL_MIN_DESC) {
    return `its description is ${desc.length} chars; a description that says nothing useful is under ${NEW_SKILL_MIN_DESC}. Say what the skill does AND when to load it.`;
  }
  if (desc.length > NEW_SKILL_MAX_DESC) {
    return `its description is ${desc.length} chars; the cap is ${NEW_SKILL_MAX_DESC}. The detail belongs in the body, not the index line.`;
  }
  return null;
}

// The exact front matter `ox skill new` scaffolds (src/cli.js skillTemplate), plus
// the evidence index that justified the skill. No timestamp: identical input
// must produce identical bytes, so a re-apply after an undo is a no-op rather
// than a diff.
function buildSkillMd({ name, description, body, event }) {
  const meta = ['metadata:', '  source: refine'];
  if (Number.isInteger(event)) meta.push(`  evidence-event: ${event}`);
  return ['---', `name: ${name}`, `description: ${description}`, ...meta, '---', '', `# ${name}`, '', body, ''].join('\n');
}

function planItem({ resolved, proposal, text, files, evidence = null }) {
  const abs = resolved.path;
  const before = Object.prototype.hasOwnProperty.call(files, abs) ? files[abs] : null;

  if (resolved.category === NEW_SKILL_CATEGORY) {
    const name = resolved.target;
    const desc = normalizeDescription(proposal.description);
    const shape = descriptionShapeProblem(desc);
    if (shape) {
      return {
        ok: false,
        kind: 'invalid-skill',
        message: `/refine: refusing to create skill '${name}' -- ${shape}.`,
      };
    }
    // The body was already screened by applyProposals (every category goes
    // through screenPersistText). The DESCRIPTION is a second surface: it is
    // re-injected into the skill index on every single turn, so it gets the same
    // screen. memory.js decides; this only routes its verdict.
    const dblock = screenPersistText(desc, 'new-skill description', `the ${name} skill description`);
    if (dblock) {
      return { ok: false, kind: 'screen-refused', message: `/refine: ${dblock}` };
    }
    const after = buildSkillMd({ name, description: desc, body: text, event: evidence?.event ?? null });

    // The real parser, on the bytes that would be written.
    const parsed = parseSkillMd(after, abs);
    if (!parsed.ok) {
      return {
        ok: false,
        kind: 'invalid-skill',
        message: `/refine: refusing to create skill '${name}' -- the SKILL.md it would write is not loadable (${parsed.warning}). /refine does not create skills the scanner skips.`,
      };
    }
    if (parsed.skill.name !== name) {
      return {
        ok: false,
        kind: 'invalid-skill',
        message: `/refine: refusing to create skill '${name}' -- its front matter would load as '${String(parsed.skill.name).slice(0, 40)}'. The directory name and the front-matter name must agree or the loader keys the skill under a name the proposal never asked for.`,
      };
    }
    if (parsed.skill.description !== desc) {
      // Quoted, or containing ' #', or anything else parseYamlish rewrites: the
      // stored description would not be the one that was reviewed.
      return {
        ok: false,
        kind: 'invalid-skill',
        message:
          `/refine: refusing to create skill '${name}' -- its description does not survive the front-matter parser ` +
          '(leading/trailing quotes and " #" are rewritten by the loader, so the stored line would not be the reviewed one). ' +
          'Write it as plain words on one line.',
      };
    }
    if (before != null && after === before) {
      return { ok: false, kind: 'no-change', message: `/refine: skill '${name}' already reads exactly that; nothing to apply.` };
    }
    // Undo has to REMOVE this, not empty it, so the snapshot records the
    // directory -- but only when this call is what brought it into being. A
    // directory that already existed (replacing a skill whose SKILL.md was
    // absent) is left in place on undo; only the file we wrote goes.
    const dirExisted = fs.existsSync(path.dirname(abs));
    return {
      ok: true,
      after,
      item: resolved.item,
      extraPaths: [],
      createdDir: before == null && !dirExisted ? path.dirname(abs) : null,
    };
  }

  if (resolved.category === 'subagent-spec') {
    if (before == null) {
      return {
        ok: false,
        kind: 'not-found',
        message: `/refine: no subagent spec at ${abs}. /refine edits an EXISTING spec; creating one is packaging, not refining.`,
      };
    }
    const field = subagentFieldRefusal(proposal);
    if (!field.ok) return field;
    const patched = patchSubagentSpec(before, proposal, text);
    if (patched.error) return { ok: false, kind: 'out-of-policy', message: `/refine: ${patched.error}` };
    if (patched.unchanged) return { ok: false, kind: 'no-change', message: `/refine: ${resolved.target} already has that; nothing to apply.` };
    return { ok: true, after: patched.value, item: resolved.item, extraPaths: resolved.paths.slice(1) };
  }

  if (resolved.category === 'skill-description') {
    if (before == null) {
      return { ok: false, kind: 'not-found', message: `/refine: ${abs} does not exist.` };
    }
    const op = String(proposal.operation ?? 'set-description');
    if (op !== 'set-description') {
      return {
        ok: false,
        kind: 'out-of-policy',
        message: `/refine: out of policy -- skill-description operation '${op}' rewrites more than the description line.`,
      };
    }
    const delta = checkDescriptionDelta(currentDescription(before), text);
    if (!delta.ok) return delta;
    const after = setDescription(before, text);
    if (after == null) {
      return { ok: false, kind: 'out-of-policy', message: `/refine: ${abs} has no 'description:' front-matter line to refine.` };
    }
    if (after === before) return { ok: false, kind: 'no-change', message: '/refine: the description already reads that way.' };
    return { ok: true, after, item: resolved.item, extraPaths: [] };
  }

  if (resolved.category === 'supplemental-prompt') {
    const next = upsertBlock(before, text);
    if (next.unchanged) return { ok: false, kind: 'no-change', message: `/refine: that guidance line is already in ${abs}.` };
    return { ok: true, after: next.text, item: resolved.item, extraPaths: [] };
  }

  // memory: memory.js writes the line. The plan records the two files it may
  // touch so the snapshot covers both and undo restores both.
  return { ok: true, memory: true, after: null, item: resolved.item, extraPaths: resolved.paths.slice(1) };
}

// ---- preflight --------------------------------------------------------------

function preflight(dirs) {
  const created = [];
  const seen = new Set();
  try {
    for (const dir of dirs) {
      if (seen.has(dir)) continue;
      seen.add(dir);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        created.push(dir);
      }
      fs.accessSync(dir, fs.constants.W_OK);
    }
  } catch (e) {
    // Remove only the directories THIS call created, so an aborted batch does
    // not leave empty scaffolding behind pretending a refinement happened.
    for (const dir of created.slice().reverse()) {
      try {
        fs.rmdirSync(dir);
      } catch {}
    }
    return { ok: false, reason: String((e && e.message) || e) };
  }
  return { ok: true, created };
}

// ---- history ----------------------------------------------------------------

export function refineHistory({ cwd, limit = 20 } = {}) {
  const text = readFileOr(historyPath(cwd), '');
  const rows = text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return limit > 0 ? rows.slice(-limit) : rows;
}

function appendHistory(cwd, record) {
  try {
    fs.mkdirSync(stateDir(cwd), { recursive: true });
    fs.appendFileSync(historyPath(cwd), `${JSON.stringify(record)}\n`);
  } catch {}
  return record;
}

// ---- apply ------------------------------------------------------------------

// `faultAfter` is a test-only hook: it throws after N item writes so the
// restore-on-crash path can be proven without waiting for a real disk to fail.
export function applyProposals({
  cwd,
  home = os.homedir(),
  proposals = [],
  trajectory = null,
  sessionFile = null,
  dryRun = false,
  faultAfter = null,
  now = new Date(),
} = {}) {
  const root = path.resolve(cwd ?? process.cwd());
  const traj = trajectory ?? loadTrajectory({ cwd: root, home, sessionFile });
  const accepted = [];
  const rejected = [];
  const claimed = new Set();

  for (const [index, proposal] of proposals.entries()) {
    const base = { index, category: proposal?.category ?? null, target: proposal?.target ?? null };
    const fail = (kind, message, extra = {}) => rejected.push({ ...base, kind, reason: message, ...extra });

    // -- 1. evidence -------------------------------------------------------
    const evCheck = verifyEvidence(proposal, traj);
    if (!evCheck.ok) {
      fail(evCheck.kind, evCheck.message);
      continue;
    }
    // -- 2. structural immutability ---------------------------------------
    // Ahead of the size policy on purpose: a proposal that names an immutable
    // artifact is refused for THAT, whether or not it is also too big. The
    // dangerous refusal must never be reported as a formatting nit.
    const resolved = resolveTarget({
      cwd: root,
      home,
      category: proposal.category,
      target: proposal.target,
      replace: proposal.replace === true,
    });
    if (!resolved.ok) {
      fail(resolved.kind, resolved.message, resolved.immutable ? { immutable: resolved.immutable } : {});
      continue;
    }
    // -- 3. size / policy --------------------------------------------------
    const small = checkSmallness(proposal);
    if (!small.ok) {
      fail(small.kind, small.message);
      continue;
    }
    // One file, one change, per batch. Two accepted items on the same path would
    // be planned from the same pre-batch bytes, so the second write would
    // silently discard the first -- a partial-state bug wearing a success
    // message. The second proposal is refused instead.
    const clash = resolved.paths.find((p) => claimed.has(p));
    if (clash) {
      fail('duplicate-target', `/refine: refusing '${resolved.category}/${resolved.target}' -- an earlier proposal in this batch already targets ${clash}. Apply them one at a time so each change is reviewable.`);
      continue;
    }
    // -- 4. the credential/injection screen, per artifact -------------------
    const storeName = path.relative(root, resolved.path) || resolved.path;
    const blocked = screenPersistText(small.text, `${proposal.category} refinement`, storeName);
    if (blocked) {
      fail('screen-refused', `/refine: ${blocked}`);
      continue;
    }
    // -- 5. THE GATE (src/memory.js episodePromotionQualifies) ---------------
    // A refinement IS a lesson, so it is judged as one: at least one lesson
    // (guaranteed by having text) AND (score >= 6 OR verified). The score and
    // the verified flag come from the PROPOSAL -- the reviewer's judgement --
    // never from the text itself, so a model cannot vote itself past the bar by
    // writing a confident sentence.
    const gateInput = {
      lessons: [small.text],
      score: proposal.score != null ? Number(proposal.score) : null,
      verified: proposal.verified === true,
    };
    if (!episodePromotionQualifies(gateInput)) {
      const why = promotionRefusalReason(gateInput);
      fail(
        'unqualified',
        `/refine: refusing '${proposal.category}/${proposal.target}' -- ${why}. Same bar as \`ox episode promote\`: >=1 lesson AND (score >= 6 OR verified).`
      );
      continue;
    }

    // -- 6. plan the new bytes (still no writes) ----------------------------
    const files = {};
    for (const p of resolved.paths) {
      const t = readFileOr(p, undefined);
      if (t !== undefined) files[p] = t;
    }
    const plan = planItem({ resolved, proposal, text: small.text, files, evidence: evCheck.evidence });
    if (!plan.ok) {
      fail(plan.kind, plan.message);
      continue;
    }
    for (const p of resolved.paths) claimed.add(p);
    accepted.push({
      ...base,
      resolved,
      plan,
      text: small.text,
      evidence: evCheck.evidence,
      gate: REFINE_GATE,
      score: gateInput.score,
      verified: gateInput.verified,
    });
  }

  const recordOf = (id, applied, extra = {}) =>
    appendHistory(root, {
      ts: new Date(now).toISOString(),
      t: 'refine',
      id,
      dryRun,
      session: traj.file ?? null,
      proposed: proposals.length,
      applied,
      rejected,
      snapshot: id,
      ...extra,
    });

  if (dryRun) {
    const record = recordOf(null, [], { accepted: accepted.length });
    return {
      ok: true,
      kind: 'dry-run',
      snapshot: null,
      accepted,
      applied: [],
      rejected,
      history: record,
      message: `/refine: reviewed ${proposals.length} proposal(s); nothing written. ${accepted.length} would pass. Re-run with apply to commit them.`,
    };
  }

  if (!accepted.length) {
    const record = recordOf(null, []);
    return {
      ok: false,
      kind: rejected.length ? 'all-rejected' : 'nothing-to-do',
      snapshot: null,
      applied: [],
      rejected,
      history: record,
      message: `/refine: nothing applied (${rejected.length} rejected).`,
    };
  }

  // -- 7. preflight every planned write BEFORE the first one ----------------
  const dirs = [];
  for (const a of accepted) {
    dirs.push(path.dirname(a.resolved.path));
    for (const p of a.plan.extraPaths) dirs.push(path.dirname(p));
  }
  const pre = preflight(dirs);
  if (!pre.ok) {
    for (const dir of pre.created ?? []) {
      try {
        fs.rmdirSync(dir);
      } catch {}
    }
    rejected.push({
      index: null,
      category: null,
      target: null,
      kind: 'atomic-abort',
      reason: `/refine: a planned write was not possible (${pre.reason}); NO item was written, so there is no partial state.`,
    });
    const record = recordOf(null, []);
    return {
      ok: false,
      kind: 'atomic-abort',
      snapshot: null,
      applied: [],
      rejected: record.rejected,
      history: record,
      message: `/refine: batch aborted before any write (${pre.reason}). Nothing was applied.`,
    };
  }

  // -- 8. snapshot BEFORE the first write -----------------------------------
  const id = `${isoStamp(now)}-${Math.random().toString(16).slice(2, 8)}`;
  const snapDir = path.join(snapshotDir(root), id);
  fs.mkdirSync(snapDir, { recursive: true });
  const items = accepted.map((a) => ({
    category: a.category,
    target: a.target,
    item: a.plan.item,
    path: a.resolved.path,
    extraPaths: a.plan.extraPaths,
    // A created skill has no prior bytes: undo has to REMOVE the directory, and
    // this is the only record that says the directory was ours to remove.
    createdDir: a.plan.createdDir ?? null,
    existed: fs.existsSync(a.resolved.path),
    before: readFileOr(a.resolved.path, null),
    extraBefore: Object.fromEntries(a.plan.extraPaths.map((p) => [p, readFileOr(p, null)])),
    after: a.plan.after,
    evidence: a.evidence,
    gate: a.gate,
    score: a.score,
    verified: a.verified,
  }));
  const snapshot = { id, ts: new Date(now).toISOString(), cwd: root, session: traj.file ?? null, items };
  const snapFile = path.join(snapDir, 'snapshot.json');
  fs.writeFileSync(snapFile, `${JSON.stringify(snapshot, null, 2)}\n`);

  // -- 9. write, restoring everything if any write throws -------------------
  let writes = 0;
  try {
    for (const a of accepted) {
      if (a.plan.memory) {
        // The real memory writer, so the entry has memory.js's format, its
        // dedupe behaviour, and its write screen -- not a second implementation.
        //
        // `dispatch` is declared `async`, but it contains no `await`, so
        // addMemory has already run -- and either persisted or refused -- by the
        // time this line returns. That means the EFFECT is checkable
        // synchronously even though the refusal message is not, so the check
        // below reads the file back rather than trusting the return value. If
        // memory.js refused, the statement is not in the index, and the batch is
        // rolled back rather than recorded as applied.
        createMemoryApi(root).dispatch('memory_add', {
          type: a.resolved.item.replace('-entry', ''),
          statement: a.text,
          topic: 'gotchas',
          detail: a.text,
        });
        const written = readFileOr(a.resolved.path, '');
        if (!String(written).includes(a.text)) {
          const err = new Error('memory.js refused the statement (nothing was added to the index)');
          err.refineKind = 'screen-refused';
          throw err;
        }
      } else {
        fs.writeFileSync(a.resolved.path, a.plan.after);
      }
      writes += 1;
      if (faultAfter != null && writes >= Number(faultAfter)) {
        throw new Error(`fault injection after ${writes} item write(s)`);
      }
    }
  } catch (e) {
    // Restore in reverse from the bytes captured a moment ago, so a crashed
    // apply leaves the tree exactly as it was.
    restoreItems(items);
    for (const dir of pre.created ?? []) {
      try {
        fs.rmdirSync(dir);
      } catch {}
    }
    const kind = e?.refineKind ?? 'rolled-back';
    rejected.push({
      index: null,
      category: null,
      target: null,
      kind,
      reason: `/refine: apply failed (${String((e && e.message) || e)}); every item in the batch was restored from snapshot ${id}. No partial state remains.`,
    });
    const record = recordOf(id, []);
    return {
      ok: false,
      kind,
      snapshot: { id, path: snapFile },
      applied: [],
      rejected: record.rejected,
      history: record,
      message: `/refine: apply failed and was rolled back to snapshot ${id}. Nothing is half-applied.`,
    };
  }

  const applied = accepted.map((a) => ({
    index: a.index,
    category: a.category,
    target: a.target,
    item: a.plan.item,
    path: a.resolved.path,
    text: a.text,
    evidence: a.evidence,
    gate: a.gate,
    score: a.score,
    verified: a.verified,
  }));
  const record = recordOf(id, applied);
  return {
    ok: true,
    kind: 'applied',
    snapshot: { id, path: snapFile },
    applied,
    rejected,
    history: record,
    message: `/refine: applied ${applied.length}, rejected ${rejected.length}. Snapshot ${id}. Undo with: /refine undo ${id}`,
  };
}

// A directory this apply created, removed whole. The integrity check is cheap
// and deliberate: a hand-edited or stale snapshot.json must not be able to turn
// "undo a skill I created" into a recursive delete of some other path, so the
// recorded directory is only removed when its own basename is still the skill
// name that was created. (The non-recursive case is covered by the same
// `createdDir === null` branch as every other created file.)
function removeCreatedDir(item) {
  const dir = String(item.createdDir ?? '');
  if (!dir) return;
  if (path.basename(dir) !== safeName(item.target)) return;
  try {
    if (fs.statSync(dir).isDirectory()) fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

// Byte-exact restore: `before` is the file's full prior contents, or null for a
// file refine created (which is then removed, not left empty behind). A created
// DIRECTORY goes with it -- an empty `skills/<name>/` left on disk is still a
// name the scanner walks and `ox skill ls` still lists, so "emptied" is not
// "undone" for a skill.
function restoreItems(items) {
  for (const it of items.slice().reverse()) {
    try {
      if (it.existed) fs.writeFileSync(it.path, it.before ?? '');
      else if (it.createdDir) removeCreatedDir(it);
      else fs.rmSync(it.path, { force: true });
      for (const [p, before] of Object.entries(it.extraBefore ?? {})) {
        if (before == null) fs.rmSync(p, { force: true });
        else fs.writeFileSync(p, before);
      }
    } catch {}
  }
}

// ---- rollback ---------------------------------------------------------------

export function listRefineSnapshots({ cwd } = {}) {
  let entries = [];
  try {
    entries = fs.readdirSync(snapshotDir(path.resolve(cwd ?? process.cwd())));
  } catch {
    return [];
  }
  return entries.sort().reverse();
}

function readSnapshot(cwd, id) {
  const file = path.join(snapshotDir(path.resolve(cwd)), id, 'snapshot.json');
  const t = readFileOr(file);
  if (t == null) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

export function refineUndo({ cwd, id = null, now = new Date() } = {}) {
  const root = path.resolve(cwd ?? process.cwd());
  const want = id ?? listRefineSnapshots({ cwd: root })[0] ?? null;
  if (!want) {
    return { ok: false, kind: 'not-found', message: '/refine undo: no snapshots recorded yet.' };
  }
  const snap = readSnapshot(root, want);
  if (!snap) {
    return { ok: false, kind: 'not-found', message: `/refine undo: snapshot '${want}' does not exist (try: /refine list).` };
  }
  const items = snap.items ?? [];
  restoreItems(items);
  const restored = items.map((it) => ({ category: it.category, target: it.target, path: it.path }));
  appendHistory(root, {
    ts: new Date(now).toISOString(),
    t: 'undo',
    id: snap.id,
    dryRun: false,
    proposed: 0,
    applied: [],
    rejected: [],
    restored,
    snapshot: snap.id,
    reason: `rolled back ${restored.length} item(s) from snapshot ${snap.id}`,
  });
  return {
    ok: true,
    kind: 'undone',
    id: snap.id,
    restored,
    message: `/refine undo: restored ${restored.length} item(s) from snapshot ${snap.id}.`,
  };
}

// ---- rendering (for the CLI) ------------------------------------------------

export function renderRefineResult(res, color) {
  const c = color ?? { dim: (s) => s, red: (s) => s, green: (s) => s, bold: (s) => s, yellow: (s) => s };
  const lines = [];
  for (const a of res.applied ?? []) {
    lines.push(c.green(`  OK applied [${a.category}] ${a.target}${a.item ? ` (${a.item})` : ''}`));
    lines.push(c.dim(`      evidence: "${String(a.evidence?.quote ?? '').slice(0, 120)}"`));
    lines.push(c.dim(`      gate: ${a.gate} (score ${a.score ?? '(none)'}${a.verified ? ', verified' : ''})`));
    lines.push(c.dim(`      ${a.path}`));
  }
  for (const r of res.rejected ?? []) {
    const tag = r.immutable ? ` [${r.immutable.id}]` : '';
    lines.push(c.red(`  X rejected${tag} [${r.kind}] ${r.category ?? ''}/${r.target ?? ''}`));
    lines.push(c.dim(`      ${r.reason}`));
  }
  return lines.join('\n');
}

// ---- the command surface ----------------------------------------------------
//
// One handler, so `ox refine ...` and the in-REPL `/refine ...` cannot drift.
// Everything below is synchronous on purpose: applyProposals is a plan-then-write
// operation over local files, and a slash command that awaits nothing is a slash
// command that cannot hang mid-batch.

function usage() {
  return [
    'usage:',
    '  ox refine                      review the current trajectory (dry run: nothing is written)',
    '  ox refine apply [file.json]    apply reviewed proposals; mined from the trajectory when no file is given',
    '  ox refine history [n]          what was proposed, applied, and rejected -- with reasons',
    '  ox refine undo [id]            restore the state before a snapshot (default: the newest)',
    '  ox refine rollback <id>        same as undo, spelled the other way',
    '  ox refine list                 recorded snapshots',
    '  ox refine policy               every refinable category, its cap, and what is immutable',
  ].join('\n');
}

function proposalsFromArgs(args, traj) {
  const file = args.find((a) => !String(a).startsWith('-'));
  if (file && file.toLowerCase() !== 'apply') {
    const loaded = loadProposalFile(file);
    if (!loaded.ok) return { ok: false, message: loaded.message };
    return { ok: true, proposals: loaded.proposals, from: file };
  }
  return { ok: true, proposals: proposeRefinements({ trajectory: traj }), from: 'trajectory' };
}

export function renderRefineCommand(rawArgs, { cwd = process.cwd(), home = os.homedir(), color } = {}) {
  const args = String(rawArgs ?? '')
    .split(/\s+/)
    .map((a) => a.trim())
    .filter(Boolean);
  const c = color ?? { dim: (s) => s, red: (s) => s, green: (s) => s, bold: (s) => s, yellow: (s) => s };
  const verb = (args[0] ?? '').toLowerCase();
  const rolledBack = args.find((a) => a === '--rollback' || a === '--undo');
  const rest = args.slice(1).filter((a) => !String(a).startsWith('-') && a !== rolledBack);

  if (verb === 'policy' || verb === '--help' || verb === '-h') {
    return [
      c.bold('/refine policy'),
      `  refinable categories: ${ALL_REFINE_CATEGORIES.join(', ')}`,
      ...ALL_REFINE_CATEGORIES.map((k) => `    ${k}: max ${CATEGORY_LIMITS[k].maxLines} line / ${CATEGORY_LIMITS[k].maxChars} chars`),
      '    new-skill also needs a one-line `description`; it creates <home>/.agents/skills/<name>/SKILL.md,',
      '    refuses to overwrite an existing skill without `replace: true`, and /refine undo REMOVES a skill it created.',
      `  evidence gate: ${REFINE_GATE} -- >=1 lesson AND (score >= 6 OR verified)`,
      c.red('  immutable (never refinable):'),
      ...IMMUTABLE_TARGETS.map((t) => `    ${t.id}: ${t.label}`),
    ].join('\n');
  }

  if (verb === 'history') {
    const rows = refineHistory({ cwd, limit: Number(rest[0] ?? 20) || 20 });
    if (!rows.length) return c.dim('/refine history: nothing recorded yet.');
    const lines = [c.bold(`/refine history (${rows.length})`)];
    for (const r of rows) {
      const when = String(r.ts ?? '').replace('T', ' ').slice(0, 19);
      lines.push(c.dim(`  ${when}  ${r.t}${r.dryRun ? ' (dry run)' : ''}  snapshot=${r.snapshot ?? '-'}`));
      for (const a of r.applied ?? []) {
        lines.push(c.green(`    + [${a.category}] ${a.target}: ${String(a.text ?? '').slice(0, 90)}`));
        lines.push(c.dim(`        evidence: "${String(a.evidence?.quote ?? '').slice(0, 90)}" (${a.gate})`));
      }
      for (const x of r.rejected ?? []) {
        const tag = x.immutable ? ` [${x.immutable.id}]` : '';
        lines.push(c.red(`    - [${x.kind}]${tag} ${x.category ?? ''}/${x.target ?? ''}`));
        lines.push(c.dim(`        ${String(x.reason ?? '').slice(0, 220)}`));
      }
      for (const r2 of r.restored ?? []) {
        lines.push(c.yellow(`    ~ restored [${r2.category}] ${r2.target} -> ${r2.path}`));
      }
    }
    return lines.join('\n');
  }

  if (verb === 'list') {
    const ids = listRefineSnapshots({ cwd });
    if (!ids.length) return c.dim('/refine list: no snapshots recorded yet.');
    return [c.bold(`/refine snapshots (${ids.length})`), ...ids.map((i) => `  ${i}`)].join('\n');
  }

  if (verb === 'undo' || verb === 'rollback' || rolledBack) {
    const id = rest[0] ?? null;
    const res = refineUndo({ cwd, id });
    return res.ok ? c.green(res.message) : c.red(res.message);
  }

  const apply = verb === 'apply';
  const traj = loadTrajectory({ cwd, home });
  const from = proposalsFromArgs(rest, traj);
  if (!from.ok) return c.red(from.message);
  if (!from.proposals.length) {
    return c.dim(`/refine: no evidence-backed proposals found in ${traj.file ?? 'the (empty) transcript'}. Nothing to review.`);
  }
  const res = applyProposals({ cwd, home, proposals: from.proposals, trajectory: traj, dryRun: !apply });
  const head = [
    c.bold(`/refine ${apply ? 'apply' : 'review'}`),
    c.dim(`  transcript: ${traj.file ?? '(none)'} (${traj.events.length} events)`),
    c.dim(`  proposals:  ${from.proposals.length} (from ${from.from})`),
  ];
  const out = apply ? res.ok ? res.message : c.red(res.message) : res.message;
  return [...head, out, renderRefineResult(res, c), ''].join('\n');
}
