// Recall by meaning, when this machine has a local embedding model (Ollama's
// nomic-embed-text, embeddinggemma, bge, …; nothing is downloaded for you).
// Words alone missed "What do I do for a living?" → "product designer at
// Shopify" and "our dog" → "golden retriever named Toast"; Supermemory and
// Zep close that gap with embeddings, fused with the other signals.
//
// Vectors live beside the graph (graph.vec.json, id → vector), filled in the
// background, so remembering stays instant and never waits on a model.
import fs from 'node:fs';
import path from 'node:path';
import { load, recall } from './memory-graph.js';

let cached = { at: 0, embedder: null };
/** The local embedder, or null. Checked at most once a minute. */
export async function localEmbedder({ base = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434', fetchImpl = fetch } = {}) {
  if (process.env.OX_MEMORY_EMBED === '0') return null;
  if (Date.now() - cached.at < 60_000) return cached.embedder;
  cached = { at: Date.now(), embedder: null };
  try {
    const tags = await (await fetchImpl(`${base}/api/tags`, { signal: AbortSignal.timeout(1500) })).json();
    const model = (tags.models ?? []).map((m) => m.name).find((n) => /embed|minilm|bge|e5|gte|nomic/i.test(n));
    if (!model) return null;
    // nomic-style models read better with a task prefix; others ignore it.
    const prefix = /nomic/i.test(model) ? { doc: 'search_document: ', query: 'search_query: ' } : { doc: '', query: '' };
    const embed = async (texts, kind = 'doc') => {
      const r = await fetchImpl(`${base}/api/embed`, { method: 'POST', body: JSON.stringify({ model, input: texts.map((t) => prefix[kind] + t) }), signal: AbortSignal.timeout(30_000) });
      return (await r.json()).embeddings ?? [];
    };
    cached.embedder = { model, embed };
  } catch {}
  return cached.embedder;
}

const vecFile = (file) => path.join(path.dirname(file), `${path.basename(file, '.jsonl')}.vec.json`);
function readVecs(file) { try { return JSON.parse(fs.readFileSync(vecFile(file), 'utf8')); } catch { return { model: null, v: {} }; } }

/** Embed every memory that has no vector yet (a different model starts over). → how many. */
export async function embedMissing(file, { embedder = null } = {}) {
  const E = embedder ?? (await localEmbedder());
  if (!E) return 0;
  let store = readVecs(file);
  if (store.model !== E.model) store = { model: E.model, v: {} };
  const todo = load(file).filter((m) => m.state === 'active' && !store.v[m.id]);
  for (let i = 0; i < todo.length; i += 32) {
    const batch = todo.slice(i, i + 32);
    const vecs = await E.embed(batch.map((m) => m.text), 'doc');
    batch.forEach((m, j) => { if (vecs[j]) store.v[m.id] = vecs[j].map((x) => Math.round(x * 1e4) / 1e4); });
  }
  if (todo.length) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(vecFile(file), JSON.stringify(store), { mode: 0o600 }); }
  return todo.length;
}

const cos = (a, b) => { let d = 0, x = 0, y = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; } return d / (Math.sqrt(x * y) || 1); };

/**
 * recall() with meaning added: the question's vector against each memory's,
 * passed to recall as one more ranked signal. Without an embedder it is recall().
 */
export async function recallSemantic(query, opts = {}) {
  const E = await localEmbedder();
  if (!E || !String(query ?? '').trim()) return recall(query, opts);
  try {
    await embedMissing(opts.file, { embedder: E });
    const store = readVecs(opts.file);
    const [qv] = await E.embed([String(query)], 'query');
    if (!qv) return recall(query, opts);
    const sim = new Map(Object.entries(store.v).map(([id, v]) => [id, cos(qv, v)]));
    return recall(query, { ...opts, semantic: sim });
  } catch {
    return recall(query, opts);
  }
}
