import test from 'node:test';
import assert from 'node:assert/strict';

test('sends, payments, deletes and destructive commands need a fingerprint; reading does not', async () => {
  const G = await import('../src/approval-guard.js');
  for (const [tool, detail] of [['whatsapp_send', 'hi'], ['bash', 'rm -rf build'], ['bash', 'git push origin main'], ['web_task', 'click Buy now'], ['mail_send', '']]) assert.equal(G.needsFingerprint(tool, detail), true, `${tool} ${detail}`);
  for (const [tool, detail] of [['read_file', 'src/a.js'], ['open_app', 'Calculator'], ['bash', 'ls -la'], ['write_file', 'notes.txt']]) assert.equal(G.needsFingerprint(tool, detail), false, `${tool} ${detail}`);
  assert.equal(await G.confirmWithFingerprint('x', { platform: 'linux' }), true);
});
