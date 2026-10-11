import { turn, countExecuted, finalTextOf } from '../harness.mjs';

const MARKER = 'BENCH-MARKER-ZQ7: ok-8821';
const FILE = 'marker.txt';

export default {
  name: '01-basic-read',
  description: 'model reads a file and echoes its marker back',
  category: 'core-tools',
  prompt: `Read ${FILE} in the workspace root with read_file and reply with the exact marker line it contains.`,
  tokensPerTurn: { in: 700, out: 80 },

  async setup(sb) {
    const { writeWs } = await import('../harness.mjs');
    writeWs(sb, FILE, `${MARKER}\n`);
  },

  async script(body, ws, state) {
    if (!body.messages.some((m) => m.role === "tool")) {
      return turn({ calls: [{ id: 'call_read1', name: 'read_file', args: { path: `${ws}/${FILE}` } }], usage: { in: 700, out: 40 } });
    }
    return turn({ text: `The marker line is: ${MARKER}`, usage: { in: 700, out: 40 } });
  },

  async check(r) {
    const finals = r.events.filter((e) => e.t === 'final');
    const text = finalTextOf(r.events);
    const reads = r.events.filter((e) => e.t === 'tool-start' && e.name === 'read_file').length;
    if (r.exitCode !== 0) return { pass: false, detail: `exitCode=${r.exitCode} stderr=${r.stderr.slice(0, 200)}` };
    if (reads !== 1) return { pass: false, detail: `expected exactly 1 read_file call, got ${reads}` };
    if (!text.includes('ok-8821')) return { pass: false, detail: `final text missing marker: "${text.slice(0, 120)}"` };
    if (!finals.length) return { pass: false, detail: 'no final event' };
    return { pass: true, detail: 'marker echoed, exactly one read' };
  },
};
