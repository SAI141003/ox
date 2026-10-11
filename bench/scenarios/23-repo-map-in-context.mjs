import { turn, systemOf } from '../harness.mjs';

export default {
  name: '23-repo-map-in-context',
  description: '--repo-map adds a repo map to the system prompt',
  category: 'context',
  prompt: 'List the files in the repo',
  extraArgs: ['--repo-map'],
  tokensPerTurn: { in: 1000, out: 80 },

  async setup(sb) {
    const { writeWs } = await import('../harness.mjs');
    writeWs(sb, 'src/foo.js', 'export const foo = 1;\n');
    writeWs(sb, 'lib/bar.js', 'export const bar = 2;\n');
  },

  async script(body, ws, state) {
    const sys = systemOf(body);
    state.flags.systemHasRepoMap = sys.includes('# REPO MAP') || (sys.includes('src/foo.js') && sys.includes('lib/bar.js'));
    return turn({ text: 'The repo contains: src/foo.js, lib/bar.js', usage: { in: 800, out: 40 } });
  },

  async check(r) {
    if (r.exitCode !== 0) return { pass: false, detail: `exitCode=${r.exitCode}` };
    if (!r.flags.systemHasRepoMap) return { pass: false, detail: 'system prompt missing repo map or file paths' };
    return { pass: true, detail: 'system prompt includes repo map with file paths' };
  },
};
