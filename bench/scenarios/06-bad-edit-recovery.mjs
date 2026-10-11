import { turn, countExecuted } from '../harness.mjs';

export default {
  name: '06-bad-edit-recovery',
  description: 'edit fails (old_string absent), model recovers with correct edit',
  category: 'agentic-loop',
  prompt: 'In notes.txt, replace the word "gamma" with "GAMMA" using edit_file.',
  extraArgs: ['--yes-edits'],
  tokensPerTurn: { in: 800, out: 100 },

  async setup(sb) {
    const { writeWs } = await import('../harness.mjs');
    writeWs(sb, 'notes.txt', 'alpha beta gamma\nsecond line\n');
  },

  async script(body, ws, state) {
    const edits = countExecuted(body, 'edit_file');
    if (edits === 0) {
      // Deliberately wrong: "delta" is not in the file.
      return turn({ calls: [{ id: 'call_bad', name: 'edit_file', args: { path: `${ws}/notes.txt`, old_string: 'alpha delta gamma', new_string: 'alpha delta GAMMA' } }] });
    }
    if (edits === 1) {
      return turn({ calls: [{ id: 'call_good', name: 'edit_file', args: { path: `${ws}/notes.txt`, old_string: 'gamma', new_string: 'GAMMA' } }] });
    }
    return turn({ text: 'Recovered after the failed match; GAMMA is now in place.' });
  },

  async check(r) {
    if (r.exitCode !== 0) return { pass: false, detail: `exitCode=${r.exitCode} stderr=${r.stderr.slice(0, 200)}` };
    const fs = await import('node:fs');
    const path = await import('node:path');
    const after = fs.readFileSync(path.join(r.ws, 'notes.txt'), 'utf8');
    const starts = r.events.filter((e) => e.t === 'tool-start' && e.name === 'edit_file');
    const ends = r.events.filter((e) => e.t === 'tool-end' && e.name === 'edit_file');
    if (!after.includes('alpha beta GAMMA')) return { pass: false, detail: `file not correctly mutated:\n${after}` };
    if (starts.length !== 2) return { pass: false, detail: `expected exactly one failed-then-success pair, got ${starts.length} edits` };
    if (!ends[0]?.isError) return { pass: false, detail: 'first edit did not error' };
    if (ends[1]?.isError) return { pass: false, detail: 'second edit errored' };
    if (!r.events.some((e) => e.t === 'reflection')) return { pass: false, detail: 'no reflection emitted after failure' };
    return { pass: true, detail: 'recovered: fail then success, no crash' };
  },
};
