import fs from 'fs';
import path from 'path';
import os from 'os';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildTimeline, formatTimeline, costPerCheckpoint, timelineStats } from '../src/timeline.js';

function makeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'timeline-test-'));
}

function writeMilestone(cwd, stamp, goal, status, tokIn, tokOut, cost) {
  const dir = path.join(cwd, '.agent', 'checkpoints');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${stamp.replace(/[:.]/g, '-')}-x.md`),
    `# Checkpoint pre\n\n- Goal: ${goal}\n- Status: ${status}\n- Phase: general\n- Tokens in-out: ${tokIn} / ${tokOut}\n- Cost USD: ${cost}\n- Model: m\n- Date: ${stamp}\n`);
}

function writeSession(cwd, pts) {
  const file = path.join(cwd, 'session.jsonl');
  fs.writeFileSync(file, pts.map((p) => JSON.stringify({ t: 'rewind-point', ...p })).join('\n') + '\n');
  return file;
}

function writeEpisode(cwd, date, goal) {
  const dir = path.join(cwd, '.agent', 'episodes');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${date}-test.md`), `# Episode ${date}\n\n- date: ${date}\n- goal: ${goal}\n- outcome: done\n`);
}

describe('timeline', () => {
  it('merges sources, newest first, with correct labels and costs', () => {
    const cwd = makeDir();
    writeMilestone(cwd, '2026-09-17T14:21:44.000Z', 'compaction', 'ok', 8000, 3100, '$0.0388');
    writeMilestone(cwd, '2026-09-17T14:32:05.000Z', 'pre-compaction', 'ok', 9000, 3300, '$0.0412');
    writeEpisode(cwd, '2026-09-17', 'fix the parser');
    const sf = writeSession(cwd, [{ id: 3, label: 'before edit_file on src/cli.js', ts: '2026-09-17T14:28:11.000Z' }]);

    const events = buildTimeline(cwd, { sessionFile: sf });
    assert.deepEqual(events.map((e) => e.t), [
      '2026-09-17T14:32:05.000Z', '2026-09-17T14:28:11.000Z', '2026-09-17T14:21:44.000Z', '2026-09-17T00:00:00.000Z',
    ]);
    assert.deepEqual(events.map((e) => e.kind), ['checkpoint', 'rewind', 'checkpoint', 'episode']);
    assert.equal(events[0].label, 'pre-compaction');
    assert.equal(events[0].costUsd, 0.0412);
    assert.equal(events[1].ref, 'rw-3');
    assert.equal(events[3].ref, '2026-09-17-test.md');
    assert.equal(costPerCheckpoint(events).total, 0.08);
  });

  it('formats the timeline and aggregates stats', () => {
    const cwd = makeDir();
    writeMilestone(cwd, '2026-09-17T14:21:44.000Z', 'compaction', 'done', 8000, 3100, '$0.0388');
    const sf = writeSession(cwd, [{ id: 1, label: 'before edit', ts: '2026-09-17T14:28:11.000Z' }]);
    const events = buildTimeline(cwd, { sessionFile: sf });

    const out = formatTimeline(events);
    assert.match(out, /TIME TRAVEL TIMELINE/);
    assert.match(out, /● 14:21:44\s+checkpoint\s+compaction · \$0\.0388 · 11\.1k tok/);
    assert.match(out, /○ 14:28:11\s+rewind\s+point rw-1 · before edit/);
    assert.match(out, /n=2 · total \$0\.04/);

    const stats = timelineStats(events);
    assert.equal(stats.count, 2);
    assert.equal(stats.checkpoints, 1);
    assert.equal(stats.rewindPoints, 1);
    assert.equal(stats.episodes, 0);
    assert.equal(stats.totalCostUsd, 0.0388);
    assert.equal(stats.totalTokens, 11100);
    assert.equal(stats.spanMs, 387000);
  });

  it('handles an empty directory deterministically', () => {
    const cwd = makeDir();
    const events = buildTimeline(cwd, { sessionFile: path.join(cwd, 'missing.jsonl') });
    assert.deepEqual(events, []);
    assert.deepEqual(timelineStats(events), {
      count: 0, checkpoints: 0, rewindPoints: 0, episodes: 0, totalCostUsd: 0, totalTokens: 0, spanMs: 0,
    });
    assert.match(formatTimeline([]), /n=0/);
  });
});
