// The project map: agenttrail's PLAN.md convention, checked, and joined with
// the files git says changed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parsePlan, globToRe, lintPlan, projectMap } from '../src/project-map.js';

const PLAN = `# my project

## Capture the audio {#capture}
files: [src/audio/**]
- [x] Grab the mic feed {#capture-mic}
  tech: coreaudio tap
- [~] Keep the last 30 seconds {#capture-ring}

## Classify the alerts {#classify}
needs: [capture, nowhere]
- [!] Score events {#classify-score}

## decisions
- 2026-08-21: dropped redis
`;

test('the plan: components, tasks, status from tasks, decisions', () => {
  const p = parsePlan(PLAN);
  assert.equal(p.title, 'my project');
  const capture = p.nodes.find((n) => n.id === 'capture');
  assert.equal(capture.status, 'active');
  assert.deepEqual(capture.files, ['src/audio/**']);
  assert.equal(p.nodes.find((n) => n.id === 'classify').status, 'blocked', 'stuck wins');
  assert.equal(p.nodes.find((n) => n.id === 'capture-mic').tech, 'coreaudio tap');
  assert.deepEqual(p.decisions, ['2026-08-21: dropped redis']);
  const lints = lintPlan(p, PLAN);
  assert.ok(lints.some((l) => /unknown component "nowhere"/.test(l)));
  assert.ok(lints.some((l) => /classify: no files/.test(l)));
  assert.ok(globToRe('src/audio/**').test('src/audio/tap.ts'));
  assert.ok(!globToRe('src/*.js').test('src/a/b.js'));
});

test('the map pins changed files to components and lists the unplanned ones', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-map-'));
  const g = (...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  g('init', '-q');
  fs.writeFileSync(path.join(dir, 'PLAN.md'), PLAN);
  fs.mkdirSync(path.join(dir, 'src', 'audio'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'audio', 'tap.ts'), 'x');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'y');
  const m = projectMap(dir);
  assert.equal(m.hasPlan, true);
  assert.deepEqual(m.progress, { done: 1, total: 3 });
  const capture = m.components.find((c) => c.id === 'capture');
  assert.ok(capture.recent.some((f) => f.file.startsWith('src/')), JSON.stringify(capture.recent));
  assert.equal(capture.live, true);
  assert.ok(m.unplanned.some((f) => f.file === 'notes.txt'));
  const none = projectMap(fs.mkdtempSync(path.join(os.tmpdir(), 'ox-map-none-')));
  assert.equal(none.hasPlan, false);
  assert.equal(none.git, false);
});
