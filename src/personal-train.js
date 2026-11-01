// Your own model, end to end on this Mac (Apple silicon, MLX): a small open
// model, a LoRA adapter trained on the examples you approved, a try, and a
// local server that ox uses as a model like any other. The base weights are
// never changed; nothing leaves the Mac.
//
//   ~/.ox/personal-model/runtime/            Python 3.12 + mlx-lm (made with uv, once)
//   ~/.ox/personal-model/runs/<id>/data/     train.jsonl, valid.jsonl (chat format)
//   ~/.ox/personal-model/runs/<id>/adapter/  the trained adapter
//   bot "my-model"                           ox's model entry, served by mlx_lm server
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';

const HOME = () => process.env.OX_HOME || path.join(os.homedir(), '.ox');
const DIR = () => path.join(HOME(), 'personal-model');
const RUNTIME = () => path.join(DIR(), 'runtime');
const PY = () => path.join(RUNTIME(), 'bin', 'python');
export const MIN_EXAMPLES = 20;

/** Small models that train in minutes on a MacBook (4-bit MLX builds, downloaded on first use). */
export const BASE_MODELS = Object.freeze([
  { id: 'mlx-community/Qwen2.5-0.5B-Instruct-4bit', name: 'Qwen 2.5 · 0.5B', size: '~300 MB', note: 'fastest, a few minutes to train' },
  { id: 'mlx-community/Llama-3.2-1B-Instruct-4bit', name: 'Llama 3.2 · 1B', size: '~700 MB', note: 'balanced' },
  { id: 'mlx-community/Qwen2.5-1.5B-Instruct-4bit', name: 'Qwen 2.5 · 1.5B', size: '~900 MB', note: 'best answers, slower' },
]);

let job = { kind: null, running: false, step: '', progress: 0, error: null, log: [] };
let server = null;
export const jobState = () => ({ ...job, log: job.log.slice(-6) });

export function runtimeReady() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') return { ok: false, why: 'Training on this Mac needs Apple silicon' };
  if (!fs.existsSync(PY())) return { ok: false, why: 'not installed yet' };
  const r = spawnSync(PY(), ['-c', 'import mlx_lm'], { timeout: 20_000 });
  return r.status === 0 ? { ok: true } : { ok: false, why: 'the install is incomplete' };
}

function freeGB() { try { const s = fs.statfsSync(HOME()); return (s.bavail * s.bsize) / 2 ** 30; } catch { return null; } }

function runStep(cmd, args, { onLine = () => {}, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    const read = (d) => { const s = String(d); tail = (tail + s).slice(-3000); for (const l of s.split(/\r|\n/)) if (l.trim()) onLine(l.trim()); };
    p.stdout.on('data', read); p.stderr.on('data', read);
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(tail) : reject(new Error(tail.split('\n').filter(Boolean).slice(-2).join(' ') || `exit ${code}`))));
  });
}

const start = (kind, step) => { if (job.running) throw new Error(`busy: ${job.kind} is running`); job = { kind, running: true, step, progress: 0, error: null, log: [] }; };
const say = (step, progress = job.progress) => { job.step = step; job.progress = progress; };
const finish = (e) => { job.running = false; if (e) { job.error = e.message; job.step = 'failed'; } else { job.progress = 1; } };

/** Python 3.12 and mlx-lm in ox's own folder (about 250 MB), with uv. */
export function install() {
  start('install', 'Setting up Python');
  (async () => {
    try {
      const free = freeGB();
      if (free != null && free < 2) throw new Error(`not enough disk: ${free.toFixed(1)} GB free, 2 GB needed`);
      if (spawnSync('uv', ['--version']).status !== 0) throw new Error('needs uv: brew install uv');
      fs.mkdirSync(DIR(), { recursive: true });
      await runStep('uv', ['venv', '--python', '3.12', RUNTIME()], { onLine: (l) => job.log.push(l) });
      say('Installing MLX (about 250 MB)', 0.4);
      await runStep('uv', ['pip', 'install', '--python', PY(), 'mlx-lm'], { onLine: (l) => job.log.push(l) });
      finish();
      say('Ready');
    } catch (e) { finish(e); }
  })();
  return jobState();
}

/** The approved examples as MLX chat data: 90% to learn from, 10% held out to check it. */
export function writeData(examples, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const rows = examples.filter((e) => e.input && e.output).map((e) => JSON.stringify({ messages: [{ role: 'user', content: e.input }, { role: 'assistant', content: e.output }] }));
  // At least one full batch (4) held out: MLX refuses a check set smaller than its batch.
  const held = Math.min(Math.max(4, Math.round(rows.length * 0.1)), Math.max(1, rows.length - 4));
  fs.writeFileSync(path.join(dir, 'train.jsonl'), `${rows.slice(held).join('\n')}\n`);
  fs.writeFileSync(path.join(dir, 'valid.jsonl'), `${rows.slice(0, held).join('\n')}\n`);
  return { train: rows.length - held, valid: held };
}

/** Train a LoRA adapter. Progress from MLX's own "Iter N" lines. */
export function train({ base, examples }) {
  if (!runtimeReady().ok) throw new Error('install the trainer first');
  if (!base) throw new Error('choose a base model first');
  if (examples.length < MIN_EXAMPLES) throw new Error(`add at least ${MIN_EXAMPLES} examples first (${examples.length} so far)`);
  start('train', 'Getting the base model ready');
  const id = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
  const runDir = path.join(DIR(), 'runs', id);
  const counts = writeData(examples, path.join(runDir, 'data'));
  const iters = Math.min(600, Math.max(100, counts.train * 8));
  (async () => {
    try {
      await runStep(PY(), ['-m', 'mlx_lm', 'lora', '--model', base, '--train', '--data', path.join(runDir, 'data'), '--iters', String(iters), '--batch-size', String(Math.max(1, Math.min(4, counts.train, counts.valid))), '--adapter-path', path.join(runDir, 'adapter'), '--steps-per-report', '10', '--steps-per-eval', String(Math.max(50, Math.round(iters / 4)))], {
        onLine: (line) => {
          let l = line;
          // MLX prints a coloured table ("  120   0.067 ▼  316  20.9k") or "Iter N: Train loss X".
          l = l.replace(/\x1b\[[0-9;]*m/g, '');
          job.log.push(l);
          const it = /Iter (\d+):.*?(?:Train|Val) loss ([\d.]+)/.exec(l) ?? /^\s*(\d+)\s+([\d.]+)\s*[▼▲]/.exec(l);
          if (it) say(`Training: step ${it[1]} of ${iters} · loss ${Number(it[2]).toFixed(2)}`, Math.min(0.99, Number(it[1]) / iters));
          else if (/Fetching|Downloading/i.test(l) && job.progress === 0) say('Downloading the base model (once)');
        },
      });
      fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({ id, base, examples: examples.length, iters, at: Date.now() }));
      finish();
      say('Trained');
    } catch (e) { finish(e); }
  })();
  return jobState();
}

export function latestRun() {
  let ids = [];
  try { ids = fs.readdirSync(path.join(DIR(), 'runs')).sort(); } catch {}
  for (const id of ids.reverse()) {
    try { return { id, ...JSON.parse(fs.readFileSync(path.join(DIR(), 'runs', id, 'run.json'), 'utf8')), adapter: path.join(DIR(), 'runs', id, 'adapter') }; } catch {}
  }
  return null;
}

/** One answer from the trained model, to see what it learned. */
export async function tryIt(prompt) {
  const run = latestRun();
  if (!run) throw new Error('train it first');
  const out = await runStep(PY(), ['-m', 'mlx_lm', 'generate', '--model', run.base, '--adapter-path', run.adapter, '--max-tokens', '220', '--prompt', String(prompt).slice(0, 2000)]);
  const m = /==========\n([\s\S]*?)\n==========/.exec(out);
  return (m ? m[1] : out).trim();
}

const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

/** Serve it on this Mac and add it to ox's models as "my-model". */
export async function useIt({ saveConfigDoc }) {
  const run = latestRun();
  if (!run) throw new Error('train it first');
  if (server && server.exitCode === null) server.kill();
  const port = await freePort();
  server = spawn(PY(), ['-m', 'mlx_lm', 'server', '--model', run.base, '--adapter-path', run.adapter, '--host', '127.0.0.1', '--port', String(port)], { stdio: 'ignore', detached: true });
  server.unref();
  saveConfigDoc((doc) => { doc.bots = { ...(doc.bots ?? {}), 'my-model': { provider: 'vllm', model: 'default_model', baseUrl: `http://127.0.0.1:${port}/v1`, chatOnly: true, desc: `Your own model · ${run.examples} examples · ${run.base.split('/').pop()}` } }; });
  return { bot: 'my-model', port };
}

/** At ox's start: "my-model" is in use but its local server is gone (a restart): serve it again. */
export async function ensureServing({ readConfigDoc, saveConfigDoc }) {
  const bot = readConfigDoc().bots?.['my-model'];
  if (!bot?.baseUrl || !latestRun() || !runtimeReady().ok) return false;
  try { const r = await fetch(`${bot.baseUrl}/models`, { signal: AbortSignal.timeout(1500) }); if (r.ok) return false; } catch {}
  await useIt({ saveConfigDoc });
  return true;
}
