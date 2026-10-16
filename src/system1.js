// ox's System 1: fast typed decisions about a message, with Laya
// (github.com/NandhaKishorM/laya, Apache-2.0): a non-autoregressive model that
// answers choice / score / yes-no questions over text in one forward pass, in
// 100+ languages, generating nothing (so nothing to parse or hallucinate).
//
// ox uses it where it used English-only word lists: is this small talk, a
// question, something needing the web, about the project, a task, or a request
// for something interactive; and does it need a plan. Kept apart in ~/.ox/laya:
//
//   venv/   a private Python (uv) with the laya package
//   hf/     the laya-multilingual checkpoint (Hugging Face cache, ~680 MB)
//
// The model loads once into a long-lived worker. Until it is ready (or if it is
// not installed, or slow), decide() returns null and ox keeps its word lists, so
// a turn never waits on it for more than its time limit.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import readline from 'node:readline';

export const S1_DIR = () => process.env.OX_LAYA_DIR || path.join(process.env.OX_HOME || path.join(os.homedir(), '.ox'), 'laya');
const PY_BIN = () => path.join(S1_DIR(), 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const HF = () => path.join(S1_DIR(), 'hf');
export const CHECKPOINT = 'multilingual';

export function system1Status() {
  const python = fs.existsSync(PY_BIN());
  const lib = python && spawnSync(PY_BIN(), ['-I', '-c', 'import importlib.util,sys; sys.exit(0 if importlib.util.find_spec("laya") else 1)'], { timeout: 15000 }).status === 0;
  const model = fs.existsSync(HF()) && fs.readdirSync(HF(), { recursive: true }).some((f) => String(f).endsWith('model.safetensors'));
  return { ready: !!(python && lib), python, lib, model, dir: S1_DIR(), worker: worker ? (workerReady ? 'ready' : 'loading') : 'off' };
}

// Off in tests and when switched off; on only once installed.
export function system1Enabled(env = process.env) {
  return env.OX_SYSTEM1 !== '0' && !env.NODE_TEST_CONTEXT && fs.existsSync(PY_BIN());
}

const WORKER = `
import sys, json, os
from laya import Router
r = Router()
def plain(o):
    if hasattr(o, "item"): return o.item()
    if hasattr(o, "tolist"): return o.tolist()
    return str(o)
r.predict("hello", {"g": {"type": "noul", "instructions": "Is this a greeting?"}}, model=sys.argv[1])
print(json.dumps({"ready": True}), flush=True)
for line in sys.stdin:
    req = {}
    try:
        req = json.loads(line)
        out = r.predict(req["state"], req["questions"], model=req.get("model") or sys.argv[1])
        print(json.dumps({"id": req["id"], "ok": True, "answers": out.get("answers"), "routing": out.get("routing")}, default=plain), flush=True)
    except Exception as e:
        print(json.dumps({"id": req.get("id"), "ok": False, "error": str(e)[:300]}), flush=True)
`;

let worker = null, workerReady = false;
function startWorker() {
  if (worker) return worker;
  const p = spawn(PY_BIN(), ['-I', '-c', WORKER, CHECKPOINT], {
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    env: { ...process.env, HF_HOME: HF(), TOKENIZERS_PARALLELISM: 'false', HF_HUB_DISABLE_TELEMETRY: '1' },
  });
  const pending = new Map();
  let err = '';
  let readyResolve, readyReject;
  const ready = new Promise((res, rej) => { readyResolve = res; readyReject = rej; });
  ready.catch(() => {});
  p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
  readline.createInterface({ input: p.stdout }).on('line', (line) => {
    let m; try { m = JSON.parse(line); } catch { return; }
    if (m.ready) { workerReady = true; return readyResolve(true); }
    const w = pending.get(m.id); if (!w) return;
    pending.delete(m.id);
    m.ok ? w.resolve(m) : w.reject(new Error(`Laya: ${m.error}`));
  });
  const fail = (why) => {
    worker = null; workerReady = false;
    readyReject(new Error(why));
    for (const w of pending.values()) w.reject(new Error(why));
    pending.clear();
  };
  p.on('error', (e) => fail(`Laya could not start: ${e.message}`));
  p.on('exit', (code) => fail(`Laya stopped (${code}): ${err.trim().split('\n').slice(-2).join(' ')}`));
  p.unref?.();
  p.stdout.unref?.(); p.stderr.unref?.(); p.stdin.unref?.();
  let n = 0;
  worker = {
    ready, proc: p,
    ask(req) {
      const id = ++n;
      return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); p.stdin.write(`${JSON.stringify({ ...req, id })}\n`); });
    },
  };
  return worker;
}

// Load the model now (the first load takes seconds); later turns use it warm.
export function warmSystem1() {
  if (!system1Enabled()) return null;
  try { return startWorker().ready; } catch { return null; }
}

// { answers, routing, ms } or null: not installed, still loading, failed or too slow.
export async function decide(state, questions, { timeoutMs = 1500 } = {}) {
  if (!system1Enabled()) return null;
  let w;
  try { w = startWorker(); } catch { return null; }
  if (!workerReady) return null;
  const t0 = Date.now();
  const r = await Promise.race([
    w.ask({ state: String(state ?? '').slice(0, 4000), questions }).catch(() => null),
    new Promise((res) => setTimeout(() => res(null), timeoutMs).unref?.()),
  ]);
  return r ? { answers: r.answers ?? {}, routing: r.routing ?? null, ms: Date.now() - t0 } : null;
}

export function stopSystem1() {
  if (worker) { try { worker.proc.kill(); } catch {} worker = null; workerReady = false; }
}

// What kind of message this is, for routing a turn.
export const TURN_QUESTIONS = Object.freeze({
  kind: {
    type: 'choice',
    instructions: 'What is this message to an AI assistant asking for?',
    criteria: {
      chat: 'a greeting, thanks, or small talk',
      question: 'a question answered from general knowledge',
      current: 'current or live information from the internet: news, prices, weather, scores, latest versions',
      project: "something about code, files, or the user's own project or computer",
      task: 'to build, write, change, fix or run something',
      interactive: 'something to use on screen: a calculator, chart, form, planner, tracker or quiz',
    },
  },
  plan: { type: 'noul', instructions: 'Does this need several steps, a plan, or work across many files?' },
});

// Laya answers come back as { choice, ... } for a choice and { noul } (the
// probability of yes) for a yes-no question; anything else is ignored.
export function readTurn(answers) {
  const kind = answers?.kind?.choice;
  if (!kind || !(kind in TURN_QUESTIONS.kind.criteria)) return null;
  const probs = answers.kind.probs ?? answers.kind.probabilities ?? answers.kind.scores ?? null;
  const confidence = typeof answers.kind.confidence === 'number' ? answers.kind.confidence
    : probs && typeof probs === 'object' && typeof probs[kind] === 'number' ? probs[kind] : null;
  const plan = typeof answers?.plan?.noul === 'number' ? answers.plan.noul : null;
  return { kind, confidence, plan };
}

export async function classifyTurn(text, opts = {}) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  const r = await decide(t, TURN_QUESTIONS, opts);
  if (!r) return null;
  const turn = readTurn(r.answers);
  return turn ? { ...turn, ms: r.ms, model: r.routing?.model ?? CHECKPOINT } : null;
}

export function installSteps() {
  return [
    { what: 'a private Python 3.12 for System 1 (uv)', cmd: 'uv', args: ['venv', '--python', '3.12', path.join(S1_DIR(), 'venv')] },
    { what: 'laya (Apache-2.0) and PyTorch into it', cmd: 'uv', args: ['pip', 'install', '--python', PY_BIN(), 'laya'] },
    { what: 'the laya-multilingual checkpoint (~680 MB, Hugging Face)', cmd: PY_BIN(), args: ['-I', '-c', `from laya import Router; Router().predict("hi", {"g": {"type": "noul", "instructions": "Is this a greeting?"}}, model="${CHECKPOINT}"); print("ok")`], env: { HF_HOME: HF() } },
  ];
}

export function installSystem1({ log = console.log } = {}) {
  if (spawnSync('uv', ['--version'], { encoding: 'utf8' }).status !== 0) throw new Error('uv is needed to give System 1 its own Python: https://docs.astral.sh/uv/ (brew install uv)');
  fs.mkdirSync(S1_DIR(), { recursive: true });
  for (const s of installSteps()) {
    const st = system1Status();
    if (s.args[0] === 'venv' && st.python) { log(`✓ ${s.what} (already here)`); continue; }
    if (s.args[0] === 'pip' && st.lib) { log(`✓ ${s.what} (already here)`); continue; }
    if (s.cmd === PY_BIN() && st.model) { log(`✓ ${s.what} (already here)`); continue; }
    log(`… ${s.what}`);
    const r = spawnSync(s.cmd, s.args, { stdio: 'inherit', env: { ...process.env, ...(s.env ?? {}) } });
    if (r.status !== 0) throw new Error(`failed: ${s.what}`);
  }
  return system1Status();
}
