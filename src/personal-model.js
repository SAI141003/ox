// Personal model control plane.
//
// This is deliberately an adapter-training workflow, not a claim that OX can
// safely train a foundation model from a person's private life.  It keeps the
// immutable base model separate from a versioned adapter, accepts only
// explicitly-approved examples, and never promotes an adapter without a held-
// out evaluation and a second explicit approval.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { screenPersistText } from './memory.js';

export const PERSONAL_MODEL_SCHEMA_VERSION = 1;
export const PERSONAL_MODEL_SOURCES = Object.freeze(['preferences', 'approved_chats', 'studio_recipes']);
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

function root(home) {
  // OX_HOME already names Ox's data directory in the rest of the app; adding
  // another `.ox` here would split personal-model data away from every other
  // Ox setting when a user or test supplies OX_HOME.
  return home ?? process.env.OX_HOME ?? path.join(os.homedir(), '.ox');
}

export function personalModelPaths({ home } = {}) {
  const dir = path.join(root(home), 'personal-model');
  return {
    dir,
    config: path.join(dir, 'config.json'),
    dataset: path.join(dir, 'approved-examples.jsonl'),
    versions: path.join(dir, 'versions.json'),
  };
}

export function defaultPersonalModelState() {
  return {
    version: PERSONAL_MODEL_SCHEMA_VERSION,
    enabled: false,
    name: 'my-ox-adapter',
    baseModel: '',
    sources: { preferences: false, approved_chats: false, studio_recipes: false },
    status: 'off',
    adapter: null,
    updatedAt: null,
  };
}

function cleanSources(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return Object.fromEntries(PERSONAL_MODEL_SOURCES.map((key) => [key, src[key] === true]));
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (err) {
    if (err?.code === 'ENOENT') return fallback;
    throw new Error(`personal model state is not valid JSON: ${err?.message ?? err}`);
  }
}

export function personalModelState({ home } = {}) {
  const raw = readJson(personalModelPaths({ home }).config, defaultPersonalModelState());
  const d = defaultPersonalModelState();
  return {
    ...d,
    ...raw,
    enabled: raw?.enabled === true,
    name: NAME_RE.test(String(raw?.name ?? '')) ? String(raw.name) : d.name,
    baseModel: String(raw?.baseModel ?? '').slice(0, 200),
    sources: cleanSources(raw?.sources),
    adapter: raw?.adapter && typeof raw.adapter === 'object' ? raw.adapter : null,
  };
}

// Save only configuration. Turning this on NEVER reads chats, screens, shell
// history, or behaviour.  Those records must arrive through addTrainingExample
// with an individual `approved: true` acknowledgement.
export function savePersonalModelState(input = {}, { home, now = new Date() } = {}) {
  const prev = personalModelState({ home });
  const next = {
    ...prev,
    ...(typeof input.name === 'string' ? { name: input.name.trim() } : {}),
    ...(typeof input.baseModel === 'string' ? { baseModel: input.baseModel.trim().slice(0, 200) } : {}),
    ...(input.sources ? { sources: cleanSources(input.sources) } : {}),
  };
  if (!NAME_RE.test(next.name)) throw new Error('name must use letters, numbers, dot, dash or underscore (1–64 characters)');
  if (input.enabled != null) {
    if (typeof input.enabled !== 'boolean') throw new Error('enabled must be true or false');
    if (input.enabled && input.consent !== true) throw new Error('explicit consent is required before personal-model collection can be armed');
    next.enabled = input.enabled;
  }
  const selected = Object.values(next.sources).some(Boolean);
  next.status = !next.enabled ? 'off' : !next.baseModel ? 'needs-base-model' : !selected ? 'needs-source-selection' : 'armed';
  next.updatedAt = now.toISOString();
  const p = personalModelPaths({ home });
  fs.mkdirSync(p.dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(p.config, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return next;
}

export function addTrainingExample(example = {}, { home, now = new Date() } = {}) {
  const state = personalModelState({ home });
  const source = String(example.source ?? '');
  if (!state.enabled) throw new Error('personal model collection is off');
  if (!PERSONAL_MODEL_SOURCES.includes(source) || !state.sources[source]) throw new Error(`source '${source}' is not enabled`);
  if (example.approved !== true) throw new Error('each training example needs explicit approval');
  const input = String(example.input ?? '').trim();
  const output = String(example.output ?? '').trim();
  if (!input || !output) throw new Error('training examples need both input and output');
  if (input.length + output.length > 24_000) throw new Error('training example is too large (24,000 characters maximum)');
  const unsafe = screenPersistText(`${input}\n${output}`, 'training example', 'the personal-model dataset');
  if (unsafe) throw new Error(unsafe);
  const row = { id: `${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`, source, input, output, approvedAt: now.toISOString() };
  const p = personalModelPaths({ home });
  fs.mkdirSync(p.dir, { recursive: true, mode: 0o700 });
  fs.appendFileSync(p.dataset, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  return { ...row, chars: input.length + output.length };
}

export function personalModelDataset({ home } = {}) {
  const { dataset } = personalModelPaths({ home });
  let rows = [];
  try {
    rows = fs.readFileSync(dataset, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch (err) { if (err?.code !== 'ENOENT') throw new Error(`personal model dataset is invalid: ${err?.message ?? err}`); }
  return rows.map(({ input, output, ...rest }) => ({ ...rest, inputChars: String(input ?? '').length, outputChars: String(output ?? '').length }));
}

function executable(cmd, args, spawn = spawnSync) {
  try { return spawn(cmd, args, { encoding: 'utf8', timeout: 4_000 }).status === 0; } catch { return false; }
}

export function trainingRuntime({ platform = process.platform, spawn = spawnSync } = {}) {
  // These probes never install packages or download weights. They describe what
  // a user may choose to install after reviewing the plan.
  const python = executable('python3', ['--version'], spawn);
  const hasMlx = platform === 'darwin' && python && executable('python3', ['-c', 'import mlx_lm'], spawn);
  const hasPeft = python && executable('python3', ['-c', 'import peft, transformers'], spawn);
  return {
    available: hasMlx || hasPeft,
    kind: hasMlx ? 'mlx-lora' : hasPeft ? 'peft-lora' : null,
    detail: hasMlx ? 'MLX LoRA is available locally.' : hasPeft ? 'PEFT LoRA is available locally.' : 'Install MLX LM on Apple Silicon or PEFT + Transformers before starting a local adapter run.',
  };
}

export function trainingPlan({ home, platform, spawn } = {}) {
  const state = personalModelState({ home });
  const examples = personalModelDataset({ home });
  const runtime = trainingRuntime({ platform, spawn });
  const blockers = [];
  if (!state.enabled) blockers.push('Turn on personal model collection first.');
  if (!state.baseModel) blockers.push('Choose an open-weight base model first.');
  if (!Object.values(state.sources).some(Boolean)) blockers.push('Choose at least one approved data source.');
  if (examples.length < 50) blockers.push('Add at least 50 individually approved examples; fewer examples are too easy to overfit.');
  if (!runtime.available) blockers.push(runtime.detail);
  return {
    ready: blockers.length === 0,
    blockers,
    runtime,
    dataset: { examples: examples.length, heldOutRecommended: examples.length >= 25 ? Math.max(5, Math.ceil(examples.length * 0.15)) : 0 },
    method: 'LoRA adapter only; base weights remain immutable.',
    promotion: 'Run a held-out evaluation and manually approve promotion; automatic promotion is disabled.',
  };
}

export function evaluateAdapterPromotion({ baseline, candidate, safetyPassed, heldOutExamples }) {
  const base = Number(baseline);
  const next = Number(candidate);
  const n = Number(heldOutExamples);
  const blockers = [];
  if (!Number.isFinite(base) || !Number.isFinite(next)) blockers.push('Both baseline and candidate held-out scores are required.');
  if (!Number.isFinite(n) || n < 5) blockers.push('Use at least five held-out examples that were not in training.');
  if (safetyPassed !== true) blockers.push('The safety regression suite must pass.');
  if (!blockers.length && next < base) blockers.push('Candidate did not beat or match the baseline on held-out data.');
  return { promotable: blockers.length === 0, blockers, baseline: Number.isFinite(base) ? base : null, candidate: Number.isFinite(next) ? next : null, heldOutExamples: Number.isFinite(n) ? n : null };
}
