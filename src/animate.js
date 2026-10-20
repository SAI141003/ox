// Script → scene-by-scene motion animations (Flick's idea, Creatorberry, MIT;
// ox's way: no Remotion download, nothing installed). A video or a transcript
// becomes a scene plan you can read and change; each scene is drawn frame by
// frame in a headless Chrome from a time-driven template (like Remotion's
// useCurrentFrame: the same frame number always draws the same picture), and
// ffmpeg turns the frames into one MP4 and a poster per scene. Sound effects
// are made by ffmpeg on the spot and placed only where something moves in.
//
//   ox-animate/<name>/
//     transcript.json   the words, timed (from a video) or as given
//     plan.md           the scene plan to read and approve
//     scene-spec.json   what each scene draws (edit it, then re-render one)
//     scenes/<scene>/<scene>.mp4, poster.jpg
//     all.mp4           every scene in order
//
// Templates live in src/animate-templates/*.js and in ~/.ox/animations (scenes
// you saved for reuse); each exports a draw(spec, t, ctx) function source.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

export const ASPECTS = { '9:16': [1080, 1920], '16:9': [1920, 1080], '1:1': [1080, 1080], '4:5': [1080, 1350] };
export const TEMPLATES = ['headline', 'stat', 'list', 'compare', 'quote', 'flow', 'captions'];
const FPS = 30;

export const savedDir = (env = process.env) => path.join(env.OX_HOME || path.join(os.homedir(), '.ox'), 'animations');
const slug = (s, n = 40) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, n) || 'scene';

// ------------------------------------------------------------------ the plan

const sentences = (text) => String(text).replace(/\s+/g, ' ').trim().split(/(?<=[.!?]["”']?)\s+(?=[A-Z0-9"'“])/).map((s) => s.trim()).filter(Boolean);

/** Which picture fits these words, without a model. */
export function guessScene(text, i = 0) {
  const t = String(text).trim();
  const num = /(\$?\d[\d,.]*\s?(?:%|percent|x|k|m|million|billion|hours?|minutes?|seconds?|days?|times)?)/i.exec(t);
  const vs = /^(.{3,60}?)\s+(?:vs\.?|versus|instead of|compared to|or)\s+(.{3,60}?)[.!?]?$/i.exec(t);
  const quote = /^["“](.+)["”]/.exec(t);
  const listy = t.split(/,\s*|;\s*|\band\b/).map((x) => x.trim()).filter((x) => x.length > 1);
  const steps = /\b(?:first|then|next|after that|finally|step \d+)\b/gi;
  const isStep = /^(?:first|then|next|after that|finally|step \d+)$/i;
  const words = t.split(/\s+/);
  const title = words.slice(0, 7).join(' ').replace(/[.,;:!?]+$/, '');
  if (quote) return { template: 'quote', text: quote[1], by: t.slice(quote[0].length).replace(/^[\s,—-]+/, '') };
  if (vs) return { template: 'compare', left: vs[1].replace(/^(?:use|try|pick)\s+/i, ''), right: vs[2], title: 'vs' };
  if (num && /\d/.test(num[1])) return { template: 'stat', value: num[1].trim(), label: t.replace(num[1], '').replace(/\s+/g, ' ').trim().slice(0, 80) };
  if ((t.match(steps) ?? []).length >= 2) return { template: 'flow', title: '', items: t.split(steps).map((x) => x.replace(/^[\s,]+|[\s,.]+$/g, '')).filter((x) => x.length > 2 && !isStep.test(x)).slice(0, 5) };
  if (listy.length >= 3 && listy.every((x) => x.split(/\s+/).length <= 6)) {
    const items = listy.slice(0, 5).map((x) => x.replace(/[.!?]+$/, ''));
    return { template: 'list', title: '', items: items.map((x, k) => (k === items.length - 1 ? x : x)) };
  }
  if (words.length > 14) return { template: 'captions', text: t };
  return { template: 'headline', text: t };
}

/**
 * Transcript segments ([{start,end,text}]) or plain text → scenes. Without a
 * model: a scene per one or two sentences, a template guessed from the words.
 */
export function planScenes(source, { maxScenes = 12 } = {}) {
  const segs = Array.isArray(source) ? source : null;
  const parts = [];
  if (segs?.length) {
    // Speech often comes back as one long run with commas: cut it into clauses
    // (each with its share of the time), then join clauses that make one picture.
    const clauses = [];
    for (const sg of segs) {
      const bits = String(sg.text).trim().split(/(?<=[.!?,;:])\s+/).filter(Boolean);
      const total = bits.reduce((n, b) => n + b.length, 0) || 1;
      let at = sg.start;
      for (const b of bits) { const d = ((sg.end - sg.start) * b.length) / total; clauses.push({ start: at, end: at + d, text: b }); at += d; }
    }
    const kind = (t) => guessScene(t.replace(/[,;:]+$/, '')).template;
    let cur = null;
    for (const cl of clauses) {
      if (!cur) { cur = { ...cl }; continue; }
      const joined = `${cur.text} ${cl.text}`;
      const k = kind(joined);
      const shortPlain = cur.text.split(/\s+/).length < 5 && kind(cur.text) === 'headline';
      if (!/[.!?]$/.test(cur.text) && (shortPlain || ((k === 'flow' || k === 'list') && kind(cur.text) !== 'stat' && kind(cur.text) !== 'compare'))) { cur.end = cl.end; cur.text = joined; continue; }
      parts.push(cur); cur = { ...cl };
    }
    if (cur) parts.push(cur);
    for (const p of parts) p.text = p.text.replace(/[,;:]+$/, '.');
  } else {
    const ss = sentences(source);
    for (let i = 0; i < ss.length; i++) {
      const s = ss[i];
      // A very short line joins the next one only when neither has a picture of its own.
      if (s.split(/\s+/).length < 6 && ss[i + 1] && guessScene(s).template === 'headline' && guessScene(ss[i + 1]).template === 'headline') { parts.push({ text: `${s} ${ss[++i]}` }); continue; }
      parts.push({ text: s });
    }
  }
  // Too many: join neighbours, shortest pairs first.
  while (parts.length > maxScenes) {
    let best = 0;
    for (let i = 1; i < parts.length - 1; i++) if (parts[i].text.length + parts[i + 1].text.length < parts[best].text.length + parts[best + 1].text.length) best = i;
    parts.splice(best, 2, { start: parts[best].start, end: parts[best + 1].end, text: `${parts[best].text} ${parts[best + 1].text}` });
  }
  const names = new Set();
  return parts.map((p, i) => {
    const g = guessScene(p.text, i);
    let name = slug(p.text.split(/\s+/).slice(0, 4).join(' '), 28);
    while (names.has(name)) name += '-2';
    names.add(name);
    const words = p.text.split(/\s+/).length;
    const seconds = p.end != null ? Math.max(2.5, Math.min(12, p.end - p.start)) : Math.max(3, Math.min(9, words / 2.6 + 1.2));
    return { name, ...g, say: p.text, seconds: Math.round(seconds * 10) / 10, ...(p.start != null ? { start: p.start, end: p.end } : {}) };
  });
}

export const PLAN_SYSTEM = `You are a motion director. Turn a script into short-form scene animations.
Reply with JSON only: {"scenes":[...]} and nothing else. One scene per idea, 3 to 12 scenes.
Each scene: {"name":"kebab-case-unique","template":one of ${TEMPLATES.join('|')},"say":"the script words it covers","seconds":2.5-12, plus the template's fields}
Fields: headline {text}; stat {value:"72%", label}; list {title, items:[2-5 short]}; compare {left, right, title}; quote {text, by}; flow {title, items:[2-5 short steps]}; captions {text}.
Short on-screen words (under 9 per line). Use your own words on screen, never a whole paragraph.`;

/** A model's reply → scenes, or null if it is not usable. */
export function parsePlan(reply, fallback, known = TEMPLATES) {
  const m = /\{[\s\S]*\}/.exec(String(reply ?? ''));
  if (!m) return null;
  let j;
  try { j = JSON.parse(m[0]); } catch { return null; }
  const scenes = (j.scenes ?? []).filter((s) => s && known.includes(s.template)).slice(0, 12);
  if (!scenes.length) return null;
  const names = new Set();
  return scenes.map((s, i) => {
    let name = slug(s.name || `scene-${i + 1}`, 28);
    while (names.has(name)) name += '-2';
    names.add(name);
    const timed = fallback?.[i];
    return { ...s, name, seconds: Math.max(2.5, Math.min(12, Number(s.seconds) || 4)), ...(timed?.start != null ? { start: timed.start, end: timed.end } : {}) };
  });
}

export function planMarkdown(title, scenes, { aspect, brand }) {
  const line = (s) => {
    const shown = s.template === 'stat' ? `${s.value} — ${s.label ?? ''}` : s.template === 'compare' ? `${s.left} vs ${s.right}` : s.items ? `${s.title ? `${s.title}: ` : ''}${s.items.join(' · ')}` : s.text ?? '';
    return `| ${s.name} | ${s.template} | ${s.seconds}s | ${String(shown).replace(/\|/g, '/')} |`;
  };
  return `# ${title}\n\nAspect ${aspect} · colours ${brand.bg} / ${brand.fg} / ${brand.accent}${brand.logo ? ` · logo ${path.basename(brand.logo)}` : ''}\n\n| scene | animation | length | on screen |\n|---|---|---|---|\n${scenes.map(line).join('\n')}\n\nChange one: edit scene-spec.json, then \`ox video animate --redo <scene> <folder>\`.\n`;
}

// ------------------------------------------------------------------ drawing

const TEMPLATE_DIR = new URL('./animate-templates/', import.meta.url);

/** Every template's draw() source: built-in, then saved ones (a saved name wins). */
export function templateSources(env = process.env) {
  const out = {};
  for (const dir of [TEMPLATE_DIR.pathname, savedDir(env)]) {
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.js')); } catch { continue; }
    for (const f of files) out[f.slice(0, -3)] = fs.readFileSync(path.join(dir, f), 'utf8');
  }
  return out;
}

/** The page that draws any scene at any time: window.__draw(t). */
export function scenePage(spec, { width, height, brand, sources }) {
  const src = sources[spec.template] ?? sources.headline;
  const logo = brand.logo && fs.existsSync(brand.logo) ? `data:image/${path.extname(brand.logo).slice(1).replace('jpg', 'jpeg')};base64,${fs.readFileSync(brand.logo).toString('base64')}` : '';
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden;background:${brand.bg};color:${brand.fg};font-family:${brand.font}}
#stage{position:absolute;inset:0}
#logo{position:absolute;right:${Math.round(width * 0.05)}px;top:${Math.round(height * 0.04)}px;height:${Math.round(Math.min(width, height) * 0.07)}px;opacity:.9}
</style></head><body><div id="stage"></div>${logo ? `<img id="logo" src="${logo}">` : ''}<script>
const W=${width},H=${height},U=Math.min(W,H)/100,BRAND=${JSON.stringify(brand)},SPEC=${JSON.stringify(spec)};
const clamp=(x,a=0,b=1)=>Math.max(a,Math.min(b,x));
const ease=(x)=>{x=clamp(x);return 1-Math.pow(1-x,3)};
const inOut=(x)=>{x=clamp(x);return x<.5?4*x*x*x:1-Math.pow(-2*x+2,3)/2};
// A damped spring from 0 to 1 (Remotion's spring(), simplified): overshoots a little, settles.
const spring=(t,{stiff=170,damp=14}={})=>{if(t<=0)return 0;const w=Math.sqrt(stiff),z=damp/(2*w);if(z>=1)return 1-Math.exp(-w*t)*(1+w*t);const wd=w*Math.sqrt(1-z*z);return 1-Math.exp(-z*w*t)*(Math.cos(wd*t)+z*w/wd*Math.sin(wd*t))};
const el=(tag,css,html)=>{const e=document.createElement(tag);e.style.cssText=css;if(html!=null)e.innerHTML=html;return e};
const esc=(s)=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]);
const stage=document.getElementById('stage');
const ctx={W,H,U,BRAND,clamp,ease,inOut,spring,el,esc,stage,state:{}};
${src}
window.__draw=(t)=>{draw(SPEC,t,ctx)};
window.__cues=()=>typeof cues==='function'?cues(SPEC):[];
</script></body></html>`;
}

// ------------------------------------------------------------------ sound

/** A short effect made by ffmpeg: whoosh (moving in), pop (appearing), tick (counting), click. */
function sfxArgs(kind, at, i) {
  const d = Math.round(at * 1000);
  const src = {
    whoosh: 'anoisesrc=d=0.45:c=pink:a=0.5,highpass=f=300,lowpass=f=5000,afade=t=in:d=0.18,afade=t=out:st=0.2:d=0.25,volume=0.55',
    pop: 'sine=f=660:d=0.12,afade=t=out:st=0.02:d=0.1,volume=0.5',
    tick: 'sine=f=1500:d=0.04,afade=t=out:d=0.04,volume=0.25',
    click: 'anoisesrc=d=0.03:c=white:a=0.4,highpass=f=2000,volume=0.4',
  }[kind] ?? null;
  return src ? { filter: `${src},adelay=${d}|${d}[a${i}]`, label: `[a${i}]` } : null;
}

// ------------------------------------------------------------------ render

function ffmpegBin() { return spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).status === 0 ? 'ffmpeg' : null; }

/** One scene → <dir>/<name>.mp4 + poster.jpg. Uses an open browser tab. */
async function renderScene(browser, spec, { width, height, brand, sources, dir, sfx = true }) {
  fs.mkdirSync(dir, { recursive: true });
  const html = path.join(dir, 'scene.html');
  fs.writeFileSync(html, scenePage(spec, { width, height, brand, sources }));
  await browser.call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await browser.call('Page.navigate', { url: `file://${html}` });
  const until = Date.now() + 10_000;
  while (Date.now() < until && (await browser.evaluate('typeof window.__draw').catch(() => '')) !== 'function') await new Promise((r) => setTimeout(r, 20));
  await browser.evaluate('document.fonts && document.fonts.ready.then(()=>1)', { awaitPromise: true }).catch(() => {});
  const frames = Math.round(spec.seconds * FPS);
  const mp4 = path.join(dir, `${spec.name}.mp4`);
  const silent = path.join(dir, '.video.mp4');
  const ff = spawn('ffmpeg', ['-y', '-v', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(FPS), silent], { stdio: ['pipe', 'ignore', 'pipe'] });
  let err = '';
  ff.stderr.on('data', (d) => (err += d));
  const done = new Promise((resolve) => ff.on('close', resolve));
  let poster = null;
  for (let f = 0; f < frames; f++) {
    const t = f / FPS;
    await browser.evaluate(`window.__draw(${t})`);
    const { data } = await browser.call('Page.captureScreenshot', { format: 'jpeg', quality: 92, captureBeyondViewport: false });
    const buf = Buffer.from(data, 'base64');
    if (f === Math.round(frames * 0.7)) poster = buf;
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
  }
  ff.stdin.end();
  if ((await done) !== 0) throw new Error(`ffmpeg could not make ${spec.name}: ${err.trim().slice(-300)}`);
  if (poster) fs.writeFileSync(path.join(dir, 'poster.jpg'), poster);
  // Sound effects at the template's cues, only for things that move in.
  const cues = sfx ? ((await browser.evaluate('JSON.stringify(window.__cues())').then(JSON.parse).catch(() => [])) ?? []).filter((c) => c.t < spec.seconds) : [];
  const parts = cues.map((c, i) => sfxArgs(c.kind, c.t, i)).filter(Boolean);
  if (parts.length) {
    const chain = `${parts.map((p) => p.filter).join(';')};${parts.map((p) => p.label).join('')}amix=inputs=${parts.length}:normalize=0,apad[aout]`;
    const r = spawnSync('ffmpeg', ['-y', '-v', 'error', '-i', silent, '-filter_complex', chain, '-map', '0:v', '-map', '[aout]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-shortest', mp4], { encoding: 'utf8' });
    if (r.status !== 0) fs.renameSync(silent, mp4);
  } else {
    // A silent track keeps every scene joinable.
    spawnSync('ffmpeg', ['-y', '-v', 'error', '-i', silent, '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-c:v', 'copy', '-c:a', 'aac', '-shortest', mp4]);
  }
  fs.rmSync(silent, { force: true });
  fs.rmSync(html, { force: true });
  return { name: spec.name, file: mp4, poster: path.join(dir, 'poster.jpg'), seconds: spec.seconds, cues: cues.length };
}

function joinScenes(files, out) {
  const list = path.join(path.dirname(out), '.join.txt');
  fs.writeFileSync(list, files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'));
  const r = spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', out], { encoding: 'utf8' });
  fs.rmSync(list, { force: true });
  if (r.status !== 0) throw new Error(`could not join the scenes: ${(r.stderr ?? '').slice(-200)}`);
  return out;
}

export const DEFAULT_BRAND = { bg: '#0d0f14', fg: '#f5f5f7', accent: '#ffb020', muted: '#8b93a7', font: '-apple-system,"SF Pro Display","Inter","Segoe UI",Helvetica,Arial,sans-serif', logo: null };

async function openBrowser(opts) {
  const { Browser } = await import('./fast-browser.js');
  return opts.browser ?? Browser.open('about:blank', { headless: true });
}

/**
 * Source → workspace with a plan, a spec and rendered scenes.
 *   source: a video/audio file, a .txt/.md/.json transcript, or the script itself
 *   plan:   async (system, user) → reply text (a model); without one, scenes are guessed
 * → { dir, scenes:[{name,file,poster,seconds}], all, plan }
 */
export async function animate(source, { out = null, aspect = '9:16', brand = {}, plan = null, onStep = () => {}, render = true, only = null, sfx = true, env = process.env } = {}) {
  if (!ffmpegBin()) throw new Error('animating needs ffmpeg (brew install ffmpeg)');
  if (!ASPECTS[aspect]) throw new Error(`aspect is one of ${Object.keys(ASPECTS).join(', ')}`);
  const [width, height] = ASPECTS[aspect];
  const B = { ...DEFAULT_BRAND, ...Object.fromEntries(Object.entries(brand).filter(([, v]) => v)) };
  let title = 'animation', transcript;
  const isFile = typeof source === 'string' && source.length < 1024 && fs.existsSync(source);
  if (isFile && /\.(mp4|mov|m4v|webm|mkv|mp3|m4a|wav|aac|flac|ogg)$/i.test(source)) {
    onStep('transcribing', path.basename(source));
    const V = await import('./video-edit.js');
    const tr = V.transcribe(source);
    if (!tr.segments?.length) throw new Error(tr.note ?? 'no words were heard in that file; paste the script instead');
    transcript = tr.segments.map((s) => ({ start: s.start, end: s.end, text: s.text.trim() }));
    title = path.basename(source).replace(/\.[^.]+$/, '');
  } else if (isFile && /\.json$/i.test(source)) {
    const j = JSON.parse(fs.readFileSync(source, 'utf8'));
    transcript = Array.isArray(j) ? j : j.segments ?? j.transcript;
    title = path.basename(source, '.json');
  } else {
    const text = isFile ? fs.readFileSync(source, 'utf8') : String(source);
    if (text.trim().split(/\s+/).length < 3) throw new Error('give a video, a transcript file, or a script of a sentence or more');
    transcript = text.trim();
    title = isFile ? path.basename(source).replace(/\.[^.]+$/, '') : text.trim().split(/\s+/).slice(0, 5).join(' ');
  }
  const dir = out ?? path.join(process.cwd(), 'ox-animate', slug(title));
  fs.mkdirSync(path.join(dir, 'scenes'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'transcript.json'), JSON.stringify(Array.isArray(transcript) ? { segments: transcript } : { text: transcript }, null, 2));
  onStep('planning', `${aspect}`);
  const guessed = planScenes(transcript);
  let scenes = guessed;
  if (plan) {
    const words = Array.isArray(transcript) ? transcript.map((s) => `[${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text}`).join('\n') : transcript;
    const saved = savedAnimations(env);
    const extra = saved.length ? `\nSaved animations you may reuse when one clearly fits (same fields as the template it came from): ${saved.map((a) => `${a.name} (from ${a.from})`).join(', ')}` : '';
    try { scenes = parsePlan(await plan(PLAN_SYSTEM + extra, `Aspect ${aspect}. Script:\n${words.slice(0, 12000)}`), guessed, [...TEMPLATES, ...saved.map((a) => a.name)]) ?? guessed; } catch { scenes = guessed; }
  }
  const spec = { title, aspect, width, height, brand: B, scenes };
  fs.writeFileSync(path.join(dir, 'scene-spec.json'), JSON.stringify(spec, null, 2));
  fs.writeFileSync(path.join(dir, 'plan.md'), planMarkdown(title, scenes, { aspect, brand: B }));
  if (!render) return { dir, scenes: [], plan: path.join(dir, 'plan.md') };
  return renderSpec(dir, { only, onStep, sfx, env });
}

/** (Re-)render a workspace from its scene-spec.json; only: scene names to redo. */
export async function renderSpec(dir, { only = null, onStep = () => {}, sfx = true, env = process.env, browser = null } = {}) {
  const spec = JSON.parse(fs.readFileSync(path.join(dir, 'scene-spec.json'), 'utf8'));
  const { width, height, brand } = spec;
  const sources = templateSources(env);
  const want = only ? new Set([].concat(only)) : null;
  if (want) for (const n of want) if (!spec.scenes.some((s) => s.name === n)) throw new Error(`no scene named ${n} (scenes: ${spec.scenes.map((s) => s.name).join(', ')})`);
  const b = await openBrowser({ browser });
  const made = [];
  try {
    for (const [i, s] of spec.scenes.entries()) {
      const sdir = path.join(dir, 'scenes', s.name);
      const file = path.join(sdir, `${s.name}.mp4`);
      if (want && !want.has(s.name) && fs.existsSync(file)) { made.push({ name: s.name, file, poster: path.join(sdir, 'poster.jpg'), seconds: s.seconds }); continue; }
      onStep('rendering', `${i + 1}/${spec.scenes.length} ${s.name} (${s.template})`);
      made.push(await renderScene(b, s, { width, height, brand, sources, dir: sdir, sfx }));
    }
  } finally { if (!browser) await b.close(); }
  const all = made.length > 1 ? joinScenes(made.map((m) => m.file), path.join(dir, 'all.mp4')) : made[0]?.file;
  return { dir, scenes: made, all, plan: path.join(dir, 'plan.md') };
}

/** Keep a scene's look for later runs: its template, with this scene's colours as defaults. */
export function saveAnimation(dir, sceneName, as = null, env = process.env) {
  const spec = JSON.parse(fs.readFileSync(path.join(dir, 'scene-spec.json'), 'utf8'));
  const s = spec.scenes.find((x) => x.name === sceneName);
  if (!s) throw new Error(`no scene named ${sceneName}`);
  const src = templateSources(env)[s.template];
  const name = slug(as ?? `${s.template}-${sceneName}`, 40);
  fs.mkdirSync(savedDir(env), { recursive: true });
  fs.writeFileSync(path.join(savedDir(env), `${name}.js`), `// saved from ${sceneName} (${new Date().toISOString().slice(0, 10)})\n${src}`);
  fs.writeFileSync(path.join(savedDir(env), `${name}.json`), JSON.stringify({ from: s.template, example: s, brand: spec.brand }, null, 2));
  return { name, file: path.join(savedDir(env), `${name}.js`) };
}

/** Saved animations, for the catalog and the plan. */
export function savedAnimations(env = process.env) {
  try { return fs.readdirSync(savedDir(env)).filter((f) => f.endsWith('.json')).map((f) => ({ name: f.slice(0, -5), ...JSON.parse(fs.readFileSync(path.join(savedDir(env), f), 'utf8')) })); } catch { return []; }
}
