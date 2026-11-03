// ox memory bench: LongMemEval-style categories, run against ox's own memory
// (src/memory-graph.js) with nothing mocked.
//
//   node bench/memory/run.mjs [--json]
//
// Stage 1, learning: ordinary user messages, said across "sessions" days
// apart, go through learnFromMessages exactly as a chat would. Did the fact get
// kept at all? (extraction recall)
// Stage 2, recall: questions asked in different words than the fact was said.
// Is the CURRENT gold fact in the top k? Superseded facts must not win. A
// question about something never said must come back empty (abstention).
// Also reported: the tokens the memory block adds to a prompt.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.OX_MEMORY_HOME = path.join(os.tmpdir(), 'ox-membench-unused');
const M = await import('../../src/memory-graph.js');
const DAY = 86_400_000;
const T0 = Date.parse('2026-09-01T10:00:00Z');

// Sessions: what the user said, when. Facts are inside ordinary messages.
const SESSIONS = [
  { day: 0, said: [
    'hey, quick one. I work at Stripe as a backend engineer, mostly on the billing service.',
    'I prefer TypeScript over JavaScript for anything new.',
    'my sister is Priya and she lives in Toronto.',
    'Can you fix the flaky test in payments.spec.ts?',
  ] },
  { day: 3, said: [
    'I usually deploy with Fly.io, not Heroku.',
    'remember that my dog is called Biscuit',
    'I live in Vancouver.',
    'I never want semicolons in my JavaScript.',
  ] },
  { day: 9, said: [
    'from now on use pnpm instead of npm in my projects',
    'I am allergic to peanuts, so skip those in any recipe.',
    'my favourite editor is Neovim',
    'we use Postgres 16 for the main database',
  ] },
  { day: 20, said: [
    'big news: I work at Anthropic now, started this week.',
    'I moved, I live in Seattle now.',
    'my standup is at 9:30 every weekday',
  ] },
  { day: 30, said: [
    'I prefer dark mode in every app',
    'my daughter Maya starts kindergarten on September 3rd',
    'I hate long meetings, keep summaries short',
  ] },
];

// q: the question, in other words. gold: words the right memory must contain.
// not: words that must NOT be in the top answer (an outdated version).
const QUESTIONS = [
  { cat: 'single-session', q: 'Which company am I employed by?', gold: ['anthropic'], not: ['stripe'] },
  { cat: 'single-session', q: "What's my sister's name?", gold: ['priya'] },
  { cat: 'single-session', q: 'What is my pet called?', gold: ['biscuit'] },
  { cat: 'single-session', q: 'What food can I not eat?', gold: ['peanut'] },
  { cat: 'single-session', q: 'Which database do we run?', gold: ['postgres'] },
  { cat: 'preference', q: 'Which language should new code be written in?', gold: ['typescript'] },
  { cat: 'preference', q: 'What package manager should you use for my repos?', gold: ['pnpm'] },
  { cat: 'preference', q: 'Where do I host my apps?', gold: ['fly'] },
  { cat: 'preference', q: 'What code editor do I use?', gold: ['neovim'] },
  { cat: 'preference', q: 'Should I get a light or dark theme?', gold: ['dark'] },
  { cat: 'preference', q: 'How should my JS be formatted regarding semicolons?', gold: ['semicolon'] },
  { cat: 'preference', q: 'How long should meeting notes be?', gold: ['short'] },
  { cat: 'knowledge-update', q: 'What city do I live in?', gold: ['seattle'], not: ['vancouver'] },
  { cat: 'knowledge-update', q: 'Where do I work?', gold: ['anthropic'], not: ['stripe'] },
  { cat: 'temporal', q: 'When does Maya start school?', gold: ['maya'] },
  { cat: 'temporal', q: 'What time is my daily standup?', gold: ['9:30'] },
  { cat: 'multi-session', q: 'Where does my sibling live?', gold: ['toronto'] },
  { cat: 'multi-session', q: 'What do I know about my kids?', gold: ['maya'] },
  { cat: 'abstention', q: 'What is my wife called?', gold: [] },
  { cat: 'abstention', q: 'Which gym do I go to?', gold: [] },
];

// Held out: written after the fixes above, never tuned against. Its score is the honest one.
const HOLDOUT_SESSIONS = [
  { day: 0, said: [
    'I teach chemistry at a high school in Calgary.',
    'my husband is Daniel and he is a nurse.',
    'I prefer short answers with bullet points.',
    'we deploy everything on Railway.',
  ] },
  { day: 5, said: [
    'I am vegetarian, no meat in any meal plan please.',
    'my son Leo plays hockey on Saturdays.',
    'I use VS Code with the Vim extension.',
    'I never use tabs, always two spaces.',
  ] },
  { day: 14, said: [
    'I moved to Edmonton last month.',
    'my cat is called Pepper',
    'we switched to MySQL from Postgres',
  ] },
];
const HOLDOUT_QUESTIONS = [
  { cat: 'single-session', q: 'What subject do I teach?', gold: ['chemistry'] },
  { cat: 'single-session', q: "What's my partner's job?", gold: ['nurse'] },
  { cat: 'single-session', q: 'What is my cat named?', gold: ['pepper'] },
  { cat: 'preference', q: 'How should you format your replies to me?', gold: ['bullet'] },
  { cat: 'preference', q: 'Where are our services hosted?', gold: ['railway'] },
  { cat: 'preference', q: 'Which IDE do I code in?', gold: ['vs code'] },
  { cat: 'preference', q: 'Tabs or spaces for indentation?', gold: ['space'] },
  { cat: 'preference', q: 'Can you put chicken in my dinner recipe?', gold: ['vegetarian'] },
  { cat: 'knowledge-update', q: 'Which city am I based in?', gold: ['edmonton'], not: ['calgary'] },
  { cat: 'knowledge-update', q: 'What database do we use now?', gold: ['mysql'] },
  { cat: 'multi-session', q: 'What sport do my children play?', gold: ['hockey'] },
  { cat: 'temporal', q: 'What does Leo do on weekends?', gold: ['hockey'] },
  { cat: 'abstention', q: 'What is my brother called?', gold: [] },
  { cat: 'abstention', q: 'Which bank do I use?', gold: [] },
];

// Fresh test set: written after every change above, run once, reported as is.
const TEST_SESSIONS = [
  { day: 0, said: [
    "so I'm a product designer at Shopify, mostly checkout flows.",
    'our team ships every Thursday afternoon.',
    'my partner Sam and I have a golden retriever named Toast.',
    "I'm lactose intolerant btw.",
    'Please refactor the header component.',
  ] },
  { day: 6, said: [
    'for diagrams I always use Excalidraw.',
    'I run on a 2023 MacBook Pro with 16 GB of RAM.',
    'I live in Montreal but I grew up in Halifax.',
    'my mom turns 60 on December 12.',
  ] },
  { day: 18, said: [
    "heads up, I left Shopify, I'm at Figma now.",
    'we stopped shipping on Thursdays, releases are on Tuesdays now.',
    'I want you to always write commit messages in present tense.',
  ] },
];
const TEST_QUESTIONS = [
  { cat: 'single-session', q: 'What do I do for a living?', gold: ['designer'] },
  { cat: 'single-session', q: "What's the name of our dog?", gold: ['toast'] },
  { cat: 'single-session', q: 'What computer am I using?', gold: ['macbook'] },
  { cat: 'preference', q: 'Can I have milk in my coffee?', gold: ['lactose'] },
  { cat: 'preference', q: 'What tool should I draw the architecture diagram in?', gold: ['excalidraw'] },
  { cat: 'preference', q: 'How do I like commit messages worded?', gold: ['present tense'] },
  { cat: 'knowledge-update', q: 'Which company do I work for these days?', gold: ['figma'], not: ['shopify'] },
  { cat: 'knowledge-update', q: 'What day do we release?', gold: ['tuesday'], not: ['thursday'] },
  { cat: 'temporal', q: "When is my mother's birthday?", gold: ['60'] },
  { cat: 'multi-session', q: 'Who do I live with?', gold: ['sam'] },
  { cat: 'multi-session', q: 'Where is my hometown?', gold: ['halifax'] },
  { cat: 'abstention', q: 'What is my cat called?', gold: [] },
  { cat: 'abstention', q: 'Which university did I go to?', gold: [] },
];

const has = (text, words) => words.every((w) => text.toLowerCase().includes(w));
export async function runBench({ k = 5, sessions = SESSIONS, questions = QUESTIONS, ask = null, semantic = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-membench-'));
  process.env.OX_MEMORY_HOME = path.join(home, '.ox', 'memory');
  const userFile = M.memoryFile('user', { home });
  // Stage 1: learn.
  let kept = 0, offered = 0;
  for (const s of sessions) {
    const ref = T0 + s.day * DAY;
    const r = M.learnFromMessages(s.said.map((content) => ({ role: 'user', content })), { home, ref });
    offered += s.said.length;
    kept += Array.isArray(r) ? r.filter((x) => x && x.op && x.op !== 'refused').length : Number(r?.learned ?? 0);
  }
  // Stage 1b (--extract <bot>): the background pass reads what the rules missed.
  let extracted = null;
  if (ask) {
    const X = await import('../../src/memory-extract.js');
    extracted = await X.extractInbox({ ask, home });
  }
  const stored = M.load(userFile).filter((m) => m.state === 'active' && m.latest !== false);
  // Stage 2: recall.
  const now = T0 + 31 * DAY;
  const S = semantic ? await import('../../src/memory-semantic.js') : null;
  const rows = [];
  for (const x of questions) rows.push(await (async () => {
    const hits = semantic ? await S.recallSemantic(x.q, { file: userFile, now, k }) : M.recall(x.q, { file: userFile, now, k });
    let ok;
    if (!x.gold.length) ok = hits.length === 0;
    // Right when a hit has the gold answer and no hit that has only the OLD value ranks above it
    // ("I left Shopify and joined Figma" names the old value and is still the right answer).
    else {
      const first = hits.findIndex((h) => has(h.text, x.gold));
      ok = first >= 0 && !(x.not && hits.slice(0, first).some((h) => has(h.text, x.not)));
    }
    const learnedIt = !x.gold.length || stored.some((m) => has(m.text, x.gold));
    return { ...x, ok, learnedIt, top: hits[0]?.text ?? null };
  })());
  const block = M.memoryPromptBlock({ home, cwd: home, task: 'Where do I work and what should I use?', now });
  const byCat = {};
  for (const r of rows) { const c = (byCat[r.cat] ??= { n: 0, ok: 0, learned: 0 }); c.n++; c.ok += r.ok ? 1 : 0; c.learned += r.learnedIt ? 1 : 0; }
  fs.rmSync(home, { recursive: true, force: true });
  return { offered, stored: stored.length, extracted, rows, byCat, total: rows.filter((r) => r.ok).length, n: rows.length, blockTokens: Math.ceil(block.length / 4), learnedCount: rows.filter((r) => r.learnedIt).length };
}

const print = (title, r) => {
  {
    console.log(`\n${title}`);
    console.log(`learning: ${r.stored} memories kept from ${r.offered} messages${r.extracted ? ` (${r.extracted.learned.length} of them by the background pass, from ${r.extracted.read} queued statements)` : ''}; the fact behind ${r.learnedCount}/${r.n} questions was learned`);
    for (const [c, v] of Object.entries(r.byCat)) console.log(`  ${c.padEnd(16)} recall ${v.ok}/${v.n}   learned ${v.learned}/${v.n}`);
    console.log(`overall ${r.total}/${r.n} (${Math.round((100 * r.total) / r.n)}%) · memory block ${r.blockTokens} tokens`);
    for (const x of r.rows.filter((y) => !y.ok)) console.log(`  ✗ [${x.cat}] ${x.q} → ${x.top ?? '(nothing)'}${x.learnedIt ? '' : '   (never learned)'}`);
  }
};

// --extract <bot>: run the background extraction with that model (keys from ~/.ox/keys.json).
async function askerFor(spec) {
  if (!spec) return null;
  (await import('../../src/keystore.js')).loadKeysIntoEnv();
  const { resolveBot } = await import('../../src/bots.js');
  const { loadConfig } = await import('../../src/config.js');
  const { quickText } = await import('../../src/quick-text.js');
  const target = resolveBot(spec, loadConfig());
  return async ({ system, user }) => (await quickText(target, { system, user, maxTokens: 900 })).text;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const i = process.argv.indexOf('--extract');
  const ask = await askerFor(i >= 0 ? process.argv[i + 1] : null);
  const semantic = process.argv.includes('--semantic');
  const dev = await runBench({ ask, semantic });
  const held = await runBench({ sessions: HOLDOUT_SESSIONS, questions: HOLDOUT_QUESTIONS, ask, semantic });
  const fresh = await runBench({ sessions: TEST_SESSIONS, questions: TEST_QUESTIONS, ask, semantic });
  if (process.argv.includes('--json')) console.log(JSON.stringify({ dev, held, fresh }, null, 2));
  else { print('dev set (tuned on)', dev); print('held-out set (tuned on once)', held); print('fresh test set (never tuned on)', fresh); }
}
