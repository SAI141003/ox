// ox in JetBrains IDEs: an entry in ~/.jetbrains/acp.json, other agents kept, a broken file never rewritten.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setupJetBrains, removeJetBrains, jetbrainsStatus, acpJsonPath, oxAgentEntry } from '../src/jetbrains.js';

const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ox-jb-'));

test('setup writes ox with absolute paths and keeps the other agents', () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, '.jetbrains'));
  fs.writeFileSync(acpJsonPath(home), JSON.stringify({ default_mcp_settings: { use_idea_mcp: true }, agent_servers: { other: { command: '/bin/other', args: ['acp'] } } }));
  const r = setupJetBrains({ home });
  assert.equal(r.changed, true);
  assert.ok(fs.existsSync(r.backup));
  const doc = JSON.parse(fs.readFileSync(acpJsonPath(home), 'utf8'));
  assert.deepEqual(doc.agent_servers.other, { command: '/bin/other', args: ['acp'] });
  assert.deepEqual(doc.default_mcp_settings, { use_idea_mcp: true });
  assert.ok(path.isAbsolute(doc.agent_servers.ox.command));
  assert.deepEqual(doc.agent_servers.ox.args.slice(1), ['acp', 'server']);
  assert.equal(setupJetBrains({ home }).changed, false, 'running it again changes nothing');
  assert.equal(jetbrainsStatus({ home }).ok, true);
  assert.equal(removeJetBrains({ home }).changed, true);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(acpJsonPath(home), 'utf8')).agent_servers), ['other']);
});

test('a file that is not valid JSON is left alone, with a reason', () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, '.jetbrains'));
  fs.writeFileSync(acpJsonPath(home), '{ "agent_servers": { "a": 1, } }');
  assert.throws(() => setupJetBrains({ home }), /not valid JSON.*left as it was/);
  assert.equal(fs.readFileSync(acpJsonPath(home), 'utf8'), '{ "agent_servers": { "a": 1, } }');
  assert.match(jetbrainsStatus({ home }).error, /not valid JSON/);
});

test('a fresh machine gets a new file, and the command really starts ox', () => {
  const home = tmpHome();
  assert.equal(setupJetBrains({ home }).backup, null);
  const e = oxAgentEntry();
  assert.ok(fs.existsSync(e.command) && fs.existsSync(e.args[0]), 'node and bin/ox.js both exist');
});
