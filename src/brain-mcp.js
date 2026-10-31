// ox brain for any agent: the notes in ~/.ox/brain (src/brain.js) as an MCP
// server, so Claude Code, Cursor, Codex or Claude Desktop search and keep the
// same memory ox does (Agently's "same brain in every tool", over local files).
//
//   ox brain mcp            the server, on stdio
//   ox brain connect        how to add it to Claude Code, Cursor and others
//
// Nothing leaves this Mac: the server reads and writes the markdown notes.
import fs from 'node:fs';
import path from 'node:path';
import * as B from './brain.js';

const prop = (type, description, extra = {}) => ({ type, description, ...extra });

export const BRAIN_MCP_TOOLS = [
  { name: 'search', description: 'Search the brain: notes, call notes and saved reading. Returns passages with where each came from and whether it is still current.', inputSchema: { type: 'object', properties: { query: prop('string', 'What to look for.'), limit: prop('number', 'How many results (default 6).'), include_old: prop('boolean', 'Also notes that were replaced.') }, required: ['query'] } },
  { name: 'list_notes', description: 'The current notes, one line each (title, type, tags).', inputSchema: { type: 'object', properties: { filter: prop('string', 'Only titles or tags containing this.') } } },
  { name: 'read_note', description: 'One note in full, by its title.', inputSchema: { type: 'object', properties: { title: prop('string', 'The note\'s title.') }, required: ['title'] } },
  { name: 'remember', description: 'Save a note. To change a fact, save the new one with supersedes: [the old title]; the old note is kept, marked no longer current.', inputSchema: { type: 'object', properties: { title: prop('string', 'A short title.'), body: prop('string', 'The note (markdown; [[links]] to other notes).'), tags: prop('array', 'Tags.', { items: { type: 'string' } }), type: prop('string', 'note, fact, decision, person, project…'), supersedes: prop('array', 'Titles this replaces.', { items: { type: 'string' } }) }, required: ['title', 'body'] } },
  { name: 'save_page', description: 'Hand over a finished page (report, brief, handoff, weekly update) with its sources at the bottom; the owner reads it in ox under Pages. Cite as [1], [2] in the body, in the order of sources.', inputSchema: { type: 'object', properties: { title: prop('string', 'The title.'), body: prop('string', 'The page, in markdown.'), sources: prop('array', 'Links or descriptions of where the facts came from.', { items: { type: 'string' } }), kind: prop('string', 'report, brief, handoff, update…') }, required: ['title', 'body'] } },
  { name: 'retire_note', description: 'Mark a note no longer current (nothing is deleted).', inputSchema: { type: 'object', properties: { title: prop('string', 'The note\'s title.'), reason: prop('string', 'Why, or what replaces it.') }, required: ['title'] } },
];

function notes(dir) {
  return B.walk(dir).map((f) => { const { meta, body } = B.parseNote(fs.readFileSync(f, 'utf8')); return { file: f, meta: { ...meta, title: meta.title ?? path.basename(f, '.md') }, body }; });
}

export function createBrainTools({ dir = B.brainDir(), embed = undefined } = {}) {
  return async function call(name, a = {}) {
    if (name === 'search') {
      const hits = await B.search(String(a.query ?? ''), { dir, limit: Math.max(1, Math.min(20, Number(a.limit ?? 6))), includeOld: a.include_old === true, embed: embed === undefined ? await B.localEmbedder().catch(() => null) : embed });
      return B.formatHits(hits);
    }
    if (name === 'list_notes') {
      const f = String(a.filter ?? '').toLowerCase();
      const rows = notes(dir).filter((n) => !n.meta.valid_to).filter((n) => !f || `${n.meta.title} ${(n.meta.tags ?? []).join(' ')}`.toLowerCase().includes(f));
      return rows.map((n) => `- ${n.meta.title} (${n.meta.type ?? 'note'}${n.meta.tags?.length ? `; ${[].concat(n.meta.tags).join(', ')}` : ''})`).join('\n') || 'no notes yet';
    }
    if (name === 'read_note') {
      const n = notes(dir).find((x) => x.meta.title === String(a.title ?? ''));
      if (!n) throw new Error(`no note titled "${a.title}" (list_notes shows them)`);
      return `# ${n.meta.title}${n.meta.valid_to ? ` (no longer current since ${n.meta.valid_to}${n.meta.superseded_by ? `, see ${n.meta.superseded_by}` : ''})` : ''}\n\n${n.body.trim()}`;
    }
    if (name === 'remember') {
      const r = B.remember({ title: String(a.title ?? ''), body: String(a.body ?? ''), tags: [].concat(a.tags ?? []).map(String), type: String(a.type ?? 'note'), supersedes: [].concat(a.supersedes ?? []).map(String), source: 'mcp' }, { dir });
      await B.index({ dir }).catch(() => {});
      return `saved "${r.title}"`;
    }
    if (name === 'save_page') {
      const r = (await import('./pages.js')).savePage({ title: a.title, body: a.body, sources: [].concat(a.sources ?? []), kind: a.kind ? String(a.kind) : 'report', by: 'an agent over MCP' });
      return `page saved: ${r.id} (${r.sources} sources)`;
    }
    if (name === 'retire_note') {
      const f = B.close(String(a.title ?? ''), String(a.reason ?? 'retired'), { dir });
      if (!f) throw new Error(`no current note titled "${a.title}"`);
      await B.index({ dir }).catch(() => {});
      return `"${a.title}" is no longer current (kept, marked)`;
    }
    throw new Error(`tools: ${BRAIN_MCP_TOOLS.map((t) => t.name).join(', ')}`);
  };
}

export function serveBrainMcp({ input = process.stdin, output = process.stdout, call = createBrainTools() } = {}) {
  let buf = '';
  const send = (o) => output.write(`${JSON.stringify(o)}\n`);
  input.setEncoding('utf8');
  input.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'ox-brain', version: '0.1.0' }, instructions: 'ox brain: the owner\'s notes and memory, shared with ox. search before answering about their projects, people or decisions; remember what should outlive this session; to change a fact, remember the new one with supersedes.' } });
      else if (msg.method === 'tools/list') send({ jsonrpc: '2.0', id: msg.id, result: { tools: BRAIN_MCP_TOOLS } });
      else if (msg.method === 'tools/call') {
        call(msg.params?.name, msg.params?.arguments ?? {})
          .then((text) => send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text }], isError: false } }))
          .catch((e) => send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: String(e?.message ?? e) }], isError: true } }));
      } else if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, result: {} });
    }
  });
}

/** How to add it to other agents: exact commands and config. */
export function connectText(oxCli, node = process.execPath) {
  const json = JSON.stringify({ mcpServers: { 'ox-brain': { command: node, args: [oxCli, 'brain', 'mcp'] } } }, null, 2);
  return [
    'Claude Code:',
    `  claude mcp add --scope user ox-brain -- "${node}" "${oxCli}" brain mcp`,
    'Codex:',
    `  codex mcp add ox-brain -- "${node}" "${oxCli}" brain mcp`,
    'Cursor (~/.cursor/mcp.json), Claude Desktop (claude_desktop_config.json) and others:',
    json.split('\n').map((l) => `  ${l}`).join('\n'),
  ].join('\n');
}
