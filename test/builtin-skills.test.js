// ox ships its own skills in <repo>/skills. They must parse, stay short (every
// loaded body costs tokens), scan clean, and lose to a user skill of the same name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BUILTIN_SKILLS_DIR, discoverSkills, parseSkillMd } from '../src/skills.js';
import { scanSkillSource } from '../src/skill-add.js';

const names = fs.readdirSync(BUILTIN_SKILLS_DIR).filter((n) => fs.existsSync(path.join(BUILTIN_SKILLS_DIR, n, 'SKILL.md')));

test('there is a real built-in skill set', () => {
  assert.ok(names.length >= 12, `only ${names.length} built-in skills`);
});

for (const name of names) {
  test(`built-in skill '${name}' parses, is concise, and scans clean`, () => {
    const file = path.join(BUILTIN_SKILLS_DIR, name, 'SKILL.md');
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = parseSkillMd(raw, file);
    assert.equal(parsed.ok, true, parsed.warning);
    assert.equal(parsed.skill.name, name, 'folder name matches the declared name');
    assert.ok(parsed.skill.description.length >= 40, 'description says when to use it');
    assert.ok(raw.split('\n').length <= 40, 'built-in skills stay under 40 lines');
    assert.deepEqual(scanSkillSource(path.join(BUILTIN_SKILLS_DIR, name)).findings, []);
  });
}

test('built-ins are discovered, and a user skill of the same name wins', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-builtin-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  let skills = discoverSkills({ cwd: home, home, builtin: true });
  assert.equal(skills.find((s) => s.name === 'plan-first')?.builtin, true);

  fs.mkdirSync(path.join(home, '.agents', 'skills', 'plan-first'), { recursive: true });
  fs.writeFileSync(path.join(home, '.agents', 'skills', 'plan-first', 'SKILL.md'), '---\nname: plan-first\ndescription: my own planning rules for this team\n---\nmine\n');
  skills = discoverSkills({ cwd: home, home, builtin: true });
  const mine = skills.find((s) => s.name === 'plan-first');
  assert.equal(mine.description, 'my own planning rules for this team');
  assert.equal(mine.builtin, undefined);
});

test('OX_NO_BUILTIN_SKILLS=1 (the test default) hides them', () => {
  const home = os.tmpdir();
  assert.equal(discoverSkills({ cwd: home, home, builtin: false }).some((s) => s.builtin), false);
});
