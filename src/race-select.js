// Picking the winner of `ox race` by evidence, not by opinion.
//
// A race is best-of-N, and best-of-N is only as good as the pick. Test-based
// and judge-based pickers each plateau; together they do better (R2E-Gym), a
// fail→pass reproduction test doubles precision (SWT-Bench), and a judge alone
// says "fine" to 17-22% of wrong patches. So the lanes are ranked by, in order:
//   1. a reproduction test written apart from every lane, that fails on the
//      code before the race: does the lane make it pass?
//   2. the project's own checks (lint, build, test) on the lane;
//   3. the lanes' own new tests, each run against every other lane: a lane that
//      passes more of its rivals' tests did more of what was asked;
//   4. new security findings in the lane's diff (fewer is better);
//   5. a judge, only to break a tie, asked twice with the order swapped (a
//      verdict that flips with the order counts for nothing);
//   then the smaller change.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { scanDiff } from './security-scan.js';

const isTest = (f) => /(?:^|[._-])(?:test|spec)s?\.[cm]?[jt]sx?$|(?:^|\/)test_.*\.py$|_test\.(?:py|go)$|(?:^|\/)(?:test|tests|__tests__)\//.test(f);
const sh = (cwd, cmd, args, timeout = 10 * 60_000) => {
  const env = { ...process.env, CI: '1', NO_COLOR: '1', FORCE_COLOR: '0' };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout, env });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const failed = /^# fail (\d+)/m.exec(out);
  return { ok: r.status === 0 && !(failed && Number(failed[1]) > 0), out };
};

/** How to run one test file in this project (null when unknown). */
export function testFileCommand(dir) {
  let pkg = null;
  try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch {}
  if (pkg) {
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    if (deps.vitest) return (f) => ['npx', ['vitest', 'run', f]];
    if (deps.jest) return (f) => ['npx', ['jest', f]];
    if (deps.mocha) return (f) => ['npx', ['mocha', f]];
    return (f) => ['node', ['--test', f]];
  }
  if (['pyproject.toml', 'requirements.txt', 'setup.py', 'pytest.ini'].some((f) => fs.existsSync(path.join(dir, f)))) return (f) => ['python3', ['-m', 'pytest', '-q', f]];
  return null;
}

/** Run test files (paths relative to `from`) inside `dir`, copied in and removed after. → passed, total */
export function runForeignTests(dir, from, files) {
  const cmd = testFileCommand(dir);
  if (!cmd || !files.length) return { passed: 0, total: 0 };
  let passed = 0;
  for (const f of files) {
    const dest = path.join(dir, f);
    const existed = fs.existsSync(dest);
    const prev = existed ? fs.readFileSync(dest) : null;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(from, f), dest);
    try { const [c, a] = cmd(f); if (sh(dir, c, a).ok) passed++; }
    finally { if (existed) fs.writeFileSync(dest, prev); else fs.rmSync(dest, { force: true }); }
  }
  return { passed, total: files.length };
}

/** The test files a lane added or changed in its commit. */
export function laneTests(dir) {
  const r = spawnSync('git', ['diff', '--name-only', 'HEAD~1', 'HEAD'], { cwd: dir, encoding: 'utf8' });
  return String(r.stdout ?? '').split('\n').filter((f) => f && isTest(f) && fs.existsSync(path.join(dir, f)));
}

export const REPRO_SYSTEM = `You write ONE automated test that reproduces a task: it must FAIL on the code as it is now and PASS once the task is done correctly. Test the behaviour the task asks for through the project's public interface. Use the project's test framework. Answer with the test file's code only, no fences, no notes.`;

/**
 * The reproduction test: written in a fresh context from the task and the
 * project map, kept only if it fails on the code before the race.
 * → { file, rel, failsBefore } or { skipped }
 */
export async function reproTest(root, prompt, { ask, projectMap = '', dir = null }) {
  const cmd = testFileCommand(root);
  if (!cmd) return { skipped: 'no test runner known for this project' };
  const testDir = fs.existsSync(path.join(root, 'test')) ? 'test' : fs.existsSync(path.join(root, 'tests')) ? 'tests' : '.';
  const py = cmd('x')[0] === 'python3';
  const rel = path.join(testDir, py ? 'test_ox_race_repro.py' : 'ox-race-repro.test.mjs');
  let code = String(await ask({ system: REPRO_SYSTEM, user: `Task: ${prompt}\n\nThe test file will be at ${rel}.\n\nProject:\n${projectMap}` })).trim().replace(/^```\w*\n?|\n?```$/g, '');
  if (code.length < 40) return { skipped: 'the reproduction test writer returned nothing usable' };
  const keep = path.join(dir ?? root, '.ox-race-repro', path.basename(rel));
  fs.mkdirSync(path.dirname(keep), { recursive: true });
  fs.writeFileSync(keep, `${code}\n`);
  // Must fail before any lane's change, or it reproduces nothing.
  const dest = path.join(root, rel);
  fs.copyFileSync(keep, dest);
  let before;
  try { const [c, a] = cmd(rel); before = sh(root, c, a); } finally { fs.rmSync(dest, { force: true }); }
  if (before.ok) return { skipped: 'the reproduction test already passes before any change, so it shows nothing' };
  return { file: keep, rel, failsBefore: true };
}

/** Run the reproduction test in a lane. */
export function runRepro(dir, repro) {
  if (!repro?.file) return null;
  const cmd = testFileCommand(dir);
  const dest = path.join(dir, repro.rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(repro.file, dest);
  try { const [c, a] = cmd(repro.rel); return sh(dir, c, a).ok; } finally { fs.rmSync(dest, { force: true }); }
}

export const JUDGE_SYSTEM = `Two changes try to do the same task. Read the task and both diffs and decide which does the task better: correct, complete, no unrelated changes, no weakened tests. Answer with ONE word: A or B.`;

/** Ask the judge twice, with the order swapped. → 'a' | 'b' | null (no consistent answer) */
export async function judge(prompt, diffA, diffB, ask) {
  const one = async (x, y) => (String(await ask({ system: JUDGE_SYSTEM, user: `Task: ${prompt}\n\n--- Change A ---\n${x.slice(0, 12_000)}\n\n--- Change B ---\n${y.slice(0, 12_000)}` })).trim().toUpperCase().match(/\b[AB]\b/)?.[0] ?? null);
  const first = await one(diffA, diffB);
  const second = await one(diffB, diffA);
  if (first === 'A' && second === 'B') return 'a';
  if (first === 'B' && second === 'A') return 'b';
  return null;
}

/**
 * Rank race lanes. `lanes`: [{ agent, dir, files, plus, minus, checksOk, checks }].
 * → { ranked: [{ agent, score, why }], winner, evidence }
 */
export async function rankLanes(root, prompt, lanes, { ask = null, repro = null, base = 'HEAD~1' } = {}) {
  const live = lanes.filter((l) => l.files > 0);
  const ev = new Map(lanes.map((l) => [l.agent, { agent: l.agent, changed: l.files > 0, repro: null, checks: l.checksOk === true || (l.checksOk !== false && !(l.checks ?? []).length) ? (l.checks ?? []).length ? 'pass' : 'none' : 'fail', rivalsPassed: 0, rivalsTotal: 0, security: 0, judgeWins: 0, size: (l.plus ?? 0) + (l.minus ?? 0) }]));
  for (const l of live) ev.get(l.agent).repro = runRepro(l.dir, repro);
  // 3. every lane's new tests against every other lane
  const tests = new Map(live.map((l) => [l.agent, laneTests(l.dir)]));
  for (const l of live) {
    for (const o of live) {
      if (o === l) continue;
      const r = runForeignTests(l.dir, o.dir, tests.get(o.agent));
      ev.get(l.agent).rivalsPassed += r.passed;
      ev.get(l.agent).rivalsTotal += r.total;
    }
  }
  // 4. new security findings
  for (const l of live) { try { ev.get(l.agent).security = scanDiff({ cwd: l.dir, base }).findings.filter((f) => f.severity !== 'low').length; } catch {} }
  const key = (e) => [e.changed ? 1 : 0, e.repro === true ? 1 : 0, e.checks === 'fail' ? 0 : 1, e.rivalsTotal ? e.rivalsPassed / e.rivalsTotal : 0, -e.security];
  const cmp = (a, b) => { const x = key(a), y = key(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return y[i] - x[i]; return 0; };
  let order = [...ev.values()].sort(cmp);
  // 5. the judge, only between the top two when the evidence ties them
  let judged = null;
  if (ask && order.length > 1 && order[0].changed && cmp(order[0], order[1]) === 0) {
    const d = (agent) => spawnSync('git', ['diff', base, 'HEAD'], { cwd: lanes.find((l) => l.agent === agent).dir, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).stdout ?? '';
    try {
      judged = await judge(prompt, d(order[0].agent), d(order[1].agent), ask);
      if (judged) order[judged === 'a' ? 0 : 1].judgeWins = 1;
    } catch {}
  }
  order = order.sort((a, b) => cmp(a, b) || b.judgeWins - a.judgeWins || a.size - b.size);
  const why = (e) => [
    !e.changed && 'no change',
    e.repro === true && 'passes the reproduction test', e.repro === false && 'fails the reproduction test',
    e.checks === 'pass' && 'project checks pass', e.checks === 'fail' && 'project checks fail',
    e.rivalsTotal && `passes ${e.rivalsPassed}/${e.rivalsTotal} of the other lanes' tests`,
    e.security && `${e.security} new security finding${e.security === 1 ? '' : 's'}`,
    e.judgeWins && 'the judge preferred it both ways round',
  ].filter(Boolean).join(', ');
  const ranked = order.map((e) => ({ agent: e.agent, why: why(e), evidence: e }));
  return { ranked, winner: ranked[0]?.evidence.changed ? ranked[0].agent : null, judged };
}
