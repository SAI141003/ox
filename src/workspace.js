// Where ox works, like a person at a terminal: in the folder you open, or the
// one you pick, and anywhere you send it. Never inside ox's own install by
// default, and a new project gets a folder of its own where you keep projects,
// not a hidden one of ox's.
//
//   defaultWorkspace()  the folder a chat starts in: the folder ox was started
//                       in, unless that is ox's own install (the app starts its
//                       server there); then your home folder
//   projectsDir()       where new projects go: OX_PROJECTS_DIR, config
//                       projectsDir, else the first of ~/Projects, ~/projects,
//                       ~/Developer, ~/code, ~/dev, ~/src that exists, else home
//   newProjectDir(name) a free folder for a new project there
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const OX_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

export function isOxInstall(dir) {
  return real(dir) === real(OX_ROOT);
}

export function defaultWorkspace({ cwd = process.cwd(), home = os.homedir() } = {}) {
  if (!cwd || cwd === path.parse(cwd).root || isOxInstall(cwd)) return home;
  return cwd;
}

export function projectsDir({ env = process.env, home = os.homedir(), config = null } = {}) {
  const set = env.OX_PROJECTS_DIR || config?.projectsDir;
  if (set) return path.resolve(String(set).replace(/^~(?=$|[\\/])/, home));
  for (const d of ['Projects', 'projects', 'Developer', 'code', 'dev', 'src']) {
    const p = path.join(home, d);
    try { if (fs.statSync(p).isDirectory()) return p; } catch {}
  }
  return home;
}

// A project's folder name from how it was asked: "hey build me a 3D game" → 3d-game.
const FILLER = new Set('a an the me hey hi please can could would you i we want need build make create write give set up setup new simple tiny small little quick basic in with using use plain for my our that which and of to on as it this some like app'.split(' '));
export function slugOf(s) {
  const words = String(s ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const kept = words.filter((w) => !FILLER.has(w));
  const pick = (kept.length ? kept : words).slice(0, 4).join('-').slice(0, 32).replace(/-+$/, '');
  return pick || 'project';
}

/** A folder for a new project, named after it, that does not exist yet. */
export function newProjectDir(name, opts = {}) {
  const base = projectsDir(opts);
  // A name given as a name ("Todo App") keeps its words; only a request is trimmed (teamDirFor).
  const slug = String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'project';
  let dir = path.join(base, slug);
  for (let i = 2; fs.existsSync(dir); i++) dir = path.join(base, `${slug}-${i}`);
  return dir;
}

/** The project folder a request names, if it names one ("in ~/code/shop", "at /tmp/x"). */
export function namedFolder(text, { home = os.homedir() } = {}) {
  const m = /\b(?:in|into|at|inside|under)\s+((?:~|\/)[^\s,;'"`]+)/i.exec(String(text ?? ''));
  return m ? path.resolve(m[1].replace(/^~(?=$|\/)/, home).replace(/[.)]+$/, '')) : null;
}

/** Is this folder a project (a git repo or a package), not a folder of projects? */
export function isProject(dir) {
  return ['.git', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'Package.swift'].some((f) => fs.existsSync(path.join(dir, f)));
}

/**
 * Where a team builds a task asked in a session working in `cwd`: in that
 * project when it is one, else a new folder for the task inside it (your
 * workspace), or where you keep projects when the session is in your home.
 */
export function teamDirFor(cwd, task, { home = os.homedir(), env = process.env, config = null } = {}) {
  const here = cwd ? path.resolve(cwd) : null;
  if (here && isProject(here) && !isOxInstall(here)) return here;
  const base = !here || real(here) === real(home) || isOxInstall(here) || here === path.parse(here).root ? projectsDir({ env, home, config }) : here;
  const slug = slugOf(task);
  let dir = path.join(base, slug);
  for (let i = 2; fs.existsSync(dir); i++) dir = path.join(base, `${slug}-${i}`);
  return dir;
}
