// Script → scene animations (src/animate.js): the plan without a model, a
// model's plan read safely, and one real scene drawn frame by frame.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const A = await import('../src/animate.js');

test('each kind of line gets the picture that fits it', () => {
  assert.equal(A.guessScene('Most agents waste 72% of their tokens.').template, 'stat');
  assert.equal(A.guessScene('Claude Code or Codex?').template, 'compare');
  assert.equal(A.guessScene('First you plan, then you build, finally you test.').template, 'flow');
  assert.deepEqual(A.guessScene('First you plan, then you build, finally you test.').items, ['you plan', 'you build', 'you test']);
  assert.equal(A.guessScene('"Ship small, ship often."').template, 'quote');
  assert.equal(A.guessScene('Speed, cost, and quality.').template, 'list');
  assert.equal(A.guessScene('Stop rereading files you already know every single time an agent starts a new task.').template, 'captions');
  assert.equal(A.guessScene('This changes everything.').template, 'headline');
});

test('speech without full stops is cut into clauses and joined into pictures, with their times', () => {
  const s = A.planScenes([{ start: 0, end: 8.64, text: '90% of startups fail in their first year, build fast or build right, first you talk to users, then you ship, finally you listen again.' }]);
  assert.deepEqual(s.map((x) => x.template), ['stat', 'compare', 'flow']);
  assert.equal(s[0].start, 0);
  assert.ok(s[2].start > s[1].start && s[2].end <= 8.65);
  assert.equal(new Set(s.map((x) => x.name)).size, s.length, 'names are unique');
});

test('a model plan is used only when it is valid JSON with known templates', () => {
  const ok = A.parsePlan('Sure! {"scenes":[{"name":"Hook!","template":"stat","value":"40x","label":"rereads","seconds":30},{"name":"x","template":"nonsense"}]}');
  assert.equal(ok.length, 1);
  assert.equal(ok[0].name, 'hook');
  assert.equal(ok[0].seconds, 12, 'lengths are kept to 12 s');
  assert.equal(A.parsePlan('no json here'), null);
  assert.equal(A.parsePlan('{"scenes":[{"template":"nope"}]}'), null);
});

const hasTools = spawnSync('ffmpeg', ['-version']).status === 0 && (await import('../src/dev-flow.js')).chromePath();
test('one scene renders to a real MP4 with sound effects and a poster; redo and save work', { skip: !hasTools && 'needs ffmpeg and Chrome', timeout: 180_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-anim-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-anim-home-'));
  const r = await A.animate('Claude Code or Codex?', { out: dir, aspect: '1:1', env: { ...process.env, OX_HOME: home } });
  assert.equal(r.scenes.length, 1);
  const f = r.scenes[0].file;
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height:format=duration', '-of', 'json', f], { encoding: 'utf8' });
  const j = JSON.parse(probe.stdout);
  assert.deepEqual(j.streams.map((x) => x.codec_type).sort(), ['audio', 'video']);
  assert.equal(j.streams.find((x) => x.codec_type === 'video').width, 1080);
  assert.ok(Math.abs(Number(j.format.duration) - r.scenes[0].seconds) < 0.5);
  assert.ok(fs.statSync(r.scenes[0].poster).size > 5000);
  assert.ok(r.scenes[0].cues >= 2, 'sound effects at the cards and the vs');
  // Change the words, redo only that scene.
  const specFile = path.join(dir, 'scene-spec.json');
  const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));
  spec.scenes[0].right = 'Both';
  fs.writeFileSync(specFile, JSON.stringify(spec));
  const before = fs.statSync(f).mtimeMs;
  await A.renderSpec(dir, { only: [spec.scenes[0].name], env: { ...process.env, OX_HOME: home } });
  assert.ok(fs.statSync(f).mtimeMs > before);
  const saved = A.saveAnimation(dir, spec.scenes[0].name, 'my-vs', { ...process.env, OX_HOME: home });
  assert.equal(saved.name, 'my-vs');
  assert.ok(A.templateSources({ ...process.env, OX_HOME: home })['my-vs']);
  assert.deepEqual(A.savedAnimations({ ...process.env, OX_HOME: home }).map((x) => x.name), ['my-vs']);
});
