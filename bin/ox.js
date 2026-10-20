#!/usr/bin/env node

import fs from 'node:fs';

// Fast path: --version / -v must never pay the full CLI import cost.
if (process.argv.length === 3 && (process.argv[2] === '--version' || process.argv[2] === '-v')) {
  const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  // Terminals get the banner; piped/CI output stays byte-identical to `ox ${version}`.
  if (process.stdout.isTTY) {
    const { banner } = await import('../src/logo.js');
    console.log(`${banner({ version })}\nox ${version}`);
  } else {
    console.log(`ox ${version}`);
  }
  process.exit(0);
}

// Fast paths for what agents run on every step: Claude Code calls `ox hook` on
// each tool call and `ox statusline` on each redraw, so they load only their
// own module, never the whole CLI (that cost ~150-300 ms per call).
const [cmd, a1, a2] = process.argv.slice(2);
if (cmd === 'hook') {
  try {
    const ah = await import('../src/agent-hooks.js');
    let raw = '';
    for await (const chunk of process.stdin) raw += chunk;
    const out = await ah.handleHook(a1 ?? 'claude', raw, { event: a2 ?? null });
    if (out) process.stdout.write(`${out}\n`);
  } catch {}
  process.exit(0);
}
if (cmd === 'statusline') {
  try {
    const { runStatusline } = await import('../src/statusline.js');
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    process.stdout.write(runStatusline(Buffer.concat(chunks).toString('utf8')));
  } catch {}
  process.exit(0);
}

async function main() {
  // Node keeps the compiled CLI on disk and reuses it (Node 22.1+; ignored before).
  if (process.env.OX_COMPILE_CACHE !== '0') { try { (await import('node:module')).enableCompileCache?.(); } catch {} }
  // Keys pasted into the app (~/.ox/keys.json) fill in what the shell did not set.
  try { (await import('../src/keystore.js')).loadKeysIntoEnv(); } catch {}
  let cli = null;
  try {
    cli = await import('../src/cli.js');
  } catch (err) {
    // Never mask a load failure: a syntax error in any module must name itself.
    console.error(`ox: failed to load CLI — ${err?.stack ?? err}`);
    process.exit(1);
  }
  if (typeof cli.main !== 'function') {
    console.error('ox: src/cli.js does not export main()');
    process.exit(1);
  }
  try {
    await cli.main(process.argv.slice(2));
  } catch (err) {
    console.error(`ox: ${err?.message ?? err}`);
    // Remembered (secrets redacted) so `ox evolve` can fix what actually broke.
    try { await (await import('../src/evolve.js')).recordFailure({ command: process.argv.slice(2), error: err }); } catch {}
    process.exit(1);
  }
}

main();
