// The Craft apps in Studio: ArtCraft's open-source (Apache-2.0), clean-room
// rebuilds of Adobe's suite and more, in pure Rust (github.com/storytold).
// Each app has a desktop app (a signed, notarized DMG) and a command-line tool
// whose `mcp` subcommand is an MCP server, so any ox agent can drive it.
//
//   ~/Applications/<Name>.app            the app, from its latest release DMG
//   ~/.ox/craft/<id>/<id>-cli            the command-line tool, from its zip
//   ~/.agents/skills/<id>/SKILL.md       how to drive it (midasmatterhorn/artcraft-skills, MIT)
//   mcpServers["<id>"]                   `<id>-cli mcp`, added when the tool is
//
// Every download is checked against the sha256 GitHub publishes for the asset.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const CRAFT_APPS = Object.freeze([
  { id: 'photocraft', name: 'PhotoCraft', replaces: 'Photoshop', group: 'adobe', what: 'Photos and layered images: layers, masks, filters, type, PSD' },
  { id: 'lightcraft', name: 'LightCraft', replaces: 'Lightroom', group: 'adobe', what: 'Non-destructive photo and raw editing, catalogs, presets' },
  { id: 'vectorcraft', name: 'VectorCraft', replaces: 'Illustrator', group: 'adobe', what: 'Vector art, logos and icons; SVG, PDF, AI' },
  { id: 'designcraft', name: 'DesignCraft', replaces: 'InDesign', group: 'adobe', what: 'Page layout: brochures, books, magazines, IDML' },
  { id: 'pdfcraft', name: 'PdfCraft', replaces: 'Acrobat', group: 'adobe', what: 'Read, edit, sign, fill and merge PDFs' },
  { id: 'filmcraft', name: 'FilmCraft', replaces: 'Premiere Pro', group: 'adobe', what: 'Non-linear video editing on a timeline' },
  { id: 'effectcraft', name: 'EffectCraft', replaces: 'After Effects', group: 'adobe', what: 'Motion graphics and compositing' },
  { id: 'soundcraft', name: 'SoundCraft', replaces: 'Audition / Pro Tools', group: 'adobe', what: 'Recording, editing and mixing audio' },
  { id: 'figcraft', name: 'FigCraft', replaces: 'XD / Figma', group: 'adobe', what: 'Interface design and prototypes' },
  { id: 'wordcraft', name: 'WordCraft', replaces: 'Word', group: 'office', what: 'Documents; DOCX in and out' },
  { id: 'gridcraft', name: 'GridCraft', replaces: 'Excel', group: 'office', what: 'Spreadsheets with formulas and charts; XLSX' },
  { id: 'deckcraft', name: 'DeckCraft', replaces: 'PowerPoint', group: 'office', what: 'Slides and presentations; PPTX' },
  { id: 'cadcraft', name: 'CADCraft', replaces: 'AutoCAD', group: 'office', what: 'Drafting and CAD; DWG, DXF' },
]);

const SKILLS_REPO = 'midasmatterhorn/artcraft-skills';
const home = (env) => env.HOME || os.homedir();
const oxHome = (env) => env.OX_HOME || path.join(home(env), '.ox');
export const craftDir = (env = process.env) => path.join(oxHome(env), 'craft');
export const cliPath = (id, env = process.env) => path.join(craftDir(env), id, `${id}-cli`);
const appDirs = (env) => [path.join(home(env), 'Applications'), '/Applications'];
const skillDir = (id, env) => path.join(home(env), '.agents', 'skills', id);
const app = (id) => { const a = CRAFT_APPS.find((x) => x.id === id); if (!a) throw new Error(`Craft apps: ${CRAFT_APPS.map((x) => x.id).join(', ')}`); return a; };

/** Where each app is on this Mac: the app, its command-line tool, its skill, its MCP server. */
export function craftStatus({ env = process.env, servers = {} } = {}) {
  return CRAFT_APPS.map((a) => {
    const bundle = appDirs(env).map((d) => path.join(d, `${a.name}.app`)).find((p) => fs.existsSync(p)) ?? null;
    return { ...a, app: bundle, cli: fs.existsSync(cliPath(a.id, env)) ? cliPath(a.id, env) : null, skill: fs.existsSync(path.join(skillDir(a.id, env), 'SKILL.md')), mcp: Object.prototype.hasOwnProperty.call(servers, a.id), repo: `https://github.com/storytold/${a.id}` };
  });
}

/** The latest release's macOS asset: { name, url, size, sha256, version }. kind: 'app' (DMG) or 'cli' (zip). */
export async function latestAsset(id, kind, { fetchImpl = globalThis.fetch } = {}) {
  app(id);
  const r = await fetchImpl(`https://api.github.com/repos/storytold/${id}/releases/latest`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'ox' } });
  if (!r.ok) throw new Error(`could not read ${id}'s releases (${r.status})`);
  const rel = await r.json();
  const want = kind === 'cli' ? new RegExp(`^${id}-cli-.+-macos-universal\\.zip$`) : new RegExp(`^${id}-[\\d.]+-macos-universal\\.dmg$`);
  const a = (rel.assets ?? []).find((x) => want.test(x.name));
  if (!a) throw new Error(`${id} ${rel.tag_name ?? ''} has no macOS ${kind === 'cli' ? 'command-line tool' : 'app'}`);
  const sha256 = /^sha256:([0-9a-f]{64})$/.exec(a.digest ?? '')?.[1];
  if (!sha256) throw new Error(`${a.name} has no published checksum; not installing it`);
  return { name: a.name, url: a.browser_download_url, size: a.size, sha256, version: String(rel.tag_name ?? '').replace(/^v/, '') };
}

const run = (cmd, args) => { const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 10 * 60_000 }); if (r.status !== 0) throw new Error(`${cmd} failed: ${(r.stderr || r.stdout || '').trim().slice(-300)}`); return r.stdout; };

/** The skill that says how to drive the app, into ~/.agents/skills/<id>. */
export async function installSkill(id, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  app(id);
  const t = await fetchImpl(`https://api.github.com/repos/${SKILLS_REPO}/git/trees/HEAD?recursive=1`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'ox' } });
  if (!t.ok) throw new Error(`could not read the Craft skills (${t.status})`);
  const files = ((await t.json()).tree ?? []).filter((f) => f.type === 'blob' && (f.path === `${id}/SKILL.md` || f.path.startsWith(`${id}/references/`)));
  if (!files.length) throw new Error(`no skill for ${id} yet`);
  const dir = skillDir(id, env);
  for (const f of files) {
    const r = await fetchImpl(`https://raw.githubusercontent.com/${SKILLS_REPO}/HEAD/${f.path}`);
    if (!r.ok) throw new Error(`could not fetch ${f.path} (${r.status})`);
    const dest = path.join(dir, f.path.slice(id.length + 1));
    if (!dest.startsWith(dir + path.sep)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, await r.text());
  }
  fs.writeFileSync(path.join(dir, 'SOURCE'), `https://github.com/${SKILLS_REPO} (MIT)\n`);
  return dir;
}

/**
 * Install an app. what: 'app' (the desktop app), 'cli' (the command-line tool,
 * its MCP server and its skill), or 'both'. onStep(label) reports progress.
 */
export async function installCraft(id, { what = 'both', env = process.env, onStep = () => {}, fetchImpl = globalThis.fetch, saveConfigDoc = null } = {}) {
  const a = app(id);
  if (process.platform !== 'darwin') throw new Error('installing Craft apps from Studio is for macOS; other systems: see the release page');
  const { fetchTo } = await import('./studio-local.js');
  const dl = path.join(craftDir(env), 'downloads');
  fs.mkdirSync(dl, { recursive: true });
  const done = {};
  if (what === 'app' || what === 'both') {
    const asset = await latestAsset(id, 'app', { fetchImpl });
    onStep(`Downloading ${a.name} ${asset.version} (${Math.round(asset.size / 2 ** 20)} MB)`);
    const dmg = await fetchTo(asset.url, path.join(dl, asset.name), { sha256: asset.sha256, size: asset.size, fetchImpl, onProgress: (g, t) => onStep(`Downloading ${a.name}: ${Math.round((g / t) * 100)}%`) });
    const mnt = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-craft-'));
    onStep(`Installing ${a.name}`);
    try {
      run('hdiutil', ['attach', dmg, '-nobrowse', '-readonly', '-quiet', '-mountpoint', mnt]);
      const bundle = fs.readdirSync(mnt).find((f) => f.endsWith('.app'));
      if (!bundle) throw new Error(`no app inside ${asset.name}`);
      const dest = path.join(home(env), 'Applications', bundle);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.rmSync(dest, { recursive: true, force: true });
      run('ditto', [path.join(mnt, bundle), dest]);
      done.app = dest;
    } finally {
      spawnSync('hdiutil', ['detach', mnt, '-quiet']);
      fs.rmSync(mnt, { recursive: true, force: true });
      fs.rmSync(dmg, { force: true });
    }
  }
  if (what === 'cli' || what === 'both') {
    const asset = await latestAsset(id, 'cli', { fetchImpl });
    onStep(`Downloading the ${a.name} command-line tool (${Math.round(asset.size / 2 ** 20)} MB)`);
    const zip = await fetchTo(asset.url, path.join(dl, asset.name), { sha256: asset.sha256, size: asset.size, fetchImpl });
    const into = path.join(craftDir(env), id);
    const tmp = `${into}.new`;
    fs.rmSync(tmp, { recursive: true, force: true });
    try {
      run('ditto', ['-x', '-k', zip, tmp]);
      const found = run('find', [tmp, '-type', 'f', '-name', `${id}-cli`]).split('\n').find(Boolean);
      if (!found) throw new Error(`no ${id}-cli inside ${asset.name}`);
      fs.rmSync(into, { recursive: true, force: true });
      fs.mkdirSync(into, { recursive: true });
      fs.renameSync(found, cliPath(id, env));
      fs.chmodSync(cliPath(id, env), 0o755);
      done.cli = cliPath(id, env);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(zip, { force: true });
    }
    // Its MCP server, so agents can drive it (asks before each call, like any new connector).
    const save = saveConfigDoc ?? (await import('./config.js')).saveConfigDoc;
    save((doc) => { doc.mcpServers = { ...(doc.mcpServers ?? {}), [id]: { command: cliPath(id, env), args: ['mcp'] } }; });
    onStep(`Adding how to use ${a.name}`);
    try { done.skill = await installSkill(id, { env, fetchImpl }); } catch (e) { done.skillError = e.message; }
  }
  return done;
}

/** Remove what installCraft put here (the app only when ox put it in ~/Applications). */
export async function removeCraft(id, { env = process.env, saveConfigDoc = null } = {}) {
  const a = app(id);
  fs.rmSync(path.join(craftDir(env), id), { recursive: true, force: true });
  fs.rmSync(skillDir(id, env), { recursive: true, force: true });
  fs.rmSync(path.join(home(env), 'Applications', `${a.name}.app`), { recursive: true, force: true });
  const save = saveConfigDoc ?? (await import('./config.js')).saveConfigDoc;
  save((doc) => { if (doc.mcpServers?.[id]) { const next = { ...doc.mcpServers }; delete next[id]; doc.mcpServers = next; } });
}
