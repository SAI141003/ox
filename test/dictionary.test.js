// The personal dictionary for dictation: whole-word replacements in any case,
// longest first, and snippets said on their own. Also the plan-usage reader.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyDictionary, saveDictionary, loadDictionary } from '../src/dictionary.js';
import { lastRateLimits, codexUsage, windowName } from '../src/plan-usage.js';

const d = { replace: { 'cloud code': 'Claude Code', 'cloud code cli': 'Claude Code CLI', 'ox island': 'OX Island' }, snippets: { 'my address': '12 Main Street, Vancouver' } };

test('replacements: whole words, any case, longest first', () => {
  assert.equal(applyDictionary('open cloud code and the Ox Island please', d), 'open Claude Code and the OX Island please');
  assert.equal(applyDictionary('install the Cloud Code CLI', d), 'install the Claude Code CLI');
  assert.equal(applyDictionary('cloud coder stays', d), 'cloud coder stays');
});

test('a snippet said on its own pastes its text; inside a sentence it does not', () => {
  assert.equal(applyDictionary('My address.', d), '12 Main Street, Vancouver');
  assert.equal(applyDictionary('send it to my address tomorrow', d), 'send it to my address tomorrow');
});

test('saved and read back', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ox-dict-')), 'dictionary.json');
  saveDictionary(d, file);
  assert.deepEqual(loadDictionary(file), d);
  assert.deepEqual(loadDictionary(`${file}.missing`), { replace: {}, snippets: {} });
});

test('plan usage: the newest Codex limits, a window past its reset reads 0', () => {
  const rl = lastRateLimits('x {"rate_limits":{"primary":{"used_percent":10}}} y {"rate_limits":{"primary":{"used_percent":42.5,"window_minutes":300,"resets_at":2000000000},"plan_type":"plus"}}');
  assert.equal(rl.primary.used_percent, 42.5);
  assert.equal(windowName(300), '5-hour');
  assert.equal(windowName(10080), 'weekly');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-codex-'));
  const dir = path.join(home, '.codex', 'sessions', '2026', '10', '16');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'rollout-a.jsonl'), `${JSON.stringify({ payload: { rate_limits: { primary: { used_percent: 61, window_minutes: 300, resets_at: 2000000000 }, secondary: { used_percent: 20, window_minutes: 10080, resets_at: 1000 }, plan_type: 'plus' } } })}\n`);
  const u = codexUsage({ home, now: 1_500_000_000_000 });
  assert.equal(u.plan, 'plus');
  assert.deepEqual(u.windows.map((w) => [w.name, w.usedPercent]), [['5-hour', 61], ['weekly', 0]]);
  assert.match(codexUsage({ home: fs.mkdtempSync(path.join(os.tmpdir(), 'ox-codex-none-')) }).missing, /no Codex session/);
});
