// Film styles in Studio: the Lemo-Opuscar library (github.com/lemomo-ai/lemo-opuscar,
// MIT): 66+ styles of short film made entirely in code (HTML/Three.js frames,
// synthesized music and voice, rendered with ffmpeg), no video model. Each style
// is a STYLE.md prompt plus a demo film; AGENTS.md walks an agent from the
// brief to the finished film.
//
//   ~/lemo-opuscar            the library (OX_FILM_LIB to put it elsewhere)
//   ~/lemo-my-styles/<slug>   the user's own styles (the library's convention)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

export const FILM_REPO = 'https://github.com/lemomo-ai/lemo-opuscar.git';
export const filmLib = (env = process.env) => env.OX_FILM_LIB || path.join(env.HOME || os.homedir(), 'lemo-opuscar');
const myStyles = (env) => path.join(env.HOME || os.homedir(), 'lemo-my-styles');

function readStyle(dir, mine = false) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'style.json'), 'utf8'));
    return { slug: j.slug ?? path.basename(dir), name: j.en ?? j.slug, cn: j.cn ?? '', category: j.category_en ?? 'Other', film: j.film ?? '', line: j.line ?? '', uses: Array.isArray(j.uses) ? j.uses : [], mine };
  } catch { return null; }
}

/** The styles: the library's and the user's own, by category. */
export function filmStyles({ env = process.env } = {}) {
  const out = [];
  for (const [root, mine] of [[path.join(filmLib(env), 'styles'), false], [myStyles(env), true]]) {
    let names = [];
    try { names = fs.readdirSync(root); } catch {}
    for (const n of names.sort()) if (!n.startsWith('_') && !n.startsWith('.')) { const s = readStyle(path.join(root, n), mine); if (s) out.push(s); }
  }
  return out;
}

/** One style's prompt (STYLE.md), and where its demo lives. */
export function filmStyle(slug, { env = process.env } = {}) {
  if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(String(slug))) throw new Error('a style is named like ukiyoe or satellite-briefing');
  for (const root of [myStyles(env), path.join(filmLib(env), 'styles')]) {
    const dir = path.join(root, slug);
    if (fs.existsSync(path.join(dir, 'STYLE.md'))) return { ...readStyle(dir, root === myStyles(env)), dir, style: fs.readFileSync(path.join(dir, 'STYLE.md'), 'utf8') };
  }
  throw new Error(`no film style "${slug}"${fs.existsSync(filmLib(env)) ? '' : ': the library is not here yet (ox studio films setup)'}`);
}

export function filmLibStatus({ env = process.env } = {}) {
  const lib = filmLib(env);
  const here = fs.existsSync(path.join(lib, 'AGENTS.md'));
  const commit = here ? (spawnSync('git', ['-C', lib, 'log', '-1', '--format=%h %cs'], { encoding: 'utf8' }).stdout ?? '').trim() : null;
  return { lib, here, commit, deps: here && fs.existsSync(path.join(lib, 'node_modules')), styles: here ? filmStyles({ env }).length : 0 };
}

const git = (args, cwd) => new Promise((res, rej) => { const p = spawn('git', args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] }); let e = ''; p.stderr.on('data', (d) => (e += d)); p.on('error', rej); p.on('close', (c) => (c === 0 ? res() : rej(new Error(`git ${args[0]} failed: ${e.trim().slice(-300)}`)))); });

/**
 * Get or update the library. The demo films' video and sound (~90 MB) are left
 * out: agents read a demo's code, they do not need its render.
 */
export async function setupFilmLib({ env = process.env } = {}) {
  const lib = filmLib(env);
  if (fs.existsSync(path.join(lib, '.git'))) await git(['pull', '--ff-only', '-q'], lib);
  else {
    await git(['clone', '-q', '--filter=blob:none', '--no-checkout', FILM_REPO, lib]);
    await git(['sparse-checkout', 'set', '--no-cone', '/*', '!*.mp4', '!*.mov', '!*.webm', '!*.wav', '!*.mp3', '!*.gif', '!docs/frames/', '!styleboard/'], lib);
    await git(['checkout', '-q'], lib);
  }
  return filmLibStatus({ env });
}
