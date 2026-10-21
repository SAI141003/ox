// ox import reads Claude Code, Codex and Cursor setups in their real formats (src/import.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { importAll, codexMcp } from '../src/import.js';

test('import: skills, subagents, MCP servers and instructions from each tool', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-imp-home-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-imp-cwd-'));
  const w = (f, t) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
  w(path.join(home, '.claude/skills/grill-me/SKILL.md'), '---\nname: grill-me\n---\nAsk hard questions.');
  w(path.join(home, '.claude/skills/grill-me/scripts/x.sh'), 'echo hi');
  w(path.join(cwd, '.claude/agents/reviewer.md'), '---\nname: reviewer\ndescription: Reviews diffs\ntools: Read, Grep\nmodel: inherit\n---\nYou review code.');
  w(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { github: { command: 'gh-mcp' } }, projects: { [cwd]: { mcpServers: { db: { command: 'db-mcp' } } } } }));
  w(path.join(home, '.codex/config.toml'), 'model = "gpt-5"\n\n[mcp_servers.docs]\ncommand = "npx"\nargs = ["-y", "docs-mcp"]\n\n[mcp_servers.docs.env]\nTOKEN = "x"\n\n[profiles.fast]\nmodel = "o3"\n');
  w(path.join(home, '.cursor/mcp.json'), JSON.stringify({ mcpServers: { linear: { url: 'https://mcp.linear.app' } } }));
  w(path.join(cwd, '.cursor/rules/style.mdc'), 'Use tabs.');
  w(path.join(cwd, 'AGENTS.md'), '# agents');
  const r = importAll(cwd, 'all', home);
  assert.deepEqual(r.skills.map((s) => s.name), ['grill-me']);
  assert.equal(r.skills[0].path, path.join(home, '.claude/skills/grill-me'), 'the folder, scripts included');
  assert.deepEqual(r.agents.map((a) => [a.name, a.description, a.tools, a.systemPrompt]), [['reviewer', 'Reviews diffs', ['Read', 'Grep'], 'You review code.']]);
  assert.deepEqual(Object.keys(r.mcpServers).sort(), ['db', 'docs', 'github', 'linear']);
  assert.deepEqual(r.mcpServers.docs, { command: 'npx', args: ['-y', 'docs-mcp'], env: { TOKEN: 'x' } });
  assert.ok(r.memoryFiles.some((m) => m.name === '.cursor/rules/style.mdc') && r.memoryFiles.some((m) => m.name === 'AGENTS.md'));
  assert.deepEqual(Object.keys(codexMcp('[mcp_servers."my-srv"]\ncommand = "a"')), ['my-srv']);
  fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(cwd, { recursive: true, force: true });
});
