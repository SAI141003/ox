#!/usr/bin/env node
// Run the test suite with an isolated home/config directory. Without this,
// persisted local-provider approvals, API keys, skills, and plugins from a
// developer's ~/.ox can change tests that claim to exercise the "no provider"
// or "clean install" path. Keep the npm test entry point cross-platform too.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-test-home-'));
const isolated = (...parts) => path.join(testHome, ...parts);
const env = {
  ...process.env,
  HOME: testHome,
  USERPROFILE: testHome,
  XDG_CONFIG_HOME: isolated('.config'),
  XDG_CACHE_HOME: isolated('.cache'),
  XDG_DATA_HOME: isolated('.local', 'share'),
  XDG_STATE_HOME: isolated('.local', 'state'),
  XDG_RUNTIME_DIR: isolated('.runtime'),
  OX_HOME: isolated('.ox'),
  OX_ISLAND: '0',
  OX_LEARN: '0',
  OX_NO_KEYSTORE: '1',
  OX_USAGE_LOG: '0',
  OX_MEMORY_HOME: isolated('.ox', 'memory'),
  OX_NO_BUILTIN_SKILLS: '1',
  OX_NO_PLUGINS: '1',
  // The repository-mutation guard intentionally launches every other test
  // file and is a separate release gate. Keeping it out of the ordinary suite
  // avoids recursively running the suite twice and making `npm test` appear
  // hung. Run `npm run test:guard` when that expensive sweep is required.
  OX_SKIP_REPO_GUARD: process.env.OX_SKIP_REPO_GUARD ?? '1',
};
const requested = process.argv.slice(2);
const files = requested.length ? requested : fs.readdirSync(path.join(ROOT, 'test'))
  .filter((name) => name.endsWith('.test.js'))
  .map((name) => path.join('test', name));
const child = spawn(process.execPath, ['--test', '--test-concurrency=2', ...files], {
  cwd: ROOT,
  env,
  stdio: 'inherit',
});

try {
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (status) => resolve(status ?? 1));
  });
  process.exitCode = code;
} finally {
  fs.rmSync(testHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
