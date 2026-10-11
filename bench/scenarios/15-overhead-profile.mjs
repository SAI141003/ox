import { turn, countExecuted, parseNdjsonEvents, timeColdStarts } from '../harness.mjs';

const MARKER = 'BENCH-OVERHEAD-MARKER';

export default {
  name: '15-overhead-profile',
  description: 'cold-start p95 + one full deterministic turn overhead (report-only tolerance)',
  category: 'meta',
  tokensPerTurn: { in: 700, out: 60 },

  async setup(sb) {
    const { writeWs } = await import('../harness.mjs');
    writeWs(sb, 'marker.txt', `${MARKER}\n`);
  },

  async script(body, ws, state) {
    if (!countExecuted(body, 'read_file')) {
      return turn({ calls: [{ id: 'call_oh', name: 'read_file', args: { path: `${ws}/marker.txt` } }] });
    }
    return turn({ text: `Marker is ${MARKER}.` });
  },

  async run(h) {
    // 20× `ox --version` cold starts
    const cold = timeColdStarts(20, ['--version']);
    // One full deterministic 01-style turn
    const server = await h.startMock({ script: this.script.bind(this), tokensPerTurn: this.tokensPerTurn, model: this.model, ws: h.sb.ws });
    const env = h.deterministicEnv({ home: h.sb.home, baseUrl: server.url, model: this.model });
    const t0 = performance.now();
    const run = await h.spawnOx({ args: ['-p', `Read marker.txt and reply with its exact contents.`, '--json'], env, cwd: h.sb.ws, timeoutMs: 30_000 });
    const turnMs = performance.now() - t0;
    const events = parseNdjsonEvents(run.stdout);
    await server.close();
    const okTurn = run.exitCode === 0 && events.some((e) => e.t === 'final' && String(e.message?.content ?? '').includes(MARKER));
    return {
      events,
      exitCode: okTurn ? 0 : (run.exitCode ?? 1),
      stdout: run.stdout,
      stderr: run.stderr,
      requests: server.requests,
      flags: { ...cold, turnMs, okTurn },
      errors: server.errors,
      model: this.model,
    };
  },

  async check(r) {
    if (!r.flags.okTurn) return { pass: false, detail: 'reference turn failed — overhead profile invalid' };
    const { mean, p95, turnMs } = r.flags;
    // Report-only tolerance: pass regardless, but surface the numbers prominently.
    const overhead = Math.max(0, turnMs - p95);
    const verdict = p95 < 300 ? 'within 300ms p95 budget' : 'ABOVE 300ms p95 budget (report-only tolerance: still passing)';
    return {
      pass: true,
      detail: `cold-start mean=${mean.toFixed(1)}ms p95=${p95.toFixed(1)}ms · full-turn=${turnMs.toFixed(1)}ms · per-turn overhead≈${overhead.toFixed(1)}ms — ${verdict}`,
    };
  },
};
