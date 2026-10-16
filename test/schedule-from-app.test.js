// A scheduled run made from the app goes through the same screening, cost cap
// and refusals as `ox schedule add`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const realHome = process.env.HOME;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-sched-home-'));
process.env.HOME = home;
const { scheduleAdd } = await import('../src/app-api.js');
test.after(() => { process.env.HOME = realHome; fs.rmSync(home, { recursive: true, force: true }); });

test('every 1d and daily at 9:00 are made and on; nonsense cadences are refused', async () => {
  let v = await scheduleAdd({ prompt: 'summarise yesterday commits', when: 'every 1d', cwd: home });
  assert.equal(v.schedules.length, 1);
  assert.equal(v.schedules[0].enabled, true);
  assert.equal(v.schedules[0].cadence, 'every 1d');
  v = await scheduleAdd({ prompt: 'check open pull requests', when: 'daily at 9:00', cwd: home });
  assert.equal(v.schedules.length, 2);
  await assert.rejects(scheduleAdd({ prompt: 'x', when: 'whenever' }), /cadence/);
  await assert.rejects(scheduleAdd({ prompt: '', when: 'every 1d' }), /prompt/);
});
