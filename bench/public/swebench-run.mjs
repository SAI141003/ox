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
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OX = path.join(HERE, '..', '..', 'bin', 'ox.js');
const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : dflt; };
const model = arg('model');
if (!model) { console.error('--model is required: a benchmark that picks a model for you cannot be read'); process.exit(2); }
const out = path.resolve(arg('out', path.join(os.homedir(), 'ox-bench', 'run')));
const limit = Number(arg('limit', 0));
const jobs = Number(arg('jobs', 1));
const minutes = Number(arg('minutes', 20));
const tasksFile = arg('tasks', path.join(HERE, 'tasks-50.jsonl'));
const reposDir = path.join(os.homedir(), 'ox-bench', 'repos');
fs.mkdirSync(out, { recursive: true }); fs.mkdirSync(reposDir, { recursive: true }); fs.mkdirSync(path.join(out, 'logs'), { recursive: true });

// The key goes from the keystore into this process's env only; it is never written or printed.
const env = { ...process.env };
(await import(path.join(HERE, '..', '..', 'src', 'keystore.js'))).loadKeysIntoEnv(env);

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

const prompt = (t) => `Fix this issue in the repository in the current folder. Change the source code only; do not add or edit tests. The project's dependencies are not installed and its extensions are not built: read the code and reason about it, and do not spend time setting up an environment (a quick check with plain python on a small piece is fine). When you are done, stop: your changes are collected from the working tree.\n\n<issue>\n${t.problem_statement}\n</issue>`;
const EXCLUDE = ['.agent', '.ox', '.ox-build', '.ox-backups', '.venv', 'venv', '__pycache__', 'node_modules', 'build', '.eggs'];

async function runOne(t) {
  const started = Date.now();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-swe-home-'));
  const work = path.join(os.tmpdir(), `ox-swe-${t.instance_id}-${process.pid}`);
  let row = { instance_id: t.instance_id, repo: t.repo, model };
  try {
    const bare = await mirror(t.repo);
    const add = git(bare, 'worktree', 'add', '--quiet', '--detach', work, t.base_commit);
    if (add.status !== 0) throw new Error(`checkout failed: ${add.stderr.slice(0, 300)}`);
    const log = fs.createWriteStream(path.join(out, 'logs', `${t.instance_id}.log`));
    const code = await new Promise((resolve) => {
      const p = spawn(process.execPath, [OX, '--model', model, '--mode', 'code', '-y', '-p', prompt(t)], {
        cwd: work,
        env: { ...env, HOME: home, OX_HOME: path.join(home, '.ox'), OX_ISLAND: '0', OX_LEARN: '0', OX_NO_KEYSTORE: '1', OX_MESH: '0', OX_NO_FAST_FALLBACK: '1', OX_NO_PLUGINS: '1', OX_NO_BUILTIN_SKILLS: '1', OX_MCP: '0' },
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
    // Tokens as ox itself logged them for this run.
    let tokensIn = 0, tokensOut = 0, cached = 0, calls = 0;
    try { for (const l of fs.readFileSync(path.join(home, '.ox', 'usage.jsonl'), 'utf8').trim().split('\n')) { const u = JSON.parse(l); tokensIn += u.in ?? 0; tokensOut += u.out ?? 0; cached += u.cached ?? 0; calls += 1; } } catch {}
    row = { ...row, exit: code, seconds: Math.round((Date.now() - started) / 1000), tokensIn, tokensOut, cached, runs: calls, patchBytes: Buffer.byteLength(patch) };
    fs.appendFileSync(predsFile, `${JSON.stringify({ instance_id: t.instance_id, model_name_or_path: `ox@${model}`, model_patch: patch })}\n`);
  } catch (e) {
    row = { ...row, error: String(e.message).slice(0, 300), seconds: Math.round((Date.now() - started) / 1000) };
    fs.appendFileSync(predsFile, `${JSON.stringify({ instance_id: t.instance_id, model_name_or_path: `ox@${model}`, model_patch: '' })}\n`);
  } finally {
    try { const bare = path.join(reposDir, `${t.repo.replace('/', '__')}.git`); git(bare, 'worktree', 'remove', '--force', work); git(bare, 'worktree', 'prune'); } catch {}
    fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
  fs.appendFileSync(resultsFile, `${JSON.stringify(row)}\n`);
  console.log(JSON.stringify(row));
}

let next = 0;
await Promise.all(Array.from({ length: jobs }, async () => { while (next < todo.length) await runOne(todo[next++]); }));
console.log(`done: ${todo.length} run now, ${done.size} from before; predictions in ${predsFile}`);
