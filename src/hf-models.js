// Open models from Hugging Face, found and downloaded from ox.
//
//   search  huggingface.co/api/models (GGUF repos, most downloaded first)
//   files   huggingface.co/api/models/<repo>/tree/main -> every .gguf with its
//           exact size and quantisation, and whether it fits this machine
//   pull    Ollama downloads it straight from Hugging Face:
//           POST /api/pull { model: "hf.co/<repo>:<QUANT>" } (streamed progress),
//           then it is a local model like any other (ox-ollama:hf.co/<repo>:<QUANT>)
//
// "Fits" is the file size plus ~20% working memory against this machine's RAM;
// on Apple silicon that RAM is shared with the GPU. Models that need a runtime
// Ollama does not have (BitNet's bitnet.cpp, MLX-only repos) are marked so.
import os from 'node:os';

const HF = () => (process.env.OX_HF_BASE || 'https://huggingface.co').replace(/\/$/, '');
const OLLAMA = () => (process.env.OX_OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, '');
const REPO_RE = /^(?!\.)[\w.-]+\/(?!\.)[\w.-]+$/; // no "..", no leading dot

async function getJson(url, fetchImpl = globalThis.fetch) {
  const r = await fetchImpl(url, { headers: { 'User-Agent': 'ox' }, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`Hugging Face answered ${r.status} for ${url}`);
  return r.json();
}

export async function searchModels(query = '', { gguf = true, limit = 30, fetchImpl } = {}) {
  const q = new URLSearchParams({ search: String(query).trim(), sort: 'downloads', direction: '-1', limit: String(limit) });
  if (gguf) q.set('filter', 'gguf');
  const list = await getJson(`${HF()}/api/models?${q}`, fetchImpl);
  return list.map((m) => ({
    repo: m.id, downloads: m.downloads ?? 0, likes: m.likes ?? 0, task: m.pipeline_tag ?? null, updated: m.lastModified ?? null,
    runtime: /bitnet/i.test(m.id) ? 'bitnet.cpp' : /mlx/i.test(m.id) ? 'mlx' : 'ollama',
  }));
}

export function quantOf(file) {
  const m = /[._-](i?q\d[\w]*|f16|f32|bf16|iq\d_\w+)\.gguf$/i.exec(String(file));
  return m ? m[1].toUpperCase() : null;
}

export async function modelFiles(repo, { fetchImpl, ramGB = os.totalmem() / 1024 ** 3 } = {}) {
  if (!REPO_RE.test(String(repo))) throw new Error('a model repo looks like owner/name');
  const tree = await getJson(`${HF()}/api/models/${repo}/tree/main`, fetchImpl);
  return tree
    .filter((f) => f.type !== 'directory' && /\.gguf$/i.test(f.path) && !/mmproj/i.test(f.path))
    .map((f) => {
      const sizeGB = (f.size ?? f.lfs?.size ?? 0) / 1024 ** 3;
      return { file: f.path, quant: quantOf(f.path), sizeGB: Number(sizeGB.toFixed(2)), fits: sizeGB * 1.2 <= ramGB * 0.75, split: /-\d{5}-of-\d{5}\.gguf$/i.test(f.path) };
    })
    .sort((a, b) => a.sizeGB - b.sizeGB);
}

// Downloads through Ollama; onProgress gets { status, total, completed }.
export async function pullModel(repo, quant, { onProgress = () => {}, fetchImpl = globalThis.fetch, signal } = {}) {
  if (!REPO_RE.test(String(repo))) throw new Error('a model repo looks like owner/name');
  if (quant && !/^[\w.-]+$/.test(quant)) throw new Error('bad quantisation name');
  const name = `hf.co/${repo}${quant ? `:${quant}` : ''}`;
  let r;
  try {
    r = await fetchImpl(`${OLLAMA()}/api/pull`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: name, stream: true }), signal });
  } catch (e) {
    throw new Error(`Ollama is not running at ${OLLAMA()}: install it from ollama.com and start it (${e.message})`);
  }
  if (!r.ok) throw new Error(`Ollama refused the download (${r.status}): ${(await r.text()).slice(0, 200)}`);
  const dec = new TextDecoder();
  let buf = '';
  let last = null;
  for await (const chunk of r.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line);
        if (ev.error) throw new Error(ev.error);
        last = ev;
        onProgress({ status: ev.status, total: ev.total ?? null, completed: ev.completed ?? null });
      } catch (e) { if (e instanceof SyntaxError) continue; throw e; }
    }
  }
  if (last?.status !== 'success') throw new Error(`the download ended without success (${last?.status ?? 'no status'})`);
  return { model: name, bot: `ox-ollama:${name}` };
}

// In-process downloads the app can watch.
const jobs = new Map();
export function startPull(repo, quant) {
  const id = `${repo}:${quant ?? ''}`;
  const existing = jobs.get(id);
  if (existing && existing.state === 'running') return existing;
  const job = { id, repo, quant, state: 'running', status: 'starting', total: null, completed: null, error: null, bot: null, startedAt: Date.now() };
  jobs.set(id, job);
  pullModel(repo, quant, { onProgress: (p) => Object.assign(job, p) })
    .then((r) => Object.assign(job, { state: 'done', status: 'success', bot: r.bot }))
    .catch((e) => Object.assign(job, { state: 'failed', error: e.message }));
  return job;
}
export function pullJobs() { return [...jobs.values()]; }
