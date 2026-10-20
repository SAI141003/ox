// ox build: from a business requirement to code that is proven to meet it.
//
// Models write a plausible snippet and miss the requirement around it. This
// pins the requirement down first, in the project's own terms, then makes the
// tests carry it:
//   1. spec: the requirement, read with a map of the project (files, scripts,
//      test framework, README), becomes numbered acceptance criteria AC-1… as
//      Given / When / Then, with constraints, what is out of scope, the files
//      likely touched and the questions it leaves open (.agent/specs/<id>.md).
//   2. tests first: one test per criterion, named with its id, seen to fail.
//   3. implement until the project's test command passes (a gate: the run
//      cannot finish while it fails), with ox's security check on what it wrote.
//   4. trace: each criterion's tests run on their own; the report says which
//      criteria pass, which fail and which have no test at all.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const SPEC_DIR = path.join('.agent', 'specs');
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', 'vendor', '.venv', 'venv', '__pycache__', 'target', '.agent', '.ox']);

// ---------------------------------------------------------------- the project
export function detectTests(cwd) {
  const has = (f) => fs.existsSync(path.join(cwd, f));
  let pkg = null;
  try { pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')); } catch {}
  if (pkg) {
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    const script = pkg.scripts?.test && !/no test specified/.test(pkg.scripts.test) ? pkg.scripts.test : null;
    if (deps.vitest || /vitest/.test(script ?? '')) return { framework: 'vitest', cmd: script ? 'npm test' : 'npx vitest run', one: (id) => ['npx', 'vitest', 'run', '-t', id] };
    if (deps.jest || /jest/.test(script ?? '')) return { framework: 'jest', cmd: script ? 'npm test' : 'npx jest', one: (id) => ['npx', 'jest', '-t', id] };
    if (deps.mocha || /mocha/.test(script ?? '')) return { framework: 'mocha', cmd: script ? 'npm test' : 'npx mocha', one: (id) => ['npx', 'mocha', '--grep', id] };
    return { framework: 'node:test', cmd: script ? 'npm test' : 'node --test', one: (id) => ['node', '--test', '--test-reporter=tap', '--test-name-pattern', id] };
  }
  if (has('pyproject.toml') || has('requirements.txt') || has('setup.py') || has('pytest.ini')) return { framework: 'pytest', cmd: 'python3 -m pytest -q', one: (id) => ['python3', '-m', 'pytest', '-q', '-k', id.replace('-', '_')] };
  if (has('go.mod')) return { framework: 'go test', cmd: 'go test ./...', one: (id) => ['go', 'test', './...', '-run', id.replace('-', '_')] };
  if (has('Cargo.toml')) return { framework: 'cargo test', cmd: 'cargo test', one: (id) => ['cargo', 'test', id.replace('-', '_').toLowerCase()] };
  return { framework: 'node:test', cmd: 'node --test', one: (id) => ['node', '--test', '--test-reporter=tap', '--test-name-pattern', id] };
}

/** A compact map of the project the model reads before writing the spec. */
export function projectContext(cwd, { maxFiles = 250 } = {}) {
  const files = [];
  const walk = (dir, depth) => {
    if (files.length >= maxFiles || depth > 6) return;
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (files.length < maxFiles) files.push(path.relative(cwd, full));
    }
  };
  walk(cwd, 0);
  let pkg = '';
  try { const p = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')); pkg = JSON.stringify({ name: p.name, type: p.type, scripts: p.scripts, dependencies: Object.keys(p.dependencies ?? {}), devDependencies: Object.keys(p.devDependencies ?? {}) }); } catch {}
  let readme = '';
  for (const n of ['README.md', 'readme.md', 'README']) { try { readme = fs.readFileSync(path.join(cwd, n), 'utf8').split('\n').slice(0, 40).join('\n'); break; } catch {} }
  const t = detectTests(cwd);
  return [`Files (${files.length}${files.length >= maxFiles ? '+' : ''}):\n${files.join('\n')}`, pkg && `package.json: ${pkg}`, `Tests: ${t.framework} (${t.cmd})`, readme && `README (start):\n${readme}`].filter(Boolean).join('\n\n');
}

// ---------------------------------------------------------------- the spec
export const SPEC_SYSTEM = `You turn a business requirement into a precise, testable specification for THIS project. Read the project map; use its language, layout and test framework. Answer with ONE JSON object and nothing else:
{"title": string, "summary": string (one or two sentences: what changes for the user),
 "acceptance": [{"id": "AC-1", "given": string, "when": string, "then": string}, ...] (every behaviour the requirement asks for, including error cases and edge cases it implies; each one checkable by an automated test),
 "constraints": [string] (rules the solution must respect: data, security, performance, compatibility),
 "outOfScope": [string], "files": [string] (existing files likely to change, from the map),
 "questions": [string] (what the requirement leaves open; for each, the assumption you made)}`;

export function parseSpec(text) {
  const raw = String(text ?? '');
  const start = raw.indexOf('{'); const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('the model did not return a JSON spec');
  let j;
  try { j = JSON.parse(raw.slice(start, end + 1)); } catch (e) { throw new Error(`the spec is not valid JSON: ${e.message}`); }
  const acceptance = (Array.isArray(j.acceptance) ? j.acceptance : []).map((a, i) => ({
    id: /^AC-\d+$/.test(String(a?.id)) ? String(a.id) : `AC-${i + 1}`,
    given: String(a?.given ?? '').trim(), when: String(a?.when ?? '').trim(), then: String(a?.then ?? '').trim(),
  })).filter((a) => a.then);
  if (!acceptance.length) throw new Error('the spec has no acceptance criteria');
  const list = (v) => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);
  return { title: String(j.title ?? 'Untitled').slice(0, 120), summary: String(j.summary ?? '').slice(0, 600), acceptance, constraints: list(j.constraints), outOfScope: list(j.outOfScope), files: list(j.files), questions: list(j.questions) };
}

export function specMarkdown(spec) {
  const ac = spec.acceptance.map((a) => `- **${a.id}** Given ${a.given || '…'}, when ${a.when || '…'}, then ${a.then}`).join('\n');
  const sec = (h, l) => (l.length ? `\n## ${h}\n${l.map((x) => `- ${x}`).join('\n')}\n` : '');
  return `# ${spec.title}\n\n${spec.summary}\n\nRequirement: ${spec.requirement ?? ''}\n\n## Acceptance criteria\n${ac}\n${sec('Constraints', spec.constraints)}${sec('Out of scope', spec.outOfScope)}${sec('Files likely to change', spec.files)}${sec('Open questions (and the assumption made)', spec.questions)}`;
}

export function saveSpec(cwd, spec) {
  const dir = path.join(cwd, SPEC_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const id = spec.id ?? `${new Date().toISOString().slice(0, 10)}-${spec.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'spec'}`;
  const full = { ...spec, id, createdAt: spec.createdAt ?? new Date().toISOString() };
  fs.writeFileSync(path.join(dir, `${id}.json`), `${JSON.stringify(full, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, `${id}.md`), specMarkdown(full));
  return full;
}

export function loadSpec(cwd, id = null) {
  const dir = path.join(cwd, SPEC_DIR);
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !/\.(?:lock|proof)\.json$/.test(f)); } catch { return null; }
  if (!names.length) return null;
  const pick = id ? names.find((n) => n.startsWith(id)) : names.map((n) => ({ n, t: fs.statSync(path.join(dir, n)).mtimeMs })).sort((a, b) => b.t - a.t)[0].n;
  if (!pick) return null;
  try { return JSON.parse(fs.readFileSync(path.join(dir, pick), 'utf8')); } catch { return null; }
}

/** The instructions the agent works from, and the contract its run must meet. */
export function buildBrief(spec, tests) {
  const ac = spec.acceptance.map((a) => `${a.id}: Given ${a.given || '…'}, when ${a.when || '…'}, then ${a.then}`).join('\n');
  const brief = `Build this, test first. The spec is .agent/specs/${spec.id}.md.

${spec.title}: ${spec.summary}

Acceptance criteria:
${ac}
${spec.constraints.length ? `\nConstraints:\n${spec.constraints.map((c) => `- ${c}`).join('\n')}\n` : ''}${spec.outOfScope.length ? `\nOut of scope (do not build):\n${spec.outOfScope.map((c) => `- ${c}`).join('\n')}\n` : ''}${spec.files.length ? `\nLikely files: ${spec.files.join(', ')}\n` : ''}
Steps, in order:
1. Read the files involved before changing anything.
2. Write the tests first, with ${tests.framework}: at least one test per criterion, and put the criterion's id in the test's name (for example "${spec.acceptance[0].id}: ${spec.acceptance[0].then.slice(0, 40)}").
3. Run ${tests.cmd} and check that the new tests fail for the right reason.
4. Implement, in the project's existing style, until ${tests.cmd} passes. Do not weaken or delete a test to make it pass.
5. Run ${tests.cmd} once more and say which criteria pass.`;
  return { brief, contract: { outcome: spec.summary || spec.title, verification: `gate: ${tests.cmd}` } };
}

/**
 * The same work in two runs, so the tests can be locked in between
 * (src/build-proof.js): first the tests only, then the code with the tests locked.
 */
export function buildBriefs(spec, tests) {
  const ac = spec.acceptance.map((a) => `${a.id}: Given ${a.given || '…'}, when ${a.when || '…'}, then ${a.then}`).join('\n');
  const head = `The spec is .agent/specs/${spec.id}.md.\n\n${spec.title}: ${spec.summary}\n\nAcceptance criteria:\n${ac}\n${spec.constraints.length ? `\nConstraints:\n${spec.constraints.map((c) => `- ${c}`).join('\n')}\n` : ''}${spec.outOfScope.length ? `\nOut of scope (do not build):\n${spec.outOfScope.map((c) => `- ${c}`).join('\n')}\n` : ''}${spec.files.length ? `\nLikely files: ${spec.files.join(', ')}\n` : ''}`;
  const testsFirst = `Step 1 of 2: write the TESTS only. ${head}
1. Read the files involved.
2. With ${tests.framework}, write at least one test per criterion, with the criterion's id in the test's name (for example "${spec.acceptance[0].id}: ${spec.acceptance[0].then.slice(0, 40)}"). Test real behaviour through the public interface, including the error and edge cases the criteria imply.
3. Do NOT implement the feature and do not change non-test files, except the smallest stubs the tests need to load (an exported function that throws "not implemented").
4. Run ${tests.cmd} and check the new tests fail for the right reason. Then stop.`;
  const code = `Step 2 of 2: implement. ${head}
The tests for these criteria are written and LOCKED: ox hashed them. Editing or deleting a locked test, adding skip / only / xfail, removing an assertion or changing the test command makes the build fail its proof. If a test is truly wrong, stop and say which and why instead of changing it.
1. Read the tests and the files involved.
2. Implement in the project's existing style until ${tests.cmd} passes. You may add new tests.
3. Run ${tests.cmd} once more and say which criteria pass. ox will then run held-out tests you have not seen and try small breaks in your code to check the tests catch them.`;
  return { testsFirst, code, contract: { outcome: spec.summary || spec.title, verification: `gate: ${tests.cmd}` } };
}

// ---------------------------------------------------------------- the trace
export function testFiles(cwd) {
  const out = [];
  const walk = (dir) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/(?:^|[._-])(?:test|spec)s?\.[cm]?[jt]sx?$|^test_.*\.py$|_test\.(?:py|go)$/.test(e.name) || /[\\/](?:test|tests|__tests__)[\\/]/.test(full)) out.push(full);
    }
  };
  walk(cwd);
  return out;
}

/**
 * Each criterion: the test files that name it, and whether its tests pass when
 * run on their own. Returns { rows: [{ id, then, files, status }], passed, failed, missing }.
 */
export function traceSpec(cwd, spec, { tests = detectTests(cwd), run = true, timeoutMs = 120_000 } = {}) {
  const files = testFiles(cwd).map((f) => ({ f, text: (() => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } })() }));
  const rows = [];
  for (const a of spec.acceptance) {
    const idRe = new RegExp(`\\b${a.id.replace('-', '[-_]')}\\b`, 'i');
    const named = files.filter((x) => idRe.test(x.text)).map((x) => path.relative(cwd, x.f));
    let status = named.length ? 'untested' : 'no test';
    let detail = '';
    if (named.length && run) {
      const [cmd, ...args] = tests.one(a.id);
      // A test runner inside a test runner reports to its parent and exits 0
      // (NODE_TEST_CONTEXT): the criterion's run must be a run of its own.
      const env = { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' };
      delete env.NODE_TEST_CONTEXT;
      const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: timeoutMs, env });
      const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
      // node:test's own count, not only the exit code: a pattern that matched
      // nothing is not a pass, and a failure is a failure whatever the exit says.
      const ran = /^# tests (\d+)/m.exec(out);
      const failedN = /^# fail (\d+)/m.exec(out);
      if (tests.framework === 'node:test' && ran && Number(ran[1]) === 0) status = 'no test ran';
      else if (tests.framework === 'node:test' && failedN) status = Number(failedN[1]) > 0 ? 'fails' : 'passes';
      else status = r.status === 0 ? 'passes' : 'fails';
      detail = out.trim().split('\n').filter((l) => /fail|error|expected|assert/i.test(l)).slice(0, 3).join(' | ').slice(0, 300);
    }
    rows.push({ id: a.id, then: a.then, files: named, status, detail });
  }
  return { rows, passed: rows.filter((r) => r.status === 'passes').length, failed: rows.filter((r) => r.status === 'fails' || r.status === 'no test ran').length, missing: rows.filter((r) => r.status === 'no test').length };
}

export function formatTrace(spec, t) {
  const mark = { passes: '✓', fails: '✗', 'no test': '·', 'no test ran': '✗', untested: '?' };
  const lines = t.rows.map((r) => `${mark[r.status] ?? '?'} ${r.id.padEnd(5)} ${r.status.padEnd(11)} ${r.then.slice(0, 70)}${r.files.length ? `  (${r.files.join(', ')})` : ''}${r.detail && r.status !== 'passes' ? `\n        ${r.detail}` : ''}`);
  return `${spec.title} (${spec.id})\n${lines.join('\n')}\n\n${t.passed}/${t.rows.length} criteria proven by a passing test${t.failed ? `, ${t.failed} failing` : ''}${t.missing ? `, ${t.missing} with no test` : ''}`;
}
