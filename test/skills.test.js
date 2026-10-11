import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MAX_INDEX_SKILLS, skillScanDirs, discoverSkills, parseSkillMd, renderSkillIndex, readSkillBody } from '../src/skills.js';

let root;
let home;
let proj;

const write = (rel, content) => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
};

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-skills-'));
  home = path.join(root, 'home');
  proj = path.join(root, 'proj');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(proj, { recursive: true });

  // path 1: home/.agents/skills — Claude-style SKILL.md w/ metadata.trigger
  write(
    'home/.agents/skills/alpha/SKILL.md',
    [
      '---',
      'name: alpha',
      'description: Alpha does alpha things',
      'metadata:',
      '  trigger: command',
      '---',
      '',
      'Alpha body here.',
      '',
    ].join('\n')
  );
  // path 2: cwd/.agents/skills
  write(
    'proj/.agents/skills/beta/SKILL.md',
    ['---', 'name: beta', 'description: Beta helps with beta ops', '---', '', 'Beta body.'].join('\n')
  );
  // path 3: home/.claude/skills
  write(
    'home/.claude/skills/gamma/SKILL.md',
    ['---', 'name: gamma', 'description: Gamma from claude dir', '---', '', 'Gamma body.'].join('\n')
  );
  // path 4: cwd/.claude/skills — later scan path overrides same name from home/.agents
  write(
    'home/.agents/skills/dup/SKILL.md',
    ['---', 'name: dup', 'description: first dup loses', '---'].join('\n')
  );
  write(
    'proj/.claude/skills/dup/SKILL.md',
    ['---', 'name: dup', 'description: second dup wins the override', '---', '', 'Dup v2 body.'].join('\n')
  );
  // malformed: missing description → skipped + warning collected
  write('home/.agents/skills/broken/SKILL.md', ['---', 'name: broken', '---', '', 'no desc'].join('\n'));
  // filler skills to exceed the index cap
  for (let i = 0; i < 27; i++) {
    const n = `s${String(i).padStart(2, '0')}`;
    write('proj/.claude/skills/' + n + '/SKILL.md', ['---', 'name: ' + n, 'description: filler ' + n, '---'].join('\n'));
  }
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

test('skillScanDirs covers all four paths in precedence order', () => {
  assert.deepEqual(skillScanDirs({ cwd: proj, home }), [
    path.join(home, '.agents', 'skills'),
    path.join(proj, '.agents', 'skills'),
    path.join(home, '.claude', 'skills'),
    path.join(proj, '.claude', 'skills'),
  ]);
});

test('discoverSkills parses Claude-style SKILL.md fully incl metadata.trigger', () => {
  const parsed = parseSkillMd(
    fs.readFileSync(path.join(root, 'home/.agents/skills/alpha/SKILL.md'), 'utf8'),
    path.join(root, 'home/.agents/skills/alpha/SKILL.md')
  );
  assert.equal(parsed.ok, true);
  assert.equal(parsed.skill.name, 'alpha');
  assert.equal(parsed.skill.description, 'Alpha does alpha things');
  assert.deepEqual(parsed.skill.metadata, { trigger: 'command' });
  assert.equal(parsed.skill.trigger, true);
  assert.equal(parsed.skill.body, 'Alpha body here.');
  assert.ok(path.isAbsolute(parsed.skill.path));
});

test('discoverSkills covers all four dirs, malformed skipped with warning, later path wins override', () => {
  const skills = discoverSkills({ cwd: proj, home });
  const names = new Set(skills.map((s) => s.name));
  for (const expected of ['alpha', 'beta', 'gamma', 'dup']) {
    assert.ok(names.has(expected), `missing ${expected}`);
  }
  assert.ok(!names.has('broken'), 'malformed skill must be skipped');

  const warningText = skills.warnings.join('\n');
  assert.ok(warningText.includes('broken'), 'warning names the skipped skill');
  assert.ok(warningText.includes('missing description'), 'warning explains the reason');

  const dup = skills.find((s) => s.name === 'dup');
  assert.equal(dup.description, 'second dup wins the override');
  assert.ok(dup.path.startsWith(path.join(proj, '.claude', 'skills', 'dup')));
  for (const s of skills) assert.ok(path.isAbsolute(s.path), s.name);
});

test('index string contains name+description+absolute SKILL.md path and honors cap of 25', () => {
  assert.equal(MAX_INDEX_SKILLS, 25);
  const skills = discoverSkills({ cwd: proj, home });
  const idx = skills.index;

  const alpha = skills.find((s) => s.name === 'alpha');
  assert.ok(idx.includes('- alpha — Alpha does alpha things'));
  assert.ok(idx.includes(`(read path to invoke: ${alpha.path})`));

  const lines = idx.split('\n').filter(Boolean);
  assert.equal(lines.length, Math.min(skills.length, 25));
  assert.ok(skills.length > 25);

  const synthetic = Array.from({ length: 30 }, (_, i) => ({ name: `n${i}`, description: `d${i}`, path: `/p/${i}` }));
  assert.equal(renderSkillIndex(synthetic).split('\n').length, 25);
  assert.equal(renderSkillIndex(synthetic, 3), '- n0 — d0 (read path to invoke: /p/0)\n- n1 — d1 (read path to invoke: /p/1)\n- n2 — d2 (read path to invoke: /p/2)');
});

test('readSkillBody is case-insensitive by name and null when missing', () => {
  const skills = discoverSkills({ cwd: proj, home });
  assert.equal(readSkillBody('ALPHA', skills), 'Alpha body here.');
  assert.equal(readSkillBody('  Beta ', skills), 'Beta body.');
  assert.equal(readSkillBody('does-not-exist', skills), null);
  assert.equal(readSkillBody('', skills), null);
  // object without cached body falls back to reading SKILL.md from disk
  const alphaPath = skills.find((s) => s.name === 'alpha').path;
  assert.equal(readSkillBody({ path: alphaPath }), 'Alpha body here.');
});
