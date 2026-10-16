// Follow-up suggestions: whatever list shape a model returns becomes three
// short questions; preambles and over-long lines are dropped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFollowups } from '../src/followups.js';

test('numbered, bulleted, quoted or plain lines all become clean questions', () => {
  assert.deepEqual(parseFollowups('Here are three:\n1. What about taxes?\n2) Can I pay early?\n- "How is interest computed?"\n4. extra one'), ['What about taxes?', 'Can I pay early?', 'How is interest computed?']);
  assert.deepEqual(parseFollowups('Sure!\n\n• Compare two loans\n↳ Add extra payments'), ['Compare two loans', 'Add extra payments']);
  assert.deepEqual(parseFollowups(`${'x'.repeat(120)}\nok?`), ['ok?']);
  assert.deepEqual(parseFollowups(''), []);
});
