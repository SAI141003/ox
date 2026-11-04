// A request to make a picture runs create_media, not a drawn answer with a
// Wikipedia photo; the made file is shown in the chat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wantsMediaMade, madeMedia } from '../src/serve.js';

test('asking for a picture or clip to be made is a media request', () => {
  for (const s of ['create an image of a dog', 'Generate a picture of a red panda on a branch', 'make me a logo for my bakery', 'draw a cat wearing a hat', 'can you make a short video of waves', 'paint a sunset over Vancouver', 'draw a cat sitting on a table', 'make an image of a page from an old book']) {
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

test('a mistyped request to make a picture is still one; real words near it are not', () => {
  for (const s of ['hey crreate and image of sports car in 2d sketch', 'creat an imge of a cat', 'crate a video of a cat', 'genrate a pictre of a dog', 'make a skecth of a house']) {
    assert.equal(wantsMediaMade(s), true, s);
  }
  for (const s of ['I created an image yesterday', 'create a mage for my game', 'create a proto for the api', 'crate the boxes', 'what is an image file', 'take a picture of this', 'build a crate for a video game page', 'create a video game with three levels']) {
    assert.equal(wantsMediaMade(s), false, s);
  }
});

test('a picture asked for reaches the tool as what to draw, with its kind', async () => {
  const { mediaBrief } = await import('../src/serve.js');
  assert.deepEqual(mediaBrief('hey crreate and image of sports car in 2d sketch'), { prompt: 'sports car in 2d sketch', kind: 'image' });
  assert.deepEqual(mediaBrief('crate a vedio of a cat jumping'), { prompt: 'a cat jumping', kind: 'video' });
  assert.deepEqual(mediaBrief('draw a red bicycle'), { prompt: 'draw a red bicycle', kind: 'image' });
});

