// API keys pasted into the app (Settings → Providers → API keys).
//
// Kept in ~/.ox/keys.json, mode 0600, readable only by your account. A key
// already in the environment always wins: the file only fills in variables
// the shell did not set, so `export ANTHROPIC_API_KEY=…` keeps working as it
// always has. Nothing here ever sends a key anywhere; the app only ever sees
// the last four characters.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const KEYS_FILE = () => path.join(process.env.OX_HOME || path.join(os.homedir(), '.ox'), 'keys.json');

// Only variable names that look like credentials can be stored or loaded, so the
// file can never set PATH, NODE_OPTIONS or anything else that changes how ox runs.
export const KEY_NAME = /^[A-Z][A-Z0-9_]{1,60}_(?:KEY|TOKEN)$/;

export function readKeys(file = KEYS_FILE()) {
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return {};
    return Object.fromEntries(Object.entries(doc).filter(([k, v]) => KEY_NAME.test(k) && typeof v === 'string' && v));
  } catch {
    return {};
  }
}

// Fill in what the environment does not already have. Returns the names loaded.
export function loadKeysIntoEnv(env = process.env, file = KEYS_FILE()) {
  if (env.OX_NO_KEYSTORE === '1') return [];
  const loaded = [];
  for (const [k, v] of Object.entries(readKeys(file))) {
    if (!env[k]) { env[k] = v; loaded.push(k); }
  }
  return loaded;
}

// Save (value) or remove (null) one key; applies to `env` straight away.
export function setKey(name, value, { env = process.env, file = KEYS_FILE() } = {}) {
  if (!KEY_NAME.test(String(name))) throw new Error(`not a key name: ${name}`);
  const keys = readKeys(file);
  const v = typeof value === 'string' ? value.trim() : '';
  if (v) {
    if (/\s/.test(v) || v.length > 512) throw new Error('that does not look like an API key (spaces, or too long)');
    keys[name] = v;
    env[name] = v;
  } else {
    // Only clear the environment when the value came from this file.
    if (keys[name] && env[name] === keys[name]) delete env[name];
    delete keys[name];
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(keys, null, 2)}\n`, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
  return keys;
}

// Where a variable's value comes from, and a hint safe to show: never the key.
export function keyStatus(name, env = process.env, file = KEYS_FILE()) {
  const v = env[name];
  if (!v) return { set: false };
  const saved = readKeys(file)[name];
  return { set: true, source: saved && saved === v ? 'app' : 'environment', hint: v.length > 8 ? `…${v.slice(-4)}` : '…' };
}
