// Restyle ox from a sentence (the Nolee DevKit idea: "give the app launcher a
// neumorphic makeover"). You or an agent describe a look; ox turns it into the
// app's design tokens plus a little CSS, checks every value, and the open app
// picks it up within seconds. A theme can only change how ox looks: colours,
// fonts, sizes, shadows, radii. No remote loads (url(), @import), no scripts.
// Themes live in ~/.ox/themes/<name>.json; the active one in ~/.ox/theme.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = () => process.env.OX_HOME || path.join(os.homedir(), '.ox');
const DIR = () => path.join(home(), 'themes');
const ACTIVE = () => path.join(home(), 'theme.json');

/** The app's tokens (src/web/chat.html :root), and what each holds. */
export const TOKENS = Object.freeze({
  '--bg': 'color', '--side': 'color', '--panel': 'color', '--raise': 'color', '--hover': 'color', '--sel': 'color',
  '--line': 'color', '--line2': 'color', '--text': 'color', '--muted': 'color', '--dim': 'color',
  '--gold': 'color', '--gold-ink': 'color', '--btn': 'color', '--btn-ink': 'color',
  '--green': 'color', '--amber': 'color', '--red': 'color', '--blue': 'color',
  '--sans': 'font', '--mono': 'font', '--fs': 'size', '--tw': 'width', 'color-scheme': 'scheme',
});

const COLOR = /^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla|oklch|oklab)\([\d\s.,%/+-]+\)|transparent)$/i;
const FONT = /^[\w\s"',.-]{1,200}$/;

export function checkToken(name, value) {
  const kind = TOKENS[name];
  const v = String(value ?? '').trim();
  if (!kind) return null;
  if (kind === 'color') return COLOR.test(v) ? v : null;
  if (kind === 'font') return FONT.test(v) && !/url|expression|import/i.test(v) ? v : null;
  if (kind === 'size') { const n = /^(\d{2}(?:\.\d)?)px$/.exec(v); return n && +n[1] >= 12 && +n[1] <= 19 ? v : null; }
  if (kind === 'width') { const n = /^(\d{3,4})px$/.exec(v); return n && +n[1] >= 560 && +n[1] <= 1400 ? v : null; }
  if (kind === 'scheme') return v === 'dark' || v === 'light' ? v : null;
  return null;
}

/** Extra CSS: kept to looks. Remote loads, imports, scripts and closing tags are removed. */
export function cleanCss(css) {
  let s = String(css ?? '').slice(0, 8000);
  s = s.replace(/<\/?\w[^>]*>/g, '')
    .replace(/@import[^;]*;?/gi, '')
    .replace(/@font-face\s*\{[^}]*\}/gi, '')
    .replace(/url\s*\([^)]*\)/gi, 'none')
    .replace(/expression\s*\(|javascript:|behavior\s*:|-moz-binding/gi, '');
  // Balanced braces only; an unclosed rule is cut off.
  let depth = 0, cut = s.length;
  for (let i = 0; i < s.length; i++) { if (s[i] === '{') depth++; else if (s[i] === '}') { depth--; if (depth < 0) { cut = i; break; } } }
  s = s.slice(0, cut);
  if (depth > 0) s = s.slice(0, s.lastIndexOf('}') + 1);
  return s.trim();
}

/** A theme from any input: keeps only checked tokens and clean CSS. → { name, description, tokens, css, dropped } */
export function normalize(t = {}) {
  const tokens = {}, dropped = [];
  for (const [k, v] of Object.entries(t.tokens ?? {})) { const ok = checkToken(k, v); if (ok) tokens[k] = ok; else dropped.push(k); }
  const name = String(t.name ?? 'custom').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'custom';
  return { name, description: String(t.description ?? '').slice(0, 200), tokens, css: cleanCss(t.css), dropped };
}

// Card-like surfaces in the app, for presets that change their shape.
const SURFACES = '.gal-card,.tk-card,.ui-stat,.sc-tile,.mm-node,.lib-pop,.sheet,.cmp-pick > div';

export const PRESETS = Object.freeze({
  neumorphic: {
    name: 'neumorphic', description: 'Soft grey, raised cards and pressed buttons, no hard lines',
    tokens: { '--bg': '#E6E9EF', '--side': '#E6E9EF', '--panel': '#E6E9EF', '--raise': '#E6E9EF', '--hover': '#DDE1E8', '--sel': '#D5DAE2', '--line': 'transparent', '--line2': '#D1D6DE', '--text': '#2D3340', '--muted': '#5F6676', '--dim': '#8A90A0', '--gold': '#4F6BED', '--gold-ink': '#FFFFFF', '--btn': '#E6E9EF', '--btn-ink': '#2D3340', '--red': '#D9534F', 'color-scheme': 'light' },
    css: `${SURFACES}{border-color:transparent!important;border-radius:18px!important;box-shadow:8px 8px 16px #C5CAD3,-8px -8px 16px #FFFFFF!important}
button:not(.nav button):not(.kbd),.iconbtn{border:0!important;border-radius:12px!important;box-shadow:4px 4px 8px #C5CAD3,-4px -4px 8px #FFFFFF}
button:not(.nav button):active,.iconbtn:active{box-shadow:inset 3px 3px 6px #C5CAD3,inset -3px -3px 6px #FFFFFF}
.nav button{box-shadow:none!important;border-radius:12px!important}
.nav button.on{box-shadow:inset 3px 3px 6px #C5CAD3,inset -3px -3px 6px #FFFFFF!important;background:transparent!important}
textarea,input:not([type=range]),select{border:0!important;border-radius:14px!important;box-shadow:inset 4px 4px 8px #C5CAD3,inset -4px -4px 8px #FFFFFF!important}`,
  },
  glass: {
    name: 'glass', description: 'Dark frosted glass with a cool blue accent',
    tokens: { '--bg': '#0B1020', '--side': 'rgba(255,255,255,0.04)', '--panel': 'rgba(255,255,255,0.05)', '--raise': 'rgba(255,255,255,0.07)', '--hover': 'rgba(255,255,255,0.09)', '--sel': 'rgba(120,160,255,0.16)', '--line': 'rgba(255,255,255,0.08)', '--line2': 'rgba(255,255,255,0.14)', '--text': '#EAF0FF', '--muted': '#A9B4D0', '--dim': '#6F7A96', '--gold': '#7AA2FF', '--gold-ink': '#0B1020', '--btn': '#7AA2FF', '--btn-ink': '#0B1020', 'color-scheme': 'dark' },
    css: `body{background:radial-gradient(1200px 700px at 20% -10%,#1E2A55 0%,transparent 60%),radial-gradient(900px 600px at 110% 10%,#3A1E55 0%,transparent 55%),#0B1020!important}
${SURFACES}{backdrop-filter:blur(18px) saturate(140%);-webkit-backdrop-filter:blur(18px) saturate(140%);border-radius:16px!important}`,
  },
  paper: {
    name: 'paper', description: 'Warm paper, ink text, a serif for reading',
    tokens: { '--bg': '#F7F3EA', '--side': '#F1ECE1', '--panel': '#FBF8F1', '--raise': '#EFE9DC', '--hover': '#EAE3D4', '--sel': '#E3DAC7', '--line': '#E2DACB', '--line2': '#D6CCB8', '--text': '#2A2620', '--muted': '#6B6255', '--dim': '#968C7C', '--btn': '#2A2620', '--btn-ink': '#F7F3EA', '--sans': '"Iowan Old Style", "Charter", Georgia, serif', 'color-scheme': 'light' },
    css: '',
  },
  terminal: {
    name: 'terminal', description: 'Green phosphor on black, monospace everywhere',
    tokens: { '--bg': '#020702', '--side': '#031003', '--panel': '#041204', '--raise': '#061A06', '--hover': '#082208', '--sel': '#0B2E0B', '--line': '#0F3A0F', '--line2': '#145014', '--text': '#7CFC7C', '--muted': '#4FBF4F', '--dim': '#2E7D2E', '--btn': '#7CFC7C', '--btn-ink': '#020702', '--sans': 'ui-monospace, "SF Mono", Menlo, monospace', 'color-scheme': 'dark' },
    css: 'body{text-shadow:0 0 6px rgba(124,252,124,0.35)}',
  },
  contrast: {
    name: 'contrast', description: 'Highest contrast, larger text, thick focus rings',
    tokens: { '--bg': '#000000', '--panel': '#000000', '--text': '#FFFFFF', '--muted': '#FFFFFF', '--dim': '#D0D0D0', '--line': '#FFFFFF', '--line2': '#FFFFFF', '--btn': '#FFFF00', '--btn-ink': '#000000', '--fs': '16px', 'color-scheme': 'dark' },
    css: ':focus-visible{outline:3px solid #FFFF00!important;outline-offset:2px}',
  },
});

export function list() {
  let saved = [];
  try { saved = fs.readdirSync(DIR()).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(DIR(), f), 'utf8'))); } catch {}
  const active = current()?.name ?? null;
  const all = new Map(Object.values(PRESETS).map((p) => [p.name, { ...p, preset: true }]));
  for (const t of saved) all.set(t.name, { ...t, preset: !!PRESETS[t.name] });
  return [...all.values()].map((t) => ({ name: t.name, description: t.description, preset: t.preset, active: t.name === active }));
}

export function current() {
  try { return JSON.parse(fs.readFileSync(ACTIVE(), 'utf8')); } catch { return null; }
}

/** Save and switch to a theme. → the theme as applied */
export function apply(theme) {
  const t = normalize(theme);
  if (!Object.keys(t.tokens).length && !t.css) throw new Error('that theme had nothing usable in it');
  fs.mkdirSync(DIR(), { recursive: true });
  const stored = { ...t, version: Date.now() };
  delete stored.dropped;
  fs.writeFileSync(path.join(DIR(), `${t.name}.json`), JSON.stringify(stored, null, 2));
  fs.writeFileSync(ACTIVE(), JSON.stringify(stored, null, 2));
  return { ...stored, dropped: t.dropped };
}

export function use(name) {
  const n = String(name ?? '').toLowerCase();
  // A built-in name is always the built-in look (a saved copy never goes stale).
  if (PRESETS[n]) return apply(PRESETS[n]);
  try { return apply(JSON.parse(fs.readFileSync(path.join(DIR(), `${n.replace(/[^a-z0-9-]/g, '')}.json`), 'utf8'))); }
  catch { throw new Error(`no theme '${name}' (ox theme list)`); }
}

export function reset() { fs.rmSync(ACTIVE(), { force: true }); return true; }

/** The active theme as a stylesheet the app loads (it wins over the app's own light and dark). */
export function css(theme = current()) {
  if (!theme) return '/* no ox theme: the app\'s own look */\n';
  const decl = Object.entries(theme.tokens ?? {}).map(([k, v]) => `  ${k}: ${v};`).join('\n');
  return `/* ox theme: ${theme.name} */\n:root[data-ox-skin], :root[data-ox-skin][data-theme] {\n${decl}\n}\n${theme.css ?? ''}\n`;
}

export const SYSTEM = `You restyle the ox app. Return JSON only:
{"name": "<one or two words, lowercase>", "description": "<one line>", "tokens": {<only these keys: ${Object.keys(TOKENS).join(', ')}>}, "css": "<optional extra CSS>"}
Token values: colours as #hex, rgb(), hsl() or oklch(); --sans/--mono as font-family lists of installed system fonts; --fs 12px-19px; --tw 560px-1400px; color-scheme dark or light.
Keep text readable: at least 4.5:1 contrast between --text and --bg, and between --btn-ink and --btn. Keep --red for errors.
Extra CSS may restyle these surfaces: ${SURFACES}, button, .iconbtn, textarea, input, select, body. No url(), no @import, no fonts that need downloading, no animations longer than 300ms.`;

/** A theme from a sentence. ask({system, user}) → text (any model). */
export async function fromPrompt(prompt, { ask, base = null } = {}) {
  const p = String(prompt ?? '').trim();
  if (!p) throw new Error('describe the look you want');
  const preset = Object.keys(PRESETS).find((k) => new RegExp(`\\b${k === 'contrast' ? 'high[- ]contrast' : k}`, 'i').test(p));
  if (!ask) { if (preset) return apply(PRESETS[preset]); throw new Error('a new look needs a model; presets work without one: ' + Object.keys(PRESETS).join(', ')); }
  const start = base ?? current() ?? (preset ? PRESETS[preset] : null);
  const user = `${p}${start ? `\n\nStart from this theme (change what the request asks; keep the rest):\n${JSON.stringify({ name: start.name, tokens: start.tokens, css: start.css })}` : ''}`;
  const text = String(await ask({ system: SYSTEM, user }));
  let t;
  try { t = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim()); }
  catch { const m = /\{[\s\S]*\}/.exec(text); try { t = JSON.parse(m?.[0] ?? ''); } catch { throw new Error('the model did not answer with a theme'); } }
  return apply(t);
}

/** WCAG contrast of two hex colours (for the check after a theme is made). */
export function contrast(a, b) {
  const lum = (hex) => {
    const h = String(hex).replace('#', '');
    const f = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6);
    const [r, g, bl] = [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  if (!/^#[0-9a-f]{3,8}$/i.test(a) || !/^#[0-9a-f]{3,8}$/i.test(b)) return null;
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100;
}
