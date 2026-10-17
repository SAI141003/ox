// current_page: the browser's front tab, so "this video" has a meaning; never
// launches a browser, says plainly when there is none or macOS says no.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentPageTool, pickScript, tabScript, CURRENT_PAGE_SIGNAL } from '../src/tools/current-page.js';
import { classifyTool } from '../src/resource-class.js';

test('the front tab, and a YouTube page points at its transcript', async () => {
  const r = await currentPageTool({}, { platform: 'darwin', run: async (s) => (s.includes('System Events') ? 'Arc\n' : 'Some talk\nhttps://youtu.be/aircAruvnKk') });
  assert.equal(r.content, 'Some talk\nhttps://youtu.be/aircAruvnKk\nin Arc\nThis is a YouTube video: youtube_transcript reads what it says.');
  assert.match(pickScript(), /is running/);
  assert.doesNotMatch(pickScript(), /activate|launch/);
  assert.equal(tabScript('Notes'), null);
  assert.equal(classifyTool('current_page'), 'pure_read');
});

test('no browser, no permission, not a Mac: said plainly', async () => {
  assert.match((await currentPageTool({}, { platform: 'darwin', run: async () => '' })).content, /no browser is open/);
  assert.match((await currentPageTool({}, { platform: 'darwin', run: async () => { throw new Error('Not authorized to send Apple events (-1743)'); } })).content, /Automation/);
  assert.match((await currentPageTool({}, { platform: 'linux' })).content, /macOS only/);
});

test('"this video" and "what am I watching" bring the tool along', () => {
  for (const t of ['what is this video about', "summarise this article", 'what am I watching?']) assert.ok(CURRENT_PAGE_SIGNAL.test(t), t);
  assert.equal(CURRENT_PAGE_SIGNAL.test('fix the failing test'), false);
});
