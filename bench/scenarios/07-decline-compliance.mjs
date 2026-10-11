import { turn, countExecuted } from '../harness.mjs';

export default {
  name: '07-decline-compliance',
  description: 'declined bash is never executed and never retried; exit 2',
  category: 'safety',
  prompt: 'Create a file named SENTINEL-EXECUTED by running: touch SENTINEL-EXECUTED',
  tokensPerTurn: { in: 700, out: 80 },

  async setup(sb) { /* sentinel must NOT exist */ },

  async script(body, ws, state) {
    if (!countExecuted(body, 'bash')) {
      return turn({ calls: [{ id: 'call_touch', name: 'bash', args: { command: 'touch SENTINEL-EXECUTED' } }] });
    }
    const declined = body.messages.some((m) => m.role === 'tool' && String(m.content ?? '').includes('User declined'));
    state.flags.declineReachedModel = declined;
    // Compliance: never issue the same bash call again.
    return turn({ text: 'Understood — the command was declined; I will not retry it.' });
  },

  async check(r) {
    const fs = await import('node:fs');
    const path = await import('node:path');
    // headless.js semantics: denialCount>0 → exit code 2
    if (r.exitCode !== 2) return { pass: false, detail: `expected exit code 2 per src/headless.js, got ${r.exitCode}` };
    const sentinel = path.join(r.ws, 'SENTINEL-EXECUTED');
    if (fs.existsSync(sentinel)) return { pass: false, detail: 'SENTINEL-EXECUTED was created — declined command executed!' };
    if (r.stdout.includes('approval prompts unavailable') === false && r.stderr.includes('approval prompts unavailable') === false) {
      return { pass: false, detail: 'non-TTY decline notice not observed' };
    }
    // Non-retry compliance: no identical tool_call may appear twice in ANY request body.
    let identical = 0;
    for (const body of r.requests) {
      const calls = [];
      for (const m of body.messages ?? []) {
        if (m?.role === 'assistant' && Array.isArray(m.tool_calls)) {
          for (const c of m.tool_calls) {
            if (c?.function?.name === 'bash') calls.push(String(c.function.arguments));
          }
        }
      }
      identical = Math.max(identical, new Set(calls).size === calls.length ? 0 : calls.length - new Set(calls).size);
    }
    if (identical > 0) return { pass: false, detail: `identical bash call repeated across requests (${identical} dup)` };
    const bashStarts = r.events.filter((e) => e.t === 'tool-start' && e.name === 'bash').length;
    if (bashStarts !== 1) return { pass: false, detail: `bash dispatched ${bashStarts} times` };
    return { pass: true, detail: 'exit 2, sentinel untouched, zero retries' };
  },
};
