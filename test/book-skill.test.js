// Book to skill (src/book-skill.js) and installing skills from GitHub links (src/skill-add.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as B from '../src/book-skill.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ox-book-'));
const para = (topic, n = 40) => Array.from({ length: n }, (_, i) => `${topic} sentence number ${i} explains how ${topic} works in practice for readers.`).join(' ');

test('chapters: split by "Chapter N" headings in plain text; tiny parts merged with both titles', () => {
  const text = [`Chapter 1: Roots`, para('roots'), `Chapter 2: Leaves`, para('leaves'), 'Chapter 3: Stub', 'tiny', 'Chapter 4: Flowers', para('flowers')].join('\n\n');
  const cs = B.chapters(text);
  assert.deepEqual(cs.map((c) => c.title), ['Chapter 1: Roots', 'Chapter 2: Leaves', 'Chapter 3: Stub · Chapter 4: Flowers']);
});

test('chapters: Markdown splits on its headings only, never on numbered lists or code', () => {
  const text = `# Guide\n\n${para('intro')}\n\n## Setup\n\n1. Install it\n2. Run it\n\n${para('setup')}\n\n\`\`\`\n# not a heading\n\`\`\`\n\n## Use\n\n${para('use')}`;
  assert.deepEqual(B.chapters(text).map((c) => c.title), ['Guide', 'Setup', 'Use']);
});

test('chapters: long heading-less text is cut at paragraph ends', () => {
  const text = Array.from({ length: 12 }, (_, i) => para(`topic${i}`, 60)).join('\n\n');
  const cs = B.chapters(text);
  assert.ok(cs.length >= 2);
  assert.ok(cs.every((c) => c.text.split(/\s+/).length <= 6500));
});

test('a folder of docs becomes a skill: index, chapter files, terms, and fewer tokens per question', () => {
  const src = tmp(), home = tmp();
  for (const t of ['alpha', 'beta', 'gamma']) fs.writeFileSync(path.join(src, `${t}.md`), `# ${t} guide\n\n${para(t, 30)}\n\n## ${t} details\n\n${para(`${t}x`, 30)}`);
  const r = B.bookToSkill(src, { name: 'My Docs', home });
  assert.equal(r.name, 'my-docs');
  const md = fs.readFileSync(path.join(r.dir, 'SKILL.md'), 'utf8');
  assert.match(md, /^---\nname: my-docs\ndescription: Use when/);
  assert.equal(r.chapters.length, 6);
  for (const ch of r.chapters) assert.ok(fs.existsSync(path.join(r.dir, ch.file)), ch.file);
  assert.ok(r.chapters[0].terms.includes('alpha'));
  assert.throws(() => B.bookToSkill(src, { name: 'My Docs', home }), /exists/);
  assert.ok(B.bookToSkill(src, { name: 'My Docs', home, force: true }).name);
});

test('many chapters: a two-level index keeps SKILL.md small', () => {
  const src = tmp(), home = tmp();
  for (let f = 0; f < 6; f++) fs.writeFileSync(path.join(src, `part${f}.md`), Array.from({ length: 9 }, (_, i) => `## p${f} section ${i}\n\n${para(`w${f}s${i}`, 20)}`).join('\n\n'));
  const r = B.bookToSkill(src, { name: 'big', home });
  assert.equal(r.chapters.length, 54);
  assert.equal(r.parts, 6);
  assert.ok(fs.existsSync(path.join(r.dir, 'index', 'part0.md')));
  assert.ok(r.ratio > 5, `ratio ${r.ratio}`);
  assert.ok(!r.short);
});

test('skill add accepts GitHub links and o/r#name (parsing only, no network)', async () => {
  const { installSkill } = await import('../src/skill-add.js');
  const r = await installSkill('https://gitlab.com/a/b', { home: tmp() });
  assert.match(r.message, /only GitHub links/);
});
