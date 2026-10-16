// A plan you pay for (Codex, Claude Code…) gets ox's part of the turn: the
// name you gave ox, a bot's instructions or the interactive-answer guide, and
// memory. Before, it got the bare chat only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planBrief } from '../src/subscriptions.js';

test('the brief carries the name, the instructions and memory; nothing when there is none', () => {
  const b = planBrief({ personaBlock: 'Answer with an openui block.', memoryBlock: 'The user prefers pnpm.' }, { OX_NAME: 'Nova' });
  assert.match(b, /You are Nova/);
  assert.match(b, /openui block/);
  assert.match(b, /prefers pnpm/);
  assert.equal(planBrief({}, { OX_NAME: 'ox' }).includes('You are'), false);
  assert.equal(planBrief({ memoryBlock: 'x'.repeat(9000) }, { OX_NAME: 'ox' }).length < 4200, true);
});
