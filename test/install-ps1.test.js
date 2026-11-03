// install.ps1 must parse, and must read the .sha256 as text. Two real bugs this
// guards against: "$name:" inside a string is a parse error (the whole script
// failed before running), and GitHub serves release files as bytes, so
// (Invoke-WebRequest …).Content.ToString() gave "System.Byte[]" and every
// download looked like a checksum mismatch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const file = path.resolve('install.ps1');
const src = fs.readFileSync(file, 'utf8');
const pwsh = ['pwsh', 'powershell'].find((c) => spawnSync(c, ['-NoProfile', '-Command', 'exit 0']).status === 0);

test('install.ps1 parses (when PowerShell is on this machine)', { skip: !pwsh && 'no pwsh here' }, () => {
  const cmd = `$e=$null; [System.Management.Automation.Language.Parser]::ParseFile('${file.replace(/'/g, "''")}',[ref]$null,[ref]$e) | Out-Null; $e | % { "line $($_.Extent.StartLineNumber): $($_.Message)" }; exit $e.Count`;
  const r = spawnSync(pwsh, ['-NoProfile', '-Command', cmd], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('no "$var:" inside double-quoted strings (a parse error in PowerShell)', () => {
  const bad = [];
  src.split(/\r?\n/).forEach((line, i) => {
    if (/^\s*#/.test(line)) return;
    for (const m of line.matchAll(/"([^"]*)"/g)) {
      // $env:X is fine; $name: followed by a space or end is not.
      for (const v of m[1].matchAll(/\$(\w+):(?=[\s"]|$)/g)) if (v[1] !== 'env') bad.push(`line ${i + 1}: $${v[1]}:`);
    }
  });
  assert.deepEqual(bad, []);
});

test('the checksum is never read from .Content (bytes for release files)', () => {
  assert.doesNotMatch(src, /\.sha256[^\n]*\.Content/);
});
