// n8n workflows into ox Flows (src/n8n-import.js) and the featured Marketplace entries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convert } from '../src/n8n-import.js';

test('convert: trigger, http, ask and if map; integrations are listed, not faked', () => {
  const wf = {
    name: 'Daily digest',
    nodes: [
      { id: '1', name: 'Every day', type: 'n8n-nodes-base.scheduleTrigger', parameters: { rule: { interval: [{ field: 'hours', hoursInterval: 6 }] } } },
      { id: '2', name: 'Get HN', type: 'n8n-nodes-base.httpRequest', parameters: { url: 'https://hacker-news.firebaseio.com/v0/topstories.json' } },
      { id: '3', name: 'Summarize It', type: '@n8n/n8n-nodes-langchain.chainLlm', parameters: { text: 'Summarize these stories' } },
      { id: '4', name: 'Send to Slack', type: 'n8n-nodes-base.slack', parameters: {} },
      { id: '5', name: 'Note', type: 'n8n-nodes-base.stickyNote', parameters: { content: '## Reads HN and posts a digest' } },
      { id: '6', name: 'Dynamic', type: 'n8n-nodes-base.httpRequest', parameters: { url: '={{ $json.url }}' } },
    ],
    connections: { 'Every day': { main: [[{ node: 'Get HN' }]] }, 'Get HN': { main: [[{ node: 'Summarize It' }]] }, 'Summarize It': { main: [[{ node: 'Send to Slack' }, { node: 'Dynamic' }]] } },
  };
  const r = convert(wf);
  assert.deepEqual(r.flow.trigger, { type: 'schedule', every: 'every 6h' });
  assert.deepEqual(r.flow.steps.map((s) => `${s.type}:${s.name}`), ['http:get_hn', 'ask:summarize_it']);
  assert.deepEqual(r.skipped.map((s) => s.type), ['slack', 'httpRequest'], 'Slack and a computed URL are named as gaps');
  assert.match(r.flow.description, /Reads HN and posts a digest/);
  assert.equal(r.flow.enabled, false, 'imported flows start off');
  assert.deepEqual(r.problems, []);
});

test('featured: ADK skills and REA are in the Marketplace with their licences', async () => {
  const { FEATURED, DEFAULT_CATALOGS } = await import('../src/market.js');
  assert.ok(DEFAULT_CATALOGS.includes('affaan-m/everything-claude-code'));
  assert.ok(FEATURED.some((f) => f.name === 'adk-agent-builder' && f.license === 'Apache-2.0'));
  const { MCP_TEMPLATES } = await import('../src/mcp-templates.js');
  assert.deepEqual(MCP_TEMPLATES.rea.entry(), { command: 'npx', args: ['-y', 'rea-agents@6.7.0', '--mcp'] });
  assert.deepEqual(MCP_TEMPLATES.pinchtab.entry(), { command: 'pinchtab', args: ['mcp'] });
  assert.ok(FEATURED.some((f) => f.name === 'pinchtab' && f.license === 'MIT'));
  assert.ok(FEATURED.some((f) => f.name === 'strix' && f.install === 'pipx install strix-agent'));
});
