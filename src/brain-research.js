import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export const BRAIN_SCHEMA_VERSION = '1.0.0';
const DATA_FILE = 'brain-data.json';

function defaultBrain() {
  return { topics: {}, sources: [], findings: {}, gaps: {}, schema: BRAIN_SCHEMA_VERSION };
}

export function createResearchBrain(cwd) {
  let data = defaultBrain();
  const dataPath = join(cwd, DATA_FILE);

  async function load() {
    try {
      const raw = await readFile(dataPath, 'utf8');
      data = JSON.parse(raw);
    } catch { /* start fresh */ }
  }

  async function save() {
    await mkdir(cwd, { recursive: true });
    await writeFile(dataPath, JSON.stringify(data, null, 2));
  }

  return {
    async init() { await load(); },

    async research(topic, opts = {}) {
      if (!data.topics[topic]) data.topics[topic] = { findings: [], gaps: [], sources: [], updated: Date.now() };
      const session = new ResearchSession(topic, data, opts);
      return session;
    },

    getFindings(topic) {
      return data.topics[topic]?.findings ?? [];
    },

    listTopics() {
      return Object.keys(data.topics);
    },

    addSource(type, urlOrContent, metadata = {}) {
      const src = { id: `${type}:${urlOrContent}`, type, content: urlOrContent, metadata, timestamp: Date.now() };
      data.sources.push(src);
      return src;
    },

    async synthesize(topic) {
      const findings = data.topics[topic]?.findings ?? [];
      const themes = {};
      for (const f of findings) {
        for (const tag of f.tags ?? []) {
          themes[tag] = (themes[tag] ?? 0) + 1;
        }
      }
      const sorted = Object.entries(themes).sort((a, b) => b[1] - a[1]);
      return { topic, themes: sorted, findingCount: findings.length, synthesizedAt: Date.now() };
    },

    getGaps(topic) {
      return data.topics[topic]?.gaps ?? [];
    },

    async exportKnowledge() {
      return JSON.parse(JSON.stringify(data));
    },

    async save() { await save(); },
    _getData() { return data; },
  };
}

export class ResearchSession {
  constructor(topic, data, opts = {}) {
    this.topic = topic;
    this.data = data;
    this.opts = opts;
    this.findings = [];
    this.gaps = [];
    this.sources = [];
    if (!data.topics[topic]) data.topics[topic] = { findings: [], gaps: [], sources: [], updated: Date.now() };
  }

  async start(topic) {
    this.topic = topic;
    if (!this.data.topics[topic]) this.data.topics[topic] = { findings: [], gaps: [], sources: [], updated: Date.now() };
    return this;
  }

  addSource(source) {
    const src = { ...source, id: source.id ?? `${source.type}:${source.name ?? source.url ?? Date.now()}`, timestamp: source.timestamp ?? Date.now() };
    this.sources.push(src);
    this.data.sources.push(src);
    this.data.topics[this.topic].sources.push(src.id);
    return src;
  }

  extractFindings() {
    const findings = [];
    for (const src of this.sources) {
      const content = typeof src.content === 'string' ? src.content : '';
      const lines = content.split('\n');
      for (const line of lines) {
        if (/(?:finding|result|conclusion|key|important|significant)/i.test(line) && line.length > 20) {
          findings.push({
            id: `f:${this.topic}:${findings.length}:${Date.now()}`,
            topic: this.topic,
            source: src.id,
            text: line.trim().slice(0, 500),
            tags: this._extractTags(line),
            confidence: src.metadata.confidence ?? 0.5,
            timestamp: Date.now(),
          });
        }
      }
    }
    this.findings = findings;
    this.data.topics[this.topic].findings = findings;
    return findings;
  }

  identifyGaps() {
    const gaps = [];
    const topicData = this.data.topics[this.topic];
    const connectionCounts = {};
    for (const edge of this.opts.graph?.edges ?? []) {
      if (edge.from?.includes(this.topic) || edge.to?.includes(this.topic)) {
        const other = edge.from === this.topic ? edge.to : edge.from;
        connectionCounts[other] = (connectionCounts[other] ?? 0) + 1;
      }
    }
    for (const [node, count] of Object.entries(connectionCounts)) {
      if (count < 2) {
        gaps.push({ topic: node, reason: 'few connections', suggestedResearch: `Investigate ${node} relationships` });
      }
    }
    if (topicData?.findings.length === 0) {
      gaps.push({ topic: this.topic, reason: 'no findings yet', suggestedResearch: `Research ${this.topic} from scratch` });
    }
    this.gaps = gaps;
    this.data.topics[this.topic].gaps = gaps;
    return gaps;
  }

  async generateReport() {
    return {
      topic: this.topic,
      sourcesCount: this.sources.length,
      findingsCount: this.findings.length,
      gapsCount: this.gaps.length,
      report: `${this.topic}: ${this.findings.length} findings, ${this.gaps.length} gaps identified`,
      generatedAt: Date.now(),
    };
  }

  async save() {
    await this.data.save?.();
  }

  _extractTags(line) {
    const matches = line.match(/(?:finding|result|conclusion|key|important|significant|novel|approach|method)/gi) ?? [];
    return [...new Set(matches.map(m => m.toLowerCase()))];
  }
}
