import { turn, countExecuted } from '../harness.mjs';

export default {
  name: '05-test-fix-loop',
  description: 'bash fails, edit fixes, bash goes green (recovery loop)',
  category: 'agentic-loop',
  prompt: 'Run node test.js with bash; if it fails, fix lib.js so the assertion passes, then run node test.js again to confirm it is green.',
  extraArgs: ['-y'],
  tokensPerTurn: { in: 900, out: 110 },

  async setup(sb) {
    const { writeWs } = await import('../harness.mjs');
    writeWs(sb, 'test.js', [
      "const assert = require('assert');",
      "const { greet } = require('./lib.js');",
      "assert.strictEqual(greet('x'), 'hi x');",
      "console.log('PASS');",
      '',
    ].join('\n'));
    writeWs(sb, 'lib.js', "module.exports.greet = (n) => 'hello ' + n;\n");
  },

  async script(body, ws, state) {
    const bashes = countExecuted(body, 'bash');
    const edits = countExecuted(body, 'edit_file');
    if (bashes === 0 && edits === 0) {
      return turn({ calls: [{ id: 'call_t1', name: 'bash', args: { command: 'node test.js' } }] });
    }
    if (edits === 0) {
      return turn({ calls: [{ id: 'call_fx', name: 'edit_file', args: { path: `${ws}/lib.js`, old_string: "'hello '", new_string: "'hi '" } }] });
    }
    if (bashes === 1) {
      return turn({ calls: [{ id: 'call_t2', name: 'bash', args: { command: 'node test.js' } }] });
    }
    const lastTool = body.messages.filter((m) => m.role === 'tool').pop();
    state.flags.secondRunGreen = String(lastTool?.content ?? '').startsWith('exit 0') && (lastTool?.content ?? '').includes('PASS');
    return turn({ text: 'Fixed lib.js; test run is green now.' });
  },

  async check(r) {
    if (r.exitCode !== 0) return { pass: false, detail: `exitCode=${r.exitCode}` };
    const fs = await import('node:fs');
    const path = await import('node:path');
    const lib = fs.readFileSync(path.join(r.ws, 'lib.js'), 'utf8');
    const bashes = r.events.filter((e) => e.t === 'tool-start' && e.name === 'bash').length;
    const firstBashEnd = r.events.find((e) => e.t === 'tool-end' && e.name === 'bash');
    if (!lib.includes("'hi '")) return { pass: false, detail: `lib.js not fixed:\n${lib}` };
    if (bashes < 2) return { pass: false, detail: `expected >=2 bash calls, got ${bashes}` };
    if (!firstBashEnd || firstBashEnd.ok !== false) return { pass: false, detail: 'first bash should have failed (red)' };
    if (!r.flags.secondRunGreen) return { pass: false, detail: 'second bash run was not green' };
    if ((r.ms ?? 0) > 20_000) return { pass: false, detail: `recovery took too long: ${r.ms}ms` };
    return { pass: true, detail: 'fail → fix → green within budget' };
  },
};
