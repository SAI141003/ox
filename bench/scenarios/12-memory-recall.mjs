import { turn, countExecuted, parseNdjsonEvents } from '../harness.mjs';

const FACT = 'BENCH-FACT-8821';
const STATEMENT = 'BENCH-FACT-8821 means the bench harness is alive';

async function script(body, ws, state) {
  const sys = body.messages?.find((m) => m.role === 'system')?.content ?? '';
  if (sys.includes(FACT)) {
    // PHASE 2: fresh process, fact must already be in the system prompt memory block.
    state.flags.phase2SystemHasFact = true;
    return turn({ text: `Confirmed from memory: ${FACT} — the bench harness is alive.` });
  }
  // PHASE 1: store the fact.
  if (!countExecuted(body, 'memory_add')) {
    return turn({ calls: [{ id: 'call_mem1', name: 'memory_add', args: { type: 'project', statement: STATEMENT } }] });
  }
  const lastTool = body.messages.filter((m) => m.role === 'tool').pop();
  state.flags.phase1Stored = String(lastTool?.content ?? '').includes('memory_add') && !String(lastTool?.content ?? '').includes('isError');
  return turn({ text: `Stored ${FACT} to project memory.` });
}

export default {
  name: '12-memory-recall',
  description: 'fact stored via memory_add in one process is recalled from system prompt in a new process',
  category: 'memory',
  tokensPerTurn: { in: 850, out: 80 },
  script,

  async run(h) {
    const server = await h.startMock({ script, tokensPerTurn: this.tokensPerTurn, model: this.model, ws: h.sb.ws });
    const env = h.deterministicEnv({ home: h.sb.home, baseUrl: server.url, model: this.model });
    const p1 = await h.spawnOx({ args: ['-p', `Persist this project fact with memory_add: ${STATEMENT}`, '--json'], env, cwd: h.sb.ws, timeoutMs: 25_000 });
    const p2 = await h.spawnOx({ args: ['-p', `What does ${FACT} mean? Answer from memory.`, '--json'], env, cwd: h.sb.ws, timeoutMs: 25_000 });
    const events = [...parseNdjsonEvents(p1.stdout).map((e) => ({ ...e, phase: 1 })), ...parseNdjsonEvents(p2.stdout).map((e) => ({ ...e, phase: 2 }))];
    const out = {
      events,
      exitCode: p1.exitCode === 0 && p2.exitCode === 0 ? 0 : (p1.exitCode ?? 1),
      stdout: p1.stdout + p2.stdout,
      stderr: p1.stderr + p2.stderr,
      requests: server.requests,
      flags: server.flags,
      errors: server.errors,
      model: this.model,
      phase1Exit: p1.exitCode,
      phase2Exit: p2.exitCode,
    };
    await server.close();
    return out;
  },

  async check(r) {
    if (r.phase1Exit !== 0 || r.phase2Exit !== 0) return { pass: false, detail: `exit codes phase1=${r.phase1Exit} phase2=${r.phase2Exit}` };
    const fs = await import('node:fs');
    const path = await import('node:path');
    let mem = '';
    try { mem = fs.readFileSync(path.join(r.ws, '.agent', 'MEMORY.md'), 'utf8'); } catch {}
    if (!mem.includes(FACT)) return { pass: false, detail: `.agent/MEMORY.md missing fact:\n${mem.slice(0, 200)}` };
    if (!r.flags.phase1Stored) return { pass: false, detail: 'memory_add tool result did not confirm storage' };
    if (!r.flags.phase2SystemHasFact) return { pass: false, detail: 'phase-2 system prompt did not contain the stored fact' };
    const final2 = [...r.events].reverse().find((e) => e.t === 'final' && e.phase === 2);
    if (!String(final2?.message?.content ?? '').includes(FACT)) return { pass: false, detail: 'phase-2 final answer did not echo fact' };
    return { pass: true, detail: 'stored → persisted on disk → recalled in fresh process' };
  },
};
