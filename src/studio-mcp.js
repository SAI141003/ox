// OX Studio for any agent (docs/STUDIO_ARCHITECTURE.md): the shape of
// Higgsfield's agent MCP server, on open-weights models. Claude Code, Codex,
// Cursor or any MCP app connects with `ox studio mcp` (stdio) and gets tools
// to explore models, generate and edit images and video, wait on jobs, run
// production recipes and edit video on this machine. Nothing is installed:
// the models run on a host you have a key for (fal, Hugging Face) or on your
// own Stable Diffusion server when one is running.
import * as C from './studio-catalog.js';

const IMAGE_SIZE = { '1:1': 'square_hd', '16:9': 'landscape_16_9', '9:16': 'portrait_16_9', '4:3': 'landscape_4_3', '3:4': 'portrait_4_3' };
const ASPECTS = Object.keys(IMAGE_SIZE);

/** Where a model can run right now, given the keys and servers this machine has. */
export function hostFor(model, { host = null, env = process.env } = {}) {
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
function modelFor(kind, ref, fallbackKind = kind) {
  const m = ref ? C.find(ref) : C.find(C.DEFAULTS[fallbackKind]);
  if (!m) throw new Error(`no model '${ref}'. models_explore lists them`);
  if (m.kind !== kind) throw new Error(`${m.name} makes ${m.kind}, not ${kind}`);
  return m;
}

/** Turn a Studio request into one engine call: { provider, model, prompt, settings, media }. */
export function plan(tool, a = {}, { env = process.env } = {}) {
  const aspect = a.aspect ? String(a.aspect) : null;
  if (aspect && !ASPECTS.includes(aspect)) throw new Error(`aspect is one of ${ASPECTS.join(', ')}`);
  const n = a.n != null ? Math.max(1, Math.min(4, Number(a.n) || 1)) : null;
  if (tool === 'generate_image') {
    const prompt = String(a.prompt ?? '').trim();
    if (!prompt) throw new Error('a prompt is needed');
    // Words in the picture: Qwen-Image is the open model that spells.
    const m = modelFor('image', a.model, a.model ? 'image' : /["“].+["”]|\b(text|title|sign|poster|logo|words?|caption)\b/i.test(prompt) ? 'text' : 'image');
    const provider = hostFor(m, { host: a.host, env });
    if (provider === 'hf') return { provider, model: m.hf, prompt, settings: {}, media: {}, label: m.name };
    if (provider === 'local') return { provider, model: 'local', prompt, settings: { ...(n ? { n } : {}), ...(aspect ? sizeFor(aspect) : {}) }, media: {}, label: m.name };
    return { provider, model: m.fal, prompt, settings: { ...(aspect ? { image_size: IMAGE_SIZE[aspect] } : {}), ...(n ? { num_images: n } : {}), ...(a.seed != null ? { seed: Number(a.seed) } : {}) }, media: {}, label: m.name };
  }
  if (tool === 'generate_video') {
    const raw = String(a.prompt ?? '').trim();
    if (!raw) throw new Error('a prompt is needed');
    if (a.camera && !C.CAMERA[a.camera]) throw new Error(`camera is one of ${Object.keys(C.CAMERA).join(', ')}`);
    const m = modelFor('video', a.model);
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
    const m = modelFor('edit', a.model);
    const provider = hostFor(m, { host: a.host, env });
    return { provider, model: m.fal, prompt: String(a.prompt), settings: {}, media: { edit: [String(a.image)] }, label: m.name };
  }
  const single = { upscale: ['upscale', 'image'], remove_background: ['cutout', 'image'] }[tool];
  if (single) {
    if (!a.image) throw new Error('image is a path or a link');
    const m = modelFor(single[0], a.model);
    return { provider: hostFor(m, { host: a.host, env }), model: m.fal, prompt: '', settings: tool === 'upscale' && a.scale ? { scale: Number(a.scale) } : {}, media: { start: [String(a.image)] }, label: m.name };
  }
  if (tool === 'lip_sync') {
    if (!a.video || !a.audio) throw new Error('lip_sync needs a video (the face) and an audio file (the voice), as links');
    const m = modelFor('lipsync', a.model);
    return { provider: hostFor(m, { host: a.host, env }), model: m.fal, prompt: '', settings: {}, media: { video: [String(a.video)], audio: [String(a.audio)] }, label: m.name };
  }
  if (tool === 'generate_audio') {
    if (!String(a.prompt ?? '').trim()) throw new Error('describe the sound');
    const m = modelFor('audio', a.model);
    return { provider: hostFor(m, { host: a.host, env }), model: m.fal, prompt: String(a.prompt), settings: a.seconds ? { seconds_total: Math.min(47, Number(a.seconds)) } : {}, media: {}, label: m.name };
  }
  throw new Error(`no plan for ${tool}`);
}

const sizeFor = (aspect) => {
  const [w, h] = aspect.split(':').map(Number);
  const s = 1024 / Math.max(w, h);
  return { width: Math.round((w * s) / 64) * 64, height: Math.round((h * s) / 64) * 64 };
};

const prop = (type, description, extra = {}) => ({ type, description, ...extra });
const aspectProp = prop('string', `Frame shape: ${ASPECTS.join(', ')}.`, { enum: ASPECTS });
const hostProp = prop('string', 'Where to run it: fal, hf (Hugging Face) or local (your Stable Diffusion server). Default: the first one this machine can use.', { enum: ['fal', 'hf', 'local'] });
const waitProp = prop('number', 'Seconds to wait for the result before returning the job id (default 45 for images, 0 for video). Use jobs_wait after.');

export const STUDIO_MCP_TOOLS = [
  { name: 'models_explore', description: 'The open-weights models OX Studio can use: what each makes, its licence, what it is good at, and whether this machine can run it now. Also the camera moves and the production recipes.', inputSchema: { type: 'object', properties: { kind: prop('string', 'image, edit, video, upscale, cutout, lipsync or audio. Omit for all.') } } },
  { name: 'generate_image', description: 'Make pictures from a prompt with an open model (FLUX.1 schnell by default; Qwen-Image when the prompt has words to spell). Returns the files, or a job id if it is still running.', inputSchema: { type: 'object', properties: { prompt: prop('string', 'What to make.'), model: prop('string', 'A model id from models_explore.'), aspect: aspectProp, n: prop('number', 'How many (1-4).'), seed: prop('number', 'Seed, to repeat a result.'), host: hostProp, wait_seconds: waitProp }, required: ['prompt'] } },
  { name: 'generate_video', description: 'Make a 5-second clip from a prompt, or from a starting image, with an open video model (Wan 2.2 by default). Add a camera move. Returns a job id; call jobs_wait.', inputSchema: { type: 'object', properties: { prompt: prop('string', 'What happens in the shot.'), image: prop('string', 'Optional first frame: a path or a link.'), camera: prop('string', `A camera move: ${Object.keys(C.CAMERA).join(', ')}.`, { enum: Object.keys(C.CAMERA) }), model: prop('string', 'A video model id from models_explore.'), aspect: aspectProp, seed: prop('number', 'Seed.'), host: hostProp, wait_seconds: waitProp }, required: ['prompt'] } },
  { name: 'edit_image', description: 'Change a picture by instruction ("make it night", "put the product on marble"), keeping the rest. Qwen-Image-Edit by default.', inputSchema: { type: 'object', properties: { image: prop('string', 'The picture: a path or a link.'), prompt: prop('string', 'What to change.'), model: prop('string', 'qwen-image-edit or flux-kontext-dev (non-commercial licence).'), host: hostProp, wait_seconds: waitProp }, required: ['image', 'prompt'] } },
  { name: 'upscale', description: 'Make a picture 4x larger with more detail (Real-ESRGAN).', inputSchema: { type: 'object', properties: { image: prop('string', 'A path or a link.'), scale: prop('number', '2 or 4.'), wait_seconds: waitProp }, required: ['image'] } },
  { name: 'remove_background', description: 'Cut the subject out of a picture onto a clear background (BiRefNet).', inputSchema: { type: 'object', properties: { image: prop('string', 'A path or a link.'), wait_seconds: waitProp }, required: ['image'] } },
  { name: 'lip_sync', description: 'Make the face in a video speak an audio track (LatentSync). Both as links.', inputSchema: { type: 'object', properties: { video: prop('string', 'Link to the video.'), audio: prop('string', 'Link to the audio.'), wait_seconds: waitProp }, required: ['video', 'audio'] } },
  { name: 'generate_audio', description: 'Make a sound effect or a short loop from a description (Stable Audio Open).', inputSchema: { type: 'object', properties: { prompt: prop('string', 'The sound.'), seconds: prop('number', 'Length, up to 47.'), wait_seconds: waitProp }, required: ['prompt'] } },
  { name: 'jobs_wait', description: 'Wait for jobs to finish and return their files.', inputSchema: { type: 'object', properties: { ids: prop('array', 'Job ids.', { items: { type: 'string' } }), timeout_seconds: prop('number', 'Give up after this long (default 300).') }, required: ['ids'] } },
  { name: 'history', description: 'What the Studio made recently: prompt, model, status and files.', inputSchema: { type: 'object', properties: { limit: prop('number', 'How many (default 20).') } } },
  { name: 'workflow_instructions', description: 'Step-by-step recipes for a production: product-photoshoot, youtube-thumbnail, character-sheet, explainer-video, short-ad. Omit the name for the list.', inputSchema: { type: 'object', properties: { name: prop('string', 'The recipe.') } } },
  { name: 'video_edit', description: 'Edit a video file on this machine with ffmpeg: captions (burned in from the speech), join (clips one after another; pass files), cut, speed, vertical (crop to 9:16 or 1:1), gif, highlights (the parts about a topic), polish (speed through idle stretches).', inputSchema: { type: 'object', properties: { op: prop('string', 'captions, join, cut, speed, vertical, gif, highlights or polish.', { enum: ['captions', 'join', 'cut', 'speed', 'vertical', 'gif', 'highlights', 'polish'] }), file: prop('string', 'The video file path.'), files: prop('array', 'join: the clips in order.', { items: { type: 'string' } }), start: prop('string', 'cut/gif: start (seconds or m:ss).'), end: prop('string', 'cut/gif: end.'), factor: prop('number', 'speed: 2 = twice as fast.'), aspect: prop('string', 'vertical: 9:16 or 1:1.'), query: prop('string', 'highlights: the topic.') }, required: ['op'] } },
  { name: 'explainer_video', description: 'Turn steps into an explainer video on this machine: one slide per step with a lit diagram, crossfades. No model or key needed.', inputSchema: { type: 'object', properties: { title: prop('string', 'The title.'), steps: prop('array', 'Steps as "Label: what happens".', { items: { type: 'string' } }) }, required: ['title', 'steps'] } },
];

const GENERATORS = new Set(['generate_image', 'generate_video', 'edit_image', 'upscale', 'remove_background', 'lip_sync', 'generate_audio']);

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
    ? `job ${j.id} done (${j.label}): ${j.files.length ? j.files.join(', ') : j.urls.join(', ')}`
    : j.status === 'failed' ? `job ${j.id} failed (${j.label}): ${j.error}` : `job ${j.id} is ${j.status} (${j.label}); call jobs_wait with ["${j.id}"]`);

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
      if (!list.length) throw new Error('kinds: image, edit, video, upscale, cutout, lipsync, audio');
      const ready = (m) => { try { return `ready on ${hostFor(m, { env })}`; } catch { return 'needs a host key'; } };
      const lines = list.map((m) => `${m.id} (${m.kind}) ${m.name}. Licence ${m.license}. Good at: ${m.good}. ${ready(m)}.`);
      if (!a.kind) lines.push('', `Camera moves for generate_video: ${Object.keys(C.CAMERA).join(', ')}.`, `Recipes for workflow_instructions: ${Object.keys(C.WORKFLOWS).join(', ')}.`);
      return lines.join('\n');
    }
    if (GENERATORS.has(name)) {
      const p = plan(name, a, { env });
      const job = start(p);
      const secs = a.wait_seconds != null ? Number(a.wait_seconds) : name === 'generate_video' || name === 'lip_sync' ? 0 : 45;
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
