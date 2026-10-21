import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compose } from '../src/today.js';

test('today: schedule, what needs you, what changed, what is ready', () => {
  const now = new Date('2026-10-20T08:00:00');
  const b = compose({
    now, events: [{ title: 'Standup', at: '2026-10-20T09:30:00' }], unread: 3,
    tasks: [{ title: 'Ship billing', status: 'in_review' }, { title: 'Fix login', status: 'done', updatedAt: '2026-10-20T01:00:00' }],
    agents: [{ tool: 'Claude Code', project: 'shop', state: 'idle', idleSec: 600 }], prs: { open: 2, failing: 1 },
    commits: [{ project: 'ox', commits: 4, last: 'Self-update' }], notes: [{ title: 'research-sqlite-licence', research: true }],
  });
  assert.match(b.text, /^Good morning\./);
  assert.match(b.text, /## Today\n- 9:30\s?AM Standup/);
  assert.deepEqual(b.needsYou, ['Review "Ship billing" (task board)', 'Claude Code in shop finished and waits for your reply', '1 pull request has failing checks', '3 unread emails']);
  assert.ok(b.changed.includes('ox: 4 commits (latest: Self-update)') && b.changed.includes('Done: Fix login'));
  assert.deepEqual(b.ready, ['Research ready: sqlite licence', '2 open pull requests']);
  assert.match(compose({ now }).text, /Calendar is not open, so ox did not read it/);
});
