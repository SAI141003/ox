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

async function main() {
  let cli = null;
  try {
    cli = await import('../src/cli.js');
  } catch {
    cli = null;
  }
  if (!cli || typeof cli.main !== 'function') {
    console.error('ox: interface layer not built yet');
    process.exit(1);
  }
  try {
    await cli.main(process.argv.slice(2));
  } catch (err) {
    console.error(`ox: ${err?.message ?? err}`);
    process.exit(1);
  }
}

main();
