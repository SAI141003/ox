// Changes to the company brain (src/brain.js) that coworkers propose and you
// decide (Rerun's idea, ox's own build). A coworker never writes the brain
// itself: it proposes a note, you accept it (it is saved, replacing the note of
// the same title) or dismiss it. A coworker refining its own pending
// proposal replaces it instead of stacking a second one to compare; a proposal
// you dismissed is not offered to you again; deciding twice does nothing.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { brainDir } from './brain.js';

const FILE = () => path.join(brainDir(), '.proposals.json');
const read = () => { try { return JSON.parse(fs.readFileSync(FILE(), 'utf8')); } catch { return { proposals: [] }; } };
const write = (doc) => { fs.mkdirSync(path.dirname(FILE()), { recursive: true }); fs.writeFileSync(FILE(), JSON.stringify(doc, null, 2), { mode: 0o600 }); };
const hashOf = (title, body) => crypto.createHash('sha256').update(`${String(title).trim().toLowerCase()}\n${String(body).trim()}`).digest('hex').slice(0, 16);

export function propose({ title, body, by = 'you', why = '' }) {
  const t = String(title ?? '').trim(), b = String(body ?? '').trim();
  if (!t || !b) throw new Error('a proposal needs a title and a body');
  const doc = read();
  const hash = hashOf(t, b);
  if (doc.proposals.some((p) => p.hash === hash && p.state === 'dismissed')) return { state: 'dismissed-before', title: t };
  const same = doc.proposals.find((p) => p.state === 'pending' && p.by === by && p.title.toLowerCase() === t.toLowerCase());
  if (same) { Object.assign(same, { body: b.slice(0, 20_000), why: String(why).slice(0, 500), hash, at: new Date().toISOString() }); write(doc); return same; }
  const p = { id: crypto.randomBytes(5).toString('hex'), title: t.slice(0, 160), body: b.slice(0, 20_000), why: String(why).slice(0, 500), by: String(by).slice(0, 60), hash, state: 'pending', at: new Date().toISOString() };
  doc.proposals.push(p);
  write(doc);
  return p;
}

export const listProposals = ({ state = 'pending' } = {}) => read().proposals.filter((p) => !state || p.state === state);

/** Accept or dismiss once: a second decision on the same proposal does nothing. */
export async function decide(id, decision) {
  const doc = read();
  const p = doc.proposals.find((x) => x.id === String(id));
  if (!p) throw new Error(`no proposal ${id}`);
  if (p.state !== 'pending') return { ...p, already: true };
  if (decision === 'accept') {
    // A note of the same title is replaced in place (brain.remember writes the same file).
    const B = await import('./brain.js');
    B.remember({ title: p.title, body: p.body, source: `proposed by ${p.by}` });
    p.state = 'accepted';
  } else p.state = 'dismissed';
  p.decidedAt = new Date().toISOString();
  write(doc);
  return p;
}
