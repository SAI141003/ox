// How often does an interactive answer actually draw? Sends interactive
// requests through a running ox app (the same request the app's "Interactive
// answer" makes), takes the ```openui block out the way the page does, and
// loads it with ox's own OpenUI engine (src/ui-lang.js, the one the page
// runs). A pass: a block came back, it has a root, and no line was dropped.
//
//   node bench/openui/run.mjs --url http://127.0.0.1:47800 --model ox-ollama:qwen2.5:3b [--repeats 2] [--json out.json]
import { checkUi, uiBlocks, digest } from '../../src/ui-lang.js';
import fs from 'node:fs';

const arg = (n, d = null) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const URL_BASE = arg('--url', 'http://127.0.0.1:47800').replace(/\/+$/, '');
const MODEL = arg('--model', 'auto');
const REPEATS = Number(arg('--repeats', 1));
const OUT = arg('--json');

export const PROMPTS = [
  'Make an interactive loan payment calculator with sliders for amount, rate and years',
  'Show a bar chart comparing the populations of the five largest countries',
  'Build a tip calculator: bill amount, tip percent slider and number of people',
  'Make a BMI calculator with height and weight inputs',
  'Compare iPhone, Pixel and Galaxy in a table: price, battery, camera',
  'A unit converter between kilometres and miles with a slider',
  'Show a pie chart of a monthly budget: rent 40%, food 20%, transport 10%, savings 30%',
  'Make a simple to-do list where I can tick items done',
  'A compound interest calculator with a line chart of the balance over 10 years',
  'Make a quiz with three multiple-choice questions about planets',
];

export const openuiBlocks = uiBlocks;

export function judge(text) {
  const c = checkUi(text);
  if (c.ok) return { pass: true, nodes: (digest(c.tree).match(/,/g) ?? []).length + 1 };
  return { pass: false, why: c.why, errors: c.errors.length, ...(c.root ? { partial: true } : {}) };
}

async function ask(prompt) {
  const started = Date.now();
  const r = await fetch(`${URL_BASE}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, stream: false, ox_ui: 'live', ox_canvas: true, messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(240_000),
  });
  const j = await r.json().catch(() => ({}));
  return { text: j.choices?.[0]?.message?.content ?? '', ms: Date.now() - started, model: j.model, error: j.error?.message ?? j.ox_error };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rows = [];
  for (let k = 0; k < REPEATS; k++) {
    for (const p of PROMPTS) {
      let r;
      try { r = await ask(p); } catch (e) { r = { text: '', ms: 0, error: String(e?.message ?? e) }; }
      const j = r.error ? { pass: false, why: `request failed: ${r.error}` } : judge(r.text);
      rows.push({ prompt: p, repeat: k, ms: r.ms, ...j, text: r.text.slice(0, 4000) });
      console.log(`${j.pass ? 'PASS' : 'FAIL'} ${String(Math.round(r.ms / 1000)).padStart(4)}s  ${p.slice(0, 60).padEnd(61)} ${j.pass ? '' : j.why}`);
    }
  }
  const pass = rows.filter((r) => r.pass).length;
  console.log(`\n${MODEL}: ${pass}/${rows.length} drew with no line dropped (${Math.round((pass / rows.length) * 100)}%)`);
  if (OUT) fs.writeFileSync(OUT, JSON.stringify({ model: MODEL, pass, total: rows.length, rows }, null, 2));
}
