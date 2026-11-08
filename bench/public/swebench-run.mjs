// ox on SWE-bench Verified tasks: real issues, real repos, the model decides everything.
// Writes predictions for the SWE-bench grader (sb-cli) and one row of measurements per task.
// Nothing here grades: the hidden tests do that, in the grader's own containers.
//
//   node bench/public/swebench-run.mjs --model nvidia:minimaxai/minimax-m3.1-flash --out <dir> [--limit 2] [--jobs 2]
//
// Each task: a fresh checkout at the task's base commit, a throwaway HOME and OX_HOME, one fixed
// model with fallbacks off, a time limit. A run that crashes or times out keeps whatever patch it
// left, and is counted as run. Finished tasks are skipped on a re-run, so it can be stopped and resumed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OX = path.join(HERE, '..', '..', 'bin', 'ox.js');
const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : dflt; };
const model = arg('model');
if (!model) { console.error('--model is required: a benchmark that picks a model for you cannot be read'); process.exit(2); }
const out = path.resolve(arg('out', path.join(os.homedir(), 'ox-bench', 'run')));
const limit = Number(arg('limit', 0));
// One at a time: the meter counts per task.
const jobs = 1;
const minutes = Number(arg('minutes', 20));
const tasksFile = arg('tasks', path.join(HERE, 'tasks-50.jsonl'));
const reposDir = path.join(os.homedir(), 'ox-bench', 'repos');
fs.mkdirSync(out, { recursive: true }); fs.mkdirSync(reposDir, { recursive: true }); fs.mkdirSync(path.join(out, 'logs'), { recursive: true });

// The key goes from the keystore into this process's env only; it is never written or printed.
const env = { ...process.env };
(await import(path.join(HERE, '..', '..', 'src', 'keystore.js'))).loadKeysIntoEnv(env);

// Every model call goes through this counting proxy, so a run that is stopped still has its
// tokens counted (ox writes its own tally only when a run ends).
const UPSTREAM = process.env.SWE_UPSTREAM ?? 'https://integrate.api.nvidia.com';
const meter = { tokensIn: 0, tokensOut: 0, cached: 0, calls: 0, rateLimited: 0 };
const proxy = http.createServer((req, res) => {
  const parts = [];
  req.on('data', (d) => parts.push(d));
  req.on('end', async () => {
    let body = Buffer.concat(parts);
    try { const j = JSON.parse(body); if (j.stream) { j.stream_options = { ...(j.stream_options ?? {}), include_usage: true }; body = Buffer.from(JSON.stringify(j)); } } catch {}
    const headers = { ...req.headers }; delete headers.host; delete headers['content-length'];
    let up;
    try { up = await fetch(new URL(req.url, UPSTREAM), { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body }); }
    catch (e) { res.writeHead(502); res.end(String(e.message)); return; }
    meter.calls += 1;
    if (up.status === 429) meter.rateLimited += 1;
    res.writeHead(up.status, Object.fromEntries([...up.headers].filter(([k]) => !['content-encoding', 'content-length', 'transfer-encoding'].includes(k))));
    let tail = '';
    const take = (u) => { if (!u) return; meter.tokensIn += u.prompt_tokens ?? 0; meter.tokensOut += u.completion_tokens ?? 0; meter.cached += u.prompt_tokens_details?.cached_tokens ?? 0; };
    try {
      for await (const chunk of up.body ?? []) {
        res.write(chunk);
        tail += Buffer.from(chunk).toString('utf8');
        const lines = tail.split('\n'); tail = lines.pop();
        for (const l of lines) if (l.startsWith('data:') && l.includes('"usage"')) { try { take(JSON.parse(l.slice(5)).usage); } catch {} }
      }
      if (tail.trim().startsWith('{')) { try { take(JSON.parse(tail).usage); } catch {} }
    } catch {}
    res.end();
  });
});
await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
const PROXY = `http://127.0.0.1:${proxy.address().port}/v1`;

const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8', maxBuffer: 1 << 28, timeout: 900_000 });
const tasks = fs.readFileSync(tasksFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const resultsFile = path.join(out, 'results.jsonl');
const predsFile = path.join(out, 'predictions.jsonl');
const done = new Set(fs.existsSync(resultsFile) ? fs.readFileSync(resultsFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).instance_id) : []);
const todo = tasks.filter((t) => !done.has(t.instance_id)).slice(0, limit || undefined);

const cloning = new Map();
function mirror(repo) {
  // One blobless clone per repo, one at a time: files arrive when a checkout needs them.
  if (!cloning.has(repo)) cloning.set(repo, (async () => {
    const dir = path.join(reposDir, `${repo.replace('/', '__')}.git`);
    if (!fs.existsSync(dir)) {
      await new Promise((resolve, reject) => spawn('git', ['clone', '--quiet', '--bare', '--filter=blob:none', `https://github.com/${repo}.git`, dir], { stdio: 'ignore' }).on('close', (c) => (c === 0 ? resolve() : reject(new Error(`clone ${repo} failed`)))));
    }
    return dir;
  })());
  return cloning.get(repo);
}

const TOOLS = ['read_file', 'write_file', 'edit_file', 'list_dir', 'glob', 'grep', 'bash', 'todo_write', 'code_graph'];
const prompt = (t) => `Fix this issue in the repository in the current folder. Change the source code only; do not add or edit tests. The project's dependencies are not installed and its extensions are not built: read the code and reason about it, and do not spend time setting up an environment (a quick check with plain python on a small piece is fine). When you are done, stop: your changes are collected from the working tree.\n\n<issue>\n${t.problem_statement}\n</issue>`;
const EXCLUDE = ['.agent', '.ox', '.ox-build', '.ox-backups', '.venv', 'venv', '__pycache__', 'node_modules', 'build', '.eggs'];

async function runOne(t) {
  const started = Date.now();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-swe-home-'));
  const work = path.join(os.tmpdir(), `ox-swe-${t.instance_id}-${process.pid}`);
  let row = { instance_id: t.instance_id, repo: t.repo, model };
  try {
    const bare = await mirror(t.repo);
    // The files at the task's commit and nothing else: no later history, no remote, no tags. The
    // first pilot checked out from a full clone, and agents diffed against the fix (results void).
    fs.mkdirSync(work, { recursive: true });
    const tar = spawnSync('sh', ['-c', `git -C "${bare}" archive --format=tar ${t.base_commit} | tar -x -C "${work}"`], { encoding: 'utf8', maxBuffer: 1 << 26, timeout: 900_000 });
    if (tar.status !== 0) throw new Error(`checkout failed: ${String(tar.stderr).slice(0, 300)}`);
    for (const a of [['init', '-q'], ['add', '-A'], ['-c', 'user.name=swe', '-c', 'user.email=swe@local', 'commit', '-q', '--no-verify', '-m', 'base']]) {
      const r = git(work, ...a);
      if (r.status !== 0) throw new Error(`git ${a[0]} failed: ${r.stderr.slice(0, 200)}`);
    }
    // No web tools, and shell commands without network (macOS sandbox): the answer cannot be looked up.
    fs.mkdirSync(path.join(home, '.ox', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(home, '.ox', 'agents', 'swe.json'), JSON.stringify({ name: 'swe', mode: 'code', tools: TOOLS }));
    fs.writeFileSync(path.join(home, '.ox', 'sandbox.json'), JSON.stringify({ extends: 'workspace', restrict_network: true }));
    row.history = Number(git(work, 'rev-list', '--count', '--all').stdout.trim());
    row.remotes = git(work, 'remote').stdout.trim().split('\n').filter(Boolean).length;
    const before = { ...meter };
    const log = fs.createWriteStream(path.join(out, 'logs', `${t.instance_id}.log`));
    const code = await new Promise((resolve) => {
      const p = spawn(process.execPath, [OX, '--model', model, '--agent', 'swe', '--mode', 'code', '--sandbox', 'swe', '-y', '-p', prompt(t)], {
        cwd: work,
        env: { ...env, OX_BASE_URL: PROXY, HOME: home, OX_HOME: path.join(home, '.ox'), OX_ISLAND: '0', OX_LEARN: '0', OX_NO_KEYSTORE: '1', OX_MESH: '0', OX_NO_FAST_FALLBACK: '1', OX_NO_PLUGINS: '1', OX_NO_BUILTIN_SKILLS: '1', OX_MCP: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      p.stdout.pipe(log, { end: false }); p.stderr.pipe(log, { end: false });
      // A polite stop first, so ox writes down the tokens it used; the hard stop only if it does not go.
      let hard = null;
      const kill = setTimeout(() => { row.timedOut = true; p.kill('SIGTERM'); hard = setTimeout(() => p.kill('SIGKILL'), 20_000); }, minutes * 60_000);
      p.on('close', (c) => { clearTimeout(kill); clearTimeout(hard); resolve(c); });
    });
    log.end();
    git(work, 'add', '-A', '--', '.', ...EXCLUDE.map((x) => `:(exclude,glob)**/${x}/**`));
    const patch = git(work, 'diff', '--cached', '--no-color', 'HEAD').stdout ?? '';
    const d = (k) => meter[k] - before[k];
    row = { ...row, exit: code, seconds: Math.round((Date.now() - started) / 1000), tokensIn: d('tokensIn'), tokensOut: d('tokensOut'), cached: d('cached'), calls: d('calls'), rateLimited: d('rateLimited'), patchBytes: Buffer.byteLength(patch) };
    fs.appendFileSync(predsFile, `${JSON.stringify({ instance_id: t.instance_id, model_name_or_path: `ox@${model}`, model_patch: patch })}\n`);
  } catch (e) {
    row = { ...row, error: String(e.message).slice(0, 300), seconds: Math.round((Date.now() - started) / 1000) };
    fs.appendFileSync(predsFile, `${JSON.stringify({ instance_id: t.instance_id, model_name_or_path: `ox@${model}`, model_patch: '' })}\n`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
  fs.appendFileSync(resultsFile, `${JSON.stringify(row)}\n`);
  console.log(JSON.stringify(row));
}

let next = 0;
await Promise.all(Array.from({ length: jobs }, async () => { while (next < todo.length) await runOne(todo[next++]); }));
console.log(`done: ${todo.length} run now, ${done.size} from before; predictions in ${predsFile}`);
proxy.close();
