import { turn, countExecuted } from '../harness.mjs';

// File uses CRLF line endings + tab indentation + double spaces inside the line.
// The mock model emits a NORMALIZED old_string; ox must apply it via the
// whitespace-fuzzy path and surface meta.fuzzy=true on the tool-end event.
export default {
  name: '03-fuzzy-edit',
  description: 'whitespace-tolerant fuzzy edit applied and surfaced',
  category: 'core-tools',
  prompt: 'In greet.js change the greeting from "hi" to "bye" using edit_file.',
  extraArgs: ['--yes-edits'],
  tokensPerTurn: { in: 800, out: 90 },

  async setup(sb) {
    const { writeWs } = await import('../harness.mjs');
    writeWs(sb, 'greet.js', 'function greet(name) {\r\n\t\treturn  "hi";\r\n}\r\nmodule.exports = { greet };\r\n');
  },

  async script(body, ws, state) {
    if (!countExecuted(body, 'edit_file')) {
      // Normalized old_string: single space, no CRLF/tab noise.
      return turn({ calls: [{ id: 'call_fz', name: 'edit_file', args: { path: `${ws}/greet.js`, old_string: 'return "hi";', new_string: 'return "bye";' } }] });
    }
    return turn({ text: 'Edited greeting to "bye".' });
  },

  async check(r) {
    if (r.exitCode !== 0) return { pass: false, detail: `exitCode=${r.exitCode}` };
    const fs = await import('node:fs');
    const path = await import('node:path');
    const after = fs.readFileSync(path.join(r.ws, 'greet.js'), 'utf8');
    const fuzzyEvents = r.events.filter((e) => e.t === 'tool-end' && e.name === 'edit_file' && e.meta?.fuzzy === true);
    if (!after.includes('return "bye";')) return { pass: false, detail: `replacement not applied:\n${JSON.stringify(after)}` };
    if (/return\s+"hi"/.test(after)) return { pass: false, detail: 'old greeting still present' };
    if (!after.includes('\r\n')) return { pass: false, detail: 'untouched regions lost their CRLF endings' };
    if (!fuzzyEvents.length) {
      const ends = r.events.filter((e) => e.t === 'tool-end').map((e) => JSON.stringify(e)).join(' | ');
      return { pass: false, detail: `fuzzy:true not surfaced on any tool-end event (${ends.slice(0, 300)})` };
    }
    return { pass: true, detail: 'fuzzy match applied, meta.fuzzy surfaced, file correct' };
  },
};
