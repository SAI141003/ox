// Plans you pay for, found where apps really put their CLIs. On a real Mac the
// `claude` on PATH was a 500-byte stub and the npm `codex` had lost its native
// part, while VS Code's Claude and ChatGPT extensions and the Claude app each
// carried a working copy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { knownCopies } from '../src/subscriptions.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-copies-'));
const mk = (...p) => { const f = path.join(home, ...p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, '#!/bin/sh\necho 1\n', { mode: 0o755 }); return f; };
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

test('claude: editor extensions newest first, then the Claude app', () => {
  const old = mk('.vscode', 'extensions', 'anthropic.claude-code-2.1.300-darwin-arm64', 'resources', 'native-binary', 'claude');
  const neu = mk('.vscode', 'extensions', 'anthropic.claude-code-2.1.301-darwin-arm64', 'resources', 'native-binary', 'claude');
  const app = mk('Library', 'Application Support', 'Claude', 'claude-code', '2.1.299', 'abc', 'claude.app', 'Contents', 'MacOS', 'claude');
  const list = knownCopies('claude', home);
  assert.deepEqual(list.filter((p) => fs.existsSync(p)), [neu, old, app]);
});

test('codex: the ChatGPT extension ships it per platform', () => {
  const c = mk('.vscode', 'extensions', 'openai.chatgpt-26.1007.21434-darwin-arm64', 'bin', 'macos-aarch64', 'codex');
  assert.deepEqual(knownCopies('codex', home).filter((p) => fs.existsSync(p)), [c]);
  assert.deepEqual(knownCopies('gemini', home), []);
});
