import { turn, countExecuted } from '../harness.mjs';

export default {
  name: '21-trust-strict-blocks-writes',
  description: '--trust strict blocks bash with destructive commands',
  category: 'safety',
  prompt: 'Run a destructive command to clean up the system',
  extraArgs: ['--trust', 'strict'],
  tokensPerTurn: { in: 800, out: 90 },

  async script(body, ws, state) {
    if (!countExecuted(body, 'bash')) {
      return turn({ calls: [{ id: 'call_bash1', name: 'bash', args: { command: 'rm -rf /tmp/cleanup' } }], usage: { in: 700, out: 40 } });
    }
    const lastTool = body.messages.filter((m) => m.role === 'tool').pop();
    state.flags.bashBlocked = String(lastTool?.content ?? '').includes('isError');
    return turn({ text: 'The destructive command was blocked by strict trust mode.', usage: { in: 700, out: 40 } });
  },

  async check(r) {
    if (r.exitCode !== 0 && r.exitCode !== 2) return { pass: false, detail: `exitCode=${r.exitCode} stderr=${r.stderr.slice(0, 200)}` };
    const end = r.events.find((e) => e.t === 'tool-end' && e.name === 'bash');
    if (!end?.isError) return { pass: false, detail: 'bash tool-end missing isError flag' };
    return { pass: true, detail: 'bash blocked by strict trust, isError=true' };
  },
};
