import fs from 'node:fs';
import path from 'node:path';
import { turn } from '../harness.mjs';

export default {
  name: '09-resume-pairing',
  description: 'crashed session (orphan tool_call) resumes cleanly via sanitizeHistory',
  category: 'sessions',
  prompt: 'continue',
  extraArgs: ['-c'],
  tokensPerTurn: { in: 900, out: 70 },
  model: 'grok-4.6',

  async setup(sb) {
    const sessionsDir = path.join(sb.home, '.ox', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    const file = path.join(sessionsDir, `${stamp}-cef009.jsonl`);
    const lines = [
      JSON.stringify({ t: 'meta', created: d.toISOString(), cwd: fs.realpathSync(sb.ws) }),
      JSON.stringify({ t: 'user', text: 'read both config files' }),
      JSON.stringify({
        t: 'assistant',
        text: 'Reading them now.',
        tool_calls: [
          { id: 'call_aaa', function: { name: 'read_file', arguments: JSON.stringify({ path: `${sb.ws}/a.txt` }) } },
          { id: 'call_bbb', function: { name: 'read_file', arguments: JSON.stringify({ path: `${sb.ws}/b.txt` }) } },
        ],
      }),
      // Crash simulation: only ONE tool result landed before the process died.
      JSON.stringify({ t: 'tool-result', callId: 'call_aaa', name: 'read_file', isError: false, content: 'a-config-data' }),
    ];
    fs.writeFileSync(file, lines.join('\n') + '\n');
  },

  async script(body, ws, state) {
    // Provider-side pairing audit: every assistant tool_call must be answered.
    let unanswered = [];
    const msgs = body.messages ?? [];
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (m?.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue;
      const answered = new Set();
      let j = i + 1;
      while (j < msgs.length && msgs[j]?.role === 'tool') { answered.add(msgs[j].tool_call_id); j++; }
      for (const c of m.tool_calls) if (!answered.has(c.id)) unanswered.push(c.id);
    }
    state.flags.unanswered = state.flags.unanswered?.concat(unanswered) ?? unanswered;
    const sawSynthetic = msgs.some((m) => m.role === 'tool' && m.content === '[not executed: interrupted]');
    state.flags.sawSynthetic = (state.flags.sawSynthetic || sawSynthetic) ?? sawSynthetic;
    return turn({ text: 'Resumed cleanly: the interrupted second read was marked not executed.' });
  },

  async run(h) {
    const server = await h.startMock({
      script: this.script.bind(this),
      ws: h.sb.ws,
      tokensPerTurn: this.tokensPerTurn,
      model: this.model,
    });
    const env = h.deterministicEnv({ home: h.sb.home, baseUrl: server.url, model: this.model });
    const run = await h.spawnOx({ args: ['-p', this.prompt, '--json', ...this.extraArgs], env, cwd: h.sb.ws, timeoutMs: 25_000 });
    const events = (await import('../harness.mjs')).parseNdjsonEvents(run.stdout);
    const requests = server.requests;
    const flags = server.flags;
    const errors = server.errors;
    await server.close();
    return { events, exitCode: run.exitCode, stdout: run.stdout, stderr: run.stderr, requests, flags, errors, model: this.model };
  },

  async check(r) {
    if (r.exitCode !== 0) return { pass: false, detail: `exitCode=${r.exitCode} stderr=${r.stderr.slice(0, 240)}` };
    if (!r.requests.length) return { pass: false, detail: 'no provider request reached mock' };
    if ((r.flags.unanswered ?? []).length > 0) {
      return { pass: false, detail: `provider would 400: unanswered tool_call ids ${JSON.stringify(r.flags.unanswered)}` };
    }
    if (!r.flags.sawSynthetic) return { pass: false, detail: "'[not executed: interrupted]' sentinel absent from outbound messages" };
    const final = r.events.find((e) => e.t === 'final');
    if (!String(final?.message?.content ?? '').includes('Resumed cleanly')) return { pass: false, detail: 'unexpected final text' };
    return { pass: true, detail: 'pairing sanitized, synthetic sentinel present, exit 0' };
  },
};
