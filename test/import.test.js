// ox import reads Claude Code, Codex and Cursor setups in their real formats (src/import.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { importAll, codexMcp, importFromClaudeCode } from '../src/import.js';

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
  assert.equal(r.memoryFiles.find((m) => m.name === 'AGENTS.md').content, '# agents');
  assert.deepEqual(Object.keys(codexMcp('[mcp_servers."my-srv"]\ncommand = "a"')), ['my-srv']);
  fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(cwd, { recursive: true, force: true });
});

test('Claude Code import includes only the matching project auto-memory index and topic notes', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-claude-memory-home-'));
  const cwd = path.join(os.tmpdir(), 'ox-claude-memory-project');
  const w = (f, text) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  const memory = path.join(home, '.claude', 'projects', cwd.replace(/[\\/]/g, '-'), 'memory');
  w(path.join(memory, 'MEMORY.md'), '# Claude memory index\n- Use pnpm.');
  w(path.join(memory, 'debugging.md'), '# Debugging\nCheck the process owner first.');
  w(path.join(home, '.claude', 'projects', '-some-other-project', 'memory', 'MEMORY.md'), 'DO NOT IMPORT THIS');
  const result = importFromClaudeCode(cwd, home);
  assert.deepEqual(result.memoryFiles.filter((m) => m.autoMemory).map((m) => path.basename(m.path)).sort(), ['MEMORY.md', 'debugging.md']);
  assert.ok(result.memoryFiles.find((m) => m.name.endsWith('MEMORY.md'))?.content.includes('Use pnpm'));
  assert.ok(!result.memoryFiles.some((m) => m.content.includes('DO NOT IMPORT THIS')));
  fs.rmSync(home, { recursive: true, force: true });
});
