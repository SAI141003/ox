// OX Studio for any agent (docs/STUDIO_ARCHITECTURE.md): the shape of
// Higgsfield's agent MCP server, on open-weights models. Claude Code, Codex,
// Cursor or any MCP app connects with `ox studio mcp` (stdio) and gets tools
// to explore models, generate and edit images and video, wait on jobs, run
// production recipes and edit video on this machine. Nothing is installed:
// the models run on a host you have a key for (fal, Hugging Face) or on your
// own Stable Diffusion server when one is running.
import fs from 'node:fs';
import * as C from './studio-catalog.js';
import * as LOCAL from './studio-local.js';

const IMAGE_SIZE = { '1:1': 'square_hd', '16:9': 'landscape_16_9', '9:16': 'portrait_16_9', '4:3': 'landscape_4_3', '3:4': 'portrait_4_3' };
const ASPECTS = Object.keys(IMAGE_SIZE);

/** Where a model can run right now, given the keys and servers this machine has. */
// What this Mac can run on its own (cached a few seconds: status reads the disk).
let localCache = { at: 0, can: null };
function localCan(env) {
  if ((env.OX_STUDIO_LOCAL ?? process.env.OX_STUDIO_LOCAL) === '0') return {};
  const home = env.OX_HOME ?? process.env.OX_HOME ?? '';
  if (Date.now() - localCache.at > 5000 || localCache.home !== home) { try { localCache = { at: Date.now(), home, can: LOCAL.status({ ...process.env, ...env }).can }; } catch { localCache = { at: Date.now(), home, can: {} }; } }
  return localCache.can ?? {};
}

export function hostFor(model, { host = null, env = process.env } = {}) {
  if (model.device) {
    if (host && host !== 'device') throw new Error(`${model.name} runs only on this Mac`);
    if (!localCan(env)[model.device]) throw new Error(`${model.name} is not set up yet: press Set up this Mac in Studio, or run ox studio local install`);
    return 'device';
  }
  const can = [];
  if (model.fal && env.FAL_KEY) can.push('fal');
  if (model.hf && model.kind === 'image' && env.HF_TOKEN) can.push('hf');
  if (model.kind === 'image' && env.OX_SD_URL) can.push('local');
  if (host) {
    if (!can.includes(host)) throw new Error(`${model.name} cannot run on ${host} here (${hostHint(model, env)})`);
    return host;
  }
  if (!can.length) throw new Error(`nothing can run ${model.name} yet: ${hostHint(model, env)}`);
  return can[0];
}

function hostHint(model) {
  const ways = [];
  if (model.fal) ways.push('a fal key (FAL_KEY, in Settings › API keys)');
  if (model.hf) ways.push('a Hugging Face token (HF_TOKEN)');
  if (model.kind === 'image') ways.push('your own Stable Diffusion server with its API on (set OX_SD_URL)');
  return `it needs ${ways.join(', or ')}`;
}

/** The model for a request: by id, or the default for the kind. */
function modelFor(kind, ref, fallbackKind = kind, env = process.env, host = null) {
  let m = ref ? C.find(ref) : C.find(C.DEFAULTS[fallbackKind]);
  // No model named: the default if it can run here (on the host asked for), else the first of this kind that can.
  if (!ref && m) { const runs = (x) => { try { hostFor(x, { env, host }); return true; } catch { return false; } }; if (!runs(m)) m = C.byKind(kind).find(runs) ?? (host && host !== 'device' ? C.byKind(kind).find((x) => !x.device) : null) ?? m; }
  if (!m) throw new Error(`no model '${ref}'. models_explore lists them`);
  if (m.kind !== kind) throw new Error(`${m.name} makes ${m.kind}, not ${kind}`);
  return m;
}

/** Turn a Studio request into one engine call: { provider, model, prompt, settings, media }. */
export function plan(tool, a = {}, { env = process.env } = {}) {
  const aspect = a.aspect ? String(a.aspect) : null;
  if (aspect && !ASPECTS.includes(aspect)) throw new Error(`aspect is one of ${ASPECTS.join(', ')}`);
  const n = a.n != null ? Math.max(1, Math.min(4, Number(a.n) || 1)) : null;
  const onMac = devicePlan(tool, a, { env, aspect, n });
  if (onMac) return onMac;
  if (tool === 'generate_image') {
    const prompt = String(a.prompt ?? '').trim();
    if (!prompt) throw new Error('a prompt is needed');
    // Words in the picture: Qwen-Image is the open model that spells.
    const m = modelFor('image', a.model, a.model ? 'image' : /["“].+["”]|\b(text|title|sign|poster|logo|words?|caption)\b/i.test(prompt) ? 'text' : 'image', env, a.host);
    const provider = hostFor(m, { host: a.host, env });
    if (provider === 'hf') return { provider, model: m.hf, prompt, settings: {}, media: {}, label: m.name };
    if (provider === 'local') return { provider, model: 'local', prompt, settings: { ...(n ? { n } : {}), ...(aspect ? sizeFor(aspect) : {}) }, media: {}, label: m.name };
    return { provider, model: m.fal, prompt, settings: { ...(aspect ? { image_size: IMAGE_SIZE[aspect] } : {}), ...(n ? { num_images: n } : {}), ...(a.seed != null ? { seed: Number(a.seed) } : {}) }, media: {}, label: m.name };
  }
  if (tool === 'generate_video') {
    const raw = String(a.prompt ?? '').trim();
    if (!raw) throw new Error('a prompt is needed');
    if (a.camera && !C.CAMERA[a.camera]) throw new Error(`camera is one of ${Object.keys(C.CAMERA).join(', ')}`);
    const m = modelFor('video', a.model, 'video', env, a.host);
    const provider = hostFor(m, { host: a.host, env });
    const fromImage = a.image ? String(a.image) : null;
    return {
      provider, model: fromImage && m.falFromImage ? m.falFromImage : m.fal, prompt: C.withCamera(raw, a.camera),
      settings: { ...(aspect ? { aspect_ratio: aspect } : {}), ...(a.seed != null ? { seed: Number(a.seed) } : {}) },
      media: fromImage ? { start: [fromImage] } : {}, label: m.name,
    };
  }
  if (tool === 'edit_image') {
    if (!a.image) throw new Error('image is the picture to edit (a path or a link)');
    if (!String(a.prompt ?? '').trim()) throw new Error('say what to change');
    const m = modelFor('edit', a.model, 'edit', env, a.host);
    const provider = hostFor(m, { host: a.host, env });
    return { provider, model: m.fal, prompt: String(a.prompt), settings: {}, media: { edit: [String(a.image)] }, label: m.name };
  }
  const single = { upscale: ['upscale', 'image'], remove_background: ['cutout', 'image'] }[tool];
  if (single) {
    if (!a.image) throw new Error('image is a path or a link');
    const m = modelFor(single[0], a.model, single[0], env, a.host);
    return { provider: hostFor(m, { host: a.host, env }), model: m.fal, prompt: '', settings: tool === 'upscale' && a.scale ? { scale: Number(a.scale) } : {}, media: { start: [String(a.image)] }, label: m.name };
  }
  if (tool === 'lip_sync') {
    if (!a.video || !a.audio) throw new Error('lip_sync needs a video (the face) and an audio file (the voice), as links');
    const m = modelFor('lipsync', a.model, 'lipsync', env, a.host);
    return { provider: hostFor(m, { host: a.host, env }), model: m.fal, prompt: '', settings: {}, media: { video: [String(a.video)], audio: [String(a.audio)] }, label: m.name };
  }
  if (tool === 'restyle_video') {
    const mode = String(a.mode ?? (a.image ? 'move' : 'restyle'));
    const id = { move: 'wan-animate-move', swap: 'wan-animate-replace', replace: 'wan-animate-replace', restyle: 'wan-vace' }[mode];
    if (!id) throw new Error('mode is move (motion transfer), swap (replace the person) or restyle (a new look from words)');
    if (!/^https?:/.test(String(a.video ?? ''))) throw new Error('video is a link to the clip (upload it first)');
    if (id !== 'wan-vace' && !a.image) throw new Error(`${mode} needs image: the person or character to use`);
    if (id === 'wan-vace' && !String(a.prompt ?? '').trim()) throw new Error('restyle needs a prompt: the new look');
    const m = C.find(id);
    return { provider: hostFor(m, { host: a.host, env }), model: m.fal, prompt: String(a.prompt ?? ''), settings: a.seed != null ? { seed: Number(a.seed) } : {}, media: { video: [String(a.video)], ...(id !== 'wan-vace' ? { start: [String(a.image)] } : {}) }, label: m.name };
  }
  if (tool === 'generate_audio') {
    if (!String(a.prompt ?? '').trim()) throw new Error('describe the sound');
    const m = modelFor('audio', a.model, 'audio', env, a.host);
    return { provider: hostFor(m, { host: a.host, env }), model: m.fal, prompt: String(a.prompt), settings: a.seconds ? { seconds_total: Math.min(47, Number(a.seconds)) } : {}, media: {}, label: m.name };
  }
  throw new Error(`no plan for ${tool}`);
}

/** A request this Mac runs itself, or null when it goes to a hosted model. */
function devicePlan(tool, a, { env, aspect, n }) {
  const kind = { generate_image: 'image', edit_image: 'edit', generate_video: 'video', upscale: 'upscale', remove_background: 'cutout' }[tool];
  if (!kind) return null;
  if (a.host && a.host !== 'device') return null;
  const textWanted = tool === 'generate_image' && !a.model && /["“].+["”]|\b(text|title|sign|poster|logo|words?|caption)\b/i.test(String(a.prompt ?? ''));
  let m;
  try { m = modelFor(kind, a.model, textWanted ? 'text' : kind, env); } catch { return null; }
  if (!m.device) return null;
  hostFor(m, { host: a.host, env });
  const prompt = String(a.prompt ?? '').trim();
  if ((kind === 'image' || kind === 'edit') && !prompt) throw new Error(kind === 'edit' ? 'say what to change' : 'a prompt is needed');
  if (kind === 'video' && !prompt && !a.image) throw new Error('a prompt (or a starting image) is needed');
  if (['edit', 'upscale', 'cutout'].includes(kind) && !a.image) throw new Error('image is the picture (a path on this Mac or a link)');
  if (a.camera && !C.CAMERA[a.camera]) throw new Error(`camera is one of ${Object.keys(C.CAMERA).join(', ')}`);
  return {
    provider: 'device', model: m.id, prompt,
    settings: { op: kind, ...(aspect ? { aspect } : {}), ...(n ? { n } : {}), ...(a.seed != null ? { seed: Number(a.seed) } : {}), ...(a.camera ? { camera: a.camera } : {}), ...(a.strength != null ? { strength: Number(a.strength) } : {}), ...(a.fast ? { fast: true } : {}), ...(a.mode ? { mode: String(a.mode) } : {}) },
    media: a.image ? { start: [String(a.image)] } : {}, label: m.name,
  };
}

const sizeFor = (aspect) => {
  const [w, h] = aspect.split(':').map(Number);
  const s = 1024 / Math.max(w, h);
  return { width: Math.round((w * s) / 64) * 64, height: Math.round((h * s) / 64) * 64 };
};

const prop = (type, description, extra = {}) => ({ type, description, ...extra });
const aspectProp = prop('string', `Frame shape: ${ASPECTS.join(', ')}.`, { enum: ASPECTS });
const hostProp = prop('string', 'Where to run it: device (this Mac\'s own chip, no key), fal, hf (Hugging Face) or local (your Stable Diffusion server). Default: this Mac when it is set up, else the first one that can.', { enum: ['device', 'fal', 'hf', 'local'] });
const waitProp = prop('number', 'Seconds to wait for the result before returning the job id (default 45 for images, 0 for video). Use jobs_wait after.');

export const STUDIO_MCP_TOOLS = [
  { name: 'models_explore', description: 'The open-weights models OX Studio can use: what each makes, its licence, what it is good at, and whether this machine can run it now. Also the camera moves and the production recipes.', inputSchema: { type: 'object', properties: { kind: prop('string', 'image, edit, video, restyle, upscale, cutout, lipsync or audio. Omit for all.') } } },
  { name: 'generate_image', description: 'Make pictures from a prompt with an open model (FLUX.1 schnell by default; Qwen-Image when the prompt has words to spell). Returns the files, or a job id if it is still running.', inputSchema: { type: 'object', properties: { prompt: prop('string', 'What to make.'), model: prop('string', 'A model id from models_explore.'), aspect: aspectProp, n: prop('number', 'How many (1-4).'), seed: prop('number', 'Seed, to repeat a result.'), host: hostProp, wait_seconds: waitProp }, required: ['prompt'] } },
  { name: 'generate_video', description: 'Make a 5-second clip from a prompt, or from a starting image, with an open video model (Wan 2.2 by default). Add a camera move. Returns a job id; call jobs_wait.', inputSchema: { type: 'object', properties: { prompt: prop('string', 'What happens in the shot.'), image: prop('string', 'Optional first frame: a path or a link.'), camera: prop('string', `A camera move: ${Object.keys(C.CAMERA).join(', ')}.`, { enum: Object.keys(C.CAMERA) }), model: prop('string', 'A video model id from models_explore.'), aspect: aspectProp, seed: prop('number', 'Seed.'), host: hostProp, wait_seconds: waitProp }, required: ['prompt'] } },
  { name: 'edit_image', description: 'Change a picture by instruction ("make it night", "put the product on marble"), keeping the rest. Qwen-Image-Edit by default.', inputSchema: { type: 'object', properties: { image: prop('string', 'The picture: a path or a link.'), prompt: prop('string', 'What to change.'), model: prop('string', 'qwen-image-edit or flux-kontext-dev (non-commercial licence).'), host: hostProp, wait_seconds: waitProp }, required: ['image', 'prompt'] } },
  { name: 'upscale', description: 'Make a picture larger with more detail. On this Mac: 2x, mode detail (the model redraws fine detail, a few minutes) or quick (instant). Hosted: Real-ESRGAN 4x.', inputSchema: { type: 'object', properties: { image: prop('string', 'A path or a link.'), scale: prop('number', '2 or 4 (hosted).'), mode: prop('string', 'On this Mac: detail or quick.', { enum: ['detail', 'quick'] }), wait_seconds: waitProp }, required: ['image'] } },
  { name: 'remove_background', description: 'Cut the subject out of a picture onto a clear background (BiRefNet).', inputSchema: { type: 'object', properties: { image: prop('string', 'A path or a link.'), wait_seconds: waitProp }, required: ['image'] } },
  { name: 'lip_sync', description: 'Make the face in a video speak an audio track (LatentSync). Both as links.', inputSchema: { type: 'object', properties: { video: prop('string', 'Link to the video.'), audio: prop('string', 'Link to the audio.'), wait_seconds: waitProp }, required: ['video', 'audio'] } },
  { name: 'generate_audio', description: 'Make a sound effect or a short loop from a description (Stable Audio Open).', inputSchema: { type: 'object', properties: { prompt: prop('string', 'The sound.'), seconds: prop('number', 'Length, up to 47.'), wait_seconds: waitProp }, required: ['prompt'] } },
  { name: 'jobs_wait', description: 'Wait for jobs to finish and return their files.', inputSchema: { type: 'object', properties: { ids: prop('array', 'Job ids.', { items: { type: 'string' } }), timeout_seconds: prop('number', 'Give up after this long (default 300).') }, required: ['ids'] } },
  { name: 'history', description: 'What the Studio made recently: prompt, model, status and files.', inputSchema: { type: 'object', properties: { limit: prop('number', 'How many (default 20).') } } },
  { name: 'workflow_instructions', description: 'Step-by-step recipes for a production: product-photoshoot, youtube-thumbnail, character-sheet, explainer-video, scene-animation, video-restyle, app-store-kit, short-ad, code-film, craft-edit. Omit the name for the list.', inputSchema: { type: 'object', properties: { name: prop('string', 'The recipe.') } } },
  { name: 'video_edit', description: 'Edit a video file on this machine with ffmpeg: captions (burned in from the speech), join (clips one after another; pass files), cut, speed, vertical (crop to 9:16 or 1:1), gif, highlights (the parts about a topic), polish (speed through idle stretches).', inputSchema: { type: 'object', properties: { op: prop('string', 'captions, join, cut, speed, vertical, gif, highlights or polish.', { enum: ['captions', 'join', 'cut', 'speed', 'vertical', 'gif', 'highlights', 'polish'] }), file: prop('string', 'The video file path.'), files: prop('array', 'join: the clips in order.', { items: { type: 'string' } }), start: prop('string', 'cut/gif: start (seconds or m:ss).'), end: prop('string', 'cut/gif: end.'), factor: prop('number', 'speed: 2 = twice as fast.'), aspect: prop('string', 'vertical: 9:16 or 1:1.'), query: prop('string', 'highlights: the topic.') }, required: ['op'] } },
  { name: 'compose_video', description: 'Make a long-form video from one or more local scenes, optionally mixing a narration or music file across the entire result. This is the way to create 30-minute or one-hour videos: supply enough scenes; Ox reports the actual output duration and does not pretend a short generative shot is an hour.', inputSchema: { type: 'object', properties: { files: prop('array', 'Video scene paths, in timeline order.', { items: { type: 'string' }, minItems: 1 }), audio: prop('string', 'Optional local narration or music path. It is looped and trimmed to the video unless loop_audio is false.'), volume: prop('number', 'Audio-track volume from 0 to 1; default 0.28.'), keep_original: prop('boolean', 'Mix scene audio underneath the new track; default true.'), loop_audio: prop('boolean', 'Loop a short music bed to the full timeline; default true.'), out: prop('string', 'Optional MP4 output path.') }, required: ['files'] } },
  { name: 'restyle_video', description: 'Keep a video\'s motion and change what is in it (Genjutsu-style, open Wan models): move = the person in your picture does what the video shows; swap = the person in the video becomes the one in your picture; restyle = a new look or world from a prompt. Returns a job id; call jobs_wait.', inputSchema: { type: 'object', properties: { mode: prop('string', 'move, swap or restyle.', { enum: ['move', 'swap', 'restyle'] }), video: prop('string', 'Link to the clip (4-10 s is best).'), image: prop('string', 'move/swap: link or path to the person or character.'), prompt: prop('string', 'restyle: the new look.'), seed: prop('number', 'Seed.'), host: hostProp, wait_seconds: waitProp }, required: ['mode', 'video'] } },
  { name: 'animate_script', description: 'Turn a video, a transcript or a script into scene-by-scene motion animations on this machine (Flick-style: animated headlines, counting stats, lists, comparisons, quotes, flows, kinetic captions, sound effects). No key needed. plan_only first, then render; redo one scene after editing scene-spec.json.', inputSchema: { type: 'object', properties: { source: prop('string', 'A video/audio file path, a transcript file path, or the script text.'), folder: prop('string', 'An existing animation folder (to render a plan, redo or save a scene).'), aspect: prop('string', '9:16, 16:9, 1:1 or 4:5.', { enum: ['9:16', '16:9', '1:1', '4:5'] }), bg: prop('string', 'Background colour (#hex).'), fg: prop('string', 'Text colour.'), accent: prop('string', 'Accent colour.'), logo: prop('string', 'Logo image path.'), plan_only: prop('boolean', 'Write plan.md and scene-spec.json without rendering.'), redo: prop('array', 'Scene names to render again.', { items: { type: 'string' } }), save: prop('string', 'A scene name to keep as a reusable animation.') } } },
  { name: 'app_assets', description: 'Assets an app needs, made on this machine (no key): icons (one square image → iOS AppIcon set, macOS .icns, Android mipmaps, web favicons), shots (screenshots → store-sized pictures with a headline each), demo (screenshots + captions → a vertical demo video).', inputSchema: { type: 'object', properties: { op: prop('string', 'icons, shots or demo.', { enum: ['icons', 'shots', 'demo'] }), images: prop('array', 'Image paths (icons: one square image).', { items: { type: 'string' } }), captions: prop('array', 'shots/demo: one headline per screenshot.', { items: { type: 'string' } }), sizes: prop('array', 'shots: iphone-6.9, iphone-6.5, ipad-13, play-phone.', { items: { type: 'string' } }), out: prop('string', 'Where to put them.') }, required: ['op', 'images'] } },
  { name: 'film_styles', description: 'Film styles made entirely in code, no video model (the Lemo-Opuscar library: 66+ styles such as Ukiyo-e, Satellite Briefing, Exploded Teardown, Swiss Motion, 16-bit Pixel RPG, 1920s Silent Film). Omit style for the list by category; pass a style for its full STYLE.md and where the library is. For a film in one: workflow_instructions code-film.', inputSchema: { type: 'object', properties: { style: prop('string', 'A style slug from the list, e.g. ukiyoe.'), category: prop('string', 'Only this category of the list.') } } },
  { name: 'craft_apps', description: 'The Craft apps: open-source, clean-room rebuilds of Adobe\'s suite and more (PhotoCraft = Photoshop, LightCraft = Lightroom, VectorCraft = Illustrator, DesignCraft = InDesign, PdfCraft = Acrobat, FilmCraft = Premiere Pro, EffectCraft = After Effects, SoundCraft, FigCraft, WordCraft, GridCraft, DeckCraft, CADCraft). Says which are on this Mac; an installed one is driven by its own MCP tools and its skill.', inputSchema: { type: 'object', properties: {} } },
  { name: 'explainer_video', description: 'Turn steps into an explainer video on this machine: one slide per step with a lit diagram, crossfades. No model or key needed.', inputSchema: { type: 'object', properties: { title: prop('string', 'The title.'), steps: prop('array', 'Steps as "Label: what happens".', { items: { type: 'string' } }) }, required: ['title', 'steps'] } },
];

const GENERATORS = new Set(['generate_image', 'generate_video', 'edit_image', 'upscale', 'remove_background', 'lip_sync', 'generate_audio', 'restyle_video']);

/**
 * The Studio's tools, bound to an engine. deps: { generate, history, video, env, now }
 * generate is media-studio's generate (or a stand-in in tests).
 */
export function createStudio(deps = {}) {
  const env = deps.env ?? process.env;
  const jobs = new Map();
  let seq = 0;
  const engine = async () => deps.generate ?? (await import('./media-studio.js')).generate;
  const show = (j) => (j.status === 'completed'
    ? `job ${j.id} done (${j.label}${j.cost ? `, ${j.cost}` : ''}): ${j.files.length ? j.files.join(', ') : j.urls.join(', ')}`
    : j.status === 'failed' ? `job ${j.id} failed (${j.label}): ${j.error}` : `job ${j.id} is ${j.status} (${j.label}${j.cost ? `, ${j.cost}` : ''}); call jobs_wait with ["${j.id}"]`);

  function start(p) {
    const id = `j${Date.now().toString(36)}${(seq++).toString(36)}`;
    const job = { id, label: p.label, status: 'running', files: [], urls: [], error: null };
    job.done = (async () => {
      try {
        const gen = await engine();
        const r = await gen({ provider: p.provider, model: p.model, prompt: p.prompt, settings: p.settings, media: p.media, env, onStatus: (s) => { if (s?.status) job.status = s.status === 'completed' ? 'running' : s.status; } });
        Object.assign(job, { status: r.status === 'completed' ? 'completed' : 'failed', files: r.files ?? [], urls: r.urls ?? [], error: r.error ?? (r.status === 'completed' ? null : r.status), record: r.id });
      } catch (e) { Object.assign(job, { status: 'failed', error: e.message }); }
      return job;
    })();
    jobs.set(id, job);
    return job;
  }

  const waitOn = async (list, ms) => {
    let timer;
    await Promise.race([Promise.all(list.map((j) => j.done)), new Promise((r) => { timer = setTimeout(r, ms); })]);
    clearTimeout(timer);
  };

  async function call(name, a = {}) {
    if (name === 'models_explore') {
      const list = a.kind ? C.byKind(String(a.kind)) : C.OPEN_MODELS;
      if (!list.length) throw new Error('kinds: image, edit, video, restyle, upscale, cutout, lipsync, audio');
      const ready = (m) => { try { return `ready on ${hostFor(m, { env })}`; } catch { return 'needs a host key'; } };
      const lines = list.map((m) => `${m.id} (${m.kind}) ${m.name}. Licence ${m.license}. Good at: ${m.good}. ${ready(m)}.`);
      if (!a.kind) lines.push('', `Camera moves for generate_video: ${Object.keys(C.CAMERA).join(', ')}.`, `Recipes for workflow_instructions: ${Object.keys(C.WORKFLOWS).join(', ')}.`);
      return lines.join('\n');
    }
    if (GENERATORS.has(name)) {
      const p = plan(name, a, { env });
      const job = start(p);
      // The price, shown with the job: free on this Mac, else fal's listed price.
      const m = C.find(p.model) ?? C.OPEN_MODELS.find((x) => x.fal === p.model || x.falFromImage === p.model);
      job.cost = C.costLine(m, { aspect: a.aspect ?? '1:1', n: a.n ?? 1 });
      const secs = a.wait_seconds != null ? Number(a.wait_seconds) : name === 'generate_video' || name === 'lip_sync' || name === 'restyle_video' ? 0 : 45;
      if (secs > 0) await waitOn([job], Math.min(secs, 290) * 1000);
      return show(job);
    }
    if (name === 'jobs_wait') {
      const ids = [].concat(a.ids ?? []).map(String);
      const list = ids.map((id) => jobs.get(id));
      const missing = ids.filter((_, i) => !list[i]);
      if (missing.length) throw new Error(`no job ${missing.join(', ')} in this session (history lists earlier results)`);
      await waitOn(list, Math.min(Number(a.timeout_seconds ?? 300), 1800) * 1000);
      return list.map(show).join('\n');
    }
    if (name === 'history') {
      const rows = deps.history ? deps.history() : (await import('./media-studio.js')).history({ limit: 200 });
      const out = rows.slice(0, Math.max(1, Math.min(100, Number(a.limit ?? 20))));
      return out.map((r) => `${r.id} ${r.status ?? '?'} · ${r.label ?? r.model} · "${String(r.prompt ?? '').slice(0, 80)}"${(r.files ?? []).length ? ` · ${r.files.join(', ')}` : ''}`).join('\n') || 'nothing made yet';
    }
    if (name === 'workflow_instructions') {
      if (!a.name) return Object.entries(C.WORKFLOWS).map(([k, w]) => `${k}: ${w.title}`).join('\n');
      const w = C.WORKFLOWS[a.name];
      if (!w) throw new Error(`recipes: ${Object.keys(C.WORKFLOWS).join(', ')}`);
      return `${w.title}\n${w.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`;
    }
    if (name === 'film_styles') {
      const F = await import('./studio-films.js');
      if (a.style) { const st = F.filmStyle(String(a.style), { env }); return `${st.name} (${st.category})${st.mine ? ' · your own style' : ''}\nLibrary: ${F.filmLib(env)} (follow its AGENTS.md: brief, TREATMENT.md, look, produce, deliver)\nStyle folder: ${st.dir}\n\n${st.style}`; }
      const st = F.filmLibStatus({ env });
      if (!st.here) return `The film-style library is not on this machine yet. Get it with: ox studio films setup (or press Get the library in Studio). It goes to ${st.lib}.`;
      const by = {};
      for (const x of F.filmStyles({ env })) if (!a.category || x.category.toLowerCase().includes(String(a.category).toLowerCase())) (by[x.mine ? 'My styles' : x.category] ??= []).push(`${x.slug} (${x.name}): ${x.line}`);
      return Object.entries(by).map(([c, l]) => `${c}\n${l.map((x) => `  ${x}`).join('\n')}`).join('\n\n') || 'no style in that category';
    }
    if (name === 'craft_apps') {
      const K = await import('./studio-craft.js');
      let servers = {};
      try { servers = (await import('./config.js')).readConfigDoc().mcpServers ?? {}; } catch {}
      return K.craftStatus({ env, servers }).map((x) => `${x.id}: ${x.name} (${x.replaces}): ${x.what}. ${x.cli ? `Command-line tool: ${x.cli}${x.mcp ? `; MCP server "${x.id}" added` : ''}` : x.app ? `App: ${x.app} (no command-line tool: install it in Studio for agents)` : 'not installed (Studio › Craft apps)'}${x.skill ? `; skill ${x.id}` : ''}.`).join('\n');
    }
    if (name === 'video_edit') {
      const V = deps.video ?? (await import('./video-edit.js'));
      const f = String(a.file ?? '');
      if (a.op !== 'join' && !f) throw new Error('file is the video to edit');
      const ops = {
        join: () => V.join(a.files ?? []),
        captions: () => V.captions(f), cut: () => V.cut(f, a.start ?? 0, a.end ?? null), speed: () => V.speed(f, a.factor ?? 2),
        vertical: () => V.vertical(f, a.aspect ?? '9:16'), gif: () => V.gif(f, { start: a.start ?? null, end: a.end ?? null }),
        highlights: () => V.highlights(f, String(a.query ?? '')), polish: () => V.polish(f),
      };
      if (!ops[a.op]) throw new Error(`op is one of ${Object.keys(ops).join(', ')}`);
      const r = await ops[a.op]();
      return `${a.op} done: ${r.file ?? JSON.stringify(r)}`;
    }
    if (name === 'compose_video') {
      const V = deps.video ?? (await import('./video-edit.js'));
      const r = V.compose([].concat(a.files ?? []), { audio: a.audio ? String(a.audio) : null, volume: a.volume, keepOriginal: a.keep_original !== false, loopAudio: a.loop_audio !== false, out: a.out ? String(a.out) : null });
      return `long video done: ${r.file} (${r.scenes} scene${r.scenes === 1 ? '' : 's'}, ${Math.round(r.seconds)} s / ${r.minutes} min${a.audio ? ', audio mixed' : ''})`;
    }
    if (name === 'app_assets') {
      const K = await import('./devkit.js');
      const imgs = [].concat(a.images ?? []).map(String);
      if (a.op === 'icons') { const r = K.iconSet(imgs[0] ?? '', { out: a.out ?? null }); return `${r.files.length} icons in ${r.dir}${r.warn ? ` (${r.warn})` : ''}`; }
      if (a.op === 'shots') { const r = await K.storeShots(imgs, { captions: [].concat(a.captions ?? []), out: a.out ?? null, ...(a.sizes?.length ? { sizes: a.sizes } : {}) }); return `${r.files.length} store screenshots in ${r.dir}`; }
      if (a.op === 'demo') { const r = await K.demoVideo(imgs, { captions: [].concat(a.captions ?? []), out: a.out ?? null }); return `demo video: ${r.file} (${r.seconds} s)`; }
      throw new Error('op is icons, shots or demo');
    }
    if (name === 'animate_script') {
      const A = deps.animate ?? (await import('./animate.js'));
      if (a.save) { if (!a.folder) throw new Error('folder is the animation folder'); const r = A.saveAnimation(String(a.folder), String(a.save)); return `saved ${r.name}: later plans can reuse it`; }
      const done = (r) => `${r.scenes.map((x) => `${x.name}: ${x.file}`).join('\n')}\nall: ${r.all ?? '(one scene)'}\nplan: ${r.plan}`;
      if (a.folder && !a.source) return done(await A.renderSpec(String(a.folder), { only: a.redo?.length ? [].concat(a.redo) : null }));
      if (!a.source) throw new Error('source is a video, a transcript file or the script; folder is an existing animation');
      const r = await A.animate(String(a.source), { out: a.folder ? String(a.folder) : null, aspect: a.aspect ?? '9:16', brand: { bg: a.bg, fg: a.fg, accent: a.accent, logo: a.logo }, render: !a.plan_only, plan: deps.plan ?? null });
      return a.plan_only ? `${fs.readFileSync(r.plan, 'utf8')}\nfolder: ${r.dir} (render: animate_script with this folder)` : done(r);
    }
    if (name === 'explainer_video') {
      const V = deps.video ?? (await import('./video-edit.js'));
      const r = await V.explainerVideo(String(a.title ?? 'Explainer'), [].concat(a.steps ?? []));
      return `explainer done: ${r.file} (${r.slides ?? ''} slides${r.seconds ? `, ${Math.round(r.seconds)} s` : ''})`;
    }
    throw new Error(`unknown tool ${name}`);
  }
  return { call, jobs };
}

/** `ox studio mcp`: the Studio over MCP (stdio) for any agent. */
export function serveStudioMcp({ input = process.stdin, output = process.stdout, studio = createStudio() } = {}) {
  let buf = '';
  const send = (o) => output.write(`${JSON.stringify(o)}\n`);
  input.setEncoding('utf8');
  input.on('data', async (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'ox-studio', version: '0.1.0' }, instructions: 'OX Studio: open-weights image, video and audio models. Start with models_explore; for a production call workflow_instructions first. Video returns a job: call jobs_wait.' } });
      else if (msg.method === 'tools/list') send({ jsonrpc: '2.0', id: msg.id, result: { tools: STUDIO_MCP_TOOLS } });
      else if (msg.method === 'tools/call') {
        // Calls run side by side: a long video wait must not hold up the next call.
        studio.call(msg.params?.name, msg.params?.arguments ?? {})
          .then((text) => send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text }], isError: false } }))
          .catch((e) => send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: String(e?.message ?? e) }], isError: true } }));
      } else if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, result: {} });
    }
  });
}
