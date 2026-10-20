// code_graph: the agent asks the project's graph (src/code-graph.js) instead of
// grepping file after file: what calls this, how A reaches B, what a
// question is about. Read-only; the first call builds the graph (no model,
// under a second on ox's own 465 files) and later calls reuse it, refreshing
// the files that changed.
import { buildGraph, explainNode, graphPaths, loadGraph, queryGraph, shortestPath, godNodes } from '../code-graph.js';
import fs from 'node:fs';
import path from 'node:path';

export const CODE_GRAPH_TOOL_SCHEMAS = Object.freeze([{
  name: 'code_graph',
  description: "Ask the project's code graph (files, functions, classes; imports, calls, definitions) instead of grepping or reading whole files. Precise answers with line ranges (read just those lines after): 'callers' and 'callees' of a function, its 'definition' (file, lines, signature), a file's 'outline' (every function and class with its lines). Broader: 'explain' a symbol (where it is, what calls it, what it calls), 'path' between two symbols (how A reaches B), 'query' a plain-language question (the matching code and its neighbours), or 'overview' (most connected code and the subsystems). Every link says EXTRACTED (written in the source) or INFERRED (resolved by ox). Read-only; built from the code without a model.",
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['callers', 'callees', 'definition', 'outline', 'explain', 'path', 'query', 'overview'], description: 'What to ask.' },
      target: { type: 'string', description: "callers / callees / definition / explain: a function or class name. outline: a file path. query: the question. path: where to start." },
      to: { type: 'string', description: 'path only: where to end.' },
    },
    required: ['action'],
  },
}]);
export const CODE_GRAPH_TOOLS = Object.freeze(CODE_GRAPH_TOOL_SCHEMAS.map((s) => s.name));
export const CODE_GRAPH_KEYWORDS = Object.freeze([
  'graph', 'calls', 'caller', 'callers', 'callee', 'called', 'depends', 'dependency', 'dependencies',
  'architecture', 'structure', 'connected', 'connects', 'reaches', 'flows', 'subsystem', 'subsystems',
  'codebase', 'module', 'modules', 'imports', 'imported', 'references', 'usages', 'impact',
]);

// One graph per working folder for the life of the process, refreshed when
// files changed since it was built (the per-file hashes make that cheap).
const cache = new Map();
function graphFor(cwd) {
  const hit = cache.get(cwd);
  if (hit && Date.now() - hit.at < 30_000) return hit.g;
  const previous = hit?.g ?? loadGraph(cwd);
  const g = buildGraph(cwd, { previous });
  cache.set(cwd, { g, at: Date.now() });
  try {
    const p = graphPaths(cwd);
    fs.mkdirSync(p.dir, { recursive: true });
    fs.writeFileSync(p.json, JSON.stringify(g));
  } catch { /* a read-only folder still gets its answer */ }
  return g;
}

export async function codeGraphTool(args = {}, ctx = {}) {
  const cwd = typeof ctx.cwd === 'string' && ctx.cwd ? ctx.cwd : process.cwd();
  const action = String(args.action ?? '').toLowerCase();
  const target = String(args.target ?? '').trim();
  let g;
  try { g = graphFor(cwd); } catch (e) { return { content: `code_graph: could not build the graph: ${e?.message ?? e}`, isError: true }; }
  if (!g.nodes.length) return { content: 'code_graph: no code ox can read in this folder (JS/TS, Python, Go, Swift, Ruby, Java/Kotlin, Rust).', isError: true };
  if (action === 'overview') {
    const st = g.stats;
    const lines = [
      `${st.files} files, ${st.symbols} functions and classes, ${st.edges} links (${st.extracted} extracted, ${st.inferred} inferred).`,
      'Most connected:', ...godNodes(g, 10).map((n) => `  ${n.name} (${n.kind}, ${n.file}:${n.line}, ${n.degree} links)`),
      'Subsystems:', ...g.communities.slice(0, 12).map((c) => `  ${c.label}: ${c.size} nodes in ${c.files} files`),
    ];
    return { content: lines.join('\n') };
  }
  if (!target) return { content: `code_graph: '${action}' needs a target`, isError: true };
  let r;
  if (['callers', 'callees', 'definition', 'outline'].includes(action)) return precise(g, cwd, action, target);
  if (action === 'explain') r = explainNode(g, target);
  else if (action === 'path') r = args.to ? shortestPath(g, target, String(args.to)) : { found: false, text: "code_graph: 'path' needs 'to'" };
  else if (action === 'query') r = queryGraph(g, target);
  else return { content: `code_graph: unknown action '${action}' (callers, callees, definition, outline, explain, path, query, overview)`, isError: true };
  return { content: r.text, ...(r.found === false ? { isError: false } : {}) };
}

// Small answers with line ranges, so the agent reads 12 lines, not the file
// (code-graph queries: ~10x fewer tokens than exploring file by file).
function findSymbol(g, target) {
  const t = target.replace(/\(\)$/, '');
  return g.nodes.find((n) => n.kind !== 'file' && n.name === t)
    ?? g.nodes.find((n) => n.kind !== 'file' && (n.id.endsWith(`#${t}`) || n.short === t))
    ?? g.nodes.find((n) => n.kind !== 'file' && n.name.toLowerCase() === t.toLowerCase());
}
const where = (n) => `${n.file}:${n.line}${n.end && n.end !== n.line ? `-${n.end}` : ''}`;

function precise(g, cwd, action, target) {
  const edges = g.edges ?? g.links ?? [];
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  if (action === 'outline') {
    const file = target.replace(/^\.\//, '');
    const syms = g.nodes.filter((n) => n.kind !== 'file' && (n.file === file || n.file?.endsWith(`/${file}`))).sort((a, b) => a.line - b.line);
    if (!syms.length) return { content: `code_graph: no functions or classes found in ${target}` };
    return { content: `${syms[0].file}: ${syms.length} functions and classes\n${syms.map((n) => `  ${n.name} (${n.kind}) lines ${n.line}${n.end ? `-${n.end}` : ''}`).join('\n')}` };
  }
  const node = findSymbol(g, target);
  if (!node) return { content: `code_graph: no function or class named ${target} (try action query)` };
  if (action === 'definition') {
    let sig = '';
    try { sig = fs.readFileSync(path.join(cwd, node.file), 'utf8').split('\n')[node.line - 1]?.trim() ?? ''; } catch {}
    return { content: `${node.name} (${node.kind}) at ${where(node)}${sig ? `\n  ${sig.slice(0, 200)}` : ''}` };
  }
  if (action === 'callers') {
    const rows = edges.filter((e) => e.relation === 'calls' && e.to === node.id).map((e) => ({ e, from: byId.get(e.from) })).filter((x) => x.from);
    if (!rows.length) return { content: `${node.name} (${where(node)}): no callers found in the code graph` };
    return { content: `${node.name} (${where(node)}) is called from ${rows.length} place${rows.length === 1 ? '' : 's'}:\n${rows.slice(0, 40).map(({ e, from }) => `  ${from.name} at ${from.file}:${e.line ?? from.line} [${e.confidence}]`).join('\n')}` };
  }
  const rows = edges.filter((e) => e.relation === 'calls' && e.from === node.id).map((e) => ({ e, to: byId.get(e.to) })).filter((x) => x.to);
  if (!rows.length) return { content: `${node.name} (${where(node)}) calls nothing ox can resolve in this project` };
  return { content: `${node.name} (${where(node)}) calls:\n${rows.slice(0, 40).map(({ e, to }) => `  ${to.name} at ${where(to)} (call on line ${e.line ?? '?'}) [${e.confidence}]`).join('\n')}` };
}
