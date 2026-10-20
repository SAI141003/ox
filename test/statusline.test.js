import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { usageRecord, runStatusline, defaultLine } from '../src/statusline.js';
import { withHooks, planInstall, applyInstall } from '../src/agent-hooks.js';
import { limitAlerts } from '../src/plan-usage.js';

const tmp = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-sl-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const now = 1_800_000_000_000;
const payload = { model: { display_name: 'Opus 5.5' }, workspace: { current_dir: '/x/ox' }, rate_limits: { five_hour: { used_percentage: 84, resets_at: now / 1000 + 3600 }, seven_day: { used_percentage: 22, resets_at: now / 1000 + 86400 } } };

test('the relay keeps only the limits, and refuses nonsense', () => {
  const r = usageRecord(payload, now);
  assert.deepEqual(Object.keys(r.rate_limits), ['five_hour', 'seven_day']);
  assert.equal(r.model, 'Opus 5.5');
  assert.equal(usageRecord({}, now), null, 'no plan (API key users): nothing recorded');
  assert.equal(usageRecord({ rate_limits: { five_hour: { used_percentage: 50, resets_at: now } } }, now), null, 'milliseconds where seconds belong');
  assert.equal(usageRecord({ rate_limits: { five_hour: { used_percentage: 120, resets_at: now / 1000 + 60 } } }, now).rate_limits.five_hour.used_percentage, 100);
});

test('the relay writes the usage file, then shows the status line you had (or its own)', (t) => {
  const home = tmp(t);
  const env = { OX_HOME: home };
  assert.equal(runStatusline(JSON.stringify(payload), { env, now }), `${defaultLine(payload, usageRecord(payload, now))}\n`);
  assert.match(defaultLine(payload, usageRecord(payload, now)), /Opus 5\.5 · ox · 5h 84% · week 22%/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'plan-usage', 'claude.json'), 'utf8')).rate_limits.five_hour.used_percentage, 84);
  fs.writeFileSync(path.join(home, 'statusline-previous.json'), JSON.stringify({ command: 'cat >/dev/null; echo mine' }));
  assert.equal(runStatusline(JSON.stringify(payload), { env, now }), 'mine\n', 'your own status line still shows');
  assert.equal(runStatusline('not json', { env, now }), 'mine\n', 'bad input never breaks Claude Code');
});

test('connecting Claude routes the status line through ox and keeps yours; disconnecting puts it back', (t) => {
  const home = tmp(t);
  process.env.OX_HOME = home;
  t.after(() => { delete process.env.OX_HOME; });
  const file = path.join(home, 'settings.json');
  const mine = { type: 'command', command: '~/.claude/my-line.sh', padding: 1 };
  fs.writeFileSync(file, JSON.stringify({ statusLine: mine, model: 'opus' }, null, 2));
  const plan = planInstall('claude', { file });
  assert.match(JSON.parse(plan.afterText).statusLine.command, / statusline$/);
  assert.equal(JSON.parse(plan.afterText).statusLine.padding, 1);
  assert.equal(JSON.parse(plan.afterText).model, 'opus', 'nothing else touched');
  applyInstall(plan);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'statusline-previous.json'), 'utf8')).statusLine, mine);
  applyInstall(planInstall('claude', { file, remove: true }));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).statusLine, mine, 'your status line is back');
  assert.equal(fs.existsSync(path.join(home, 'statusline-previous.json')), false);
  assert.equal(withHooks({}, { agent: 'codex' }).statusLine, undefined, 'only Claude has a status line');
});

test('limit alerts: once at 80 %, once at 95 %, per reset period', (t) => {
  const file = path.join(tmp(t), 'alerts.json');
  const plans = (pct) => [{ id: 'claude', windows: [{ name: '5-hour', usedPercent: pct, resetsAt: now + 3_600_000 }] }];
  assert.deepEqual(limitAlerts(plans(70), { now, file }), []);
  const a = limitAlerts(plans(84), { now, file });
  assert.equal(a.length, 1);
  assert.match(a[0].text, /Claude 5-hour limit at 84%: resets in 1 h 0 min/);
  assert.deepEqual(limitAlerts(plans(86), { now, file }), [], 'not again at the same level');
  assert.equal(limitAlerts(plans(96), { now, file })[0].level, 95);
  assert.deepEqual(limitAlerts([{ id: 'claude', windows: [{ name: '5-hour', usedPercent: 99, resetsAt: now - 1 }] }], { now, file }), [], 'a past period is ignored');
});
