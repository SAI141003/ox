// Small talk answered without a model (0 tokens); anything with a request in it is not small talk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quickReply, smallTalkKind } from '../src/quick-reply.js';
import { learnable } from '../src/memory-graph.js';
import { renderFocusedSkillIndex } from '../src/skills.js';

test('greetings, thanks and goodbyes are small talk', () => {
  for (const [t, k] of [['hey how are you', 'how'], ['Hi ox, how is it going?', 'how'], ['hello!', 'hello'], ['good morning', 'hello'], ['thanks!', 'thanks'], ['thank you so much', 'thanks'], ['ok', 'ack'], ['good night', 'bye'], ["what's up", 'how']]) {
    assert.equal(smallTalkKind(t), k, t);
  }
  assert.ok(quickReply('hey how are you', { env: {} }));
});

test('a request is never answered as small talk', () => {
  for (const t of ['hey can you fix the build', 'hi, open chrome', 'thanks, now run the tests', 'how are you handling auth in this repo', 'hello world program in rust', 'ok deploy it']) {
    assert.equal(smallTalkKind(t), null, t);
  }
  assert.equal(quickReply('hey how are you', { env: { OX_QUICK_REPLY: '0' } }), null, 'can be turned off');
});

test('a one-off request is not stored as a fact about the user', () => {
  assert.deepEqual(learnable('Hey, I want you to open Chrome and search for new movies'), []);
  assert.deepEqual(learnable('can you remember that I use vim?'), []);
  assert.deepEqual(learnable('I want you to always use pnpm'), ['I want you to always use pnpm']);
  assert.deepEqual(learnable('I prefer dark mode'), ['I prefer dark mode']);
});

test('a message with no telling words gets skill names, not the whole index', () => {
  const skills = Array.from({ length: 30 }, (_, i) => ({ name: `skill-${i}`, description: `does thing number ${i} with a long description of what it is for`, path: `/s/skill-${i}/SKILL.md` }));
  const full = skills.map((s) => `- ${s.name} — ${s.description} (read path to invoke: ${s.path})`).join('\n');
  const short = renderFocusedSkillIndex(skills, 'hey how are you');
  assert.ok(short.length < full.length / 3, `${short.length} vs ${full.length}`);
  assert.match(short, /skill-0/);
});

test('a plain question in auto mode is answered with no tools', async () => {
  const { isPlainQuestion } = await import('../src/modes.js');
  for (const t of ['what is a closure in javascript?', 'why is the sky blue', 'explain recursion']) assert.equal(isPlainQuestion(t), true, t);
  for (const t of ['what does src/app.js do?', 'fix the failing test', "what's the weather today?", 'how do I install this project?', 'open chrome']) assert.equal(isPlainQuestion(t), false, t);
  const { listToolSchemas } = await import('../src/tools/index.js');
  assert.deepEqual(listToolSchemas({ noTools: true, allTools: [{ name: 'bash' }] }), [], 'no tools even when the context carries a tool set');
});
