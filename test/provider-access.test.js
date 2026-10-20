// docs/PROVIDER_ACCESS.md, enforced: ox never reads Claude's sign-in, and never
// picks the Claude plan as its default (Anthropic's consumer terms, Feb 2026).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.join(import.meta.dirname, '..', 'src');
const files = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(d, e.name)) : /\.(js|mjs|swift)$/.test(e.name) ? [path.join(d, e.name)] : []));

test('provider access: no code reads Claude Code\'s login', () => {
  const bad = /Claude Code-credentials|\.credentials\.json|claudeAiOauth|sk-ant-oat/;
  const hits = [...files(SRC), ...files(path.join(import.meta.dirname, '..', 'desktop'))].filter((f) => !f.includes('node_modules') && bad.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(hits, [], 'a file reads or names Claude\'s login store');
});

test('provider access: the default is never the Claude plan', async () => {
  const src = fs.readFileSync(path.join(SRC, 'serve.js'), 'utf8');
  const body = src.slice(src.indexOf('export function pickWorkingDefault'), src.indexOf('export function serveModelCatalog'));
  assert.match(body, /p\.id !== 'claude'/, 'plans other than Claude come first');
  assert.doesNotMatch(body, /workingPlans\(\)\[0\]/, 'the first plan (possibly Claude) is never taken blindly');
  assert.ok(fs.existsSync(path.join(SRC, '..', 'docs', 'PROVIDER_ACCESS.md')));
});
