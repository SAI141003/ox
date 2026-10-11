import fs from 'node:fs';
import path from 'node:path';
import { turn, countExecuted, systemOf } from '../harness.mjs';

const PATTERN = 'BENCH-PROCEDURAL-PATTERN-8821';

export default {
  name: '25-procedural-memory-recall',
  description: 'procedural memory from prior session appears in system prompt',
  category: 'memory',
  prompt: 'Read a file and edit it',
  extraArgs: ['--yes-edits'],
  tokensPerTurn: { in: 850, out: 80 },

  async setup(sb) {
    const { writeWs } = await import('../harness.mjs');
    writeWs(sb, 'src/test.js', 'const x = 1;\n');
    const agentDir = path.join(sb.ws, '.agent');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'procedural.md'),
      `# Procedural memory\n\n## code (1 successful, 0 failed)\n\n- ✓ [2026-09-05] ${PATTERN}\n\n`);
  },

  async script(body, ws, state) {
    if (!countExecuted(body, 'read_file')) {
      return turn({ calls: [{ id: 'call_rf1', name: 'read_file', args: { path: `${ws}/src/test.js` } }], usage: { in: 700, out: 40 } });
    }
    if (!countExecuted(body, 'edit_file')) {
      return turn({ calls: [{ id: 'call_ef1', name: 'edit_file', args: { path: `${ws}/src/test.js`, old_string: 'const x = 1;', new_string: 'const x = 2;' } }], usage: { in: 700, out: 40 } });
    }
    const sys = systemOf(body);
    state.flags.systemHasProcedural = sys.includes(PATTERN) || sys.includes('procedural memory');
    return turn({ text: 'Read and edited src/test.js successfully.', usage: { in: 700, out: 40 } });
  },

  async check(r) {
    if (r.exitCode !== 0) return { pass: false, detail: `exitCode=${r.exitCode}` };
    if (!r.flags.systemHasProcedural) return { pass: false, detail: 'system prompt missing procedural memory block' };
    return { pass: true, detail: 'system prompt includes procedural memory from prior session' };
  },
};
