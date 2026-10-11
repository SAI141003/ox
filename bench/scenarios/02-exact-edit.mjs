import { turn, countExecuted, finalTextOf } from '../harness.mjs';

export default {
  name: '02-exact-edit',
  description: 'exact-substring edit_file mutates disk correctly',
  category: 'core-tools',
  prompt: 'Use edit_file to replace the exact string "color = blue" with "color = red" in notes.txt at the workspace root.',
  extraArgs: ['--yes-edits'],
  tokensPerTurn: { in: 800, out: 90 },

  async setup(sb) {
    const { writeWs } = await import('../harness.mjs');
    writeWs(sb, 'notes.txt', '# notes\n\nfavorite color = blue\nsecondary = green\n');
  },

  async script(body, ws, state) {
    if (!countExecuted(body, 'edit_file')) {
      return turn({ calls: [{ id: 'call_edit1', name: 'edit_file', args: { path: `${ws}/notes.txt`, old_string: 'color = blue', new_string: 'color = red' } }] });
    }
    return turn({ text: 'Replaced "color = blue" with "color = red".' });
  },

  async check(r) {
    if (r.exitCode !== 0) return { pass: false, detail: `exitCode=${r.exitCode}` };
    const fs = await import('node:fs');
    const path = await import('node:path');
    const after = fs.readFileSync(path.join(r.ws, 'notes.txt'), 'utf8');
    const edits = r.events.filter((e) => e.t === 'tool-start' && e.name === 'edit_file').length;
    if (!after.includes('color = red')) return { pass: false, detail: `file not mutated:\n${after}` };
    if (after.includes('color = blue')) return { pass: false, detail: 'old string still present' };
    if (edits !== 1) return { pass: false, detail: `expected exactly 1 edit_file call, got ${edits}` };
    return { pass: true, detail: 'disk mutation verified' };
  },
};
