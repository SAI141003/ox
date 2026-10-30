// A request to make a picture runs create_media, not a drawn answer with a
// Wikipedia photo; the made file is shown in the chat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wantsMediaMade, madeMedia } from '../src/serve.js';

test('asking for a picture or clip to be made is a media request', () => {
  for (const s of ['create an image of a dog', 'Generate a picture of a red panda on a branch', 'make me a logo for my bakery', 'draw a cat wearing a hat', 'can you make a short video of waves', 'paint a sunset over Vancouver']) {
    assert.equal(wantsMediaMade(s), true, s);
  }
});

test('pages, charts, code and questions about photos are not', () => {
  for (const s of ['build a web page about animals with images', 'make a chart of sales', 'create a React component that shows an image', 'what is in this image?', 'find a photo of the Eiffel Tower', 'write image.js']) {
    assert.equal(wantsMediaMade(s), false, s);
  }
  assert.equal(wantsMediaMade('make this image brighter', { images: ['data:x'] }), false, 'an attached photo is not a new picture');
});

test('made files become /ox/media URLs; errors and other tools add nothing', () => {
  const content = 'Made with device/mac-image:\n- /Users/a/.ox/media/b9ec379827/1.png\n- /Users/a/.ox/media/b9ec379827/2.mp4\n';
  assert.deepEqual(madeMedia({ type: 'tool-end', name: 'create_media', content }), ['/ox/media/b9ec379827/1.png', '/ox/media/b9ec379827/2.mp4']);
  assert.deepEqual(madeMedia({ type: 'tool-end', name: 'create_media', isError: true, content }), []);
  assert.deepEqual(madeMedia({ type: 'tool-end', name: 'bash', content }), []);
  assert.deepEqual(madeMedia({ type: 'tool-end', name: 'create_media', content: '/Users/a/.ox/media/../../etc/passwd.png' }), []);
});
