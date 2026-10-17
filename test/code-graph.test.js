import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildGraph, extractFile, explainNode, shortestPath, queryGraph, godNodes, writeGraph, loadGraph, graphReport, graphHtml, detectCommunities } from '../src/code-graph.js';
import { codeGraphTool } from '../src/tools/code-graph.js';
import { classifyTool } from '../src/resource-class.js';
import { narrowToolSchemas, listToolSchemas } from '../src/tools/index.js';

function project(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-graph-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), text);
  }
  return dir;
}

const JS = {
  'src/db.js': `// WHY: one pool for the whole process, opened lazily\nexport function connect(url) {\n  return open(url);\n}\nfunction open(url) {\n  return { url };\n}\nexport class Store {\n  get(key) {\n    return this.read(key);\n  }\n  read(key) {\n    return key;\n  }\n}\n`,
  'src/api.js': `import { connect, Store } from './db.js';\nimport express from 'express';\nexport async function handler(req) {\n  const db = connect(process.env.DB);\n  const s = new Store();\n  path.resolve('x');\n  return s.get(req.id);\n}\n`,
  'src/server.js': `const { handler } = require('./api.js');\nfunction main() {\n  handler({ id: 1 });\n}\nmain();\n`,
};

test('extractFile: JS declarations, their extent, imports, calls and the function each call is in', () => {
  const x = extractFile('src/db.js', JS['src/db.js']);
  const names = x.symbols.map((s) => `${s.kind}:${s.parent ? `${s.parent}.` : ''}${s.name}`);
  assert.deepEqual(names, ['function:connect', 'function:open', 'class:Store', 'method:Store.get', 'method:Store.read']);
  const connect = x.symbols.find((s) => s.name === 'connect');
  assert.equal(connect.line, 2);
  assert.equal(connect.end, 4);
  assert.ok(x.calls.some((c) => c.name === 'open' && c.from === 'connect'));
  assert.ok(x.calls.some((c) => c.name === 'read' && c.from === 'get' && c.self));
  assert.equal(x.notes[0].tag, 'WHY');
  assert.equal(x.notes[0].about, 'connect');
  const api = extractFile('src/api.js', JS['src/api.js']);
  assert.deepEqual(api.imports.map((i) => [i.spec, i.names]), [['./db.js', ['connect', 'Store']], ['express', ['express']]]);
});

test('extractFile: Python by indentation, and code in strings or comments is not code', () => {
  const x = extractFile('app/models.py', 'from .db import session\n\nclass User:\n    def save(self):\n        session.add(self)\n        return validate(self)\n\ndef validate(u):\n    # not_a_call(here)\n    s = "fake_call(x)"\n    return True\n');
  assert.deepEqual(x.symbols.map((s) => `${s.kind}:${s.name}`), ['class:User', 'method:save', 'function:validate']);
  assert.equal(x.symbols.find((s) => s.name === 'save').end, 6);
  assert.ok(x.calls.some((c) => c.name === 'validate' && c.from === 'save'));
  assert.ok(!x.calls.some((c) => c.name === 'not_a_call' || c.name === 'fake_call'));
  assert.deepEqual(x.imports[0], { spec: '.db', names: ['session'], line: 1 });
});

test('buildGraph: imports and calls across files, each tagged with how it was found', (t) => {
  const g = buildGraph(project(t, JS));
  const edge = (from, to, rel) => g.edges.find((e) => e.from === from && e.to === to && e.relation === rel);
  assert.equal(edge('file:src/api.js', 'file:src/db.js', 'imports').confidence, 'EXTRACTED');
  assert.equal(edge('src/api.js#handler', 'src/db.js#connect', 'calls').confidence, 'EXTRACTED', 'imported by name');
  assert.equal(edge('src/db.js#connect', 'src/db.js#open', 'calls').confidence, 'EXTRACTED', 'same file');
  assert.equal(edge('src/db.js#Store.get', 'src/db.js#Store.read', 'calls').confidence, 'INFERRED', 'this.read()');
  assert.ok(edge('src/server.js#main', 'src/api.js#handler', 'calls'), 'require() binds the name too');
  // `path.resolve()` is not a call to anything in this project.
  assert.ok(!g.edges.some((e) => e.relation === 'calls' && /resolve/.test(e.to)));
  assert.deepEqual(g.libraries.map((l) => l.name), ['express']);
  assert.ok(g.nodes.some((n) => n.kind === 'note' && n.tag === 'WHY'));
});

test('a name defined in two files and not imported is left out, not guessed', (t) => {
  const g = buildGraph(project(t, { 'a.js': 'export function load() {\n  return 1;\n}\n', 'b.js': 'export function load() {\n  return 2;\n}\n', 'c.js': 'function go() {\n  load();\n}\n' }));
  assert.equal(g.edges.filter((e) => e.relation === 'calls').length, 0);
});

test('explain, path and query answer from the graph', (t) => {
  const g = buildGraph(project(t, JS));
  const ex = explainNode(g, 'connect');
  assert.equal(ex.found, true);
  assert.match(ex.text, /connect\s+\(function, src\/db\.js:2-4\)/);
  assert.match(ex.text, /<-- handler \[calls\] \[EXTRACTED\]/);
  const p = shortestPath(g, 'main', 'open');
  assert.equal(p.found, true);
  assert.deepEqual(p.path.map((n) => n.name), ['main', 'handler', 'connect', 'open']);
  assert.equal(shortestPath(g, 'open', 'main', { directed: true }).found, false, 'calls only go one way');
  const q = queryGraph(g, 'how does the store read a key');
  assert.ok(q.seeds.slice(0, 3).some((n) => /Store/.test(n.name)));
  assert.equal(explainNode(g, 'nothingLikeThis').found, false);
});

test('update re-reads only the files that changed, and gives the same graph', (t) => {
  const dir = project(t, JS);
  const first = writeGraph(dir).graph;
  fs.appendFileSync(path.join(dir, 'src/server.js'), 'function extra() {\n  main();\n}\n');
  const second = writeGraph(dir, { update: true }).graph;
  assert.equal(second.stats.reused, 2);
  assert.ok(second.nodes.some((n) => n.id === 'src/server.js#extra'));
  assert.equal(second.edges.length, first.edges.length + 2, 'defines + calls for the new function');
  assert.ok(loadGraph(dir));
  for (const f of ['graph.json', 'GRAPH_REPORT.md', 'graph.html']) assert.ok(fs.existsSync(path.join(dir, '.agent', 'graph', f)), f);
});

test('communities are deterministic and the report and page are self-contained', (t) => {
  const g = buildGraph(project(t, JS));
  const again = detectCommunities(g.nodes, g.edges);
  assert.deepEqual(again.list, g.communities);
  assert.ok(godNodes(g, 1)[0]);
  const report = graphReport(g);
  assert.match(report, /## What everything flows through/);
  assert.match(report, /WHY: one pool/);
  const html = graphHtml(g);
  assert.ok(!/<script[^>]+src=/.test(html) && !/<link[^>]+href=/.test(html), 'no external scripts or styles');
  assert.ok(!html.includes('</script><script>alert'), 'names are escaped into JSON');
});

test('the code_graph tool: a read-only tool, offered when a message is about structure', async (t) => {
  const dir = project(t, JS);
  const r = await codeGraphTool({ action: 'explain', target: 'handler' }, { cwd: dir });
  assert.match(r.content, /handler/);
  assert.match(r.content, /--> connect \[calls\] \[EXTRACTED\]/);
  const p = await codeGraphTool({ action: 'path', target: 'main', to: 'open' }, { cwd: dir });
  assert.match(p.content, /3 hops/);
  assert.equal((await codeGraphTool({ action: 'explain' }, { cwd: dir })).isError, true);
  assert.equal(classifyTool('code_graph'), 'pure_read');
  const all = listToolSchemas({});
  assert.ok(all.some((s) => s.name === 'code_graph'));
  const offered = (m) => narrowToolSchemas(all, { message: m }).map((s) => s.name);
  assert.ok(offered('what calls runAgentLoop and what depends on it?').includes('code_graph'));
  assert.ok(!offered('fix the typo in the README').includes('code_graph'));
});

test('graph.html lays out: its own script, run with a stand-in canvas, keeps every node on screen', async (t) => {
  const vm = await import('node:vm');
  // Big enough for an unstable layout to blow up (the first version did, at 1,500 nodes).
  const files = {};
  for (let i = 0; i < 60; i++) {
    const fns = Array.from({ length: 5 }, (_, k) => `export function f${i}_${k}() {\n  hub(); return ${k ? `f${i}_${k - 1}()` : i ? `g${i}()` : '0'};\n}\n`).join('');
    files[`m${i}.js`] = `import { hub } from './hub.js';\n${i ? `import { f${i - 1}_4 as g${i} } from './m${i - 1}.js';\n` : ''}${fns}`;
  }
  files['hub.js'] = 'export function hub() {\n  return 1;\n}\n';
  const g = buildGraph(project(t, files));
  assert.ok(g.nodes.length > 300, `${g.nodes.length} nodes`);
  const html = graphHtml(g);
  const script = /<script>([\s\S]*)<\/script>/.exec(html)[1];
  const el = () => ({ style: {}, set textContent(v) {}, set innerHTML(v) {}, querySelector: () => el(), append() {}, set oninput(f) {}, set onmousedown(f) {}, set onwheel(f) {} });
  const ctx2d = new Proxy({}, { get: (o, k) => (k in o ? o[k] : () => {}), set: (o, k, v) => { o[k] = v; return true; } });
  const frames = [];
  const sandbox = {
    document: { getElementById: (id) => (id === 'c' ? { ...el(), getContext: () => ctx2d } : el()), createElement: el, body: {} },
    getComputedStyle: () => ({ getPropertyValue: () => '#000' }),
    addEventListener() {}, requestAnimationFrame: (f) => frames.push(f), innerWidth: 800, innerHeight: 600, devicePixelRatio: 1, Math, JSON, Map, Set,
  };
  vm.runInNewContext(`${script};globalThis.__N=N;`, sandbox);
  for (let i = 0; i < 300 && frames.length; i++) frames.shift()();
  assert.ok(sandbox.__N.length > 0);
  for (const n of sandbox.__N) assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y) && Math.abs(n.x) < 5000 && Math.abs(n.y) < 5000, `${n.n} at ${n.x},${n.y}`);
});
