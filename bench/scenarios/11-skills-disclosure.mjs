import { turn, countExecuted } from '../harness.mjs';

export default {
  name: '11-skills-disclosure',
  description: 'skill index in system prompt, body read from disk, instruction followed',
  category: 'integrations',
  prompt: 'Follow your deploy-pro skill exactly.',
  tokensPerTurn: { in: 850, out: 70 },

  async setup(sb) {
    const { writeWs } = await import('../harness.mjs');
    writeWs(sb, '.agents/skills/deploy-pro/SKILL.md', [
      '---',
      'name: deploy-pro',
      'description: Production deployment procedure with the mandatory SKILLMARK acknowledgment.',
      '---',
      '',
      '# deploy-pro',
      '',
      'Deployment procedure step 1: verify the build artifact.',
      'MANDATORY: whenever you execute this skill, print the word SKILLMARK exactly once in your final answer.',
      '',
    ].join('\n'));
  },

  async script(body, ws, state) {
    const sys = body.messages?.find((m) => m.role === 'system')?.content ?? '';
    if (!state.flags.skillIndexInSystem && sys.includes('deploy-pro')) state.flags.skillIndexInSystem = true;
    if (!countExecuted(body, 'read_file')) {
      const m = sys.match(/deploy-pro — [^\n]*\(read path to invoke: ([^)]+)\)/);
      if (!m) { state.flags.noIndexPath = true; return turn({ text: 'no skill path found' }); }
      return turn({ calls: [{ id: 'call_sk1', name: 'read_file', args: { path: m[1].trim() } }] });
    }
    const lastTool = body.messages.filter((x) => x.role === 'tool').pop();
    state.flags.skillBodyRead = String(lastTool?.content ?? '').includes('SKILLMARK exactly once');
    return turn({ text: 'Deploy procedure acknowledged. SKILLMARK' });
  },

  async check(r) {
    if (r.exitCode !== 0) return { pass: false, detail: `exitCode=${r.exitCode}` };
    if (!r.flags.skillIndexInSystem) return { pass: false, detail: "system prompt does not disclose 'deploy-pro' skill index" };
    if (r.flags.noIndexPath) return { pass: false, detail: 'skill index line lacked a readable path' };
    const readCalls = [];
    for (const body of r.requests) {
      for (const m of body.messages ?? []) {
        if (m?.role === 'assistant' && Array.isArray(m.tool_calls)) {
          for (const c of m.tool_calls) {
            if (c?.function?.name === 'read_file') readCalls.push(String(JSON.parse(c.function.arguments || '{}').path ?? ''));
          }
        }
      }
    }
    if (!readCalls.some((p) => p.endsWith('deploy-pro/SKILL.md'))) return { pass: false, detail: `SKILL.md never read: ${JSON.stringify(readCalls)}` };
    if (!r.flags.skillBodyRead) return { pass: false, detail: 'skill body content not returned by read_file' };
    const final = r.events.find((e) => e.t === 'final');
    if (!String(final?.message?.content ?? '').includes('SKILLMARK')) return { pass: false, detail: 'final answer lacks SKILLMARK' };
    return { pass: true, detail: 'index disclosed, body read, instruction honored' };
  },
};
