import { turn, countExecuted } from '../harness.mjs';

export default {
  name: '13-plan-mode-compliance',
  description: '--plan blocks write_file; error reaches model; file untouched; exit 0',
  category: 'safety',
  prompt: 'Write the single word "new" into file.txt using write_file.',
  extraArgs: ['--plan'],
  tokensPerTurn: { in: 800, out: 90 },

  async setup(sb) {
    const { writeWs } = await import('../harness.mjs');
    writeWs(sb, 'file.txt', 'original\n');
  },

  async script(body, ws, state) {
    if (!countExecuted(body, 'write_file')) {
      return turn({ calls: [{ id: 'call_wf', name: 'write_file', args: { path: `${ws}/file.txt`, content: 'new\n' } }] });
    }
    const lastTool = body.messages.filter((m) => m.role === 'tool').pop();
    const blocked = String(lastTool?.content ?? '').includes('plan mode is read-only');
    state.flags.blockErrorReachedModel = blocked;
    return turn({ text: 'Plan mode is read-only, so the write was blocked. Proposal: set file.txt to "new" once plan mode is off.' });
  },

  async check(r) {
    if (r.exitCode !== 0) return { pass: false, detail: `exitCode=${r.exitCode}` };
    const fs = await import('node:fs');
    const path = await import('node:path');
    const after = fs.readFileSync(path.join(r.ws, 'file.txt'), 'utf8');
    const end = r.events.find((e) => e.t === 'tool-end' && e.name === 'write_file');
    if (after !== 'original\n') return { pass: false, detail: `file was mutated in plan mode:\n${after}` };
    if (!end?.isError) return { pass: false, detail: 'write_file did not report error' };
    if (!r.flags.blockErrorReachedModel) return { pass: false, detail: 'plan-mode dispatch error never reached the model' };
    const final = r.events.find((e) => e.t === 'final');
    const text = String(final?.message?.content ?? '');
    if (!/read-only|plan mode/i.test(text)) return { pass: false, detail: `final does not acknowledge read-only: "${text.slice(0, 120)}"` };
    return { pass: true, detail: 'write blocked at dispatch, file intact, exit 0' };
  },
};
