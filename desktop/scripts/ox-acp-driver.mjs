import { createAcpClient } from '../../src/acp.js';

function parseArgv(argv) {
  const args = { cwd: process.cwd(), prompt: null, target: null, env: {} };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--cwd':
        args.cwd = argv[++i] ?? process.cwd();
        break;
      case '--prompt':
        args.prompt = argv[++i] ?? null;
        break;
      case '--target':
        args.target = argv[++i] ?? null;
        break;
      case '--set-env':
        // KEY=VALUE pairs forwarded into the spawned agent process only.
        // Lets the desktop pass per-session API keys without touching
        // the user's shell environment.
        {
          const kv = argv[++i] ?? '';
          const eq = kv.indexOf('=');
          if (eq > 0) args.env[kv.slice(0, eq)] = kv.slice(eq + 1);
        }
        break;
    }
  }
  return args;
}

function parseTarget(targetStr) {
  if (!targetStr) return null;
  const sep = targetStr.includes(':') ? ':' : '/';
  const idx = targetStr.indexOf(sep);
  if (idx === -1) return { model: targetStr };
  return { provider: targetStr.slice(0, idx), model: targetStr.slice(idx + 1) };
}

async function main() {
  const { cwd, prompt, target, env } = parseArgv(process.argv.slice(2));

  if (!prompt) {
    process.stderr.write(JSON.stringify({ type: 'error', error: '--prompt is required' }) + '\n');
    process.exit(2);
  }

  let client = null;
  try {
    // Per-session env (API keys from the desktop model picker) is merged
    // into the process env for this run only — never written to disk here.
    const prev = {};
    for (const [k, v] of Object.entries(env)) {
      prev[k] = process.env[k];
      process.env[k] = v;
    }
    try {
      client = await createAcpClient({ cwd, target: parseTarget(target) });
      const session = await client.newSession();
      const events = await client.prompt(session.sessionId, prompt);

      for (const ev of events) {
        process.stdout.write(JSON.stringify({ type: 'event', data: ev }) + '\n');
      }
      process.stdout.write(JSON.stringify({ type: 'final', events }) + '\n');
    } finally {
      for (const [k, v] of Object.entries(env)) {
        if (v === undefined || prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k];
      }
    }
  } catch (err) {
    process.stdout.write(JSON.stringify({ type: 'error', error: String(err?.message ?? err) }) + '\n');
    process.exit(1);
  } finally {
    client?.dispose();
  }
}

main();
