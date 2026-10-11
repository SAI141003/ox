import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const realHome = process.env.HOME;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-config-home-'));
process.env.HOME = home;

const { loadConfig } = await import('../src/config.js');

const plain = (o) => JSON.parse(JSON.stringify(o));

const OX_KEYS = ['OX_YOLO', 'OX_MAX_COST', 'OX_BASE_URL', 'OX_API_KEY', 'OX_MODEL'];
const savedEnv = Object.fromEntries(OX_KEYS.map((k) => [k, process.env[k]]));
for (const k of OX_KEYS) delete process.env[k];

test('config precedence, mcp merge, var expansion, malformed JSON', async (t) => {
  t.after(() => {
    fs.rmSync(home, { recursive: true, force: true });
    process.env.HOME = realHome;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const cfgDir = path.join(home, '.ox');
  const projDir = path.join(home, 'project');
  const writeConfig = (obj) => {
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify(obj));
  };

  await t.test('defaults when no file and no env', () => {
    const c = loadConfig({ cwd: projDir });
    assert.equal(c.defaultBot, 'ox-grok');
    assert.equal(c.baseUrl, null);
    assert.equal(c.apiKey, null);
    assert.equal(c.model, null);
    assert.equal(c.maxCostUsd, null);
    assert.equal(c.yolo, false);
    assert.deepEqual({ ...c.mcpServers }, {});
    assert.equal(Object.getPrototypeOf(c.mcpServers), null);
  });

  await t.test('precedence flags > env > file > defaults', () => {
    writeConfig({ model: 'from-file', max_cost: 5, base_url: 'http://file.example/v1' });

    const fileOnly = loadConfig({ cwd: projDir });
    assert.equal(fileOnly.model, 'from-file');
    assert.equal(fileOnly.maxCostUsd, 5);
    assert.equal(fileOnly.baseUrl, 'http://file.example/v1');

    process.env.OX_MODEL = 'from-env';
    process.env.OX_MAX_COST = '2.5';
    const envWins = loadConfig({ cwd: projDir });
    assert.equal(envWins.model, 'from-env');
    assert.equal(envWins.maxCostUsd, 2.5);

    const flagWins = loadConfig({ cwd: projDir, model: 'from-flag', maxCostUsd: 1.25 });
    assert.equal(flagWins.model, 'from-flag');
    assert.equal(flagWins.maxCostUsd, 1.25);

    delete process.env.OX_MODEL;
    delete process.env.OX_MAX_COST;

    process.env.OX_BASE_URL = 'http://env.example/v1';
    assert.equal(loadConfig({ cwd: projDir }).baseUrl, 'http://env.example/v1');
    assert.equal(
      loadConfig({ cwd: projDir, baseUrl: 'http://flag.example/v1' }).baseUrl,
      'http://flag.example/v1'
    );
    delete process.env.OX_BASE_URL;
  });

  await t.test('cost caps accept zero and reject invalid configured values', () => {
    writeConfig({ maxCostUsd: 0 });
    assert.equal(loadConfig({ cwd: projDir }).maxCostUsd, 0);
    for (const value of [-1, 'NaN', 'Infinity', 'bad', true, ' ']) {
      writeConfig({ maxCostUsd: value });
      assert.throws(() => loadConfig({ cwd: projDir }), /finite nonnegative/);
    }
    writeConfig({ maxCostUsd: 5 });
    process.env.OX_MAX_COST = '0';
    assert.equal(loadConfig({ cwd: projDir }).maxCostUsd, 0);
    assert.equal(loadConfig({ cwd: projDir, maxCostUsd: 2 }).maxCostUsd, 2);
    process.env.OX_MAX_COST = 'bad';
    assert.throws(() => loadConfig({ cwd: projDir }), /finite nonnegative/);
    assert.equal(loadConfig({ cwd: projDir, maxCostUsd: 2 }).maxCostUsd, 2);
    delete process.env.OX_MAX_COST;
  });

  await t.test('project .mcp.json merges over global mcpServers', () => {
    writeConfig({
      mcpServers: {
        shared: { command: 'global-shared' },
        'only-global': { command: 'g' },
      },
    });
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(
      path.join(projDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          shared: { command: 'project-shared', args: ['x'] },
          'only-project': { url: 'http://p' },
        },
      })
    );
    const c = loadConfig({ cwd: projDir });
    assert.deepEqual(plain(c.mcpServers), {
      shared: { command: 'project-shared', args: ['x'] },
      'only-global': { command: 'g' },
      'only-project': { url: 'http://p' },
    });
  });

  await t.test('${VAR:-default} expansion in mcpServers', () => {
    process.env.OX_TEST_TOKEN = 'secret-tok';
    try {
      writeConfig({
        mcpServers: {
          srv: {
            env: {
              TOKEN: '${OX_TEST_TOKEN}',
              FALLBACK: '${OX_TEST_MISSING:-fallback-val}',
            },
          },
        },
      });
      const c = loadConfig({ cwd: projDir });
      assert.deepEqual(plain(c.mcpServers.srv?.env ?? {}), {
        TOKEN: 'secret-tok',
        FALLBACK: 'fallback-val',
      });
    } finally {
      delete process.env.OX_TEST_TOKEN;
    }
  });

  await t.test('malformed global config.json throws error naming the file', () => {
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(path.join(cfgDir, 'config.json'), '{"model": "x",,,}');
    assert.throws(() => loadConfig({ cwd: projDir }), (err) =>
      err.message.includes(path.join(cfgDir, 'config.json'))
    );
  });

  await t.test('malformed project .mcp.json throws error naming the file', () => {
    writeConfig({ model: 'ok' });
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, '.mcp.json'), '{ broken');
    assert.throws(() => loadConfig({ cwd: projDir }), (err) =>
      err.message.includes(path.join(projDir, '.mcp.json'))
    );
  });

  await t.test('expandVars drops prototype-pollution keys from hostile .mcp.json', () => {
    writeConfig({});
    fs.mkdirSync(projDir, { recursive: true });
    const hostile =
      '{"mcpServers":{"__proto__":{"polluted":"pwned"},"constructor":{"polluted":1},"prototype":{"polluted":1},"safe":{"command":"echo"}}}';
    fs.writeFileSync(path.join(projDir, '.mcp.json'), hostile);
    const c = loadConfig({ cwd: projDir });
    assert.deepEqual(plain(c.mcpServers), { safe: { command: 'echo' } });
    assert.equal(Object.keys(c.mcpServers).includes('__proto__'), false);
    assert.equal(Object.keys(c.mcpServers).includes('constructor'), false);
    assert.equal(Object.keys(c.mcpServers).includes('prototype'), false);
    assert.equal(({}).polluted, undefined);
    assert.equal(Object.prototype.polluted, undefined);
  });
});
