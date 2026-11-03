// What the code graph saves, measured on a real project: for each question,
// the tokens of the graph's answer against the tokens of the files an agent
// would otherwise open to find the same thing (every file the answer points
// to), and against the whole project. Text is counted with ox's own estimate.
import fs from 'node:fs';
import path from 'node:path';
import { tokensOf } from './agent.js';
import { ensureGraph, queryGraph, explainNode } from './code-graph.js';

const tok = (t) => tokensOf([{ role: 'user', content: String(t ?? '') }]);

export const DEFAULT_QUESTIONS = Object.freeze([
  'how does the agent loop call tools',
  'where are approvals asked in the app',
  'how is memory recalled for a prompt',
  'how does the build room merge a part',
  'how are MCP servers started',
]);

export function benchGraph(root = process.cwd(), { questions = DEFAULT_QUESTIONS } = {}) {
  const g = ensureGraph(root);
  const fileTokens = new Map();
  const tokensOfFile = (f) => {
    if (!fileTokens.has(f)) { let t = 0; try { t = tok(fs.readFileSync(path.join(root, f), 'utf8')); } catch {} fileTokens.set(f, t); }
    return fileTokens.get(f);
  };
  const projectTokens = [...new Set(g.nodes.map((n) => n.file).filter(Boolean))].reduce((s, f) => s + tokensOfFile(f), 0);
  const rows = questions.map((q) => {
    const r = queryGraph(g, q);
    const files = [...new Set(r.seeds.map((n) => n?.file).filter(Boolean))];
    const graph = tok(r.text);
    const opened = files.reduce((s, f) => s + tokensOfFile(f), 0);
    return { question: q, graph, files: files.length, opened, times: graph ? Math.round((opened / graph) * 10) / 10 : null };
  });
  const sum = (k) => rows.reduce((s, r) => s + r[k], 0);
  return { rows, projectTokens, graph: sum('graph'), opened: sum('opened'), times: sum('graph') ? Math.round((sum('opened') / sum('graph')) * 10) / 10 : null, nodes: g.nodes.length, edges: g.edges.length };
}

export { explainNode };
