// Keep the agent out of secrets: .env files, private keys and credential files
// are refused by the file tools (read, write, edit, search) by default, and a
// project can name more in an .oxignore file at its root, gitignore-style:
//
//   # .oxignore
//   config/prod.yml        a path from the project root
//   *.sqlite               a name anywhere
//   private/               a whole folder
//   !.env.test             an exception (re-allowed)
//
// The default list covers what leaks most: .env and .env.* (but not
// .env.example / .sample / .template), *.pem, *.key, *.p12, *.pfx, SSH keys,
// .npmrc / .pypirc / .netrc, credentials.json, service-account*.json, and
// secrets.* files. OX_ALLOW_SECRET_READS=1 (or the older OX_ALLOW_SENSITIVE_READS=1)
// turns the fence off for one run.
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_PATTERNS = Object.freeze([
  '.env', '.env.*', '!.env.example', '!.env.sample', '!.env.template', '!.env.defaults',
  '*.pem', '*.key', '*.p12', '*.pfx', '*.keystore', '*.jks',
  'id_rsa', 'id_rsa.*', 'id_ed25519', 'id_ed25519.*', 'id_ecdsa', 'id_dsa', '!*.pub',
  '.npmrc', '.pypirc', '.netrc', '.git-credentials', '.htpasswd',
  'credentials.json', 'service-account*.json', 'secrets.*', '.secrets', '*.secret', '*.secrets',
]);

/** A gitignore-style pattern → a test on the path relative to the project root. */
export function compile(raw) {
  let p = String(raw).trim();
  if (!p || p.startsWith('#')) return null;
  const negate = p.startsWith('!');
  if (negate) p = p.slice(1);
  const dirOnly = p.endsWith('/');
  if (dirOnly) p = p.slice(0, -1);
  const anchored = p.includes('/');
  if (p.startsWith('/')) p = p.slice(1);
  const rx = p.split('**').map((part) => part.split('*').map((x) => x.split('?').map((y) => y.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('[^/]')).join('[^/]*')).join('.*');
  const re = new RegExp(anchored ? `^${rx}(?:/.*)?$` : `(?:^|/)${rx}${dirOnly ? '/.*' : '(?:/.*)?'}$`);
  return { raw: String(raw).trim(), negate, test: (rel) => re.test(rel) };
}

const cache = new Map();
/** The rules for a project: the defaults, then its .oxignore (later rules win). */
export function rules(root) {
  const file = root ? path.join(root, '.oxignore') : null;
  let mtime = 0;
  try { mtime = file ? fs.statSync(file).mtimeMs : 0; } catch {}
  const key = `${root}\0${mtime}`;
  if (cache.has(key)) return cache.get(key);
  let extra = [];
  try { extra = mtime ? fs.readFileSync(file, 'utf8').split(/\r?\n/) : []; } catch {}
  const list = [...DEFAULT_PATTERNS, ...extra].map(compile).filter(Boolean);
  cache.set(key, list);
  return list;
}

/**
 * Is this file a secret the agent must not touch? → the pattern that matched,
 * or null. root: the project folder (its .oxignore applies; paths outside it are
 * judged by name only).
 */
export function secretMatch(absPath, root, env = process.env) {
  if (env.OX_ALLOW_SECRET_READS === '1' || env.OX_ALLOW_SENSITIVE_READS === '1') return null;
  const abs = path.resolve(String(absPath ?? ''));
  const base = root ? path.resolve(root) : null;
  let rel = base ? path.relative(base, abs) : '';
  if (!base || rel.startsWith('..') || path.isAbsolute(rel)) rel = path.basename(abs);
  rel = rel.split(path.sep).join('/');
  let hit = null;
  for (const r of rules(base)) if (r.test(rel)) hit = r.negate ? null : r.raw;
  return hit;
}
