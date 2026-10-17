// code_graph: the agent asks the project's graph (src/code-graph.js) instead of
// grepping file after file: what calls this, how A reaches B, what a
// question is about. Read-only; the first call builds the graph (no model,
// under a second on ox's own 465 files) and later calls reuse it, refreshing
// the files that changed.
import { buildGraph, explainNode, graphPaths, loadGraph, queryGraph, shortestPath, godNodes } from '../code-graph.js';
import fs from 'node:fs';

export const CODE_GRAPH_TOOL_SCHEMAS = Object.freeze([{
  name: 'code_graph',
  description: "Ask the project's code graph (files, functions, classes; imports, calls, definitions) instead of grepping: 'explain' a symbol (where it is, what calls it, what it calls), 'path' between two symbols (how A reaches B), 'query' a plain-language question (the matching code and its neighbours), or 'overview' (most connected code and the subsystems). Every link says EXTRACTED (written in the source) or INFERRED (resolved by ox). Read-only; built from the code without a model.",
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['explain', 'path', 'query', 'overview'], description: 'What to ask.' },
      target: { type: 'string', description: "explain: a function, class or file name. query: the question. path: where to start." },
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
  if (action === 'explain') r = explainNode(g, target);
  else if (action === 'path') r = args.to ? shortestPath(g, target, String(args.to)) : { found: false, text: "code_graph: 'path' needs 'to'" };
  else if (action === 'query') r = queryGraph(g, target);
  else return { content: `code_graph: unknown action '${action}' (explain, path, query, overview)`, isError: true };
  return { content: r.text, ...(r.found === false ? { isError: false } : {}) };
}
