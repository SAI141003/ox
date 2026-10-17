// The model a run uses when none is named: your default if it can run here,
// else what the app would pick (a signed-in plan, a local model, a keyed
// provider). Said out loud, never silent: the island and the terminal used to
// stop with "Missing API key" for a saved default that has no key on this Mac.
import { defaultBotSpec, resolveBot } from './bots.js';

export async function workingModelSpec(config = {}, { explicit = null, env = process.env, say = (s) => process.stderr.write(`${s}\n`) } = {}) {
  if (explicit) return explicit;
  const spec = defaultBotSpec(config, env);
  if (!spec) return spec;
  let target = null;
  try { target = resolveBot(spec, config, env); } catch { return spec; }
  // A plan (subscription) or a keyless target is left to its own checks.
  if (target?.subscription || !target?.keyEnv || env[target.keyEnv]) return spec;
  // Off in tests (they pin the no-key path) and when switched off.
  if (env.OX_NO_FALLBACK === '1' || env.NODE_TEST_CONTEXT || process.env.NODE_TEST_CONTEXT) return spec;
  try {
    const S = await import('./serve.js');
    await S.refreshOllama().catch(() => {});
    if (env.OX_NO_PLAN_CHECK !== '1' && env.OX_NO_KEYSTORE !== '1') await S.refreshPlans().catch(() => {});
    const pick = S.pickWorkingDefault(env);
    if (pick && pick !== spec && pick !== 'ox-ollama' && S.runnable(pick, env)) {
      say(`· your default model ${spec} cannot run here (no ${target.keyEnv}); using ${pick}. Change it: ox model use <name>, or Settings › General in the app`);
      return pick;
    }
  } catch {}
  return spec;
}
