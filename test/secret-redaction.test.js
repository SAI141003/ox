// Keys in files never reach the model: read_file, grep and bash output pass
// through redactSecrets (src/memory.js). Found by bench/compare-features.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redactSecrets } from '../src/memory.js';
import { readFileTool, grepTool } from '../src/tools/fs.js';
import { bashTool } from '../src/tools/exec.js';

const KEY = 'sk-proj-FAKEfakeFAKE0123456789abcdefABCDEFghijklmnop';
const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ox-redact-')));
fs.writeFileSync(path.join(dir, '.env'), `# local settings\nOPENAI_API_KEY=${KEY}\nPORT=3000\n`);
const ctx = { cwd: dir, yolo: true };

test('values are redacted, names and ordinary settings kept', () => {
  const r = redactSecrets(`OPENAI_API_KEY=${KEY}\nPORT=3000\nconst sha = "3f2a9c1b7e";`);
  assert.equal(r.count, 1);
  assert.doesNotMatch(r.text, /FAKEfakeFAKE/);
  assert.match(r.text, /OPENAI_API_KEY=.*\[REDACTED: a provider API key\]/);
  assert.match(r.text, /PORT=3000/);
  assert.match(r.text, /sha = "3f2a9c1b7e"/);
  const pem = redactSecrets('a\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----\nz');
  assert.equal(pem.text, 'a\n[REDACTED: a PEM openssh private key block]\nz');
  assert.equal(redactSecrets(`k=${KEY}`, { OX_ALLOW_SECRET_READS: '1' }).count, 0, 'opt-out');
});

test('read_file, grep and bash never hand the key to the model', async () => {
  // read_file refuses a .env outright and grep skips it (src/oxignore.js); bash,
  // which can still cat it after approval, redacts what comes back.
  const read = await readFileTool({ path: '.env' }, ctx);
  assert.equal(read.isError, true);
  assert.match(read.content, /looks like a secret/);
  assert.doesNotMatch(read.content, /FAKEfakeFAKE/);
  assert.doesNotMatch((await grepTool({ pattern: 'API_KEY' }, ctx)).content, /FAKEfakeFAKE/);
  const sh = await bashTool({ command: 'cat .env' }, ctx);
  assert.doesNotMatch(sh.content, /FAKEfakeFAKE/);
  assert.match(sh.content, /REDACTED/);
  assert.match(sh.content, /credential\(s\) redacted/);
  assert.match(fs.readFileSync(path.join(dir, '.env'), 'utf8'), /FAKEfakeFAKE/, 'the file itself is untouched');
});
