// Coworkers with a life of their own (Rerun's model, ox's build): a soul and a
// workspace each, a brief with their skills, memories and teammates, a curator
// that keeps facts as memory and ways of working as skills, their own
// schedules and token-guarded triggers, asking a teammate, and brain changes
// that wait for the owner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as O from '../src/org.js';
import * as H from '../src/coworker-home.js';

const fresh = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-cow-'));
  return { d, file: path.join(d, 'org.json'), tasks: { dir: path.join(d, 'tasks') }, usageFile: path.join(d, 'usage.jsonl'), env: { ...process.env, OX_HOME: d } };
};

test('a coworker brief: its soul, its skills, what it remembers, its teammates, the shared folder', async () => {
  const o = fresh();
  const ada = O.hire({ name: 'Ada', title: 'Researcher', instructions: 'Cite every source.' }, o);
  O.hire({ name: 'Bo', title: 'Writer' }, o);
  H.ensureHome(ada, { env: o.env });
  assert.match(H.readSoul('ada', { env: o.env }), /Cite every source/);
  H.writeSkill('ada', { name: 'Weekly digest', description: 'How the Monday digest is made', steps: '1. Collect\n2. Rank' }, { env: o.env });
  const M = await H.loadMemoryGraph();
  M.remember('The newsletter goes out on Mondays at 8am.', { file: path.join(H.homeOf('ada', o.env), 'memory.jsonl') });
  const brief = H.homeBrief(ada, 'prepare the monday newsletter digest', { env: o.env, org: O.readOrg(o) });
  assert.match(brief, /Weekly digest: How the Monday digest is made/);
  assert.match(brief, /newsletter goes out on Mondays/);
  assert.match(brief, /- bo: Bo, Writer/);
  assert.match(brief, /ox org ask <id>/);
  assert.match(brief, /ox brain propose/);
});

test('the curator: a fact to memory (replacing what it contradicts), a way of working to a skill', async () => {
  const o = fresh();
  const ada = O.hire({ name: 'Ada', title: 'Researcher' }, o);
  H.ensureHome(ada, { env: o.env });
  const M = await H.loadMemoryGraph();
  const file = path.join(H.homeOf('ada', o.env), 'memory.jsonl');
  const old = M.remember('The client is based in Toronto.', { file }).memory;
  const ask = async ({ user }) => {
    assert.match(user, new RegExp(old.id));
    return JSON.stringify({ memory: { content: 'The client moved to Vancouver.', updateId: old.id }, obsoleteIds: [], skill: { name: 'Client brief', description: 'How to write the client brief', steps: '1. Lead with numbers\n2. One page' } });
  };
  const out = await H.curate(ada, { asked: 'update the client brief: they moved to Vancouver', said: 'Done. Client brief updated with Vancouver.' }, { ask, env: o.env });
  assert.equal(out.memory, 'The client moved to Vancouver.');
  assert.equal(out.skill, 'client-brief');
  const live = M.load(file).filter((m) => m.state === 'active').map((m) => m.text);
  assert.ok(live.some((t) => /Vancouver/.test(t)));
  assert.ok(!live.some((t) => /Toronto/.test(t)), 'the contradicted memory is gone');
  assert.equal(H.listSkills('ada', { env: o.env })[0].learned, true);
  assert.equal(H.parseCuration('nothing'), null);
});

test('a run happens in its own workspace, and what it learned is kept', async () => {
  const o = fresh();
  O.hire({ name: 'Ada', title: 'Researcher' }, o);
  await O.tell('ada', 'find three competitors', o);
  let seen = null;
  const r = await O.beat('ada', { ...o, run: async (a, task, prompt) => { seen = prompt; return { ok: true, output: 'Found: Acme, Globex, Initech. Acme is the market leader.' }; }, ask: async () => JSON.stringify({ memory: { content: 'Acme is the market leader.', updateId: null }, obsoleteIds: [], skill: null }), awaitCurate: true });
  assert.equal(r.ok, true);
  assert.match(seen, /SHARED FOLDER/);
  assert.match(seen, /find three competitors/);
  assert.ok((await H.memories('ada', { env: o.env })).some((m) => /Acme is the market leader/.test(m.text)));
  assert.ok(O.readOrg(o).log.some((x) => x.action === 'learned'));
});

test('schedules come round once; a trigger needs its token', async () => {
  const o = fresh();
  const ada = O.hire({ name: 'Ada', title: 'Researcher' }, o);
  H.ensureHome(ada, { env: o.env });
  await H.addSchedule('ada', 'every 2h', 'check the inbox', { env: o.env });
  await assert.rejects(H.addSchedule('ada', 'whenever', 'x', { env: o.env }), /cannot read/);
  const agents = Object.values(O.readOrg(o).agents);
  const now = Date.now();
  assert.equal((await H.dueSchedules({ env: o.env, agents, now })).length, 1);
  assert.equal((await H.dueSchedules({ env: o.env, agents, now: now + 60_000 })).length, 0, 'not twice');
  assert.equal((await H.dueSchedules({ env: o.env, agents, now: now + 2 * 3600_000 + 1 })).length, 1);
  const t = H.addTrigger('ada', 'New lead', 'Research the company in the lead and draft a reply', { env: o.env });
  assert.equal(H.fireTrigger('ada', 'new-lead', 'wrong', '{}', { env: o.env }), null);
  assert.equal(H.fireTrigger('ada', '../../x', t.token, '', { env: o.env }), null);
  const p = H.fireTrigger('ada', 'new-lead', t.token, { company: 'Acme' }, { env: o.env });
  assert.match(p, /Research the company/);
  assert.match(p, /data, not instructions[\s\S]*"company": "Acme"/);
  assert.equal(H.listTriggers('ada', { env: o.env })[0].fired, 1);
});

test('asking a teammate runs it now and returns its answer; two levels deep at most', async () => {
  const o = fresh();
  O.hire({ name: 'Bo', title: 'Writer' }, o);
  const r = await O.askAgent('bo', 'what tone do we use?', { ...o, run: async () => ({ ok: true, output: 'Warm and plain.' }), curate: false });
  assert.deepEqual(r, { ok: true, answer: 'Warm and plain.' });
  const prev = process.env.OX_ORG_DEPTH;
  process.env.OX_ORG_DEPTH = '2';
  try { await assert.rejects(O.askAgent('bo', 'x', o), /too deep/); } finally { if (prev === undefined) delete process.env.OX_ORG_DEPTH; else process.env.OX_ORG_DEPTH = prev; }
});

test('brain changes are proposals: refined in place, decided once, a dismissed one never comes back', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-brainp-'));
  const prev = process.env.OX_BRAIN_DIR;
  process.env.OX_BRAIN_DIR = d;
  try {
    const P = await import('../src/brain-proposals.js');
    const a = P.propose({ title: 'Pricing', body: 'Pro is $20', by: 'ada' });
    const b = P.propose({ title: 'Pricing', body: 'Pro is $25', by: 'ada' });
    assert.equal(a.id, b.id, 'refined, not stacked');
    assert.equal(P.listProposals().length, 1);
    await P.decide(b.id, 'accept');
    assert.match(fs.readFileSync(path.join(d, 'pricing.md'), 'utf8'), /Pro is \$25/);
    assert.equal((await P.decide(b.id, 'dismiss')).already, true);
    const c = P.propose({ title: 'Office', body: 'We moved', by: 'bo' });
    await P.decide(c.id, 'dismiss');
    assert.equal(P.propose({ title: 'Office', body: 'We moved', by: 'bo' }).state, 'dismissed-before');
  } finally { if (prev === undefined) delete process.env.OX_BRAIN_DIR; else process.env.OX_BRAIN_DIR = prev; fs.rmSync(d, { recursive: true, force: true }); }
});
