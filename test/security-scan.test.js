// ox-secure-ignore-file (labelled examples of vulnerable code, on purpose)
// ox secure (src/security-scan.js): the rules, the labelled sets, and the
// agent's security check after it edits files (a scripted model on loopback).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-secure-home-'));
process.env.HOME = home;
process.env.OX_API_KEY = 'test-key'; // the loopback mock below is the only provider
fs.mkdirSync(path.join(home, '.ox'), { recursive: true });

const { scanText, scanPaths, scanDiff, findingsForModel, RULES } = await import('../src/security-scan.js');
const { CASES } = await import('../bench/security/cases.mjs');
const { HOLDOUT } = await import('../bench/security/holdout.mjs');
const { runAgent } = await import('../src/agent.js');

test('every rule names a CWE, a severity, a message and a fix', () => {
  assert.ok(RULES.length >= 50);
  for (const r of RULES) {
    assert.match(r.cwe, /^CWE-\d+$/, r.id);
    assert.ok(['high', 'medium', 'low'].includes(r.sev), r.id);
    assert.ok(r.msg && r.fix, r.id);
  }
});

test('the labelled and held-out sets: every vulnerable line caught, no safe lookalike flagged', () => {
  for (const c of [...CASES, ...HOLDOUT]) {
    const found = scanText(c.f, c.code);
    if (c.cwe) assert.ok(found.some((x) => x.cwe === c.cwe || (c.cwe === 'CWE-916' && x.cwe === 'CWE-327')), `missed ${c.cwe}: ${c.code}`);
    else assert.deepEqual(found.map((x) => x.rule), [], `false alarm: ${c.code}`);
  }
});

test('comments, ignore markers, test files and secrets', () => {
  assert.equal(scanText('a.js', '// db.query(`SELECT * FROM t WHERE id = ${id}`)').length, 0);
  assert.equal(scanText('a.js', 'el.innerHTML = html // ox-secure-ignore: built from escaped parts').length, 0);
  assert.equal(scanText('a.js', '// ox-secure-ignore: escaped above\nel.innerHTML = html').length, 0);
  assert.equal(scanText('test/a.test.js', 'el.innerHTML = html')[0].severity, 'medium');
  const s = scanText('config.js', "const key = 'AKIAIOSFODNN7EXAMPLE'");
  assert.equal(s[0].cwe, 'CWE-798');
  assert.ok(!s[0].excerpt.includes('AKIA'), 'a secret is never echoed into the report');
});

test('Python tempfile.mktemp is flagged, but mkstemp is safe', () => {
  const finding = scanText('app.py', 'name = tempfile.mktemp()')[0];
  assert.equal(finding.cwe, 'CWE-377');
  assert.equal(finding.severity, 'high');
  assert.match(finding.fix, /tempfile\.mkstemp.*NamedTemporaryFile/);
  assert.equal(scanText('app.py', 'fd, name = tempfile.mkstemp()').length, 0);
});

test('--diff looks only at the lines you changed', () => {
  const dir = fs.mkdtempSync(path.join(home, 'repo-'));
  const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'old.js'), 'el.innerHTML = legacy\n');
  git('add', '.'); git('commit', '-qm', 'old');
  fs.writeFileSync(path.join(dir, 'old.js'), 'el.innerHTML = legacy\nconst q = db.query(`SELECT * FROM t WHERE id = ${id}`)\n');
  fs.writeFileSync(path.join(dir, 'new.py'), 'subprocess.call(cmd, shell=True)\n');
  const r = scanDiff({ cwd: dir });
  assert.deepEqual(r.findings.map((f) => `${f.file}:${f.line}:${f.cwe}`).sort(), ['new.py:1:CWE-78', 'old.js:2:CWE-89']);
  assert.equal(scanPaths(['.'], { cwd: dir }).findings.length, 3, 'a full scan sees the old line too');
});

test('what the model is told: high and medium only, with file, line, CWE and fix', () => {
  const note = findingsForModel(scanText('app.js', 'db.query(`SELECT * FROM users WHERE id = ${req.params.id}`)'));
  assert.match(note, /app\.js:1 CWE-89/);
  assert.match(note, /Fix: placeholders/);
  assert.equal(findingsForModel(scanText('a.js', "crypto.createHash('md5')")), '', 'low findings are not pushed at the model');
});

test('the agent is told about a vulnerability it just wrote, and fixes it', async (t) => {
  const cwd = fs.mkdtempSync(path.join(home, 'work-'));
  const bad = 'export const find = (db, id) => db.query(`SELECT * FROM users WHERE id = ${id}`)\n';
  const good = "export const find = (db, id) => db.query('SELECT * FROM users WHERE id = ?', [id])\n";
  const bodies = [];
  const sse = (o) => `data: ${JSON.stringify(o)}\n\n`;
  const call = (id, name, args) => sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] }) + 'data: [DONE]\n\n';
  const say = (text) => sse({ choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n';
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    const body = JSON.parse(raw); bodies.push(body);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const n = bodies.length;
    if (n === 1) return res.end(call('w1', 'write_file', { path: 'users.js', content: bad }));
    if (n === 2) return res.end(say('Wrote users.js.'));
    if (n === 3) return res.end(call('w2', 'write_file', { path: 'users.js', content: good }));
    return res.end(say('Fixed: the query now uses a placeholder.'));
  });
  t.after(() => { server.closeAllConnections?.(); server.close(); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const target = { provider: 'custom', model: 'mock-model', baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
  const events = [];
  for await (const e of runAgent({ target, ctx: { cwd, modelWindow: 128000, yolo: true, approval: 'yolo' }, config: { repoMap: false }, auxTarget: null, messages: [{ role: 'user', content: 'add a function to find a user by id' }] })) events.push(e);
  const told = bodies[2]?.messages?.find((m) => m.role === 'user' && /Security check/.test(String(m.content)));
  assert.ok(told, `the third request carries the security note; got ${bodies.length} requests`);
  assert.match(String(told.content), /users\.js:1 CWE-89/);
  assert.equal(fs.readFileSync(path.join(cwd, 'users.js'), 'utf8'), good, 'the model fixed it');
  assert.equal(events.filter((e) => e.type === 'security-check').length, 1, 'one round only: it cannot loop');
});

test('across lines: request input kept in a variable, SQL built then run, templates', () => {
  // NodeGoat's research page: the URL is built on one line and fetched on the next.
  const ssrf = scanText('r.js', 'const url = req.query.url + req.query.symbol;\nreturn needle.get(url, cb)');
  assert.deepEqual(ssrf.map((f) => `${f.cwe}:${f.line}`), ['CWE-918:2']);
  // Through a sanitizer it is no longer raw input (ox's own shelf upload).
  assert.equal(scanText('u.js', "const name = path.basename(String(req.headers['x-file-name']));\nfs.writeFileSync(path.join(dir, name), body)").length, 0);
  // DVNA's login: SQL built in one statement, run in the next.
  const sql = scanText('h.js', 'var query = "SELECT name FROM Users WHERE login=\'" + req.body.login + "\'";\ndb.sequelize.query(query, { model: db.User })');
  assert.ok(sql.some((f) => f.cwe === 'CWE-89' && f.line === 2), JSON.stringify(sql));
  assert.equal(scanText('h.js', 'const query = "SELECT name FROM Users WHERE login = ?";\ndb.query(query, [login])').length, 0, 'a fixed query is fine');
  // Templates that print without escaping.
  assert.equal(scanText('p.ejs', '<td><%- output.searchTerm %></td>')[0].cwe, 'CWE-79');
  assert.equal(scanText('p.ejs', '<td><%= output.searchTerm %></td>').length, 0);
  assert.equal(scanText('c.vue', '<div v-html="post.body"></div>')[0].cwe, 'CWE-79');
  // ReDoS: only a group that is nothing but a repeated item.
  assert.equal(scanText('a.js', 'const re = /([0-9]+)+#/')[0].cwe, 'CWE-1333');
  assert.equal(scanText('a.js', 'const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/').length, 0);
});
