import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const STACK_SCHEMA_VERSION = '1.0.0';
export const MAX_STACK_SIZE = 128;
export const VALID_CATEGORIES = [
  'frontend', 'backend', 'data', 'ml-ai', 'testing', 'security',
  'devops', 'infra', 'ui-ux', 'docs', 'quality', 'performance',
];
export const CONFLICTING_CATEGORIES = [
  ['testing', 'security'],
  ['frontend', 'backend'],
  ['data', 'ml-ai'],
];

const STACK_FILE = 'aas-stack.json';
const EVIDENCE_FILE = 'aas-selection-evidence.json';

function envArtifactDir() {
  return process.env.OX_AAS_ARTIFACT_DIR || null;
}

function normalizeCatalog(catalog) {
  if (!catalog || typeof catalog !== 'object') return new Map();
  const map = new Map();
  if (Array.isArray(catalog)) {
    for (const entry of catalog) {
      if (entry && entry.id) map.set(entry.id, entry);
    }
  } else {
    for (const [id, entry] of Object.entries(catalog)) {
      map.set(id, entry ?? { id });
    }
  }
  return map;
}

function categoryOf(catalog, id) {
  const entry = catalog.get(id);
  if (!entry) return null;
  return entry.category || entry.cats || null;
}

function requiredSkillsOf(catalog) {
  const out = [];
  for (const [, entry] of catalog) {
    if (entry && entry.required === true) out.push(entry.id);
  }
  return out;
}

function hasConflict(cats) {
  const set = new Set(cats);
  for (const [a, b] of CONFLICTING_CATEGORIES) {
    if (set.has(a) && set.has(b)) return [a, b];
  }
  return null;
}

export function validateStack(skillIds, catalog) {
  const errors = [];
  const warnings = [];
  const catMap = normalizeCatalog(catalog);

  const input = Array.isArray(skillIds) ? skillIds : [];
  const unique = new Set(input);
  const duplicates = input.filter((id) => {
    const count = input.filter((x) => x === id).length;
    return count > 1;
  });

  if (duplicates.length > 0) {
    errors.push(`Duplicate skill IDs: ${[...new Set(duplicates)].join(', ')}`);
  }

  const unknown = input.filter((id) => !catMap.has(id));
  if (unknown.length > 0) {
    errors.push(`Unknown skill IDs: ${unknown.join(', ')}`);
  }

  if (input.length > MAX_STACK_SIZE) {
    errors.push(`Stack size ${input.length} exceeds max ${MAX_STACK_SIZE}`);
  }

  const cats = [...new Set(input.map((id) => categoryOf(catMap, id)).filter(Boolean))];
  const conflict = hasConflict(cats);
  if (conflict) {
    errors.push(`Conflicting categories present: ${conflict[0]} + ${conflict[1]}`);
  }

  const required = requiredSkillsOf(catMap);
  const missing = required.filter((id) => !unique.has(id));
  if (missing.length > 0) {
    errors.push(`Missing required skills: ${missing.join(', ')}`);
  }

  if (input.length > MAX_STACK_SIZE * 0.8) {
    warnings.push(`Stack is approaching max size (${input.length}/${MAX_STACK_SIZE})`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    stats: {
      total: input.length,
      unique: unique.size,
      duplicates: duplicates.length,
      unknown: unknown.length,
      conflicts: conflict ? 1 : 0,
    },
  };
}

function serializeForHash(plan) {
  const stable = {
    id: plan.id,
    version: plan.version,
    target: plan.target,
    skills: plan.skills,
    steps: plan.steps,
    createdAt: plan.createdAt,
  };
  return JSON.stringify(stable);
}

export function buildPlan(stack, catalog, target) {
  const catMap = normalizeCatalog(catalog);
  const ids = Array.isArray(stack) ? stack : (stack && stack.ids ? stack.ids : []);
  const uniqueIds = [...new Set(ids)];

  const steps = [];
  const skills = [];
  let order = 0;

  for (const id of uniqueIds) {
    const entry = catMap.get(id);
    if (!entry) continue;
    skills.push({ id, name: entry.name || id, category: entry.category || null });
    order += 1;
    steps.push({
      order,
      skillId: id,
      action: 'install',
      command: `ox skill install ${id}`,
      description: `Install skill ${entry.name || id}`,
    });
    steps.push({
      order,
      skillId: id,
      action: 'configure',
      command: `ox skill configure ${id}`,
      description: `Configure skill ${entry.name || id}`,
    });
    steps.push({
      order,
      skillId: id,
      action: 'verify',
      command: `ox skill verify ${id}`,
      description: `Verify skill ${entry.name || id}`,
    });
  }

  const createdAt = new Date().toISOString();
  const plan = {
    id: `plan-${createHash('sha256').update(target + ':' + createdAt).digest('hex').slice(0, 12)}`,
    version: STACK_SCHEMA_VERSION,
    target,
    skills,
    steps,
    createdAt,
    hash: '',
  };
  plan.hash = createHash('sha256').update(serializeForHash(plan)).digest('hex');
  return Object.freeze(plan);
}

export function diffStacks(stackA, stackB) {
  const a = new Set(Array.isArray(stackA) ? stackA : []);
  const b = new Set(Array.isArray(stackB) ? stackB : []);
  const added = [...b].filter((x) => !a.has(x));
  const removed = [...a].filter((x) => !b.has(x));
  const unchanged = [...a].filter((x) => b.has(x));
  return { added, removed, unchanged, changed: [] };
}

export function saveStack(stack, dir) {
  const targetDir = dir || envArtifactDir() || process.cwd();
  try {
    const payload = {
      version: STACK_SCHEMA_VERSION,
      savedAt: new Date().toISOString(),
      skills: Array.isArray(stack) ? stack : (stack && stack.ids ? stack.ids : []),
    };
    const p = path.join(targetDir, STACK_FILE);
    fs.writeFile(p, JSON.stringify(payload, null, 2));
    return { path: p, ok: true };
  } catch (err) {
    return { path: path.join(targetDir, STACK_FILE), ok: false, error: err.message };
  }
}

export async function loadStack(dir) {
  const targetDir = dir || envArtifactDir() || process.cwd();
  try {
    const raw = await fs.readFile(path.join(targetDir, STACK_FILE), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed.skills || [];
  } catch {
    return null;
  }
}

export function saveEvidence(evidence, dir) {
  const targetDir = dir || envArtifactDir() || process.cwd();
  try {
    const payload = {
      version: STACK_SCHEMA_VERSION,
      savedAt: new Date().toISOString(),
      evidence,
    };
    const p = path.join(targetDir, EVIDENCE_FILE);
    fs.writeFile(p, JSON.stringify(payload, null, 2));
    return { path: p, ok: true };
  } catch (err) {
    return { path: path.join(targetDir, EVIDENCE_FILE), ok: false, error: err.message };
  }
}

export async function loadEvidence(dir) {
  const targetDir = dir || envArtifactDir() || process.cwd();
  try {
    const raw = await fs.readFile(path.join(targetDir, EVIDENCE_FILE), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed.evidence || null;
  } catch {
    return null;
  }
}

export function verifyPlan(plan) {
  if (!plan) return { valid: false, storedHash: null, computedHash: null };
  const storedHash = plan.hash;
  const clone = { ...plan };
  delete clone.hash;
  const computedHash = createHash('sha256').update(serializeForHash(clone)).digest('hex');
  return {
    valid: storedHash === computedHash,
    storedHash,
    computedHash,
  };
}

export function formatStack(stack) {
  const ids = Array.isArray(stack) ? stack : [];
  if (ids.length === 0) return '(empty stack)';
  const lines = [`Stack (${ids.length} skills):`];
  ids.forEach((id, i) => lines.push(`  ${i + 1}. ${id}`));
  return lines.join('\n');
}

export function formatPlan(plan) {
  if (!plan) return '(no plan)';
  const lines = [
    `Plan: ${plan.id}`,
    `Version: ${plan.version}`,
    `Target: ${plan.target}`,
    `Created: ${plan.createdAt}`,
    `Hash: ${plan.hash}`,
    `Skills: ${plan.skills.length}`,
    `Steps: ${plan.steps.length}`,
    '',
  ];
  for (const step of plan.steps) {
    lines.push(`  [${step.order}] ${step.action.toUpperCase()} :: ${step.skillId}`);
    lines.push(`       cmd: ${step.command}`);
    lines.push(`       ${step.description}`);
  }
  return lines.join('\n');
}

export class AasStackManager {
  constructor({ cwd, catalog } = {}) {
    this.cwd = cwd || process.cwd();
    this.catalog = normalizeCatalog(catalog);
    this.savedStack = null;
    this.plans = [];
    this.evidence = null;
    this.stats = { validations: 0, plans: 0, diffs: 0, exports: 0 };
  }

  validate(ids) {
    this.stats.validations += 1;
    return validateStack(ids, this.catalog);
  }

  plan(ids, target) {
    const plan = buildPlan(ids, this.catalog, target || 'default');
    this.plans.push(plan);
    this.stats.plans += 1;
    return plan;
  }

  install(ids, target, dryRun) {
    const plan = this.plan(ids, target);
    return {
      steps: plan.steps,
      dryRun: dryRun !== false,
      ok: true,
    };
  }

  diff(ids) {
    this.stats.diffs += 1;
    const current = Array.isArray(ids) ? ids : [];
    const saved = this.savedStack || (this.savedStack = loadStack(this.cwd));
    return diffStacks(saved || [], current);
  }

  exportEvidence(ids) {
    const validation = this.validate(ids);
    const evidence = {
      version: STACK_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      skillIds: Array.isArray(ids) ? ids : [],
      validation,
      stats: { ...this.stats },
    };
    this.evidence = evidence;
    this.stats.exports += 1;
    return saveEvidence(evidence, this.cwd);
  }

  getStats() {
    return { ...this.stats };
  }

  reset() {
    this.savedStack = null;
    this.plans = [];
    this.evidence = null;
    this.stats = { validations: 0, plans: 0, diffs: 0, exports: 0 };
  }
}
