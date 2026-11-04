// Talking to another agent from inside a run, or from `ox ask`: Codex, Claude Code, Gemini
// or any other plan you are signed in to, any model you have a key for, or a session
// already open on this Mac. Vendor bridges go one way, between two products. Here any of
// them can be asked, and they can call `ox ask` back.
//
// A question runs read-only in your project. Work runs in its own checkout, and its changes
// land as a patch (src/subagent-worktree.js), so two agents never write over each other.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOTS, FAST_FALLBACKS, KEY_ENV, resolveBot } from './bots.js';
import { workingModelSpec } from './working-model.js';
import { SUBSCRIPTION_CLIS } from './subscriptions.js';
import { prepareWorktree, landWorktree } from './subagent-worktree.js';

const OX_BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ox.js');
const ALIASES = { codex: 'chatgpt-plan', chatgpt: 'chatgpt-plan', claude: 'claude-plan', 'claude-code': 'claude-plan' };
const MAX_DEPTH = 1;   // an agent you asked cannot ask another, so no two can call each other forever

/** "codex" → chatgpt-plan, "gemini" → gemini-plan; a bot or model spec stays as it is. */
export function agentSpec(name) {
  const n = String(name ?? '').trim();
  const low = n.toLowerCase();
  if (ALIASES[low]) return ALIASES[low];
  return Object.hasOwn(SUBSCRIPTION_CLIS, low) ? `${low}-plan` : n;
}

/** Who can answer right now: the plans you are signed in to and the providers you have a key for. */
export async function reachableAgents(config = {}, env = process.env) {
  const S = await import('./serve.js');
  if (env.OX_NO_PLAN_CHECK !== '1') await S.refreshPlans().catch(() => {});
  const plans = Object.keys(SUBSCRIPTION_CLIS).map((id) => `${id}-plan`).filter((b) => S.runnable(b, env));
  const seen = new Set();
  const keyed = [];
  for (const id of Object.keys(BOTS)) {
    let t = null;
    try { t = resolveBot(id, config, env); } catch { continue; }
    if (!t?.keyEnv || !env[t.keyEnv] || seen.has(t.provider)) continue;
    seen.add(t.provider);
    keyed.push({ spec: id, provider: t.provider, model: t.model });
  }
  // A carrier with no named bot (NVIDIA): its known quick model.
  for (const spec of FAST_FALLBACKS) {
    const provider = spec.split(':')[0];
    if (!spec.includes(':') || seen.has(provider) || !env[KEY_ENV[provider]]) continue;
    seen.add(provider);
    keyed.push({ spec, provider, model: spec.slice(provider.length + 1) });
  }
  return { plans, keyed };
}

/**
 * The models for a team, one carrier each, so one rate limit stops one agent rather than all
 * of them and a change is reviewed by a different family than wrote it. Your default comes
 * first. The Claude plan joins only when you name it: Anthropic keeps those logins for its own apps.
 */
export async function teamLineup(config = {}, env = process.env, { max = 4 } = {}) {
  const first = await workingModelSpec(config, { env, say: () => {} });
  const carrier = (spec) => { try { const t = resolveBot(spec, config, env); return t.subscription ?? t.provider; } catch { return null; } };
  const { plans, keyed } = await reachableAgents(config, env);
  const out = [];
  const used = new Set();
  // Your default may be a model on another of your computers, and that one may be off.
  const reachable = async (spec) => {
    if (!String(spec).startsWith('mesh:')) return true;
    try { return (await fetch(`${resolveBot(spec, config, env).baseUrl}/models`, { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; }
  };
  for (const spec of [first, ...plans.filter((p) => p !== 'claude-plan'), ...keyed.map((k) => k.spec)]) {
    const c = spec ? carrier(spec) : null;
    if (!c || used.has(c) || !(await reachable(spec))) continue;
    used.add(c);
    out.push(spec);
    if (out.length >= max) break;
  }
  return out;
}

function spawnOx({ spec, message, cwd, work, env, signal }) {
  const args = [OX_BIN, '-p', message, '--json', '--bot', spec, '--cwd', cwd, ...(work ? ['-y', '--sandbox', 'workspace'] : ['--mode', 'ask'])];
  const child = spawn(process.execPath, args, {
    cwd,
    signal,
    env: { ...env, OX_ASK_DEPTH: String((Number(env.OX_ASK_DEPTH) || 0) + 1), OX_ISLAND: '0', OX_LEARN: '0', NO_COLOR: '1', FORCE_COLOR: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    child.on('error', (e) => resolve({ code: 1, out, err: e.message }));
    child.on('close', (code) => resolve({ code: code ?? 1, out, err }));
  });
}

/** The last answer in an `ox -p --json` stream. */
export function replyOf(stream) {
  let reply = '';
  let error = '';
  for (const line of String(stream).split('\n')) {
    let ev = null;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === 'final') reply = String(ev.message?.content ?? ev.text ?? reply);
    else if (ev.type === 'error') error = String(ev.error ?? ev.message ?? error);
  }
  return { reply: reply.trim(), error };
}

/**
 * Ask or task another agent. → { ok, reply, error?, who, landed? }
 * @param {string} [o.agent]    codex, claude, gemini, a plan, a bot or provider:model
 * @param {string} [o.session]  a session id from `ox agents`, to continue that conversation
 * @param {'read'|'work'} [o.mode]
 */
export async function askAgent({ agent, session, message, mode = 'read', cwd = process.cwd(), config = {}, env = process.env, signal, run = spawnOx }) {
  const text = String(message ?? '').trim();
  if (!text) return { ok: false, error: 'nothing to ask' };
  if ((Number(env.OX_ASK_DEPTH) || 0) >= MAX_DEPTH) return { ok: false, error: 'an agent that was asked for help cannot ask another: answer with what you have' };
  if (session) {
    const { sendToSession } = await import('./agents-live.js');
    try {
      const r = await sendToSession(String(session), text);
      if (r.queued) return { ok: true, who: session, reply: `Queued: ${r.why}` };
      return { ok: !!r.ok, who: session, reply: String(r.reply ?? ''), ...(r.ok ? {} : { error: r.error ?? 'the session did not answer' }) };
    } catch (e) { return { ok: false, who: session, error: e.message }; }
  }
  const spec = agentSpec(agent);
  if (!spec) return { ok: false, error: 'say which agent: codex, claude, gemini, or a model' };
  let target = null;
  try { target = resolveBot(spec, config, env); } catch (e) { return { ok: false, who: spec, error: e.message }; }
  if (target.keyEnv && !env[target.keyEnv]) return { ok: false, who: spec, error: `no ${target.keyEnv} on this machine` };
  const work = mode === 'work';
  const wt = work ? prepareWorktree(cwd) : null;
  // Told plainly, or a model in a read-only sandbox answers without opening a file.
  const where = work ? 'You are in a copy of the project: change files here, your changes come back as a patch.' : 'You are in the project folder: read its files and run commands that change nothing. You cannot change anything here.';
  const r = await run({ spec, message: `${where}\n\n${text}`, cwd: wt?.cwd ?? cwd, work, env, signal });
  const { reply, error } = replyOf(r.out);
  const landed = wt ? landWorktree(wt).trim() || 'It changed no files, whatever it says above.' : '';
  const ok = r.code === 0 && !error && !!reply;
  return {
    ok,
    who: spec,
    reply,
    ...(landed ? { landed } : {}),
    ...(ok ? {} : { error: error || r.err.trim().split('\n').slice(-3).join(' ').slice(0, 400) || `it stopped with code ${r.code}` }),
  };
}

export function askAgentSchema() {
  return {
    name: 'ask_agent',
    description: 'Ask or task another agent or model: codex, claude, gemini, any model you have a key for, or an open session. For a second opinion from another family, or work it does better. agent "list" shows who can answer. mode read (default) answers without changing files; work changes files in its own checkout and lands them here. It starts fresh: put everything it needs in the message.',
    input_schema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'codex, claude, gemini, a bot or provider:model, or "list".' },
        message: { type: 'string', description: 'The question or task, complete on its own.' },
        mode: { type: 'string', enum: ['read', 'work'] },
        session: { type: 'string', description: 'Continue this open session instead (an id from `ox agents`).' },
      },
      additionalProperties: false,
    },
  };
}

export async function askAgentTool(args = {}, ctx = {}) {
  const config = ctx.config ?? (await import('./config.js')).loadConfig({ cwd: ctx.cwd ?? process.cwd() });
  const env = { ...process.env, ...(ctx.env ?? {}) };
  if (String(args.agent ?? '').toLowerCase() === 'list') {
    const { plans, keyed } = await reachableAgents(config, env);
    const { liveAgents } = await import('./agents-live.js');
    const open = liveAgents({}).slice(0, 12).map((s) => `${s.id} (${s.tool}, ${s.state})`);
    return { content: [`plans: ${plans.join(', ') || 'none'}`, `keys: ${keyed.map((k) => `${k.spec} (${k.model})`).join(', ') || 'none'}`, `open sessions: ${open.join(', ') || 'none'}`].join('\n') };
  }
  // Your work goes to whoever answers, so you say yes to each one. The Claude plan is only
  // ever used when a person picks it, so nobody watching means no.
  const spec = args.session ? String(args.session) : agentSpec(args.agent);
  if (spec === 'claude-plan' && ctx.yolo) return { content: 'ask_agent: the Claude plan runs only when you pick it, and nobody is watching this run. Use `ox ask claude` yourself, or another agent.', isError: true };
  if (!ctx.yolo && typeof ctx.requestApproval === 'function') {
    const what = `${args.mode === 'work' ? 'Let it change files in its own copy' : 'Send this question'}: ${String(args.message ?? '').slice(0, 300)}`;
    if (!(await ctx.requestApproval('ask_agent', args, `Ask ${spec}. ${what}`))) return { content: `ask_agent: you did not allow asking ${spec}.`, isError: true };
  }
  const r = await askAgent({ agent: args.agent, session: args.session, message: args.message, mode: args.mode, cwd: ctx.cwd ?? process.cwd(), config, env, signal: ctx.signal });
  if (!r.ok) return { content: `ask_agent (${r.who ?? 'nobody'}): ${r.error}${r.reply ? `\n${r.reply}` : ''}`, isError: true };
  return { content: `${r.who} says:\n${r.reply}${r.landed ? `\n${r.landed}` : ''}` };
}
