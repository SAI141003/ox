// Your personal dictionary for dictation (Coucou's Dictionary and Snippets),
// in ~/.ox/dictionary.json, shared with OX Island:
//
//   { "replace":  { "cloud code": "Claude Code", "ox island": "OX Island" },
//     "snippets": { "my address": "12 Main Street, Vancouver" } }
//
// Replacements fix words the recogniser gets wrong, whole words only and in
// any case; a snippet is a short phrase that, said on its own, pastes the whole
// text untouched. The island applies the same two rules (Dictation.swift).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DICT_FILE = () => path.join(process.env.OX_HOME || path.join(os.homedir(), '.ox'), 'dictionary.json');

export function loadDictionary(file = DICT_FILE()) {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { replace: d.replace && typeof d.replace === 'object' ? d.replace : {}, snippets: d.snippets && typeof d.snippets === 'object' ? d.snippets : {} };
  } catch {
    return { replace: {}, snippets: {} };
  }
}

export function saveDictionary(d, file = DICT_FILE()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ replace: d.replace ?? {}, snippets: d.snippets ?? {} }, null, 2)}\n`);
}

const norm = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function applyDictionary(text, d = loadDictionary()) {
  const said = String(text ?? '');
  const snip = Object.entries(d.snippets ?? {}).find(([k]) => norm(k) && norm(k) === norm(said));
  if (snip) return snip[1];
  let out = said;
  // Longest first, so "claude code cli" wins over "claude code".
  for (const [from, to] of Object.entries(d.replace ?? {}).sort((a, b) => b[0].length - a[0].length)) {
    if (!from.trim()) continue;
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escape(from.trim())}(?![\\p{L}\\p{N}])`, 'giu'), to);
  }
  return out;
}
