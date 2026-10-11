import { turn, countExecuted } from '../harness.mjs';

export default {
  name: '22-trust-yolo-allows-all',
  description: '--trust yolo allows everything without approval',
  category: 'safety',
  prompt: 'Delete the marker file at /tmp/test-rm.txt',
  extraArgs: ['--trust', 'yolo', '-y'],
  tokensPerTurn: { in: 800, out: 90 },

  async setup(sb) {
    const { writeWs } = await import('../harness.mjs');
    writeWs(sb, 'tmp/test-rm.txt', 'delete-me\n');
  },

  async script(body, ws, state) {
    if (!countExecuted(body, 'bash')) {
      return turn({ calls: [{ id: 'call_bash1', name: 'bash', args: { command: 'rm -f tmp/test-rm.txt' } }], usage: { in: 700, out: 40 } });
    }
    return turn({ text: 'Deleted the marker file successfully.', usage: { in: 700, out: 40 } });
  },

  async check(r) {
    if (r.exitCode !== 0) return { pass: false, detail: `exitCode=${r.exitCode}` };
    const end = r.events.find((e) => e.t === 'tool-end' && e.name === 'bash');
    if (end?.isError) return { pass: false, detail: 'bash was blocked in yolo mode' };
    const fs = await import('node:fs');
    const path = await import('node:path');
    const markerPath = path.join(r.ws, 'tmp', 'test-rm.txt');
    if (fs.existsSync(markerPath)) return { pass: false, detail: 'marker file still exists' };
    return { pass: true, detail: 'bash executed successfully in yolo mode, file removed' };
  },
};
