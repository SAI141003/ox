// ox build's proof, made so the coding agent cannot fake it.
//
// Agents that may edit the tests will: they edit a failing test, delete the
// assertion, or mark it skip, and then "all tests pass" (EvilGenie, ImpossibleBench).
// Telling them not to does not work. So the proof does not trust the run:
//   1. lock: after the tests-first step, every test file and test setting is
//      hashed (.agent/specs/<id>.lock.json). Any later change to a locked test,
//      a deleted test file, a new skip / only / xfail, fewer assertions, or a
//      changed test command fails the proof unless you approve it.
//   2. held-out tests: written in a fresh context from the spec and the code's
//      diff only, kept outside the project (~/.ox/heldout), never shown to the
//      coding agent, and run only here.
//   3. mutation check: small breaks in the new code (=== to !==, < to >=, true
//      to false…) must make the tests fail; a break the tests miss is reported.
//   4. a verifier in a fresh context sees only the spec, the diff and the test
//      output, never the coder's own account of its work; it is advice, not the gate.
// Every command, its exit code and its time go into .agent/specs/<id>.proof.md.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { testFiles } from './build-spec.js';

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const SPEC_DIR = path.join('.agent', 'specs');

// ---------------------------------------------------------------- 1. the lock
const ASSERT = /\bassert(?:\.\w+)?\s*\(|\bexpect\s*\(|\.should\b|\bassert\s+[^=]|\bt\.(?:Error|Fatal|Fail)|\bassert_(?:eq|ne)!|\bself\.assert\w*\(/g;
const SKIP = /\.(?:skip|todo)\s*\(|\b(?:xit|xdescribe|xtest)\s*\(|\{\s*skip\s*:\s*(?:true|['"])|@pytest\.mark\.(?:skip|xfail)|\bpytest\.(?:skip|xfail)\s*\(|\bt\.Skip(?:Now|f)?\s*\(|#\[ignore\]|@unittest\.skip/g;
const ONLY = /\.only\s*\(|\bfit\s*\(|\bfdescribe\s*\(|\{\s*only\s*:\s*true/g;
const count = (re, text) => (String(text).match(re) ?? []).length;

/** Test settings a run could loosen: the test command and the runners' config files. */
export function testConfig(cwd) {
  const out = {};
  try { const p = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')); out['package.json scripts.test'] = sha(String(p.scripts?.test ?? '')); out['package.json jest'] = sha(JSON.stringify(p.jest ?? null)); } catch {}
  let names = [];
  try { names = fs.readdirSync(cwd); } catch {}
  for (const n of names.filter((n) => /^(?:jest|vitest|vite)\.config\.|^\.mocharc|^pytest\.ini$|^conftest\.py$|^setup\.cfg$|^tox\.ini$|^\.c8rc|^\.nycrc/.test(n))) out[n] = sha(read(path.join(cwd, n)) ?? '');
  const py = read(path.join(cwd, 'pyproject.toml'));
  if (py) out['pyproject.toml [tool.pytest]'] = sha(/\[tool\.pytest[^\]]*\][^[]*/.exec(py)?.[0] ?? '');
  return out;
}

/** Every test file with its hash and its assertion / skip / only counts, and the test settings. */
export function testSnapshot(cwd) {
  const files = {};
  for (const f of testFiles(cwd)) {
    const text = read(f) ?? '';
    files[path.relative(cwd, f)] = { sha: sha(text), asserts: count(ASSERT, text), skips: count(SKIP, text), only: count(ONLY, text) };
  }
  return { files, config: testConfig(cwd) };
}

const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
const lockPath = (cwd, id) => path.join(cwd, SPEC_DIR, `${id}.lock.json`);

/** Lock the tests as they are now; `base` is the commit the build started from (for the diff). */
export function lockTests(cwd, specId, { base = null } = {}) {
  const lock = { spec: specId, at: new Date().toISOString(), base, ...testSnapshot(cwd) };
  fs.mkdirSync(path.join(cwd, SPEC_DIR), { recursive: true });
  fs.writeFileSync(lockPath(cwd, specId), `${JSON.stringify(lock, null, 2)}\n`);
  return lock;
}
export const loadLock = (cwd, specId) => { try { return JSON.parse(fs.readFileSync(lockPath(cwd, specId), 'utf8')); } catch { return null; } };

/** What changed in the tests since the lock: [{ file, kind, detail }]. Added test files are fine unless they skip or narrow. */
export function integrity(cwd, lock) {
  const now = testSnapshot(cwd);
  const problems = [];
  for (const [f, was] of Object.entries(lock.files)) {
    const is = now.files[f];
    if (!is) { problems.push({ file: f, kind: 'deleted', detail: 'a locked test file is gone' }); continue; }
    if (is.sha === was.sha) continue;
    if (is.asserts < was.asserts) problems.push({ file: f, kind: 'assertions-dropped', detail: `${was.asserts} → ${is.asserts} assertions` });
    if (is.skips > was.skips) problems.push({ file: f, kind: 'skip-added', detail: `${is.skips - was.skips} new skip / xfail / todo` });
    if (is.only > was.only) problems.push({ file: f, kind: 'only-added', detail: 'a new .only hides the other tests' });
    problems.push({ file: f, kind: 'changed', detail: 'a locked test was edited after the tests-first step' });
  }
  for (const [f, is] of Object.entries(now.files)) {
    if (lock.files[f]) continue;
    if (is.skips) problems.push({ file: f, kind: 'skip-added', detail: `a new test file with ${is.skips} skip / xfail / todo` });
    if (is.only) problems.push({ file: f, kind: 'only-added', detail: 'a new .only hides the other tests' });
  }
  for (const [k, v] of Object.entries(lock.config ?? {})) if (now.config[k] !== v) problems.push({ file: k, kind: 'config-changed', detail: 'the test command or runner settings changed' });
  for (const k of Object.keys(now.config)) if (!(k in (lock.config ?? {}))) problems.push({ file: k, kind: 'config-changed', detail: 'a new test runner setting appeared' });
  return { ok: problems.length === 0, problems };
}

// ---------------------------------------------------------------- the diff
const isTest = (f) => /(?:^|[._-])(?:test|spec)s?\.[cm]?[jt]sx?$|(?:^|\/)test_.*\.py$|_test\.(?:py|go)$|(?:^|\/)(?:test|tests|__tests__)\//.test(f);

/** The source files the build changed (not tests, not the spec), with the new line numbers. */
export function changedSource(cwd, base) {
  if (!base) return [];
  const r = git(cwd, ['diff', '-U0', '--no-color', base, '--', '.', ':(exclude).agent']);
  const untracked = git(cwd, ['ls-files', '--others', '--exclude-standard']).stdout.split('\n').filter(Boolean);
  const out = new Map();
  let file = null;
  for (const line of String(r.stdout ?? '').split('\n')) {
    const m = /^\+\+\+ b\/(.+)$/.exec(line);
    if (m) { file = isTest(m[1]) || !/\.(?:[cm]?[jt]sx?|py|go|rs|rb|java|kt|swift)$/.test(m[1]) ? null : m[1]; if (file) out.set(file, out.get(file) ?? []); continue; }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h && file) { const start = Number(h[1]), n = h[2] == null ? 1 : Number(h[2]); for (let i = 0; i < n; i++) out.get(file).push(start + i); }
  }
  for (const f of untracked) if (!isTest(f) && !f.startsWith('.agent/') && /\.(?:[cm]?[jt]sx?|py|go|rs|rb)$/.test(f)) out.set(f, (read(path.join(cwd, f)) ?? '').split('\n').map((_, i) => i + 1));
  return [...out].map(([f, lines]) => ({ file: f, lines }));
}

/** The diff as text, for the verifier and the held-out test writer (source only, or with tests). */
export function diffText(cwd, base, { tests = true, max = 24_000 } = {}) {
  if (!base) return '';
  const r = git(cwd, ['diff', '--no-color', base, '--', '.', ':(exclude).agent']);
  let text = String(r.stdout ?? '');
  const untracked = git(cwd, ['ls-files', '--others', '--exclude-standard']).stdout.split('\n').filter((f) => f && !f.startsWith('.agent/'));
  for (const f of untracked) text += `\n--- new file: ${f}\n${read(path.join(cwd, f)) ?? ''}`;
  if (!tests) text = text.split(/(?=^diff --git |^--- new file: )/m).filter((part) => { const m = /^diff --git a\/(\S+)|^--- new file: (\S+)/.exec(part); return !m || !isTest(m[1] ?? m[2]); }).join('');
  return text.length > max ? `${text.slice(0, max)}\n… (diff cut at ${max} characters)` : text;
}

// ---------------------------------------------------------------- 3. mutation check
const SWAPS = [[/===/, '!=='], [/!==/, '==='], [/(?<![=!<>])==(?!=)/, '!='], [/!=(?!=)/, '=='], [/<=/, '>'], [/>=/, '<'], [/(?<![<=-])<(?![=<])/, '>='], [/(?<![>=-])>(?![=>])/, '<='], [/&&/, '||'], [/\|\|/, '&&'], [/\btrue\b/, 'false'], [/\bfalse\b/, 'true'], [/\bTrue\b/, 'False'], [/\bFalse\b/, 'True'], [/ \+ (?=\w)/, ' - '], [/ - (?=\w)/, ' + '], [/\band\b/, 'or'], [/\bor\b/, 'and']];
const COMMENT = /^\s*(?:\/\/|#|\*|\/\*)/;

/** One small break for a line, or null: the first that applies of a swapped operator, a dropped "!", a removed step of a call chain, a number off by one, an empty return. */
function breakLine(text, code) {
  for (const [re, to] of SWAPS) {
    const m = re.exec(code);
    if (m) return text.slice(0, m.index) + to + text.slice(m.index + m[0].length);
  }
  let m = /!(?=[\w(])/.exec(code);
  if (m && !/!=/.test(code.slice(m.index, m.index + 2))) return text.slice(0, m.index) + text.slice(m.index + 1);
  if (/^\s*\.\w+\(.*\)\s*;?\s*$/.test(code)) return /;\s*$/.test(text) ? text.replace(/\S.*$/, ';') : '';
  m = /(?<![\w.])(\d+)(?![\w.])/.exec(code);
  if (m) return text.slice(0, m.index) + String(Number(m[1]) + 1) + text.slice(m.index + m[1].length);
  m = /\breturn\s+(?!;|undefined\b|null\b)\S/.exec(code);
  if (m) return `${text.slice(0, m.index)}return undefined;`;
  return null;
}

/** Small breaks in the changed lines: [{ file, line, from, to }], at most `max`, spread over the files. */
export function mutants(cwd, changed, { max = 8 } = {}) {
  const all = [];
  for (const { file, lines } of changed) {
    const src = (read(path.join(cwd, file)) ?? '').split('\n');
    for (const n of lines) {
      const text = src[n - 1];
      if (text == null || COMMENT.test(text) || /^\s*(?:import|export\s+\{|from\s|require\()/.test(text)) continue;
      const code = text.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, (s) => ' '.repeat(s.length)).replace(/\/(?![/*])(?:\\.|\[(?:\\.|[^\]])*\]|[^/\n])+\/[a-z]*/g, (s) => ' '.repeat(s.length));
      const to = breakLine(text, code);
      if (to != null && to !== text) all.push({ file, line: n, from: text, to });
    }
  }
  if (all.length <= max) return all;
  const step = all.length / max;
  return Array.from({ length: max }, (_, i) => all[Math.floor(i * step)]);
}

/** Run the tests against each mutant; a mutant the tests still pass "survived". */
export function mutationCheck(cwd, list, { run }) {
  const out = [];
  for (const m of list) {
    const f = path.join(cwd, m.file);
    const orig = fs.readFileSync(f, 'utf8');
    const lines = orig.split('\n');
    lines[m.line - 1] = m.to;
    fs.writeFileSync(f, lines.join('\n'));
    let r;
    try { r = run(`mutant ${m.file}:${m.line}`); } finally { fs.writeFileSync(f, orig); }
    out.push({ ...m, killed: !r.ok });
  }
  const killed = out.filter((x) => x.killed).length;
  return { mutants: out, killed, total: out.length, score: out.length ? killed / out.length : null };
}

// ---------------------------------------------------------------- 2. held-out tests
const projectKey = (cwd) => sha(path.resolve(cwd)).slice(0, 16);
export const heldOutDir = (cwd, specId, home = os.homedir()) => path.join(home, '.ox', 'heldout', projectKey(cwd), specId);

/** Where a held-out test goes while it runs, and how to run that one file. */
export function heldOutTarget(cwd, tests, specId) {
  const slug = specId.replace(/[^a-z0-9]+/gi, '_').slice(0, 40);
  const dir = fs.existsSync(path.join(cwd, 'test')) ? 'test' : fs.existsSync(path.join(cwd, 'tests')) ? 'tests' : '.';
  switch (tests.framework) {
    case 'pytest': return { rel: path.join(dir, `test_ox_heldout_${slug}.py`), cmd: (f) => ['python3', '-m', 'pytest', '-q', f] };
    case 'jest': return { rel: path.join(dir, `ox-heldout-${slug}.test.js`), cmd: (f) => ['npx', 'jest', f] };
    case 'vitest': return { rel: path.join(dir, `ox-heldout-${slug}.test.js`), cmd: (f) => ['npx', 'vitest', 'run', f] };
    case 'mocha': return { rel: path.join(dir, `ox-heldout-${slug}.test.js`), cmd: (f) => ['npx', 'mocha', f] };
    case 'node:test': return { rel: path.join(dir, `ox-heldout-${slug}.test.mjs`), cmd: (f) => ['node', '--test', f] };
    default: return null;
  }
}

export const HELDOUT_SYSTEM = `You write extra acceptance tests that another engineer's code must pass. You see the specification and the source changes only (not their tests, not their notes). Write ONE test file for the named framework that checks each acceptance criterion through the code's public interface (exported functions, the CLI, the HTTP routes) as the spec describes it, including the edge and error cases the spec implies. Import from the project with paths relative to the given test file location. Do not test private details or exact wording the spec does not fix. Answer with the file's code only, no fences, no notes.`;

/** Write the held-out test (once per spec) with `ask`, in a fresh context; kept outside the project. */
export async function writeHeldOut(cwd, spec, tests, { base, ask, home = os.homedir() }) {
  const target = heldOutTarget(cwd, tests, spec.id);
  if (!target) return { skipped: `held-out tests are not supported for ${tests.framework} yet` };
  const dir = heldOutDir(cwd, spec.id, home);
  const file = path.join(dir, path.basename(target.rel));
  if (fs.existsSync(file)) return { file, target, reused: true };
  const ac = spec.acceptance.map((a) => `${a.id}: Given ${a.given || '…'}, when ${a.when || '…'}, then ${a.then}`).join('\n');
  const user = `Framework: ${tests.framework}. The test file will be at ${target.rel} (relative to the project root).\n\nSpecification: ${spec.title}\n${spec.summary}\n\nAcceptance criteria:\n${ac}\n\nSource changes (diff):\n${diffText(cwd, base, { tests: false })}`;
  let code = String(await ask({ system: HELDOUT_SYSTEM, user })).trim().replace(/^```\w*\n?|\n?```$/g, '');
  if (!code || code.length < 40) return { skipped: 'the held-out test writer returned nothing usable' };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, `${code}\n`);
  return { file, target };
}

/** Copy the held-out test in, run it, take it out again. */
export function runHeldOut(cwd, held, { exec }) {
  if (!held?.file) return { skipped: held?.skipped ?? 'no held-out test' };
  const dest = path.join(cwd, held.target.rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(held.file, dest);
  try {
    const [cmd, ...args] = held.target.cmd(held.target.rel);
    const r = exec('held-out tests', cmd, args);
    return { ok: r.ok, exit: r.exit, tail: r.tail };
  } finally { fs.rmSync(dest, { force: true }); }
}

// ---------------------------------------------------------------- 4. the verifier
export const VERIFIER_SYSTEM = `You check whether a code change meets its specification. You see the spec, the diff and the test output; you do not see what the author said about it. For each acceptance criterion decide: "met" (the diff implements it and a test exercises it), "not met", or "unclear". Watch for tests that do not really check the behaviour (asserting true, mocking the thing under test, catching every error). Answer with ONE JSON object: {"criteria":[{"id":"AC-1","verdict":"met|not met|unclear","why":"one sentence"}],"concerns":["…"]}`;

export async function verify(cwd, spec, { base, testOutput, ask }) {
  const ac = spec.acceptance.map((a) => `${a.id}: Given ${a.given || '…'}, when ${a.when || '…'}, then ${a.then}`).join('\n');
  const text = String(await ask({ system: VERIFIER_SYSTEM, user: `Spec: ${spec.title}\n${spec.summary}\n\n${ac}\n\nDiff:\n${diffText(cwd, base)}\n\nTest output (end):\n${String(testOutput).slice(-4000)}` }));
  const j = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  return { criteria: Array.isArray(j.criteria) ? j.criteria : [], concerns: Array.isArray(j.concerns) ? j.concerns : [] };
}

// ---------------------------------------------------------------- the proof
/** A recorder for every command the proof runs. */
export function recorder(cwd, { timeoutMs = 300_000 } = {}) {
  const log = [];
  const exec = (why, cmd, args) => {
    const env = { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' };
    delete env.NODE_TEST_CONTEXT;
    const t0 = Date.now();
    const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: timeoutMs, env, shell: process.platform === 'win32' });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    const failed = /^# fail (\d+)/m.exec(out);
    const ok = r.status === 0 && !(failed && Number(failed[1]) > 0);
    log.push({ why, cmd: [cmd, ...args].join(' '), exit: r.status ?? (r.signal ? `signal ${r.signal}` : 'error'), ms: Date.now() - t0 });
    return { ok, exit: r.status, out, tail: out.trim().split('\n').slice(-12).join('\n') };
  };
  const shell = (why, line) => exec(why, process.platform === 'win32' ? 'cmd' : 'sh', process.platform === 'win32' ? ['/c', line] : ['-c', line]);
  return { log, exec, shell };
}

/**
 * The whole proof. `trace` is build-spec's traceSpec result; `ask` a fresh model
 * call ({ system, user } → text) or null to skip the model steps.
 * → { verdict: 'proven' | 'not proven', reasons, integrity, heldOut, mutation, verifier, commands }
 */
export async function prove(cwd, spec, { tests, trace, ask = null, acceptTestChanges = false, mutate = 8, home = os.homedir(), rec = recorder(cwd) } = {}) {
  const lock = loadLock(cwd, spec.id);
  const base = lock?.base ?? null;
  const reasons = [];
  const integ = lock ? integrity(cwd, lock) : { ok: false, problems: [{ file: '-', kind: 'no-lock', detail: 'the tests were never locked (run ox build, which locks them after the tests-first step)' }] };
  if (!integ.ok && !acceptTestChanges) reasons.push(`tests changed after they were locked (${integ.problems.length})`);
  const full = rec.shell('the whole test suite', tests.cmd);
  if (!full.ok) reasons.push('the test suite fails');
  if (trace.passed < trace.rows.length) reasons.push(`${trace.rows.length - trace.passed} of ${trace.rows.length} criteria not proven by a passing test`);
  let heldOut = { skipped: 'no model to write them' };
  let verifier = null;
  if (ask) {
    try { heldOut = runHeldOut(cwd, await writeHeldOut(cwd, spec, tests, { base, ask, home }), { exec: rec.exec }); } catch (e) { heldOut = { skipped: `held-out tests could not be written: ${e.message}` }; }
    if (heldOut.ok === false) reasons.push('held-out tests (never seen by the coder) fail');
    try { verifier = await verify(cwd, spec, { base, testOutput: full.out, ask }); } catch (e) { verifier = { error: e.message }; }
  }
  let mutation = { skipped: base ? 'no changed source lines' : 'not a git project, so the changed lines are unknown' };
  const list = base && mutate ? mutants(cwd, changedSource(cwd, base), { max: mutate }) : [];
  if (list.length) mutation = mutationCheck(cwd, list, { run: (why) => rec.shell(why, tests.cmd) });
  const verdict = reasons.length ? 'not proven' : 'proven';
  return { verdict, reasons, integrity: integ, acceptedTestChanges: acceptTestChanges && !integ.ok, heldOut, mutation, verifier, trace, commands: rec.log };
}

export function proofMarkdown(spec, p) {
  const L = [`# Proof: ${spec.title} (${spec.id})`, '', `**${p.verdict === 'proven' ? '✓ Proven' : '✗ Not proven'}**${p.reasons.length ? `: ${p.reasons.join('; ')}` : ''}`, ''];
  L.push('## Criteria', ...p.trace.rows.map((r) => `- ${r.status === 'passes' ? '✓' : '✗'} ${r.id} ${r.status}: ${r.then}${r.files.length ? ` (${r.files.join(', ')})` : ''}`), '');
  L.push('## Tests locked after the tests-first step', p.integrity.ok ? '- ✓ no locked test, skip marker, assertion or test setting changed' : p.integrity.problems.map((x) => `- ✗ ${x.file}: ${x.detail}`).join('\n'));
  if (p.acceptedTestChanges) L.push('- the changes above were approved by you (--accept-test-changes)');
  L.push('', '## Held-out tests (written apart, never shown to the coder)', p.heldOut.skipped ? `- not run: ${p.heldOut.skipped}` : `- ${p.heldOut.ok ? '✓ pass' : '✗ fail'} (exit ${p.heldOut.exit})${p.heldOut.ok ? '' : `\n\n\`\`\`\n${p.heldOut.tail}\n\`\`\``}`);
  L.push('', '## Mutation check (do the tests catch a broken change?)');
  if (p.mutation.skipped) L.push(`- not run: ${p.mutation.skipped}`);
  else { L.push(`- ${p.mutation.killed} of ${p.mutation.total} small breaks caught`); for (const m of p.mutation.mutants.filter((x) => !x.killed)) L.push(`- missed: ${m.file}:${m.line} \`${m.from.trim()}\` → \`${m.to.trim()}\``); }
  L.push('', '## Fresh-context review (advice, not the gate)');
  if (!p.verifier) L.push('- not run (no model)');
  else if (p.verifier.error) L.push(`- could not run: ${p.verifier.error}`);
  else { for (const c of p.verifier.criteria) L.push(`- ${c.verdict === 'met' ? '✓' : c.verdict === 'not met' ? '✗' : '?'} ${c.id} ${c.verdict}: ${c.why ?? ''}`); for (const c of p.verifier.concerns) L.push(`- concern: ${c}`); }
  L.push('', '## Commands run', '| Why | Command | Exit | Time |', '|---|---|---|---|', ...p.commands.map((c) => `| ${c.why} | \`${c.cmd.replace(/\|/g, '\\|').slice(0, 120)}\` | ${c.exit} | ${(c.ms / 1000).toFixed(1)} s |`));
  return `${L.join('\n')}\n`;
}

export function saveProof(cwd, spec, p) {
  const dir = path.join(cwd, SPEC_DIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${spec.id}.proof.json`), `${JSON.stringify({ ...p, at: new Date().toISOString() }, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, `${spec.id}.proof.md`), proofMarkdown(spec, p));
  return path.join(SPEC_DIR, `${spec.id}.proof.md`);
}
