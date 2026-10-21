// Code-aware dictation (Wispr Flow's edge, kept on this Mac): when you dictate
// into an editor or a terminal, the island hands Apple's on-device recognizer
// the words of the project you are in (its most-used functions and classes,
// its file names) and your own dictionary, so "getUserById" or "authMiddleware"
// come out as you meant them. Nothing leaves the Mac.
import fs from 'node:fs';
import path from 'node:path';

export const CODE_APPS = /^(Terminal|iTerm2?|Warp|Ghostty|Alacritty|kitty|WezTerm|Code|Visual Studio Code|Cursor|Windsurf|Zed|Xcode|Nova|Sublime Text|IntelliJ IDEA|WebStorm|PyCharm|Android Studio|Claude|Codex|ChatGPT)$/i;
const cache = new Map(); // root -> { at, words }

/** Spoken-friendly identifiers from a project: [name] (at most `max`). */
export async function projectWords(root, { max = 80 } = {}) {
  const hit = cache.get(root);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.words;
  const G = await import('./code-graph.js');
  let g = null;
  try { g = G.loadGraph(root) ?? G.buildGraph(root, { maxFiles: 4000 }); } catch {}
  const names = new Set();
  if (g?.nodes?.length) {
    for (const n of G.godNodes(g, 200)) {
      const name = String(n.name ?? '').replace(/^.*[#/]/, '');
      if (name.length >= 4 && name.length <= 40 && /[A-Za-z]/.test(name) && !/^(index|main|test|default|constructor)$/i.test(name)) names.add(name);
      if (names.size >= max * 0.7) break;
    }
    for (const n of g.nodes.filter((x) => x.kind === 'file')) {
      const base = path.basename(String(n.file ?? n.id).replace(/^file:/, '')).replace(/\.[a-z0-9]+$/i, '');
      if (base.length >= 4 && base.length <= 32 && !/^(index|test|main)$/i.test(base)) names.add(base);
      if (names.size >= max) break;
    }
  }
  const words = [...names].slice(0, max);
  cache.set(root, { at: Date.now(), words });
  return words;
}

/** The words for dictating into `app`: project words in code apps, your dictionary everywhere. ≤ 100. */
export async function wordsFor(app, { root = null, dictionary = {} } = {}) {
  // Your dictionary (src/dictionary.js): what you say and what it becomes, and snippet names.
  const own = [...Object.keys(dictionary.replace ?? {}), ...Object.values(dictionary.replace ?? {}).filter((v) => typeof v === 'string'), ...Object.keys(dictionary.snippets ?? {})];
  const code = CODE_APPS.test(String(app ?? '')) && root && fs.existsSync(root) ? await projectWords(root) : [];
  return [...new Set([...own.filter((w) => w && w.length <= 40), ...code])].slice(0, 100);
}
