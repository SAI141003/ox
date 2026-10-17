// Photos reach the plans you pay for (src/subscriptions.js): a message with an
// image was dropped whole, words included, and no image was ever passed on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { foldPrompt, messageText, imagesOf, SUBSCRIPTION_CLIS as CLIS } from '../src/subscriptions.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

test('a message with a photo keeps its words, and its image becomes a file', () => {
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'what is on this page?' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } }] }];
  assert.equal(messageText(messages[0]), 'what is on this page?');
  assert.equal(foldPrompt(messages), 'what is on this page?');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-planimg-'));
  const files = imagesOf(messages, dir);
  assert.equal(files.length, 1);
  assert.ok(fs.readFileSync(files[0]).subarray(1, 4).toString() === 'PNG');
  assert.deepEqual(imagesOf([{ role: 'user', content: 'no image' }], dir), []);
});

test('Codex gets --image after the prompt; Claude Code is told where the file is', () => {
  const codex = CLIS.chatgpt.args({ prompt: 'describe it', approval: 'read', images: ['/tmp/a.png'] });
  assert.deepEqual(codex.slice(-3), ['describe it', '--image', '/tmp/a.png']);
  const claude = CLIS.claude.args({ prompt: 'describe it', approval: 'read', images: ['/tmp/a.png'] });
  assert.match(claude[1], /describe it[\s\S]*read this file to see it: \/tmp\/a\.png/);
  assert.equal(CLIS.chatgpt.args({ prompt: 'x', approval: 'read' }).includes('--image'), false);
});
