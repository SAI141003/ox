import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ox-extras-'));

test('film styles: the library and my own styles, by slug', async () => {
  const F = await import('../src/studio-films.js');
  const home = tmp();
  const lib = path.join(home, 'lib');
  const style = (root, slug, en) => { fs.mkdirSync(path.join(root, slug), { recursive: true }); fs.writeFileSync(path.join(root, slug, 'style.json'), JSON.stringify({ slug, en, category_en: 'Games', line: 'a line' })); fs.writeFileSync(path.join(root, slug, 'STYLE.md'), `# ${en}`); };
  style(path.join(lib, 'styles'), 'pixel-rpg', '16-bit Pixel RPG');
  style(path.join(lib, 'styles'), '_template', 'Template');
  style(path.join(home, 'lemo-my-styles'), 'my-look', 'My Look');
  fs.writeFileSync(path.join(lib, 'AGENTS.md'), '');
  const env = { HOME: home, OX_FILM_LIB: lib };
  const all = F.filmStyles({ env });
  assert.deepEqual(all.map((s) => [s.slug, s.mine]), [['pixel-rpg', false], ['my-look', true]]);
  assert.match(F.filmStyle('pixel-rpg', { env }).style, /16-bit Pixel RPG/);
  assert.throws(() => F.filmStyle('../etc', { env }), /named like/);
  assert.throws(() => F.filmStyle('nope', { env }), /no film style/);
  assert.equal(F.filmLibStatus({ env }).styles, 2);
});

test('craft: status reads what is installed; a release without a checksum is refused', async () => {
  const K = await import('../src/studio-craft.js');
  const home = tmp();
  const env = { HOME: home, OX_HOME: path.join(home, '.ox') };
  fs.mkdirSync(path.join(home, 'Applications', 'PhotoCraft.app'), { recursive: true });
  fs.mkdirSync(path.dirname(K.cliPath('filmcraft', env)), { recursive: true });
  fs.writeFileSync(K.cliPath('filmcraft', env), '');
  const st = K.craftStatus({ env, servers: { filmcraft: {} } });
  const by = Object.fromEntries(st.map((x) => [x.id, x]));
  assert.ok(by.photocraft.app && !by.photocraft.cli);
  assert.ok(by.filmcraft.cli && by.filmcraft.mcp && !by.filmcraft.app);
  assert.equal(st.length, 13);

  const rel = (digest) => async () => ({ ok: true, json: async () => ({ tag_name: 'v1.2.0', assets: [{ name: 'photocraft-1.2.0-macos-universal.dmg', browser_download_url: 'https://x/a.dmg', size: 10, digest }, { name: 'photocraft-cli-1.2.0-macos-universal.zip', browser_download_url: 'https://x/c.zip', size: 5, digest }] }) });
  const a = await K.latestAsset('photocraft', 'app', { fetchImpl: rel(`sha256:${'a'.repeat(64)}`) });
  assert.deepEqual([a.name, a.version, a.sha256.length], ['photocraft-1.2.0-macos-universal.dmg', '1.2.0', 64]);
  assert.equal((await K.latestAsset('photocraft', 'cli', { fetchImpl: rel(`sha256:${'b'.repeat(64)}`) })).name, 'photocraft-cli-1.2.0-macos-universal.zip');
  await assert.rejects(K.latestAsset('photocraft', 'app', { fetchImpl: rel(null) }), /no published checksum/);
  await assert.rejects(K.latestAsset('notanapp', 'app', { fetchImpl: rel(null) }), /Craft apps:/);
});

test('studio tools: film_styles and craft_apps answer', async () => {
  const { createStudio, STUDIO_MCP_TOOLS } = await import('../src/studio-mcp.js');
  assert.ok(STUDIO_MCP_TOOLS.some((t) => t.name === 'film_styles') && STUDIO_MCP_TOOLS.some((t) => t.name === 'craft_apps'));
  const home = tmp();
  const s = createStudio({ env: { HOME: home, OX_FILM_LIB: path.join(home, 'none'), OX_HOME: path.join(home, '.ox') } });
  assert.match(await s.call('film_styles', {}), /not on this machine yet/);
  assert.match(await s.call('craft_apps', {}), /photocraft: PhotoCraft \(Photoshop\)/);
  assert.match(await s.call('workflow_instructions', { name: 'code-film' }), /TREATMENT\.md/);
});
