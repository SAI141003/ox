// ox port: move a project to another language without losing what it touches.
//
// A model translates a file well and a project badly: what breaks is outside
// the code it is looking at (Professor Anitha: "external factors linked to run
// smoothly"): environment variables, config and data files, network
// endpoints and ports, shell commands, databases, native modules, build and CI
// scripts, and the order modules depend on each other. So the port is driven
// by an inventory made without a model, and checked against it:
//   1. inventory: modules, their imports (an order: leaves first), the
//      libraries they use, and every external factor found in the code;
//   2. plan (.agent/port/plan.json): module by module in that order, resumable;
//   3. each module is ported and its behaviour checked (the original's tests,
//      run in the new language) before the next one starts;
//   4. every external factor must be accounted for in the port: the check
//      lists the ones the new code no longer mentions.
import fs from 'node:fs';
import path from 'node:path';
import { builtinModules } from 'node:module';

// The runtime's own modules are not libraries to replace (Node's fs, Python's os…).
const BUILTIN = new Set([...builtinModules, 'os', 'sys', 're', 'json', 'math', 'time', 'datetime', 'typing', 'collections', 'itertools', 'functools', 'pathlib', 'subprocess', 'logging', 'unittest', 'dataclasses', 'random', 'hashlib', 'base64', 'string', 'io', 'abc', 'enum', 'copy', 'decimal', 'fmt', 'strings', 'errors', 'net/http', 'encoding/json', 'testing', 'context', 'sync', 'java.util', 'java.io']);

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', 'vendor', '.venv', 'venv', '__pycache__', 'target', '.agent', '.ox', 'out']);
export const LANGS = {
  js: { exts: ['.js', '.mjs', '.cjs', '.jsx'], name: 'JavaScript' },
  ts: { exts: ['.ts', '.tsx'], name: 'TypeScript' },
  py: { exts: ['.py'], name: 'Python' },
  go: { exts: ['.go'], name: 'Go' },
  rs: { exts: ['.rs'], name: 'Rust' },
  java: { exts: ['.java'], name: 'Java' },
  rb: { exts: ['.rb'], name: 'Ruby' },
};
const langOf = (f) => Object.entries(LANGS).find(([, v]) => v.exts.includes(path.extname(f).toLowerCase()))?.[0] ?? null;
const isTest = (f) => /(?:^|[/\\])(?:test|tests|__tests__|spec)[/\\]|[._-](?:test|spec)\.[a-z]+$|^test_|_test\.(?:py|go)$/i.test(f);

// What a module reaches outside itself, by kind. Each pattern captures the name.
const FACTORS = [
  { kind: 'env', re: /process\.env\.([A-Z_][A-Z0-9_]*)|process\.env\[['"]([A-Z_][A-Z0-9_]*)['"]\]|os\.(?:environ\.get|getenv)\(\s*['"]([A-Z_][A-Z0-9_]*)['"]|os\.environ\[['"]([A-Z_][A-Z0-9_]*)['"]\]|os\.Getenv\("([A-Z_][A-Z0-9_]*)"\)|System\.getenv\("([A-Z_][A-Z0-9_]*)"\)|ENV\[['"]([A-Z_][A-Z0-9_]*)['"]\]|std::env::var\("([A-Z_][A-Z0-9_]*)"\)/g },
  { kind: 'file', re: /(?:readFile(?:Sync)?|writeFile(?:Sync)?|createReadStream|createWriteStream|open|os\.Open|os\.ReadFile|File\.read|Path)\(\s*['"`]([^'"`\n${}]{2,120})['"`]/g },
  { kind: 'file', re: /['"`]((?:\.{0,2}\/)?(?:[\w.-]+\/)*[\w.-]+\.(?:json|csv|tsv|ya?ml|txt|db|sqlite3?|log|xml|env|ini|toml|pem|key|crt|parquet))['"`]/g },
  { kind: 'url', re: /['"`](https?:\/\/[^'"`\s${}]{4,200})['"`]/g },
  { kind: 'port', re: /\.listen\(\s*(\d{2,5})|port\s*[:=]\s*(\d{2,5})\b|:(\d{4,5})['"`]/gi },
  { kind: 'command', re: /(?:exec|execSync|execFile|execFileSync|spawn|spawnSync)\(\s*['"`]([\w./-]+)|subprocess\.\w+\(\s*\[?\s*['"]([\w./-]+)|os\.system\(\s*f?['"]([\w./-]+)|exec\.Command\("([\w./-]+)"/g },
  { kind: 'database', re: /\b(mongodb|mongoose|postgres|pg|mysql2?|sqlite3?|better-sqlite3|redis|ioredis|prisma|sequelize|typeorm|knex|psycopg2?|sqlalchemy|pymongo|database\/sql|gorm|jdbc)\b/gi },
  { kind: 'native', re: /require\(\s*['"]([^'"]+\.node)['"]\)|\b(ffi-napi|node-gyp|bindings|ctypes|cffi|cgo)\b/g },
];

function walk(root) {
  const out = [];
  const go = (dir) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name.startsWith('.') && e.name !== '.env.example') continue;
      if (SKIP.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) go(full); else out.push(full);
    }
  };
  go(root);
  return out;
}

// Imports of one module: local ones become graph edges, the rest are libraries.
function importsOf(text, lang) {
  const specs = [];
  const add = (s) => s && specs.push(s);
  let m;
  if (lang === 'js' || lang === 'ts') {
    const re = /(?:import\s[^'"]*?from\s*|import\s*\(\s*|require\(\s*|export\s[^'"]*?from\s*)['"]([^'"]+)['"]/g;
    while ((m = re.exec(text))) add(m[1]);
    const bare = /^\s*import\s+['"]([^'"]+)['"]/gm;
    while ((m = bare.exec(text))) add(m[1]);
  } else if (lang === 'py') {
    const re = /^\s*(?:from\s+(\.*[\w.]*)\s+import|import\s+([\w.]+))/gm;
    while ((m = re.exec(text))) add(m[1] ?? m[2]);
  } else if (lang === 'go') {
    const re = /^\s*(?:import\s+)?"([^"]+)"/gm;
    while ((m = re.exec(text))) add(m[1]);
  } else if (lang === 'rb') {
    const re = /^\s*require(?:_relative)?\s+['"]([^'"]+)['"]/gm;
    while ((m = re.exec(text))) add(m[1]);
  } else if (lang === 'java') {
    const re = /^\s*import\s+([\w.]+)/gm;
    while ((m = re.exec(text))) add(m[1]);
  }
  return specs;
}

function resolveLocal(fromFile, spec, lang, byRel, root) {
  if (lang === 'js' || lang === 'ts') {
    if (!spec.startsWith('.')) return null;
    const base = path.resolve(path.dirname(fromFile), spec);
    for (const cand of [base, ...['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'].map((e) => base + e), ...['index.js', 'index.ts'].map((i) => path.join(base, i))]) {
      const rel = path.relative(root, cand);
      if (byRel.has(rel)) return rel;
    }
    return null;
  }
  if (lang === 'py') {
    const dots = /^\.+/.exec(spec)?.[0].length ?? 0;
    const name = spec.slice(dots).replace(/\./g, '/');
    const bases = dots ? [path.resolve(path.dirname(fromFile), ...Array(dots - 1).fill('..'))] : [root, path.dirname(fromFile)];
    for (const b of bases) for (const cand of [path.join(b, `${name}.py`), path.join(b, name, '__init__.py')]) {
      const rel = path.relative(root, cand);
      if (byRel.has(rel)) return rel;
    }
    return null;
  }
  if (lang === 'rb') {
    const cand = path.relative(root, path.resolve(path.dirname(fromFile), spec.endsWith('.rb') ? spec : `${spec}.rb`));
    return byRel.has(cand) ? cand : null;
  }
  return null;
}

/** The inventory: modules, edges, libraries, external factors, and an order (leaves first). */
export function inventory(root, { maxFiles = 3000 } = {}) {
  root = path.resolve(root);
  const all = walk(root).slice(0, maxFiles);
  const code = all.filter((f) => langOf(f));
  const counts = {};
  for (const f of code) counts[langOf(f)] = (counts[langOf(f)] ?? 0) + 1;
  const lang = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const byRel = new Map(code.map((f) => [path.relative(root, f), f]));
  const modules = [];
  const libraries = new Map();
  const factors = new Map(); // `${kind}:${name}` → { kind, name, where: [] }
  for (const [rel, abs] of byRel) {
    let text = '';
    try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    const l = langOf(abs);
    const deps = [];
    for (const spec of importsOf(text, l)) {
      const local = resolveLocal(abs, spec, l, byRel, root);
      if (local) deps.push(local);
      else if (!spec.startsWith('.') && !spec.startsWith('node:')) {
        const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : l === 'go' ? spec : spec.split(/[/.]/)[0];
        if (BUILTIN.has(name) || BUILTIN.has(spec)) continue;
        if (!libraries.has(name)) libraries.set(name, new Set());
        libraries.get(name).add(rel);
      }
    }
    // What the running program depends on: a path used only in a test is not one.
    for (const { kind, re } of isTest(rel) ? [] : FACTORS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text))) {
        const name = m.slice(1).find(Boolean);
        if (!name) continue;
        const key = `${kind}:${kind === 'database' ? name.toLowerCase() : name}`;
        if (!factors.has(key)) factors.set(key, { kind, name: kind === 'database' ? name.toLowerCase() : name, where: [] });
        const w = factors.get(key).where;
        if (!w.includes(rel)) w.push(rel);
      }
    }
    modules.push({ file: rel, lang: l, lines: text.split('\n').length, test: isTest(rel), deps: [...new Set(deps)] });
  }
  // Project-level factors: manifests, env files, containers, CI.
  for (const f of all) {
    const rel = path.relative(root, f);
    const base = path.basename(f);
    if (/^(?:package\.json|requirements.*\.txt|pyproject\.toml|go\.mod|Cargo\.toml|Gemfile|pom\.xml|build\.gradle)$/.test(base)) factors.set(`manifest:${rel}`, { kind: 'manifest', name: rel, where: [rel] });
    if (/^\.env\.example$|^Dockerfile|^docker-compose|\.ya?ml$/.test(base) && !rel.includes('node_modules')) factors.set(`config:${rel}`, { kind: 'config', name: rel, where: [rel] });
    if (/(?:^|\/)\.github\/workflows\//.test(rel)) factors.set(`ci:${rel}`, { kind: 'ci', name: rel, where: [rel] });
  }
  return { root, lang, counts, modules, order: topoOrder(modules), libraries: [...libraries].map(([name, used]) => ({ name, usedBy: [...used] })).sort((a, b) => b.usedBy.length - a.usedBy.length), factors: [...factors.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)) };
}

/** Leaves first: a module comes after everything it imports. Cycles are kept together. */
export function topoOrder(modules) {
  const deps = new Map(modules.map((m) => [m.file, m.deps.filter((d) => d !== m.file)]));
  const done = new Set();
  const order = [];
  const visiting = new Set();
  const visit = (f) => {
    if (done.has(f) || !deps.has(f)) return;
    if (visiting.has(f)) return; // a cycle: the rest of it follows
    visiting.add(f);
    for (const d of deps.get(f)) visit(d);
    visiting.delete(f);
    done.add(f);
    order.push(f);
  };
  for (const m of [...modules].sort((a, b) => a.file.localeCompare(b.file))) if (!m.test) visit(m.file);
  return order;
}

export function formatInventory(inv) {
  const byKind = {};
  for (const f of inv.factors) (byKind[f.kind] ??= []).push(f);
  const src = inv.modules.filter((m) => !m.test);
  const tests = inv.modules.filter((m) => m.test);
  const kinds = ['env', 'file', 'url', 'port', 'command', 'database', 'native', 'manifest', 'config', 'ci'];
  const label = { env: 'environment variables', file: 'files read or written', url: 'network endpoints', port: 'ports', command: 'shell commands', database: 'databases', native: 'native modules', manifest: 'dependency manifests', config: 'config / containers', ci: 'CI workflows' };
  const lines = [
    `${inv.root}`,
    `${LANGS[inv.lang]?.name ?? '?'}: ${src.length} modules (${src.reduce((a, m) => a + m.lines, 0)} lines), ${tests.length} test files`,
    `\norder (leaves first): ${inv.order.slice(0, 30).join(' → ')}${inv.order.length > 30 ? ` … (${inv.order.length})` : ''}`,
    `\nlibraries (${inv.libraries.length}): ${inv.libraries.slice(0, 25).map((l) => `${l.name} ×${l.usedBy.length}`).join(', ')}`,
    '\nexternal factors (each must exist in the port):',
    ...kinds.filter((k) => byKind[k]).map((k) => `  ${label[k]} (${byKind[k].length}): ${byKind[k].slice(0, 12).map((f) => f.name).join(', ')}${byKind[k].length > 12 ? ', …' : ''}`),
  ];
  return lines.join('\n');
}

/** The external factors the ported code no longer mentions anywhere. */
export function factorsMissing(inv, portRoot) {
  const texts = walk(path.resolve(portRoot)).filter((f) => langOf(f) || /\.(?:toml|txt|json|ya?ml|cfg|ini|env|example|md)$|Dockerfile/.test(f)).map((f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } }).join('\n');
  return inv.factors.filter((f) => ['env', 'file', 'url', 'port', 'command'].includes(f.kind) && !texts.includes(f.name));
}

// ---------------------------------------------------------------- the plan
const PLAN = (root) => path.join(root, '.agent', 'port', 'plan.json');
export function makePlan(inv, { to, out }) {
  return {
    from: inv.lang, to, source: inv.root, out: path.resolve(out),
    createdAt: new Date().toISOString(),
    steps: inv.order.map((file) => ({ file, status: 'todo' })),
    libraries: inv.libraries.map((l) => l.name),
    factors: inv.factors.map((f) => ({ kind: f.kind, name: f.name })),
  };
}
export function savePlan(plan) {
  const p = PLAN(plan.source);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(plan, null, 2)}\n`);
  return p;
}
export function loadPlan(root) {
  try { return JSON.parse(fs.readFileSync(PLAN(path.resolve(root)), 'utf8')); } catch { return null; }
}

/** The brief for one module: what it is, what it uses, what must stay true. */
export function moduleBrief(inv, plan, step, { testCmd }) {
  const m = inv.modules.find((x) => x.file === step.file);
  const facts = inv.factors.filter((f) => f.where.includes(step.file));
  const done = plan.steps.filter((s) => s.status === 'done').map((s) => s.file);
  const tests = inv.modules.filter((x) => x.test && x.deps.includes(step.file)).map((x) => x.file);
  return `Port ${step.file} from ${LANGS[plan.from]?.name} to ${LANGS[plan.to]?.name}, into ${plan.out}.
Source project: ${plan.source} (read ${step.file}${tests.length ? ` and its tests: ${tests.join(', ')}` : ''}).
It imports: ${m?.deps.length ? m.deps.join(', ') : 'nothing local'}.${done.length ? ` Already ported (use them, do not redo): ${done.join(', ')}.` : ''}
${facts.length ? `It touches, and the port must keep (same names, same behaviour): ${facts.map((f) => `${f.kind} ${f.name}`).join('; ')}.` : 'It touches nothing outside the code.'}
Libraries: use the ${LANGS[plan.to]?.name} equivalent of each one it uses, the standard library first; add it to the project's dependency file.
Port its tests too (same cases, same expected values) and run ${testCmd} until they pass. Keep the module's public names (in ${LANGS[plan.to]?.name} style) and its behaviour exactly, including errors and edge cases. Say what, if anything, could not be kept the same.`;
}
