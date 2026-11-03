// How well `ox knowledge` ranks: questions asked the way a person would ask them,
// each with the doc section that answers it. Scored on what the model is sent:
// where that section lands in the answer (hit@1, hit@3, MRR over the top 8).
//   node bench/knowledge/rank.mjs [--verbose]
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import * as K from '../../src/knowledge-graph-docs.js';

const CASES = [
  ['how do I keep my mac from sleeping while ox works', 'REFERENCE.md › ox — the featherweight coding agent › Keep the computer awake'],
  ['can I use my claude or chatgpt subscription instead of an api key', 'Bring your own subscription'],
  ['run the agent commands inside a docker container', "Run the agent's commands in a container"],
  ['move my session over to another AI coding tool', 'Move a session to another AI tool'],
  ['several agents working at once without stepping on each other', 'Task board: many agents, no collisions'],
  ['what does ox remember about me', 'What ox remembers about you'],
  ['use ox from my phone', 'ox on your phone'],
  ['read websites that only work with javascript', 'Reading JavaScript-only pages'],
  ['why does a budget stopped run exit 2 in CI', 'Breaking change: a budget-stopped run now exits 2'],
  ['talk to ox about what is on my screen', 'OX Buddy: talk to ox about your screen'],
  ['watch a web page and tell me when it changes', 'Watch a page'],
  ['do small tasks offline with no AI', 'Small tasks with no AI and no internet'],
  ['which email account does ox send from', 'Email, from the right account'],
  ['the notch app on macos', 'OX Island (macOS notch)'],
  ['keep the prompt cache stable', 'Prompt assembly & cache stability'],
  ['custom sandbox profiles', 'Custom sandbox profiles'],
  ['give agents library documentation', 'Library docs for agents'],
  ['a company of agents with roles', 'A company of agents: `ox org`'],
  ['can ox speak out loud', 'ox speaks'],
  ['install on a mac with apple silicon', 'TESTING.md › Testing ox › 1. Install'],
];

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-kg-bench-'));   // docs only: no one's memory in a benchmark
const g = await K.buildKnowledge({ root, home, memory: false, brain: false });
const verbose = process.argv.includes('--verbose');
let h1 = 0, h3 = 0, rr = 0, tokens = 0;
for (const [q, want] of CASES) {
  const r = K.queryKnowledge(g, q, { budget: 800 });
  const rank = r.used.slice(0, 8).findIndex((n) => (n.source ?? '').includes(want)) + 1;
  if (rank === 1) h1++;
  if (rank && rank <= 3) h3++;
  if (rank) rr += 1 / rank;
  tokens += r.tokens;
  if (verbose || !rank || rank > 3) console.log(`${rank ? `#${rank}` : 'miss'}  ${q}\n      top: ${r.used[0]?.source ?? '(nothing)'}`);
}
const n = CASES.length;
console.log(`\nhit@1 ${h1}/${n}   hit@3 ${h3}/${n}   MRR ${(rr / n).toFixed(3)}   avg answer ${Math.round(tokens / n)} tokens   (${g.stats.sections} sections)`);
fs.rmSync(home, { recursive: true, force: true });
