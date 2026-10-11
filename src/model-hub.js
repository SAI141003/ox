// Model hub: find open models on Hugging Face that fit THIS machine, say how
// fast they will run, and pull them with one command.
//
//   detectHardware()     -> what the model has to fit into (unified memory on
//                           Apple Silicon, VRAM on NVIDIA, RAM otherwise) and the
//                           memory bandwidth that bounds generation speed
//   searchModels(q)      -> GGUF repos from the Hugging Face API, with every
//                           quantisation's real file size (shards summed)
//   recommend()          -> the best-fitting quant per repo, ranked
//   pullCommand(repo,q)  -> `ollama pull hf.co/<repo>:<QUANT>` (Ollama pulls
//                           GGUF straight from Hugging Face; no custom downloader)
//
// Speed is an estimate, labelled as one: decode is memory-bandwidth bound, so
// tokens/s ~= bandwidth / bytes read per token (~ the weights) x efficiency.

import os from 'node:os';
import { execFileSync } from 'node:child_process';

export const HF_API = 'https://huggingface.co/api';

// Peak memory bandwidth (GB/s) by Apple chip; conservative where variants differ.
const APPLE_BANDWIDTH = [
  [/M4 Max/i, 410], [/M4 Pro/i, 273], [/M4/i, 120],
  [/M3 Max/i, 300], [/M3 Pro/i, 150], [/M3 Ultra/i, 800], [/M3/i, 100],
  [/M2 Ultra/i, 800], [/M2 Max/i, 400], [/M2 Pro/i, 200], [/M2/i, 100],
  [/M1 Ultra/i, 800], [/M1 Max/i, 400], [/M1 Pro/i, 200], [/M1/i, 68],
];

const GB = 1024 ** 3;

function sh(cmd, args) {
  try {
    return execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).toString().trim();
  } catch {
    return '';
  }
}

/** What a model must fit into, and how fast memory is. */
export function detectHardware({ platform = process.platform, arch = process.arch, totalmem = os.totalmem(), probe = sh } = {}) {
  const ramGB = totalmem / GB;
  const hw = { platform, arch, ramGB: round1(ramGB), chip: null, gpu: null, vramGB: null, kind: 'cpu', budgetGB: 0, bandwidthGBs: 40 };

  if (platform === 'darwin' && arch === 'arm64') {
    hw.chip = probe('sysctl', ['-n', 'machdep.cpu.brand_string']) || 'Apple Silicon';
    hw.kind = 'apple-unified';
    // macOS lets the GPU wire roughly 2/3 of RAM on small Macs and ~3/4 on large
    // ones; keep 2.5 GB for the OS, the app and the KV cache on top of that.
    const gpuShare = ramGB >= 64 ? 0.75 : 0.67;
    hw.budgetGB = round1(Math.max(0, ramGB * gpuShare - 2.5));
    hw.bandwidthGBs = (APPLE_BANDWIDTH.find(([re]) => re.test(hw.chip)) ?? [null, 100])[1];
    return hw;
  }

  const smi = probe('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits']);
  if (smi) {
    const [name, mib] = smi.split('\n')[0].split(',').map((s) => s.trim());
    hw.kind = 'nvidia';
    hw.gpu = name;
    hw.vramGB = round1(Number(mib) / 1024);
    hw.budgetGB = round1(Math.max(0, hw.vramGB - 1.5));
    hw.bandwidthGBs = /4090|5090|A100|H100/i.test(name) ? 900 : /40|30/i.test(name) ? 450 : 300;
    return hw;
  }

  // CPU-only: models run from system RAM, slowly. Leave half for everything else.
  hw.budgetGB = round1(Math.max(0, ramGB * 0.5 - 1));
  return hw;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

// Quality order, best first. Picking walks this list and takes the first quant
// that fits, so a roomy machine gets Q8 and a tight one falls back to Q3.
export const QUANT_PREFERENCE = ['Q8_0', 'Q6_K', 'Q5_K_M', 'Q5_K_S', 'Q4_K_M', 'Q4_K_S', 'IQ4_XS', 'Q4_0', 'Q3_K_M'];
// Q2/IQ3 and below are left out on purpose: at that size an agent loses tool-call
// reliability, which is worse than picking a smaller model at a sane quant.
const QUANT_RE = /(?:^|[-_.])((?:I?Q\d(?:_[A-Z0-9]+)*)|F16|BF16|FP16)(?=[-_.]|$)/i;

/** { QUANT: bytes } from a repo's file list; split shards summed, never double counted. */
export function quantSizes(siblings = []) {
  const single = {};
  const sharded = {};
  for (const s of siblings) {
    const name = String(s?.rfilename ?? '');
    if (!/\.gguf$/i.test(name) || !s.size) continue;
    if (/mmproj|imatrix/i.test(name)) continue;
    const m = name.replace(/\.gguf$/i, '').match(QUANT_RE);
    if (!m) continue;
    const q = m[1].toUpperCase().replace('FP16', 'F16');
    if (/-\d{5}-of-\d{5}/.test(name)) sharded[q] = (sharded[q] ?? 0) + s.size;
    else single[q] = Math.max(single[q] ?? 0, s.size);
  }
  return { ...sharded, ...single };
}

/**
 * Best quant that fits, or null. First pass keeps 25% of the budget free for
 * context (KV cache grows with every token an agent reads) and speed; only if
 * nothing fits that way does it accept a quant up to the whole budget.
 */
export function pickQuant(sizes, budgetGB) {
  for (const limit of [budgetGB * 0.75, budgetGB]) {
    for (const q of QUANT_PREFERENCE) {
      const bytes = sizes[q];
      if (bytes && bytes / GB <= limit) return { quant: q, sizeGB: round1(bytes / GB) };
    }
  }
  return null;
}

/** "bartowski/Qwen2.5-Coder-7B-Instruct-GGUF" and "Qwen/…-GGUF" are one model. */
export function baseModelKey(repo) {
  return String(repo).split('/').pop().toLowerCase().replace(/[-_.]?gguf$/, '').replace(/[-_.](imatrix|i1)$/, '');
}

export function estimateTokensPerSec(sizeGB, hw) {
  if (!sizeGB) return null;
  return Math.max(1, Math.round((hw.bandwidthGBs / sizeGB) * 0.55));
}

export function fitLabel(sizeGB, budgetGB) {
  const r = sizeGB / Math.max(budgetGB, 0.1);
  if (r <= 0.6) return 'comfortable';
  if (r <= 0.9) return 'fits';
  if (r <= 1) return 'tight';
  return 'too big';
}

export function pullCommand(repo, quant) {
  return `ollama pull hf.co/${repo}${quant ? `:${quant}` : ''}`;
}

async function getJson(url, signal) {
  const res = await fetch(url, { signal: signal ?? AbortSignal.timeout(15000), headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`Hugging Face API ${res.status} for ${url}`);
  return res.json();
}

// Variants a coding agent should not be handed by default: safety-stripped,
// role-play and audio/music fine-tunes. Still reachable by explicit search.
const EXCLUDE_RE = /abliterat|uncensor|nsfw|roleplay|\brp\b|music|audio|tts|embed/i;

/** GGUF repos matching a query, most downloaded first. */
export async function searchModels(query, { limit = 12, signal } = {}) {
  const url = `${HF_API}/models?search=${encodeURIComponent(query)}&filter=gguf&sort=downloads&limit=${limit}`;
  const rows = await getJson(url, signal);
  return rows
    .filter((r) => !r.pipeline_tag || r.pipeline_tag === 'text-generation' || r.pipeline_tag === 'image-text-to-text')
    .filter((r) => !EXCLUDE_RE.test(r.id))
    .map((r) => ({ repo: r.id, downloads: r.downloads ?? 0, likes: r.likes ?? 0, tags: r.tags ?? [] }));
}

export async function repoQuants(repo, { signal } = {}) {
  const j = await getJson(`${HF_API}/models/${repo}?blobs=true`, signal);
  return {
    repo,
    gated: Boolean(j.gated),
    license: (j.tags ?? []).find((t) => t.startsWith('license:'))?.slice(8) ?? null,
    sizes: quantSizes(j.siblings),
  };
}

// What each task searches for. Queries, not hardcoded model names, so the list
// tracks what the community actually ships instead of going stale.
export const TASK_QUERIES = {
  code: ['coder instruct', 'devstral', 'qwen3 coder'],
  general: ['instruct', 'gemma it', 'llama instruct'],
  small: ['1.5b instruct', '3b instruct'],
};

/** Ranked, hardware-fitted recommendations for a task. */
export async function recommend({ task = 'code', hw = detectHardware(), perQuery = 8, top = 8, signal } = {}) {
  const queries = TASK_QUERIES[task] ?? [task];
  const seen = new Map();
  for (const q of queries) {
    for (const r of await searchModels(q, { limit: perQuery, signal })) if (!seen.has(r.repo)) seen.set(r.repo, r);
  }
  const repos = [...seen.values()];
  const details = await Promise.all(repos.map((r) => repoQuants(r.repo, { signal }).catch(() => null)));
  const out = [];
  repos.forEach((r, i) => {
    const d = details[i];
    if (!d || d.gated) return;
    const pick = pickQuant(d.sizes, hw.budgetGB);
    if (!pick) return;
    out.push({
      repo: r.repo,
      downloads: r.downloads,
      license: d.license,
      ...pick,
      fit: fitLabel(pick.sizeGB, hw.budgetGB),
      tokensPerSec: estimateTokensPerSec(pick.sizeGB, hw),
      pull: pullCommand(r.repo, pick.quant),
    });
  });
  // One row per base model: keep the most-downloaded upload of it.
  const best = new Map();
  for (const row of out) {
    const k = baseModelKey(row.repo);
    if (!best.has(k) || best.get(k).downloads < row.downloads) best.set(k, row);
  }
  // Popularity is a proxy for "works"; bigger fitting quant is a proxy for quality.
  return [...best.values()]
    .sort((a, b) => Math.log10(b.downloads + 10) * (1 + b.sizeGB / 10) - Math.log10(a.downloads + 10) * (1 + a.sizeGB / 10))
    .slice(0, top);
}
