import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OX_BIN = path.join(ROOT, 'bin', 'ox.js');

// ---------------------------------------------------------------------------
// F1 — skill lifecycle curator: sidecars, transitions, snapshots, ledger, CLI
// ---------------------------------------------------------------------------

const {
  _now,
  curateSkills,
  recordSkillUse,
  recordSkillView,
  readUsageSidecar,
  adoptSkill,
  restoreSkill,
  purgeSkill,
  readSkillBody,
  listSnapshots,
  readSkillLedger,
  snapshotSkillDir,
  CURATOR_DEFAULTS,
} = await import('../src/skills.js');

const DAY_MS = 86_400_000;
const FIXED_NOW = Date.UTC(2026, 7, 24, 12, 0, 0);

function mkroot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-v4a-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* a throwing hook skips later cleanup: see e2e.test.js */ } });
  return dir;
}

function makeSkill(root, relName, { body = 'body text' } = {}) {
  const dir = path.join(root, '.agents', 'skills', relName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${relName}\ndescription: ${relName} desc\n---\n\n${body}\n`);
  return dir;
}

function setSidecar(dir, { useCount = 0, viewCount = 0, lastUsedMs = null } = {}) {
  const data = {
    use_count: useCount,
    view_count: viewCount,
    last_used: lastUsedMs == null ? null : new Date(lastUsedMs).toISOString(),
  };
  fs.writeFileSync(path.join(dir, '.usage.json'), `${JSON.stringify(data, null, 2)}\n`);
  return data;
}

test('curator defaults are the spec knobs', () => {
  assert.deepEqual(CURATOR_DEFAULTS, { stale_after_days: 30, archive_after_days: 90 });
});

test('recordSkillUse / recordSkillView maintain the .usage.json sidecar', (t) => {
  const root = mkroot(t);
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  const dir = makeSkill(home, 'tracker');
  try {
    _now.value = FIXED_NOW;
    assert.equal(readUsageSidecar(dir), null);
    const afterOne = recordSkillUse('tracker', dir);
    assert.equal(afterOne.use_count, 1);
    assert.equal(afterOne.view_count, 0);
    recordSkillUse('tracker', dir);
    const viewed = recordSkillView('tracker', dir);
    assert.equal(viewed.use_count, 2);
    assert.equal(viewed.view_count, 1);
    const stored = readUsageSidecar(dir);
    assert.deepEqual(stored, { use_count: 2, view_count: 1, last_used: new Date(FIXED_NOW).toISOString() });
  } finally {
    _now.value = null;
  }
});

test('readSkillBody bumps use_count on consumption', (t) => {
  const root = mkroot(t);
  const dir = makeSkill(root, 'reader');
  const before = readUsageSidecar(dir);
  assert.equal(before, null);
  const body = readSkillBody({ name: 'reader', dir, path: path.join(dir, 'SKILL.md') });
  assert.match(body, /body text/);
  const sidecar = readUsageSidecar(dir);
  assert.equal(sidecar.use_count, 1);
});

test('active→stale transition uses frozen clock + grace floor; dry-run mutates nothing', (t) => {
  const root = mkroot(t);
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  const idleDir = makeSkill(home, 'sleepy');
  setSidecar(idleDir, { useCount: 1, lastUsedMs: FIXED_NOW - 40 * DAY_MS });
  const busyDir = makeSkill(home, 'workhorse');
  setSidecar(busyDir, { useCount: 7, lastUsedMs: FIXED_NOW - 40 * DAY_MS });

  try {
    _now.value = FIXED_NOW;
    const rep = curateSkills({ home, cwd: root }, { apply: false });
    const sleepy = rep.rows.find((r) => r.name === 'sleepy');
    const workhorse = rep.rows.find((r) => r.name === 'workhorse');
    assert.equal(sleepy.state, 'stale', 'idle 40d with use_count<3 goes stale');
    assert.equal(sleepy.action, null, 'stale alone is not an archive candidate');
    assert.equal(workhorse.state, 'active', 'grace floor keeps a heavily-used skill active');
    // dry-run mutated nothing
    assert.ok(fs.existsSync(idleDir), 'skill dir untouched in dry-run');
    assert.equal(readUsageSidecar(idleDir).use_count, 1);
    assert.equal(fs.existsSync(path.join(home, '.agents', '.snapshots')), false, 'no snapshots in dry-run');
    assert.equal(fs.existsSync(path.join(home, '.agents', 'skill-ledger.jsonl')), false, 'no ledger in dry-run');
  } finally {
    _now.value = null;
  }
});

test('stale→archived move writes snapshot + ledger line (apply pass)', (t) => {
  const root = mkroot(t);
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  const dir = makeSkill(home, 'fossil', { body: 'ancient knowledge' });
  setSidecar(dir, { useCount: 0, lastUsedMs: FIXED_NOW - 100 * DAY_MS });

  try {
    _now.value = FIXED_NOW;
    const rep = curateSkills({ home, cwd: root }, { apply: true });
    const row = rep.rows.find((r) => r.name === 'fossil');
    assert.equal(row.action, 'archived');

    const archivedPath = path.join(home, '.agents', 'skills', '.archive', 'fossil');
    assert.ok(fs.existsSync(path.join(archivedPath, 'SKILL.md')), 'dir moved into sibling .archive/');
    assert.equal(fs.existsSync(dir), false, 'original dir gone');

    const snaps = listSnapshots(home, 'fossil');
    assert.equal(snaps.length, 1);
    assert.equal(
      fs.readFileSync(path.join(snaps[0], 'SKILL.md'), 'utf8'),
      fs.readFileSync(path.join(archivedPath, 'SKILL.md'), 'utf8')
    );
    const meta = JSON.parse(fs.readFileSync(path.join(snaps[0], '.snapshot-meta.json'), 'utf8'));
    assert.equal(meta.name, 'fossil');
    assert.equal(meta.origin, dir);

    const ledger = readSkillLedger(home);
    assert.equal(ledger.length, 1);
    const rec = ledger[0];
    assert.equal(rec.actor, 'curator');
    assert.equal(rec.action, 'archive');
    assert.equal(rec.name, 'fossil');
    assert.ok(rec.before_sha256 && rec.before_sha256 === rec.after_sha256, 'sha256 recorded for content');
    assert.equal(rec.details.from, dir);
    assert.equal(rec.details.to, archivedPath);
  } finally {
    _now.value = null;
  }
});

test('pin immunity and crontab (# ox-schedule) immunity', (t) => {
  const root = mkroot(t);
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  const pinnedDir = makeSkill(home, 'pinned-one');
  setSidecar(pinnedDir, { useCount: 0, lastUsedMs: FIXED_NOW - 200 * DAY_MS });
  const cronDir = makeSkill(home, 'cronned');
  setSidecar(cronDir, { useCount: 0, lastUsedMs: FIXED_NOW - 200 * DAY_MS });
  const freeDir = makeSkill(home, 'free-fall');
  setSidecar(freeDir, { useCount: 0, lastUsedMs: FIXED_NOW - 200 * DAY_MS });

  const crontab = [
    '# --- begin ox schedule ---',
    '# ox-schedule deadbeef',
    '17 9 * * * cd /ws && ox auto "keep using cronned nightly" >> log 2>&1',
    '# --- end ox schedule ---',
  ].join('\n');

  try {
    _now.value = FIXED_NOW;
    const rep = curateSkills({ home, cwd: root }, { apply: true, crontab, config: { skillPins: ['pinned-one'] } });
    const byName = Object.fromEntries(rep.rows.map((r) => [r.name, r]));
    assert.equal(byName['pinned-one'].action, null, 'pinned skills are immune');
    assert.ok(fs.existsSync(pinnedDir), 'pinned skill stays put');
    assert.equal(byName.cronned.action, null, 'crontab-referenced skills are immune');
    assert.ok(fs.existsSync(cronDir), 'cronned skill stays put');
    assert.equal(byName['free-fall'].action, 'archived', 'unprotected skill still archives');
  } finally {
    _now.value = null;
  }
});

test('unmanaged skills (no sidecar) only archivable past archive_after_days by mtime', (t) => {
  const root = mkroot(t);
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  const oldDir = makeSkill(home, 'dusty');
  const freshDir = makeSkill(home, 'newish');
  const oldPast = (FIXED_NOW - 120 * DAY_MS) / 1000;
  fs.utimesSync(path.join(oldDir, 'SKILL.md'), oldPast, oldPast);

  try {
    _now.value = FIXED_NOW;
    const rep = curateSkills({ home, cwd: root }, { apply: false });
    const byName = Object.fromEntries(rep.rows.map((r) => [r.name, r]));
    assert.equal(byName.dusty.state, 'unmanaged');
    assert.equal(byName.dusty.action, 'would-archive', 'old unmanaged is an archive candidate');
    assert.match(byName.dusty.reason, /mtime/);
    assert.equal(byName.newish.action, null, 'recent unmanaged left alone');
  } finally {
    _now.value = null;
  }
});

test('config knobs override the defaults (curator:{stale_after_days,archive_after_days})', (t) => {
  const root = mkroot(t);
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  const dir = makeSkill(home, 'quick-stale');
  setSidecar(dir, { useCount: 9, lastUsedMs: FIXED_NOW - 3 * DAY_MS });

  try {
    _now.value = FIXED_NOW;
    const lenient = curateSkills({ home, cwd: root }, { apply: false });
    assert.equal(lenient.rows.find((r) => r.name === 'quick-stale').state, 'active');
    const strict = curateSkills(
      { home, cwd: root },
      { apply: false, config: { curator: { stale_after_days: 1, archive_after_days: 2 } } }
    );
    const row = strict.rows.find((r) => r.name === 'quick-stale');
    assert.equal(row.action, 'would-archive', '3-day idle crosses the tightened archive window');
  } finally {
    _now.value = null;
  }
});

test('restore round-trips the latest snapshot back to the active path', (t) => {
  const root = mkroot(t);
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  const dir = makeSkill(home, 'phoenix', { body: 'rise again' });
  setSidecar(dir, { useCount: 0, lastUsedMs: FIXED_NOW - 99 * DAY_MS });

  try {
    _now.value = FIXED_NOW;
    curateSkills({ home, cwd: root }, { apply: true });
    assert.equal(fs.existsSync(dir), false);

    const res = restoreSkill({ home, cwd: root }, 'phoenix');
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.dest, dir);
    assert.match(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), /rise again/);
    assert.equal(
      fs.existsSync(path.join(home, '.agents', 'skills', '.archive', 'phoenix')),
      false,
      'archived copy removed on restore'
    );

    const ledger = readSkillLedger(home);
    const restoreRec = ledger.find((r) => r.action === 'restore');
    assert.ok(restoreRec, 'ledger has restore line');
    assert.equal(restoreRec.actor, 'user');
    assert.equal(restoreRec.name, 'phoenix');
    assert.equal(restoreRec.details.restored_to, dir);
  } finally {
    _now.value = null;
  }
});

test('adopt writes a fresh sidecar once; second adopt refuses', (t) => {
  const root = mkroot(t);
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  makeSkill(home, 'stray');

  try {
    _now.value = FIXED_NOW;
    const first = adoptSkill({ home, cwd: root }, 'stray');
    assert.equal(first.ok, true, first.message);
    assert.deepEqual(readUsageSidecar(first.dir), {
      use_count: 0,
      view_count: 0,
      last_used: new Date(FIXED_NOW).toISOString(),
    });
    const ledger = readSkillLedger(home);
    assert.ok(ledger.some((r) => r.action === 'adopt' && r.name === 'stray'));

    const second = adoptSkill({ home, cwd: root }, 'stray');
    assert.equal(second.ok, false);
    assert.equal(second.kind, 'managed');
  } finally {
    _now.value = null;
  }
});

test('purge deletes archived copies + old snapshots, keeping one safety snapshot', (t) => {
  const root = mkroot(t);
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  const dir = makeSkill(home, 'gone-girl');
  setSidecar(dir, { useCount: 0, lastUsedMs: FIXED_NOW - 150 * DAY_MS });

  try {
    _now.value = FIXED_NOW;
    curateSkills({ home, cwd: root }, { apply: true });

    const refused = purgeSkill({ home, cwd: root }, 'not-a-skill');
    assert.equal(refused.ok, false);
    assert.equal(refused.kind, 'not-archived');

    const res = purgeSkill({ home, cwd: root }, 'gone-girl');
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(fs.existsSync(path.join(home, '.agents', 'skills', '.archive', 'gone-girl')), false);
    const snaps = listSnapshots(home, 'gone-girl');
    assert.equal(snaps.length, 1, 'exactly the final safety snapshot survives');
    assert.equal(snaps[0], res.keptSnapshot);
    const ledger = readSkillLedger(home);
    const purgeRec = ledger.find((r) => r.action === 'purge');
    assert.ok(purgeRec, 'ledger has purge line');
    assert.equal(purgeRec.actor, 'user');
  } finally {
    _now.value = null;
  }
});

test('snapshot pruning keeps at most 5 per skill name', (t) => {
  const root = mkroot(t);
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  const dir = makeSkill(home, 'hoarder');
  for (let i = 0; i < 7; i++) {
    snapshotSkillDir({ home }, dir, 'hoarder', FIXED_NOW - (10 - i) * 60_000);
  }
  const snaps = listSnapshots(home, 'hoarder');
  assert.equal(snaps.length, 5, `kept newest 5, got ${snaps.length}`);
});

// ---------------------------------------------------------------------------
// CLI surface (subprocess, sandboxed HOME)
// ---------------------------------------------------------------------------

const SCRUB = [
  'OX_BASE_URL', 'OX_API_KEY', 'OX_MODEL', 'OX_YOLO', 'OX_MAX_COST', 'OX_FALLBACK_BOTS',
  'XAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY',
  'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'DEEPSEEK_API_KEY',
];

function sandboxCli(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-v4a-home-'));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-v4a-ws-'));
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  });
  return { home, ws };
}

function runOx(args, { home, ws } = {}) {
  const env = { ...process.env };
  for (const k of SCRUB) delete env[k];
  env.HOME = home;
  env.NO_COLOR = '1';
  return spawnSync(process.execPath, [OX_BIN, ...args], { cwd: ws, env, encoding: 'utf8' });
}

test('CLI lifecycle: pin/unpin config round-trip; curate --dry-run table; adopt; restore; purge --yes', (t) => {
  const { home, ws } = sandboxCli(t);
  const dir = makeSkill(ws, 'cli-aged', { body: 'cli fossil' });
  const oldTs = (FIXED_NOW - 100 * DAY_MS) / 1000;
  fs.utimesSync(dir, oldTs, oldTs);

  const pin = runOx(['skill', 'pin', 'cli-aged'], { home, ws });
  assert.equal(pin.status, 0, pin.stderr);
  const cfgDoc = JSON.parse(fs.readFileSync(path.join(home, '.ox', 'config.json'), 'utf8'));
  assert.deepEqual(cfgDoc.skill_pins, ['cli-aged']);

  // pinned → dry-run reports no archive candidate
  const dryPinned = runOx(['skill', 'curate', '--dry-run'], { home, ws });
  assert.equal(dryPinned.status, 0, dryPinned.stderr);
  assert.match(dryPinned.stdout, /NAME\s+STATE\s+ACTION\s+REASON/);
  assert.match(dryPinned.stdout, /cli-aged\s+unmanaged/);
  assert.doesNotMatch(dryPinned.stdout, /would-archive/, 'pinned skill must not be archivable');
  assert.ok(fs.existsSync(dir), 'dry-run left the skill in place');

  const unpin = runOx(['skill', 'unpin', 'cli-aged'], { home, ws });
  assert.equal(unpin.status, 0, unpin.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, '.ox', 'config.json'), 'utf8')).skill_pins, []);

  // adopt starts tracking, then curation applies (mtime-immune no more? adopted skills keep mtime age —
  // fresh sidecar has last_used=now so it is active regardless of mtime)
  const adopt = runOx(['skill', 'adopt', 'cli-aged'], { home, ws });
  assert.equal(adopt.status, 0, adopt.stderr);
  const sidecar = JSON.parse(fs.readFileSync(path.join(dir, '.usage.json'), 'utf8'));
  assert.equal(sidecar.use_count, 0);
  const dupAdopt = runOx(['skill', 'adopt', 'cli-aged'], { home, ws });
  assert.equal(dupAdopt.status, 3);
  assert.match(dupAdopt.stderr, /already has a \.usage\.json/);

  // age the sidecar's last_used artificially via direct rewrite, then curate applies
  setSidecar(dir, { useCount: 0, lastUsedMs: FIXED_NOW - 95 * DAY_MS });
  const curate = runOx(['skill', 'curate'], { home, ws });
  assert.equal(curate.status, 0, curate.stderr);
  assert.match(curate.stdout, /archived/);
  assert.equal(fs.existsSync(dir), false);
  assert.ok(fs.existsSync(path.join(ws, '.agents', 'skills', '.archive', 'cli-aged', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(home, '.agents', 'skill-ledger.jsonl')));

  const restore = runOx(['skill', 'restore', 'cli-aged'], { home, ws });
  assert.equal(restore.status, 0, restore.stderr);
  assert.ok(fs.existsSync(path.join(dir, 'SKILL.md')), 'restored to original project path');
  assert.equal(fs.existsSync(path.join(ws, '.agents', 'skills', '.archive', 'cli-aged')), false);

  // re-archive then purge --yes
  setSidecar(dir, { useCount: 0, lastUsedMs: FIXED_NOW - 95 * DAY_MS });
  assert.equal(runOx(['skill', 'curate'], { home, ws }).status, 0);
  const purgeNoYes = runOx(['skill', 'purge', 'cli-aged'], { home, ws });
  assert.equal(purgeNoYes.status, 4, 'non-TTY purge without --yes must refuse');
  assert.ok(fs.existsSync(path.join(ws, '.agents', 'skills', '.archive', 'cli-aged')), 'refused purge changed nothing');
  const purge = runOx(['skill', 'purge', 'cli-aged', '--yes'], { home, ws });
  assert.equal(purge.status, 0, purge.stderr);
  assert.match(purge.stdout, /purged 'cli-aged'/);
  assert.equal(fs.existsSync(path.join(ws, '.agents', 'skills', '.archive', 'cli-aged')), false);

  const ledgerLines = fs.readFileSync(path.join(home, '.agents', 'skill-ledger.jsonl'), 'utf8').trim().split('\n');
  const actions = ledgerLines.map((l) => JSON.parse(l).action);
  assert.ok(actions.includes('adopt'), 'adopt in ledger');
  assert.ok(actions.includes('archive'), 'archive in ledger');
  assert.ok(actions.includes('restore'), 'restore in ledger');
  assert.ok(actions.includes('purge'), 'purge in ledger');
});
