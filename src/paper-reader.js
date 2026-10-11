export const PAPER_SCHEMA_VERSION = '1.0.0';

export async function fetchArxivPaper(id) {
  const url = `https://arxiv.org/abs/${id}`;
  const res = await fetch(url);
  const html = await res.text();
  const title = html.match(/<title>(.*?)<\/title>/i)?.[1]?.replace(/\s*-\s*arXiv.*$/, '').trim() ?? '';
  const abstract = html.match(/<abstract[^>]*>([\s\S]*?)<\/abstract>/i)?.[1]?.replace(/<[^>]+>/g, '').trim() ?? '';
  const authorMatches = html.matchAll(/<a[^>]*author"[^>]*>(.*?)<\/a>/g);
  const authors = [];
  for (const m of authorMatches) authors.push(m[1].replace(/<[^>]+>/g, '').trim());
  const catMatches = html.matchAll(/<a[^>]*cat"[^>]*>(.*?)<\/a>/g);
  const categories = [];
  for (const m of catMatches) categories.push(m[1].replace(/<[^>]+>/g, '').trim());
  return { id, title, authors, abstract, categories, schema: PAPER_SCHEMA_VERSION };
}

export async function fetchArxivPdf(id) {
  const url = `https://arxiv.org/pdf/${id}.pdf`;
  const res = await fetch(url);
  const buf = Buffer.from(await res.arrayBuffer());
  return parsePaperText(extractTextFromPdf(buf));
}

function extractTextFromPdf(buf) {
  const str = buf.toString('latin1');
  const texts = [];
  let idx = 0;
  while ((idx = str.indexOf('BT', idx)) !== -1) {
    const end = str.indexOf('ET', idx + 2);
    if (end === -1) break;
    const block = str.slice(idx, end);
    const matches = block.matchAll(/\((?:[^()\\]|\\.)*\)/g);
    for (const m of matches) {
      let s = m[0].slice(1, -1).replace(/\\/g, '');
      if (s.length > 1) texts.push(s);
    }
    idx = end + 2;
  }
  return texts.join(' ').replace(/\s+/g, ' ');
}

export function parsePaperText(text) {
  const sections = {};
  const sectionNames = ['abstract', 'introduction', 'background', 'related', 'methods', 'methodology', 'approach', 'experiments', 'results', 'discussion', 'conclusion', 'conclusions', 'future'];
  for (const name of sectionNames) {
    const re = new RegExp(`\\b${name}\\b[\\s\\n]+(.+?)(?=\\b(?:${sectionNames.filter(n => n !== name).join('|')})\\b|$)`, 'i');
    const match = text.match(re);
    if (match) sections[name] = match[1].trim().slice(0, 2000);
  }
  const findings = [];
  for (const line of text.split(/[.\n]/)) {
    if (/(?:finding|result|conclusion|we (?:propose|present|introduce|show|demonstrate|achieve)|novel|significant)/i.test(line)) {
      findings.push(line.trim().replace(/\s+/g, ' ').slice(0, 300));
    }
  }
  const citations = [];
  const citMatches = text.matchAll(/\[(\d+)\]/g);
  for (const m of citMatches) citations.push(parseInt(m[1], 10));
  const equations = [];
  const eqMatches = text.matchAll(/\$\$.*?\$\$/gs);
  for (const m of eqMatches) equations.push(m[0]);
  return { sections, findings: findings.slice(0, 50), citations: [...new Set(citations)], equations, schema: PAPER_SCHEMA_VERSION };
}

export function createPaperReader() {
  return {
    async ingest(url) {
      const res = await fetch(url);
      const text = await res.text();
      return parsePaperText(text);
    },

    async ingestArxiv(id) {
      const paper = await fetchArxivPaper(id);
      const pdfText = await fetchArxivPdf(id);
      return { ...pdfText, meta: paper };
    },

    async ingestPdf(path) {
      const { readFile } = await import('node:fs/promises');
      const buf = await readFile(path);
      const text = extractTextFromPdf(buf);
      return parsePaperText(text);
    },

    extractMetadata(content) {
      const lines = content.split('\n');
      return {
        title: lines[0]?.trim() ?? '',
        authorCount: (content.match(/\bauthor\b/gi) ?? []).length,
        length: content.length,
        lineCount: lines.length,
        schema: PAPER_SCHEMA_VERSION,
      };
    },

    extractKeyFindings(content) {
      return parsePaperText(content).findings;
    },

    extractCitations(content) {
      const matches = content.matchAll(/\[(\d+)\]/g);
      return [...new Set(Array.from(matches).map(m => parseInt(m[1], 10)))];
    },

    toKnowledgeNode(paper) {
      return {
        id: paper.id ?? `paper:${Date.now()}`,
        type: 'paper',
        name: paper.title ?? paper.id ?? 'Unknown',
        description: paper.abstract ?? paper.content?.slice(0, 200) ?? '',
        metadata: { authors: paper.authors ?? [], categories: paper.categories ?? [], schema: PAPER_SCHEMA_VERSION },
        sources: [],
        confidence: 0.7,
        timestamp: Date.now(),
      };
    },
  };
}
