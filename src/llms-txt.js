// `@llms:<domain>` - pull a library's agent docs (its /llms.txt) into a prompt.
//
//   ox "add a liquid-glass carousel using @llms:componentry.dev"
//
// More and more libraries publish /llms.txt: docs written for agents. Pasting a
// whole one costs 10-15k tokens, so ox fetches it once (cached a day under
// ~/.ox/cache/llms), keeps the title and summary, and adds only the sections
// that share words with your request, inside a fixed budget.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const LLMS_REF_RE = /@llms:([a-z0-9][a-z0-9.-]*\.[a-z]{2,})(?![\w.-])/gi;
const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_BYTES = 512 * 1024;
export const LLMS_BUDGET = 6_000; // chars inserted per reference (~1.5k tokens)

const STOP = new Set(('a an and are as at be but by can do for from has have how i if in into is it its make me my of on or our so ' +
  'that the their them then there these this to use using want we what when where which with you your add build create').split(' '));

export const cacheDir = (home = os.homedir()) => path.join(home, '.ox', 'cache', 'llms');

/** Fetch (or read the cached) llms.txt of a domain. Throws a message a user can act on. */
export async function fetchLlms(domain, { home = os.homedir(), fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  const d = String(domain).toLowerCase();
  const file = path.join(cacheDir(home), `${d}.txt`);
  try {
    const st = fs.statSync(file);
    if (now - st.mtimeMs < TTL_MS) return fs.readFileSync(file, 'utf8');
  } catch {}
  const res = await fetchImpl(`https://${d}/llms.txt`, { signal: AbortSignal.timeout(10_000), redirect: 'follow' });
  if (!res.ok) throw new Error(`${d} has no llms.txt (HTTP ${res.status})`);
  const type = String(res.headers.get('content-type') ?? '');
  if (/html/i.test(type)) throw new Error(`${d}/llms.txt is a web page, not agent docs`);
  const text = (await res.text()).slice(0, MAX_BYTES);
  fs.mkdirSync(cacheDir(home), { recursive: true });
  fs.writeFileSync(file, text);
  return text;
}

function words(s) {
  return String(s).toLowerCase().match(/[a-z][a-z0-9-]{2,}/g)?.filter((w) => !STOP.has(w)) ?? [];
}

/** Split markdown into the head (before the first ## heading) and sections. */
export function sections(text) {
  const parts = String(text).split(/\n(?=#{2,3} )/);
  return { head: parts[0], rest: parts.slice(1) };
}

/** The head plus the sections most relevant to `query`, within `budget` chars. */
export function selectRelevant(text, query, budget = LLMS_BUDGET) {
  const { head, rest } = sections(text);
  const q = new Set(words(query));
  const scored = rest.map((body, i) => {
    const title = body.split('\n', 1)[0];
    let score = 0;
    for (const w of words(title)) if (q.has(w)) score += 3;
    for (const w of new Set(words(body))) if (q.has(w)) score += 1;
    return { i, body, score };
  });
  const top = head.slice(0, Math.floor(budget / 3)).trimEnd();
  // Relevant sections first; with no overlap at all, the opening sections
  // (usually the overview and install) are the best guess.
  const anyHit = scored.some((s) => s.score > 0);
  const order = anyHit ? [...scored].filter((s) => s.score > 0).sort((a, b) => b.score - a.score || a.i - b.i) : scored;
  const picked = [];
  let used = top.length;
  for (const s of order) {
    if (used + s.body.length + 2 > budget) continue;
    picked.push(s);
    used += s.body.length + 2;
  }
  picked.sort((a, b) => a.i - b.i);
  const body = [top, ...picked.map((p) => p.body.trimEnd())].join('\n\n');
  return { body, kept: picked.length, total: rest.length };
}

/** Expand every @llms:<domain> in `text`; failures leave the token and note why. */
export async function expandLlmsRefs(text, { note = (s) => process.stderr.write(`${s}\n`), ...opts } = {}) {
  const src = String(text ?? '');
  const domains = [...new Set([...src.matchAll(LLMS_REF_RE)].map((m) => m[1].toLowerCase()))].slice(0, 3);
  if (!domains.length) return src;
  const query = src.replace(LLMS_REF_RE, ' ');
  const blocks = new Map();
  await Promise.all(domains.map(async (d) => {
    try {
      const doc = await fetchLlms(d, opts);
      const { body, kept, total } = selectRelevant(doc, query);
      blocks.set(d, `\n[begin @llms:${d} (agent docs; ${kept} of ${total} sections, picked for this request)]\n${body}\n[end]`);
    } catch (err) {
      note(`ox: @llms:${d} left as text: ${err?.message ?? err}`);
    }
  }));
  const done = new Set();
  return src.replace(LLMS_REF_RE, (tok, d) => {
    const key = d.toLowerCase();
    if (!blocks.has(key) || done.has(key)) return tok;
    done.add(key);
    return tok + blocks.get(key);
  });
}
