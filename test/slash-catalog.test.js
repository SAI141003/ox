// Every ox command as a slash command (src/slash-catalog.js): the catalog
// matches real subcommands, parsing, the menu's matching, and installing into
// connected tools (Claude Code, Codex) in a scratch home, then removing exactly that.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const S = await import('../src/slash-catalog.js');

test('every command in the catalog is a real ox subcommand, described in a line', () => {
  const src = fs.readFileSync(new URL('../src/cli.js', import.meta.url), 'utf8');
  const subs = new Set([.../const SUBCOMMANDS = new Set\(\[([^\]]+)\]\)/.exec(src)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
  for (const c of S.COMMANDS) {
    assert.ok(subs.has(c.name), `/${c.name} has no ox ${c.name}`);
    assert.match(c.usage, new RegExp(`^/${c.name}\\b`));
    assert.ok(c.what.length > 8 && c.what.length < 90, c.name);
  }
  assert.equal(new Set(S.COMMANDS.map((c) => c.name)).size, S.COMMANDS.length);
});

test('parse keeps quoted words whole; unknown commands are not ours', () => {
  const p = S.parse('/browse "find flights to London" --url https://x.test');
  assert.equal(p.cmd.name, 'browse');
  assert.deepEqual(p.args, ['find flights to London', '--url', 'https://x.test']);
  assert.deepEqual(S.parse('/THEME use paper').args, ['use', 'paper']);
  assert.equal(S.parse('/model gpt'), null, 'chat built-ins stay in the chat');
  assert.equal(S.parse('hello /browse'), null);
});

test('the menu: name prefixes first, then whole words in the description', () => {
  assert.deepEqual(S.suggest('th').map((c) => c.name), ['theme']);
  assert.equal(S.suggest('br')[0].name, 'browse');
  assert.ok(S.suggest('vid').some((c) => c.name === 'studio'), 'description words count from 3 letters');
  assert.equal(S.suggest('').length, S.COMMANDS.length);
});

test('install into Claude Code and Codex, skip what is not installed, uninstall exactly that', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-slash-'));
  fs.mkdirSync(path.join(home, '.claude'));
  fs.mkdirSync(path.join(home, '.codex'));
  fs.mkdirSync(path.join(home, '.claude', 'commands'));
  fs.writeFileSync(path.join(home, '.claude', 'commands', 'mine.md'), 'my own command');
  const done = S.install({ home });
  assert.deepEqual(done.map((d) => d.tool), ['Claude Code', 'Codex'], 'Cursor is not installed here');
  const cmd = fs.readFileSync(path.join(home, '.claude', 'commands', 'ox-browse.md'), 'utf8');
  assert.match(cmd, /^---\ndescription: the fast browser/);
  assert.match(cmd, /allowed-tools: Bash\(ox browse:\*\)/);
  assert.match(cmd, /ox browse \$ARGUMENTS/);
  assert.ok(fs.existsSync(path.join(home, '.codex', 'prompts', 'ox-studio.md')));
  const skill = fs.readFileSync(path.join(home, '.claude', 'skills', 'ox', 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: ox\ndescription: Use ox's own commands/);
  assert.match(skill, /`ox browse "<goal>"/);
  assert.equal(S.uninstall({ home }), done.reduce((n, d) => n + d.files, 0));
  assert.equal(fs.readFileSync(path.join(home, '.claude', 'commands', 'mine.md'), 'utf8'), 'my own command', 'the user\'s own files stay');
  assert.ok(!fs.existsSync(path.join(home, '.claude', 'commands', 'ox-browse.md')));
  assert.ok(!fs.existsSync(path.join(home, '.claude', 'skills', 'ox')));
});

test('the built-in ox-commands skill is in step with the catalog', () => {
  const file = fs.readFileSync(new URL('../skills/ox-commands/SKILL.md', import.meta.url), 'utf8');
  assert.equal(file, S.skillFile('ox').replace('name: ox\n', 'name: ox-commands\n'));
});
