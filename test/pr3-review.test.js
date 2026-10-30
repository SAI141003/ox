// The fixes from the PR #3 review: each one checked on the behaviour the review described.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { remember, load, memoryFile } from '../src/memory-graph.js';
import { sleep, sleepAll, recordLesson, compatible } from '../src/memory-layer.js';
import { noteMemoryEvent } from '../src/memory-events.js';
import { autoOpenCmd } from '../src/tools/fs.js';
import { mediaMadeSince, wantsMediaMade } from '../src/serve.js';

const fresh = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-pr3-'));
  process.env.OX_MEMORY_HOME = path.join(home, '.ox', 'memory');
  return { home, file: memoryFile('user', { home }) };
};

test('sleep keeps facts about different things apart, however alike the words', () => {
  const { home, file } = fresh();
  const a = remember('Payments production PostgreSQL database connection port: 5432', { file, kind: 'fact' });
  const b = remember('Analytics production PostgreSQL database connection port: 5432', { file, kind: 'fact' });
  assert.equal(compatible({ kind: 'fact', text: 'Payments db port 5432' }, { kind: 'fact', text: 'Analytics db port 5432' }), false);
  assert.equal(compatible({ kind: 'fact', text: 'db port 5432' }, { kind: 'fact', text: 'db port 5433' }), false);
  sleep({ file, home, recalls: new Map() });
  const live = load(file).filter((m) => m.state === 'active');
  assert.ok(live.some((m) => m.id === a.memory.id) && live.some((m) => m.id === b.memory.id), 'both survive');
});

test('a lesson is screened like any other memory', () => {
  const { file } = fresh();
  const bad = recordLesson('auth failed with ghp_abcdefghijklmnopqrstuvwxyz0123456789, use it next time', { file });
  assert.equal(bad.op, 'refused');
  assert.equal(load(file).length, 0, 'nothing written');
  assert.ok(recordLesson('When npm install fails with EACCES, use a user prefix', { file }).id);
});

test('sleepAll gives both graphs the recalls logged before the cursor moves', () => {
  const { home, file } = fresh();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-pr3-proj-'));
  const u = remember('I prefer pnpm over npm', { file });
  const projFile = memoryFile('project', { cwd });
  const p = remember('This repo deploys with fly.io', { file: projFile, scope: 'project', cwd });
  noteMemoryEvent('read', { ids: [u.memory.id, p.memory.id], tokens: 10 }, { home });
  sleepAll({ home, cwd });
  assert.ok((load(file).find((m) => m.id === u.memory.id).recalled ?? 0) >= 1, 'user memory reinforced');
  assert.ok((load(projFile).find((m) => m.id === p.memory.id).recalled ?? 0) >= 1, 'project memory reinforced too');
});

test('a written page opens on Windows without cmd.exe', () => {
  const [cmd, args] = autoOpenCmd('win32', 'C:\\\\w\\\\a&calc&b.html');
  assert.equal(cmd, 'rundll32.exe');
  assert.ok(!args.includes('/c'));
  assert.equal(args.at(-1), 'C:\\\\w\\\\a&calc&b.html');
});

test('a turn shows only its own Studio pictures', async () => {
  const now = Date.now();
  const rows = [
    { id: 'mine', run: 'r1', status: 'completed', files: ['/m/1.png'], at: now, prompt: 'a dog' },
    { id: 'other', run: 'r2', status: 'completed', files: ['/m/2.png'], at: now, prompt: 'a dog' },
    { id: 'cli-match', status: 'completed', files: ['/m/3.png'], at: now, prompt: 'golden retriever puppy' },
    { id: 'cli-other', status: 'completed', files: ['/m/4.png'], at: now, prompt: 'city skyline at night' },
  ];
  const got = await mediaMadeSince(now - 1000, { history: () => rows, run: 'r1', said: 'make a picture of a golden retriever' });
  assert.deepEqual(got.map((u) => u.split('/')[3]), ['mine', 'cli-match']);
});

test('drawing requests keep their scene words', () => {
  assert.equal(wantsMediaMade('draw a cat sitting on a table'), true);
  assert.equal(wantsMediaMade('make a table of prices'), false);
});

test('removing and re-adding a gallery connector starts again at Ask', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-pr3-gal-'));
  const api = new URL('../src/app-api.js', import.meta.url).href;
  const cfg = new URL('../src/config.js', import.meta.url).href;
  try {
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
      const { addGalleryConnector, saveConnector } = await import(${JSON.stringify(api)});
      const { readConfigDoc } = await import(${JSON.stringify(cfg)});
      await addGalleryConnector({ id: 'notion' });
      await saveConnector({ name: 'notion', action: 'policy', policy: 'allow' });
      await addGalleryConnector({ id: 'notion', action: 'remove' });
      await addGalleryConnector({ id: 'notion' });
      console.log(JSON.stringify(readConfigDoc().mcpPolicy?.notion ?? 'ask'));
    `], { env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8' });
    assert.equal(JSON.parse(out.trim().split('\n').pop()), 'ask');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('an explicit model survives when the provider is left automatic', async () => {
  const { pick } = await import('../src/tools/media.js');
  assert.equal(pick({ kind: 'image', provider: 'openai', model: 'gpt-image-1' }, { OPENAI_API_KEY: 'x' }).model, 'gpt-image-1');
});
