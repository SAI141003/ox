import { turn, countExecuted } from '../harness.mjs';

export default {
  name: '04-multi-file-refactor',
  description: 'create module, rewire importer, verify via bash exit 0',
  category: 'agentic-loop',
  prompt: 'Refactor: create lib/add.js that exports add(a,b) via module.exports, then point importer.js at ./lib/add.js instead of ./math.js, then run `node importer.js` with bash to prove it still prints 3.',
  extraArgs: ['-y'],
  tokensPerTurn: { in: 900, out: 120 },

  async setup(sb) {
    const { writeWs } = await import('../harness.mjs');
    writeWs(sb, 'math.js', 'module.exports.add = (a, b) => a + b;\n');
    writeWs(sb, 'importer.js', "const { add } = require('./math.js');\nconsole.log(add(1, 2));\n");
  },

  async script(body, ws, state) {
    const writes = countExecuted(body, 'write_file');
    const edits = countExecuted(body, 'edit_file');
    const bashes = countExecuted(body, 'bash');
    if (!writes) {
      return turn({ calls: [{ id: 'call_w1', name: 'write_file', args: { path: `${ws}/lib/add.js`, content: 'module.exports.add = (a, b) => a + b;\n' } }] });
    }
    if (!edits) {
      return turn({ calls: [{ id: 'call_e1', name: 'edit_file', args: { path: `${ws}/importer.js`, old_string: "./math.js", new_string: "./lib/add.js" } }] });
    }
    if (!bashes) {
      return turn({ calls: [{ id: 'call_b1', name: 'bash', args: { command: 'node importer.js' } }] });
    }
    const bashResult = (body.messages.filter((m) => m.role === 'tool').pop()?.content ?? '');
    state.flags.bashResult = bashResult;
    return turn({ text: `Refactor complete; verification ran: ${bashResult.split('\n')[0]}` });
  },

  async check(r) {
    if (r.exitCode !== 0) return { pass: false, detail: `exitCode=${r.exitCode}` };
    const fs = await import('node:fs');
    const path = await import('node:path');
    const addJs = fs.readFileSync(path.join(r.ws, 'lib', 'add.js'), 'utf8');
    const importer = fs.readFileSync(path.join(r.ws, 'importer.js'), 'utf8');
    const bashes = r.events.filter((e) => e.t === 'tool-start' && e.name === 'bash');
    const lastBashEnd = [...r.events].reverse().find((e) => e.t === 'tool-end' && e.name === 'bash');
    if (!addJs.includes('module.exports.add')) return { pass: false, detail: 'lib/add.js wrong content' };
    if (!importer.includes('./lib/add.js')) return { pass: false, detail: `importer not rewired:\n${importer}` };
    if (bashes.length !== 1) return { pass: false, detail: `expected exactly 1 bash call, got ${bashes.length}` };
    if (!lastBashEnd || !lastBashEnd.ok) return { pass: false, detail: `bash did not succeed: ${JSON.stringify(lastBashEnd)}` };
    const observed = r.flags.bashResult ?? '';
    if (!(observed.startsWith('exit 0') && observed.includes('3'))) {
      return { pass: false, detail: `bash output not exit 0 / no '3': ${observed.slice(0, 160)}` };
    }
    return { pass: true, detail: 'both files correct, bash exit 0 once' };
  },
};
