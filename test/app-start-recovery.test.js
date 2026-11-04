// The window stuck on "Starting ox…": a load that failed within the wait between
// retries was dropped, and a message page has no server address to check later.
// Reproduced with the real app (a dead address twice, then a live one): it never
// reached the live server. These keep the parts of the fix in place.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync(new URL('../desktop/island/Sources/OxApp/main.swift', import.meta.url), 'utf8');
const dir = new URL('../desktop/island/Sources/OxIsland/', import.meta.url);

test('a failed load inside the wait is retried, not dropped, and retries end in a plain message', () => {
  const recover = app.slice(app.indexOf('func recover() {'), app.indexOf('func webView(_ webView: WKWebView, didFailProvisionalNavigation'));
  assert.match(recover, /asyncAfter\(deadline: \.now\(\) \+ wait\)/);
  assert.doesNotMatch(recover, /guard Date\(\)\.timeIntervalSince\(lastRecover\) > 10 else \{ return \}/);
  assert.match(recover, /recoverAttempts <= Self\.maxRecoverAttempts/);
  assert.match(recover, /ox did not start/);
});

test('a server that never answers, and a command that never returns, cannot hold the window', () => {
  assert.match(app, /A server that accepts and never answers[\s\S]{0,200}asyncAfter\(deadline: \.now\(\) \+ 20\)/);
  assert.match(app, /asyncAfter\(deadline: \.now\(\) \+ 60\) \{ if p\.isRunning \{ p\.terminate\(\) \} \}/);
});

test('AppleScript runs one at a time, through one function', () => {
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.swift') && n !== 'OxAppleScript.swift')) {
    assert.doesNotMatch(fs.readFileSync(new URL(f, dir), 'utf8'), /NSAppleScript\(source/, f);
  }
  assert.match(fs.readFileSync(new URL('OxAppleScript.swift', dir), 'utf8'), /appleScriptLock\.lock\(\)/);
});

test('a screen question looks at the screen even when an agent is chosen, or there is no arrow', () => {
  const tray = fs.readFileSync(new URL('Tray.swift', dir), 'utf8');
  assert.match(tray, /if let name = Self\.namedAgent\(in: text, agents: agents\.map\(\\\.name\)\) \?\? \(spoken \? nil : agent\) \{[\s\S]{0,500}screenRoute\(r\.route/);
  assert.match(tray, /removeObject\(forKey: "chat\.agent"\)/, 'no pick is kept across restarts');
  assert.match(tray, /func screenRoute[\s\S]{0,1500}"--buddy"/);
});

test('a spoken screen question does not wait behind a long run', () => {
  const tray = fs.readFileSync(new URL('Tray.swift', dir), 'utf8');
  assert.match(tray, /if busy, onReply != nil \{[\s\S]{0,300}lookWhileBusy/);
  assert.match(tray, /func lookWhileBusy[\s\S]{0,700}"--buddy"/);
});

test('agents are known from the start, so a spoken request can name one', () => {
  const tray = fs.readFileSync(new URL('Tray.swift', dir), 'utf8');
  assert.match(tray, /chat\.folder"\)[^\n]*\n[^\n]*\n\s*loadAgents\(\)/);
});

test('a look at the screen never picks the Claude plan by itself', () => {
  const cli = fs.readFileSync(new URL('../src/cli.js', import.meta.url), 'utf8');
  const block = cli.slice(cli.indexOf('A look at the screen should come back'), cli.indexOf('opts.sayFailure = plainFailure'));
  assert.match(block, /runnable\('chatgpt-plan'\)/);
  assert.doesNotMatch(block, /'claude-plan'/);
});

