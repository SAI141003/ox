// The marketplace reads real catalogue files and GitHub search results; here a
// local stand-in serves both so the test never touches the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('search merges catalogue plugins and GitHub skill repos, filtered by the query', async (t) => {
  const catalog = { name: 'official', owner: { name: 'Anthropic' }, plugins: [
    { name: 'figma', description: 'Figma design platform integration', category: 'design', source: { source: 'url', url: 'https://github.com/x/y.git' } },
    { name: 'pdf-tools', description: 'Read and write PDFs', category: 'documents', source: './pdf' },
  ] };
  let ghQuery = null;
  const server = http.createServer((req, res) => {
    if (req.url.endsWith('/.claude-plugin/marketplace.json') && req.url.includes('/main/')) { res.end(JSON.stringify(catalog)); return; }
    if (req.url.startsWith('/search/repositories')) {
      ghQuery = new URL(req.url, 'http://x').searchParams.get('q');
      res.end(JSON.stringify({ items: [{ full_name: 'someone/figma-skill', description: 'A skill for Figma', stargazers_count: 42, pushed_at: '2026-10-01T00:00:00Z', license: { spdx_id: 'MIT' }, html_url: 'https://github.com/someone/figma-skill' }] }));
      return;
    }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const saved = { ...process.env };
  process.env.OX_MARKET_RAW_BASE = base;
  process.env.OX_MARKET_API_BASE = base;
  process.env.OX_MARKET_CACHE = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-market-'));
  t.after(() => { for (const k of ['OX_MARKET_RAW_BASE', 'OX_MARKET_API_BASE', 'OX_MARKET_CACHE']) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
  const { search, install } = await import('../src/market.js');
  const r = await search('figma');
  assert.ok(r.plugins.some((p) => p.name === 'figma' && p.category === 'design' && p.author === 'Anthropic'));
  assert.ok(!r.plugins.some((p) => p.name === 'pdf-tools'), 'filtered by the query');
  assert.equal(r.repos[0].repo, 'someone/figma-skill');
  assert.equal(r.repos[0].stars, 42);
  assert.equal(ghQuery, 'figma topic:agent-skills');
  // Names are checked before anything is fetched or run.
  await assert.rejects(() => install({ name: 'x; rm -rf /', catalog: 'a/b' }), /bad plugin name/);
  await assert.rejects(() => install({ repo: '../../etc' }), /owner\/repo/);
});
