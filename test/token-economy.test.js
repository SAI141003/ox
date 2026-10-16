// Fewer tokens for the same work: the focused skill index for a known task, and
// the warning when a local server silently cut the prompt to fit its window.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderFocusedSkillIndex, renderSkillIndex } from '../src/skills.js';
import { truncationWarning } from '../src/providers/openai-compat.js';

const skill = (name, description) => ({ name, description, path: `/home/u/skills/${name}/SKILL.md` });
const SKILLS = [
  skill('root-cause-debugging', 'Find the real cause of a failing test or crash before changing code.'),
  skill('write-docs', 'Write README sections and docs people can follow.'),
  skill('frontend-craft', 'Build polished, accessible interfaces.'),
  skill('git-hygiene', 'Small commits, clear messages, clean history.'),
];

test('a known task gets full lines only for skills that bear on it; the rest stay reachable by name', () => {
  const full = renderSkillIndex(SKILLS);
  const focused = renderFocusedSkillIndex(SKILLS, 'the test is failing with a crash, find the cause');
  assert.match(focused, /- root-cause-debugging — Find the real cause/);
  assert.match(focused, /also: write-docs, frontend-craft, git-hygiene \(read \/home\/u\/skills\/<name>\/SKILL\.md\)/);
  assert.ok(focused.length < full.length / 2, `${focused.length} vs ${full.length}`);
  assert.equal(renderFocusedSkillIndex(SKILLS, ''), full, 'no task: the full index');
});

test('a prompt cut by a small context window is reported; a normal one is not', () => {
  assert.match(truncationWarning(2050, 21_000, 'http://localhost:11434/v1'), /OLLAMA_CONTEXT_LENGTH/);
  assert.equal(truncationWarning(3600, 14_500, 'http://localhost:11434/v1'), null);
  assert.equal(truncationWarning(100, 800, 'http://localhost:11434/v1'), null, 'tiny prompts are never flagged');
});
