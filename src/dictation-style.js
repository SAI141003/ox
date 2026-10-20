// Dictation styles and translation (Coucou's Flow styles): what you said can
// be pasted as said, made natural (fillers out, punctuation in), polished
// (clear, well-formed sentences), or translated, per app. Settings live in
// ~/.ox/dictation-styles.json; the rewrite is one small model call.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const STYLES = ['as-said', 'natural', 'polished'];
const file = () => path.join(process.env.OX_HOME || path.join(os.homedir(), '.ox'), 'dictation-styles.json');

export function readStyles() {
  try { const d = JSON.parse(fs.readFileSync(file(), 'utf8')); return { default: STYLES.includes(d.default) ? d.default : 'as-said', apps: d.apps && typeof d.apps === 'object' ? d.apps : {}, translate: d.translate || null }; }
  catch { return { default: 'as-said', apps: {}, translate: null }; }
}
export function writeStyles(next) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}
export function setStyle(style, app = null) {
  if (!STYLES.includes(style)) throw new Error(`a style is one of ${STYLES.join(', ')}`);
  const s = readStyles();
  if (app) s.apps[app] = style; else s.default = style;
  return writeStyles(s);
}
export function setTranslate(lang) {
  const s = readStyles();
  s.translate = !lang || /^(off|none|no)$/i.test(lang) ? null : String(lang).slice(0, 40);
  return writeStyles(s);
}
/** The style and language for text going into `app`. */
export function styleFor(app) {
  const s = readStyles();
  return { style: s.apps[app] ?? s.default, translate: s.translate };
}

export function prompt({ style, translate, app }) {
  const parts = [];
  if (style === 'natural') parts.push('Clean up this dictation: remove fillers (um, uh, like, you know), false starts and repeated words; add punctuation and capitals. Keep the speaker\'s words and tone; do not add anything.');
  if (style === 'polished') parts.push('Turn this dictation into clear, well-formed writing: fix grammar, structure run-on speech into sentences (and short paragraphs if long). Keep the meaning and the speaker\'s voice; do not add facts.');
  if (translate) parts.push(`Then translate it into ${translate}, naturally, as a native speaker would write it.`);
  if (app) parts.push(`It will be pasted into ${app}; match that context (an email reads like an email, a chat like a chat).`);
  parts.push('Answer with the final text only: no quotes, no notes.');
  return parts.join(' ');
}

/** Rewrite `text` for `app` with `ask({ system, user })`; as said when nothing applies or the model fails. */
export async function restyle(text, app, ask) {
  const { style, translate } = styleFor(app);
  if (style === 'as-said' && !translate) return { text, style, changed: false };
  try {
    const out = String(await ask({ system: prompt({ style, translate, app }), user: text })).trim().replace(/^["“]|["”]$/g, '');
    if (!out || out.length > text.length * 4 + 200) return { text, style, changed: false, why: 'the model answer was unusable' };
    return { text: out, style, translate, changed: out !== text };
  } catch (e) { return { text, style, changed: false, why: e.message }; }
}
