import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export const KG_SCHEMA_VERSION = '1.0.0';
const DATA_FILE = 'knowledge-graph.json';

const VALID_TYPES = new Set(['concept', 'paper', 'tool', 'technique', 'pattern', 'limitation']);
const VALID_RELATIONS = new Set(['implements', 'inspired-by', 'extends', 'contradicts', 'relates-to']);

export function createKnowledgeGraph(cwd) {
  let graph = { nodes: new Map(), edges: [], schema: KG_SCHEMA_VERSION };
  const dataPath = join(cwd, DATA_FILE);

  async function persist() {
    const serial = { nodes: Object.fromEntries(graph.nodes), edges: graph.edges, schema: graph.schema };
    await mkdir(cwd, { recursive: true });
    await writeFile(dataPath, JSON.stringify(serial, null, 2));
  }

  async function load() {
    try {
      const raw = await readFile(dataPath, 'utf8');
      const data = JSON.parse(raw);
      graph.nodes = new Map(Object.entries(data.nodes ?? {}));
      graph.edges = data.edges ?? [];
      graph.schema = data.schema ?? KG_SCHEMA_VERSION;
    } catch { /* fresh */ }
  }

  return {
    async init() { await load(); },

    addNode(node) {
      const n = {
        id: node.id ?? `node:${Date.now()}`,
        type: VALID_TYPES.has(node.type) ? node.type : 'concept',
        name: node.name ?? '',
        description: node.description ?? '',
        metadata: node.metadata ?? {},
        sources: node.sources ?? [],
        confidence: node.confidence ?? 0.5,
        timestamp: node.timestamp ?? Date.now(),
      };
      graph.nodes.set(n.id, n);
      return n;
    },

    addEdge(edge) {
      const e = {
        from: edge.from,
        to: edge.to,
        relation: VALID_RELATIONS.has(edge.relation) ? edge.relation : 'relates-to',
        weight: edge.weight ?? 1,
      };
      graph.edges.push(e);
      return e;
    },

    getNode(id) { return graph.nodes.get(id) ?? null; },

    query(pattern) {
      const matches = [];
      for (const node of graph.nodes.values()) {
        let ok = true;
        if (pattern.type && node.type !== pattern.type) ok = false;
        if (pattern.name && !node.name.toLowerCase().includes(pattern.name.toLowerCase())) ok = false;
        if (pattern.metadata) {
          for (const [k, v] of Object.entries(pattern.metadata)) {
            if (node.metadata[k] !== v) ok = false;
          }
        }
        if (ok) matches.push(node);
      }
      const connected = [];
      for (const edge of graph.edges) {
        if (matches.some(m => m.id === edge.from) || matches.some(m => m.id === edge.to)) {
          connected.push(edge);
        }
      }
      return { nodes: matches, edges: connected };
    },

    findConnections(id, depth = 1) {
      const visited = new Set([id]);
      const results = [];
      let frontier = [id];
      for (let d = 0; d < depth; d++) {
        const next = [];
        for (const nodeId of frontier) {
          for (const edge of graph.edges) {
            if (edge.from === nodeId && !visited.has(edge.to)) {
              visited.add(edge.to);
              const target = graph.nodes.get(edge.to);
              if (target) { results.push({ node: target, edge, depth: d + 1 }); next.push(edge.to); }
            } else if (edge.to === nodeId && !visited.has(edge.from)) {
              visited.add(edge.from);
              const target = graph.nodes.get(edge.from);
              if (target) { results.push({ node: target, edge, depth: d + 1 }); next.push(edge.from); }
            }
          }
        }
        frontier = next;
      }
      return results;
    },

    serialize() { return { nodes: Object.fromEntries(graph.nodes), edges: graph.edges, schema: graph.schema }; },

    deserialize(data) {
      graph.nodes = new Map(Object.entries(data.nodes ?? {}));
      graph.edges = data.edges ?? [];
      graph.schema = data.schema ?? KG_SCHEMA_VERSION;
    },

    async save() { await persist(); },
    async load() { await load(); },

    stats() {
      const byType = {};
      for (const node of graph.nodes.values()) {
        byType[node.type] = (byType[node.type] ?? 0) + 1;
      }
      return { nodeCount: graph.nodes.size, edgeCount: graph.edges.length, byType, schema: graph.schema };
    },
  };
}

export function queryGraph(graph, pattern) {
  const nodes = graph.nodes ? Object.fromEntries(graph.nodes) : graph.nodes;
  const matches = [];
  for (const node of Object.values(nodes)) {
    let ok = true;
    if (pattern.type && node.type !== pattern.type) ok = false;
    if (pattern.name && !node.name.toLowerCase().includes(pattern.name.toLowerCase())) ok = false;
    if (pattern.metadata) {
      for (const [k, v] of Object.entries(pattern.metadata)) {
        if (node.metadata[k] !== v) ok = false;
      }
    }
    if (ok) matches.push(node);
  }
  return { nodes: matches, edges: graph.edges ?? [] };
}

export function findGaps(graph) {
  const connections = {};
  for (const edge of graph.edges ?? []) {
    connections[edge.from] = (connections[edge.from] ?? 0) + 1;
    connections[edge.to] = (connections[edge.to] ?? 0) + 1;
  }
  const gaps = [];
  for (const [id, node] of Object.entries(graph.nodes ?? {})) {
    const count = connections[id] ?? 0;
    if (count === 0) {
      gaps.push({ topic: node.name ?? id, reason: 'no connections', suggestedResearch: `Explore relationships for ${node.name ?? id}` });
    } else if (node.confidence < 0.3) {
      gaps.push({ topic: node.name ?? id, reason: 'low confidence', suggestedResearch: `Validate ${node.name ?? id}` });
    }
  }
  return { gaps };
}

export function mergeGraph(target, source) {
  const merged = { nodes: { ...target.nodes }, edges: [...target.edges] };
  for (const [id, node] of Object.entries(source.nodes ?? {})) {
    if (!merged.nodes[id]) {
      merged.nodes[id] = node;
    } else {
      merged.nodes[id].confidence = Math.max(merged.nodes[id].confidence ?? 0, node.confidence ?? 0);
    }
  }
  for (const edge of source.edges ?? []) {
    if (!merged.edges.some(e => e.from === edge.from && e.to === edge.to && e.relation === edge.relation)) {
      merged.edges.push(edge);
    }
  }
  return merged;
}
