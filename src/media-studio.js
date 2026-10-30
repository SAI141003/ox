// OX Studio: images and video from one prompt, 38 models, every result kept.
//
// Built on open-higgsfield (github.com/wide-trace/open-higgsfield), published by
// its author as a free, open-source studio to "clone, run and change": the model
// catalogue, each model's own settings, and the request mapping onto the
// Higgsfield platform API are ported here from its TypeScript, with the same
// behaviour. What ox adds:
//   * it runs from the terminal (`ox create`), the app (Studio) and the agent
//     (the create_media tool), not only a browser tab;
//   * finished results are downloaded to ~/.ox/media/ and kept with their full
//     recipe (model, settings, prompt, inputs), so they outlive the CDN link and
//     "reuse" restores the run exactly;
//   * local files can be used as inputs when you give a public URL for them;
//   * the key is stored like every other ox key (~/.ox/keys.json, 0600).
//
// The API (docs.higgsfield.ai): POST https://api.higgsfield.ai/<model path> with
// `Authorization: Key <id>:<secret>` -> { request_id, status_url }; poll
// GET /requests/<id>/status until completed | failed | nsfw | canceled.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const API_BASE = () => (process.env.HIGGSFIELD_API_BASE || process.env.HF_API_BASE_URL || 'https://api.higgsfield.ai').replace(/\/$/, '');
export const KEY_ENV = 'HIGGSFIELD_API_KEY';
export const MEDIA_DIR = () => path.join(process.env.OX_HOME || path.join(os.homedir(), '.ox'), 'media');
const HISTORY = () => path.join(MEDIA_DIR(), 'history.jsonl');
export const TERMINAL = new Set(['completed', 'failed', 'nsfw', 'canceled']);
export const POLL_INTERVAL_MS = 4000;
export const POLL_DEADLINE_MS = 10 * 60_000;

// ---- the catalogue (from open-higgsfield src/generation/catalog) ----------------

const IMAGE_ASPECT = ['auto', '1:1', '4:3', '3:4', '16:9', '9:16'];
const VIDEO_ASPECT = ['16:9', '9:16', '1:1'];
const SOUL_ASPECT = ['9:16', '16:9', '4:3', '3:4', '1:1', '2:3', '3:2'];
const SEEDANCE_ASPECT = ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9'];
const en = (values, def) => ({ type: 'enum', values, default: def });
const range = (min, max, def, step) => ({ type: 'range', min, max, default: def, ...(step ? { step } : {}) });
const bool = (def) => ({ type: 'boolean', default: def });

const t2v = (p) => (p.endsWith('/text-to-video') ? { text: p, image: p.replace(/\/text-to-video$/, '/image-to-video') } : { text: p });
const imageModel = (id, label, paths) => ({ id, surface: 'image', label, roles: { reference: 8 }, settings: { aspectRatio: en(IMAGE_ASPECT, '1:1'), resolution: en(['1k', '2k', '4k'], '1k') }, paths });
const videoModel = (id, label, roles, paths) => ({ id, surface: 'video', label, roles, settings: { aspectRatio: en(VIDEO_ASPECT, '16:9'), resolution: en(['720p', '1080p'], '720p'), duration: range(4, 10, 5) }, paths });

const soulSettings = { aspectRatio: en(SOUL_ASPECT, '1:1'), resolution: en(['720p', '1080p'], '720p'), batchSize: en(['1', '4'], '1'), enhancePrompt: bool(false) };
const klingTurbo = { aspectRatio: en(['16:9', '9:16', '1:1'], '16:9'), resolution: en(['720p', '1080p'], '720p'), duration: range(3, 15, 5) };
const kling3 = { aspectRatio: en(['16:9', '9:16', '1:1'], '16:9'), duration: range(3, 15, 5), sound: bool(true), cfgScale: range(0, 1, 0.5, 0.01), multiShots: bool(false) };
const klingMotion = { keepOriginalSound: bool(true), characterOrientation: en(['video', 'image'], 'video') };
const seedanceRoles = { start: 1, end: 1, reference: 9, video: 3, audio: 3 };
const seedance = { aspectRatio: en(SEEDANCE_ASPECT, '16:9'), duration: range(4, 15, 5), generateAudio: bool(true) };
const seedance25s = { resolution: en(['480p', '720p'], '720p'), generateAudio: bool(true), outputFormat: en(['mp4', 'mov'], 'mp4') };

export const MODELS = Object.freeze([
  { id: 'soul-2', surface: 'image', label: 'Soul 2', roles: {}, settings: soulSettings },
  { id: 'soul-cinema', surface: 'image', label: 'Soul Cinema', roles: {}, settings: soulSettings },
  { id: 'seedance-2.5', surface: 'video', label: 'Seedance 2.5', roles: { start: 1, end: 1, reference: 30, video: 10, audio: 10 }, settings: { aspectRatio: en(SEEDANCE_ASPECT, '16:9'), duration: range(4, 30, 5), ...seedance25s } },
  { id: 'seedance-2.5-edit', surface: 'video', label: 'Seedance 2.5 Edit', roles: { video: 1, reference: 30, audio: 10 }, settings: seedance25s },
  { id: 'seedance-2.5-extend', surface: 'video', label: 'Seedance 2.5 Extend', roles: { video: 1, reference: 30, audio: 10 }, settings: { duration: range(4, 30, 5), ...seedance25s } },
  { id: 'seedance-2', surface: 'video', label: 'Seedance 2.0', roles: seedanceRoles, settings: { ...seedance, resolution: en(['480p', '720p', '1080p', '4k'], '720p') } },
  { id: 'seedance-2-fast', surface: 'video', label: 'Seedance 2.0 Fast', roles: seedanceRoles, settings: { ...seedance, resolution: en(['480p', '720p'], '720p') } },
  { id: 'seedance-2-mini', surface: 'video', label: 'Seedance 2.0 Mini', roles: seedanceRoles, settings: { ...seedance, resolution: en(['480p', '720p'], '720p') } },
  { id: 'kling-3-turbo', surface: 'video', label: 'Kling 3.0 Turbo', roles: { start: 1 }, settings: klingTurbo },
  { id: 'kling-3-std', surface: 'video', label: 'Kling 3.0 Standard', roles: { start: 1, end: 1 }, settings: kling3 },
  { id: 'kling-3-pro', surface: 'video', label: 'Kling 3.0 Pro', roles: { start: 1, end: 1 }, settings: kling3 },
  { id: 'kling-3-4k', surface: 'video', label: 'Kling 3.0 4K', roles: { start: 1, end: 1 }, settings: kling3 },
  { id: 'kling-3-motion-std', surface: 'video', label: 'Kling 3.0 Motion Control', roles: { start: 1, video: 1 }, settings: klingMotion },
  { id: 'kling-3-motion-pro', surface: 'video', label: 'Kling 3.0 Motion Control Pro', roles: { start: 1, video: 1 }, settings: klingMotion },
  imageModel('flux-2', 'Flux 2', { text: 'flux-2-pro' }),
  imageModel('grok-imagine-2', 'Grok Imagine 2.0', { text: 'xai/grok-imagine-image-2.0' }),
  imageModel('ideogram-4', 'Ideogram 4.0', { text: 'ideogram/v4.0' }),
  imageModel('recraft-4.1', 'Recraft 4.1', { text: 'recraft/v4.1/text-to-image' }),
  imageModel('qwen-image-3', 'Qwen Image 3', { text: 'alibaba/qwen-image-3/text-to-image' }),
  imageModel('z-image-turbo', 'Z-Image Turbo', { text: 'z-image/turbo' }),
  videoModel('wan-3', 'Wan 3.0', { start: 1 }, t2v('alibaba/wan-3.0/text-to-video')),
  videoModel('wan-3-prime', 'Wan 3.0 Prime', { start: 1 }, t2v('alibaba/wan-3.0-prime/text-to-video')),
  videoModel('wan-2.7', 'Wan 2.7', { start: 1 }, t2v('wan/v2.7/text-to-video')),
  videoModel('wan-2.6', 'Wan 2.6', { start: 1 }, t2v('wan/v2.6/text-to-video')),
  videoModel('flux-3', 'Flux 3', { start: 1 }, t2v('blackforestlabs/flux-3/text-to-video')),
  videoModel('minimax-h3', 'MiniMax H3', { start: 1 }, t2v('minimax/h3/text-to-video')),
  videoModel('minimax-hailuo-2.3', 'MiniMax Hailuo 2.3', { start: 1 }, t2v('minimax/hailuo-2.3/standard/text-to-video')),
  videoModel('happy-horse-1', 'Happy Horse 1.0', { start: 1 }, t2v('alibaba/happy-horse/text-to-video')),
  videoModel('happy-horse-1.1', 'Happy Horse 1.1', { start: 1 }, t2v('alibaba/happy-horse/v1.1/text-to-video')),
  videoModel('kling-2.6', 'Kling 2.6', { start: 1 }, t2v('kling-video/v2.6/pro/text-to-video')),
  videoModel('kling-2.5', 'Kling 2.5', { start: 1 }, { image: 'kling-video/v2.5-turbo/standard/image-to-video' }),
  videoModel('kling-o3', 'Kling O3', { start: 1, end: 1 }, { firstLast: 'kling-video/o3/first-last-frame' }),
  videoModel('kling-o1', 'Kling O1 (Omni)', { start: 1, end: 1 }, { firstLast: 'kling-video/omni/first-last-frame' }),
  videoModel('ltx-2.5-fast', 'LTX 2.5 Fast', { start: 1 }, t2v('lightricks/ltx-2.5/text-to-video/fast')),
  videoModel('ltx-2.5-pro', 'LTX 2.5 Pro', { start: 1 }, t2v('lightricks/ltx-2.5/text-to-video/pro')),
  videoModel('grok-imagine-video-1.5', 'Grok Imagine Video 1.5', { reference: 8, video: 3 }, { reference: 'xai/grok-imagine-video/v1.5/reference-to-video' }),
  videoModel('pixverse-6', 'PixVerse 6', { start: 1 }, t2v('pixverse/v6/text-to-video')),
  videoModel('dop', 'DoP', { start: 1 }, { image: 'higgsfield-ai/dop/lite' }),
]);

export function getModel(id) {
  const m = MODELS.find((x) => x.id === id);
  if (!m) throw new Error(`unknown model '${id}'. ox create --models lists them`);
  return m;
}

// Settings the model declares, defaults filled in, anything out of range refused.
export function parseSettings(model, raw = {}) {
  const out = {};
  for (const [key, field] of Object.entries(model.settings)) {
    let v = raw[key];
    if (field.type === 'enum') {
      v = v == null ? field.default : String(v);
      if (!field.values.includes(v)) throw new Error(`${key} must be one of ${field.values.join(', ')}`);
    } else if (field.type === 'range') {
      v = v == null || v === '' ? field.default : Number(v);
      if (!Number.isFinite(v) || v < field.min || v > field.max) throw new Error(`${key} must be between ${field.min} and ${field.max}`);
    } else {
      v = v == null ? field.default : v === true || v === 'true' || v === 'on' || v === '1';
    }
    out[key] = v;
  }
  return out;
}

// ---- the request each model expects (from open-higgsfield to-platform.ts) -------

const urlsOf = (plane, role) => (plane.media?.[role] ?? []).map((m) => (typeof m === 'string' ? m : m.url));

function mapByPaths(plane, spec) {
  const [start] = urlsOf(plane, 'start'); const [end] = urlsOf(plane, 'end');
  const refs = urlsOf(plane, 'reference'); const videos = urlsOf(plane, 'video');
  const s = plane.settings;
  const body = { prompt: plane.prompt, ...(s.aspectRatio ? { aspect_ratio: s.aspectRatio } : {}), ...(s.resolution ? { resolution: s.resolution } : {}), ...(typeof s.duration === 'number' ? { duration: s.duration } : {}) };
  if (spec.firstLast && (start || end)) return { path: spec.firstLast, body: { ...body, ...(start ? { first_frame_url: start } : {}), ...(end ? { last_frame_url: end } : {}) } };
  if (spec.image && start) return { path: spec.image, body: { ...body, image_url: start, ...(end ? { last_image_url: end } : {}) } };
  if (spec.reference && (refs.length || videos.length)) return { path: spec.reference, body: { ...body, ...(refs.length ? { image_urls: refs } : {}), ...(videos.length ? { video_urls: videos } : {}) } };
  if (spec.text) return { path: spec.text, body: refs.length ? { ...body, image_urls: refs } : body };
  if (spec.image) return { path: spec.image, body };
  if (spec.reference) return { path: spec.reference, body };
  if (spec.firstLast) return { path: spec.firstLast, body };
  throw new Error('model has no platform path');
}
const soul = (p) => (plane) => ({ path: p, body: { prompt: plane.prompt, batch_size: Number(plane.settings.batchSize), resolution: plane.settings.resolution, aspect_ratio: plane.settings.aspectRatio, enhance_prompt: plane.settings.enhancePrompt } });
function klingTurboMap(plane) {
  const [start] = urlsOf(plane, 'start'); const s = plane.settings;
  return { path: start ? 'kling-video/v3.0-turbo/image-to-video' : 'kling-video/v3.0-turbo/text-to-video', body: { prompt: plane.prompt, duration: s.duration, resolution: s.resolution, ...(start ? { image_url: start } : { aspect_ratio: s.aspectRatio }) } };
}
const kling3Map = (prefix) => (plane) => {
  const [start] = urlsOf(plane, 'start'); const [end] = urlsOf(plane, 'end'); const s = plane.settings;
  const body = { prompt: plane.prompt, sound: s.sound ? 'on' : 'off', duration: s.duration, cfg_scale: s.cfgScale, multi_shots: s.multiShots };
  if (start) return { path: `${prefix}/image-to-video`, body: { ...body, image_url: start, ...(end ? { last_image_url: end } : {}) } };
  return { path: `${prefix}/text-to-video`, body: { ...body, aspect_ratio: s.aspectRatio } };
};
const klingMotionMap = (p) => (plane) => {
  const [start] = urlsOf(plane, 'start'); const [video] = urlsOf(plane, 'video');
  return { path: p, body: { prompt: plane.prompt, ...(start ? { image_url: start } : {}), ...(video ? { video_url: video } : {}), keep_original_sound: plane.settings.keepOriginalSound ? 'yes' : 'no', character_orientation: plane.settings.characterOrientation } };
};
const seedanceBody = (plane, withDuration) => ({ prompt: plane.prompt, resolution: plane.settings.resolution, generate_audio: plane.settings.generateAudio, ...(withDuration ? { duration: plane.settings.duration } : {}), ...(plane.settings.outputFormat ? { output_format: plane.settings.outputFormat } : {}) });
const seedanceMap = (prefix) => (plane) => {
  const [start] = urlsOf(plane, 'start'); const [end] = urlsOf(plane, 'end');
  const refs = urlsOf(plane, 'reference'); const videos = urlsOf(plane, 'video'); const audios = urlsOf(plane, 'audio');
  const shared = seedanceBody(plane, true);
  if (start) return { path: `${prefix}/image-to-video`, body: { ...shared, image_url: start, ...(end ? { end_image_url: end } : {}) } };
  if (refs.length || videos.length || audios.length) return { path: `${prefix}/reference-to-video`, body: { ...shared, aspect_ratio: plane.settings.aspectRatio, ...(refs.length ? { image_urls: refs } : {}), ...(videos.length ? { video_urls: videos } : {}), ...(audios.length ? { audio_urls: audios } : {}) } };
  return { path: `${prefix}/text-to-video`, body: { ...shared, aspect_ratio: plane.settings.aspectRatio } };
};
const seedanceSource = (p, withDuration) => (plane) => {
  const [video, ...extra] = urlsOf(plane, 'video'); const refs = urlsOf(plane, 'reference'); const audios = urlsOf(plane, 'audio');
  return { path: p, body: { ...seedanceBody(plane, withDuration), ...(video ? { video_url: video } : {}), ...(refs.length ? { image_urls: refs } : {}), ...(extra.length ? { video_urls: extra } : {}), ...(audios.length ? { audio_urls: audios } : {}) } };
};

const MAP = {
  'soul-cinema': soul('higgsfield-ai/soul/cinema'), 'soul-2': soul('higgsfield-ai/soul/v2/standard'),
  'kling-3-turbo': klingTurboMap, 'kling-3-std': kling3Map('kling-video/v3.0/std'), 'kling-3-pro': kling3Map('kling-video/v3.0/pro'), 'kling-3-4k': kling3Map('kling-video/v3.0/4k'),
  'kling-3-motion-std': klingMotionMap('kling-video/v3/motion-control/std'), 'kling-3-motion-pro': klingMotionMap('kling-video/v3/motion-control/pro'),
  'seedance-2': seedanceMap('bytedance/seedance-2.0'), 'seedance-2-fast': seedanceMap('bytedance/seedance-2.0/fast'), 'seedance-2-mini': seedanceMap('bytedance/seedance-2.0/mini'),
  'seedance-2.5': seedanceMap('bytedance/seedance-2.5'), 'seedance-2.5-edit': seedanceSource('bytedance/seedance-2.5/video-edit', false), 'seedance-2.5-extend': seedanceSource('bytedance/seedance-2.5/video-extend', true),
};

// { model, prompt, settings, media: { start: [url], reference: [url, …] } } -> { path, body }
export function toPlatform(plane) {
  const model = getModel(plane.model);
  if (!String(plane.prompt ?? '').trim() && !Object.values(plane.media ?? {}).some((l) => l?.length)) throw new Error('a prompt is needed');
  const media = {};
  for (const [role, list] of Object.entries(plane.media ?? {})) {
    const max = model.roles[role];
    if (!max) throw new Error(`${model.label} takes no ${role} input (it takes: ${Object.keys(model.roles).join(', ') || 'only a prompt'})`);
    for (const u of list) if (!/^https:\/\//.test(typeof u === 'string' ? u : u?.url)) throw new Error(`${role} inputs must be public https URLs`);
    media[role] = list.slice(0, max);
  }
  const p = { ...plane, prompt: String(plane.prompt ?? ''), media, settings: parseSettings(model, plane.settings) };
  const map = MAP[model.id] ?? (model.paths ? (x) => mapByPaths(x, model.paths) : null);
  if (!map) throw new Error(`no platform route for ${model.id}`);
  return map(p);
}

// ---- the platform client ---------------------------------------------------------

export function apiKey(env = process.env) {
  const k = String(env[KEY_ENV] ?? '').trim();
  if (!k) return null;
  const c = k.indexOf(':');
  if (c <= 0 || c === k.length - 1) throw new Error(`${KEY_ENV} must be id:secret (from console.higgsfield.ai)`);
  return k;
}

export function createClient({ key = apiKey(), base = API_BASE(), fetchImpl = globalThis.fetch } = {}) {
  if (!key) throw new Error(`no Higgsfield key. Get one at console.higgsfield.ai, then: ox create --key <id:secret> (or Settings › API keys)`);
  const send = async (method, p, body) => {
    const r = await fetchImpl(`${base}${p}`, { method, headers: { Authorization: `Key ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60_000) });
    const text = await r.text();
    let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!r.ok) throw new Error((data && typeof data === 'object' && typeof data.detail === 'string' && data.detail) || `platform request failed (${r.status})`);
    return data ?? {};
  };
  return {
    async submit(p, body) {
      if (!/^[a-z0-9][a-z0-9._/-]*$/i.test(p) || p.includes('..')) throw new Error('invalid model path');
      const d = await send('POST', `/${p}`, body);
      if (typeof d.request_id !== 'string') throw new Error('the platform answered without a request_id');
      return { requestId: d.request_id, status: d.status ?? 'queued' };
    },
    async status(id) {
      const d = await send('GET', `/requests/${encodeURIComponent(id)}/status`);
      return {
        status: String(d.status ?? 'unknown'), requestId: d.request_id ?? id,
        images: Array.isArray(d.images) ? d.images.map((x) => x?.url).filter((u) => typeof u === 'string') : [],
        video: typeof d.video?.url === 'string' ? d.video.url : null,
        error: d.error ?? null,
      };
    },
  };
}

export async function waitFor(client, requestId, { interval = POLL_INTERVAL_MS, deadline = Date.now() + POLL_DEADLINE_MS, onStatus = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let misses = 0;
  for (;;) {
    try {
      const s = await client.status(requestId);
      misses = 0;
      onStatus(s);
      if (TERMINAL.has(s.status)) return s;
    } catch (e) {
      if (++misses >= 3) throw e; // one dropped round must not end a generation
    }
    if (Date.now() > deadline) throw new Error('timed out waiting for the platform (10 minutes)');
    await sleep(interval);
  }
}

// ---- history: every run, with its recipe and the files kept locally -------------

export function history({ limit = 200 } = {}) {
  const byId = new Map();
  try {
    for (const l of fs.readFileSync(HISTORY(), 'utf8').split('\n')) {
      if (!l) continue;
      try { const r = JSON.parse(l); byId.set(r.id, { ...byId.get(r.id), ...r }); } catch {}
    }
  } catch {}
  return [...byId.values()].filter((r) => !r.deleted).sort((a, b) => b.at - a.at).slice(0, limit);
}

export function note(row) {
  fs.mkdirSync(MEDIA_DIR(), { recursive: true });
  fs.appendFileSync(HISTORY(), `${JSON.stringify(row)}\n`);
}

async function download(url, dest, fetchImpl) {
  const r = await fetchImpl(url, { signal: AbortSignal.timeout(300_000) });
  if (!r.ok) throw new Error(`download failed (${r.status})`);
  fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
  return dest;
}

// The whole run: submit, wait, download, record. Returns the finished record.
export async function create({ model, prompt = '', settings = {}, media = {}, client, fetchImpl = globalThis.fetch, onStatus = () => {}, wait, run = process.env.OX_RUN_ID } = {}) {
  const m = getModel(model);
  const { path: p, body } = toPlatform({ model, prompt, settings, media });
  const c = client ?? createClient({ fetchImpl });
  const id = crypto.randomBytes(5).toString('hex');
  const recipe = { id, at: Date.now(), model: m.id, label: m.label, surface: m.surface, prompt, settings: parseSettings(m, settings), media, ...(run ? { run: String(run) } : {}) };
  const queued = await c.submit(p, body);
  note({ ...recipe, requestId: queued.requestId, status: 'queued' });
  const done = await waitFor(c, queued.requestId, { onStatus, ...(wait ?? {}) });
  const urls = done.video ? [done.video] : done.images;
  const files = [];
  if (done.status === 'completed') {
    const dir = path.join(MEDIA_DIR(), id);
    fs.mkdirSync(dir, { recursive: true });
    for (const [i, u] of urls.entries()) {
      const ext = (/\.(png|jpe?g|webp|gif|mp4|mov|webm)(?:\?|$)/i.exec(u)?.[1] ?? (m.surface === 'video' ? 'mp4' : 'png')).toLowerCase();
      try { files.push(await download(u, path.join(dir, `${i + 1}.${ext}`), fetchImpl)); } catch {}
    }
  }
  const row = { id, status: done.status, urls, files, error: done.error ? String(typeof done.error === 'object' ? JSON.stringify(done.error) : done.error) : null, doneAt: Date.now() };
  note(row);
  return { ...recipe, requestId: queued.requestId, ...row };
}

// ---- other providers: so ox never depends on one company ---------------------------
//
//   fal      any model on fal.ai by its id (docs: fal.ai/docs, queue API):
//            POST https://queue.fal.run/<model> -> { request_id, status_url,
//            response_url }; status IN_QUEUE | IN_PROGRESS | COMPLETED; the result
//            has images[].url or video.url.
//   openai   GPT Image models (gpt-image-2, gpt-image-1.5, gpt-image-1-mini…):
//            POST /v1/images/generations -> data[].b64_json.
//   local    a Stable Diffusion server on this machine with the Automatic1111
//            API (Draw Things, Forge, AUTOMATIC1111, SD.Next): POST
//            /sdapi/v1/txt2img -> images[] (base64). No account, nothing leaves.

export const PROVIDERS = Object.freeze({
  higgsfield: { label: 'Higgsfield', key: KEY_ENV, kinds: ['image', 'video'], models: () => MODELS.map((m) => ({ id: m.id, label: m.label, surface: m.surface })) },
  fal: { label: 'fal.ai', key: 'FAL_KEY', kinds: ['image', 'video'], models: () => [{ id: 'fal-ai/flux/schnell', label: 'FLUX.1 schnell', surface: 'image' }], anyModel: true },
  openai: { label: 'OpenAI', key: 'OPENAI_API_KEY', kinds: ['image'], models: () => ['gpt-image-2', 'gpt-image-1.5', 'gpt-image-1', 'gpt-image-1-mini'].map((id) => ({ id, label: id, surface: 'image' })) },
  local: { label: 'This machine (Stable Diffusion)', key: null, kinds: ['image'], models: () => [{ id: 'local', label: 'the loaded model', surface: 'image' }] },
  // Your own ComfyUI (Comfy-Org/ComfyUI, GPL-3.0, run by you): its standard text-to-image
  // graph on a checkpoint you have, or your own workflow saved with "Save (API)".
  comfyui: { label: 'ComfyUI on this machine', key: null, kinds: ['image', 'video'], models: () => [{ id: 'default', label: 'your first checkpoint', surface: 'image' }], anyModel: true },
  // This Mac's own chip (src/studio-local.js): images, edits, clips, upscale, cut-out. No key.
  device: { label: 'This Mac (own chip, no key)', key: null, kinds: ['image', 'video'], models: () => [{ id: 'mac-image', label: 'SD-Turbo on this Mac', surface: 'image' }, { id: 'mac-video', label: 'Living picture on this Mac', surface: 'video' }] },
  // Open models on Hugging Face Inference (text to image), with your HF token.
  hf: { label: 'Hugging Face', key: 'HF_TOKEN', kinds: ['image'], models: () => [{ id: 'black-forest-labs/FLUX.1-schnell', label: 'FLUX.1 schnell', surface: 'image' }], anyModel: true },
  // Image models behind your OpenRouter key (they make and edit pictures from a prompt).
  openrouter: { label: 'OpenRouter', key: 'OPENROUTER_API_KEY', kinds: ['image'], models: () => ['google/gemini-2.5-flash-image', 'openai/gpt-5-image-mini'].map((id) => ({ id, label: id, surface: 'image' })), anyModel: true },
});

// A source image for an edit: a local path (read here) or an https URL.
async function sourceImage(ref, fetchImpl) {
  const s = String(ref ?? '');
  if (/^https?:\/\//.test(s)) { const r = await fetchImpl(s); if (!r.ok) throw new Error(`could not fetch the image (${r.status})`); return { buf: Buffer.from(await r.arrayBuffer()), type: r.headers.get('content-type') || 'image/png', name: 'image.png' }; }
  const f = s.replace(/^~(?=\/)/, os.homedir());
  if (!fs.existsSync(f)) throw new Error(`no image at ${s}`);
  const ext = path.extname(f).slice(1).toLowerCase();
  const TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4' };
  return { buf: fs.readFileSync(f), type: TYPES[ext] ?? 'image/png', name: path.basename(f) };
}
const dataUri = (img) => `data:${img.type};base64,${img.buf.toString('base64')}`;

const LOCAL_SD = () => (process.env.OX_SD_URL || 'http://127.0.0.1:7860').replace(/\/$/, '');
const COMFY = () => (process.env.OX_COMFYUI_URL || 'http://127.0.0.1:8188').replace(/\/$/, '');

/** ComfyUI's standard text-to-image graph (API format). */
export function comfyTxt2img({ ckpt, prompt, negative = '', width = 1024, height = 1024, steps = 25, cfg = 7, seed = Math.floor(Math.random() * 2 ** 32), n = 1 }) {
  return {
    4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: ckpt } },
    5: { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: n } },
    6: { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['4', 1] } },
    7: { class_type: 'CLIPTextEncode', inputs: { text: negative, clip: ['4', 1] } },
    3: { class_type: 'KSampler', inputs: { seed, steps, cfg, sampler_name: 'euler', scheduler: 'normal', denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] } },
    8: { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    9: { class_type: 'SaveImage', inputs: { filename_prefix: 'ox', images: ['8', 0] } },
  };
}

/** Run a graph on ComfyUI and bring its images (and videos) home. */
async function runComfy({ graph, dir, fetchImpl, onStatus, timeoutMs = 15 * 60_000 }) {
  const q = await jsonFetch(fetchImpl, `${COMFY()}/prompt`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: graph, client_id: 'ox' }) });
  if (!q.prompt_id) throw new Error(`ComfyUI did not queue it: ${JSON.stringify(q.node_errors ?? q.error ?? q).slice(0, 200)}`);
  const t0 = Date.now();
  for (;;) {
    if (Date.now() - t0 > timeoutMs) throw new Error('ComfyUI took too long');
    const h = await jsonFetch(fetchImpl, `${COMFY()}/history/${q.prompt_id}`);
    const run = h[q.prompt_id];
    if (run?.status?.status_str === 'error') throw new Error(`ComfyUI: ${JSON.stringify(run.status.messages ?? '').slice(0, 200)}`);
    if (run?.outputs && Object.keys(run.outputs).length) {
      fs.mkdirSync(dir, { recursive: true });
      const files = [];
      for (const out of Object.values(run.outputs)) {
        for (const it of [...(out.images ?? []), ...(out.gifs ?? []), ...(out.videos ?? [])]) {
          const r = await fetchImpl(`${COMFY()}/view?${new URLSearchParams({ filename: it.filename, subfolder: it.subfolder ?? '', type: it.type ?? 'output' })}`);
          if (!r.ok) continue;
          const f = path.join(dir, `${files.length + 1}${path.extname(it.filename) || '.png'}`);
          fs.writeFileSync(f, Buffer.from(await r.arrayBuffer()));
          files.push(f);
        }
      }
      return files;
    }
    onStatus?.('ComfyUI is working');
    await new Promise((res) => setTimeout(res, 1500));
  }
}

async function jsonFetch(fetchImpl, url, init = {}) {
  const r = await fetchImpl(url, { ...init, signal: init.signal ?? AbortSignal.timeout(300_000) });
  const text = await r.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) throw new Error((data && typeof data === 'object' && (data.detail?.toString?.() || data.error?.message || data.error)) || `request failed (${r.status})`);
  return data ?? {};
}

const writeB64 = (dir, i, b64, ext) => { const f = path.join(dir, `${i + 1}.${ext}`); fs.writeFileSync(f, Buffer.from(b64, 'base64')); return f; };

// One run on any provider. Higgsfield goes through create(); the others here.
export async function generate({ provider = 'higgsfield', model, prompt = '', settings = {}, media: mediaIn = {}, fetchImpl = globalThis.fetch, onStatus = () => {}, wait, env = process.env, run = env.OX_RUN_ID } = {}) {
  let media = { ...mediaIn };
  if (provider === 'higgsfield') return create({ model, prompt, settings, media, fetchImpl, onStatus, wait, run });
  const P = PROVIDERS[provider];
  if (!P) throw new Error(`unknown provider '${provider}' (${Object.keys(PROVIDERS).join(', ')})`);
  // Upscale, cutout and lip sync work from media alone.
  if (!String(prompt).trim() && !Object.values(media).some((l) => l?.length)) throw new Error('a prompt is needed');
  const key = P.key ? String(env[P.key] ?? '').trim() : null;
  if (P.key && !key) throw new Error(`no ${P.label} key. Set ${P.key} (Settings › API keys)`);
  const id = crypto.randomBytes(5).toString('hex');
  const dir = path.join(MEDIA_DIR(), id);
  const recipe = { id, at: Date.now(), provider, model, label: model, surface: 'image', prompt, settings, media, ...(run ? { run: String(run) } : {}) };
  note({ ...recipe, status: 'queued' });
  let files = []; let urls = []; let surface = 'image'; let status = 'completed'; let error = null;
  try {
    const editOf = media.edit?.[0] ?? null;
    if (editOf) recipe.surface = 'image';
    if (provider === 'openai' && editOf) {
      // One prompt edits the picture (Krea's idea): /images/edits with the source attached.
      const img = await sourceImage(editOf, fetchImpl);
      const form = new FormData();
      form.append('model', model || 'gpt-image-2');
      form.append('prompt', prompt);
      form.append('image', new Blob([img.buf], { type: img.type }), img.name);
      if (settings.size) form.append('size', settings.size);
      const d = await jsonFetch(fetchImpl, `${(env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '')}/images/edits`, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form });
      fs.mkdirSync(dir, { recursive: true });
      for (const [i, item] of (d.data ?? []).entries()) if (item.b64_json) files.push(writeB64(dir, i, item.b64_json, 'png'));
    } else if (provider === 'openrouter') {
      const content = [{ type: 'text', text: editOf ? `Edit this image: ${prompt}. Return the edited image.` : prompt }];
      if (editOf) content.push({ type: 'image_url', image_url: { url: dataUri(await sourceImage(editOf, fetchImpl)) } });
      const d = await jsonFetch(fetchImpl, `${(env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, '')}/chat/completions`, {
        method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: model || 'google/gemini-2.5-flash-image', modalities: ['image', 'text'], messages: [{ role: 'user', content }] }),
      });
      fs.mkdirSync(dir, { recursive: true });
      const imgs = d.choices?.[0]?.message?.images ?? [];
      for (const [i, im] of imgs.entries()) { const u = im?.image_url?.url ?? ''; const m = /^data:image\/(\w+);base64,(.+)$/.exec(u); if (m) files.push(writeB64(dir, i, m[2], m[1] === 'jpeg' ? 'jpg' : m[1])); else if (u) files.push(await download(u, path.join(dir, `${i + 1}.png`), fetchImpl)); }
      if (!files.length) throw new Error(`${model || 'the model'} answered without an image${d.choices?.[0]?.message?.content ? `: ${String(d.choices[0].message.content).slice(0, 160)}` : ''}`);
    } else if (provider === 'device') {
      const L = await import('./studio-local.js');
      const op = deviceOp(model, editOf, settings);
      // A link becomes a local file first: everything below reads files.
      let src = media.start?.[0] ?? editOf ?? null;
      if (src && /^https?:/.test(String(src))) { const img = await sourceImage(src, fetchImpl); fs.mkdirSync(dir, { recursive: true }); src = path.join(dir, `source${path.extname(img.name) || '.png'}`); fs.writeFileSync(src, img.buf); }
      const common = { outDir: dir, env, onLine: (l) => { const m = /\|\s*(\d+)\/(\d+)/.exec(l); if (m) onStatus({ status: 'in_progress', step: `${m[1]}/${m[2]}` }); } };
      const r = op === 'video' ? await L.livingPicture({ ...common, prompt, image: src, aspect: settings.aspect ?? '16:9', camera: settings.camera ?? 'push-in', seed: settings.seed ?? null, onStep: (what, detail) => onStatus({ status: 'in_progress', step: `${what} ${detail ?? ''}`.trim() }) })
        : op === 'edit' ? await L.imageToImage({ ...common, image: src, prompt, strength: settings.strength ?? 0.5, seed: settings.seed ?? null, fast: !!settings.fast })
        : op === 'upscale' ? await L.upscale({ ...common, image: src, prompt, mode: settings.mode ?? 'detail' })
        : op === 'cutout' ? await L.cutout({ ...common, image: src })
        : await L.textToImage({ ...common, prompt, aspect: settings.aspect ?? '1:1', n: settings.n ?? 1, seed: settings.seed ?? null, fast: !!settings.fast });
      files = r.files;
      surface = op === 'video' ? 'video' : 'image';
      recipe.label = { 'mac-image': 'SD-Turbo on this Mac', 'mac-edit': 'Edit on this Mac', 'mac-video': 'Living picture on this Mac', 'mac-upscale': `Upscale on this Mac (${r.mode ?? 'detail'})`, 'mac-cutout': 'Apple Vision cut-out' }[model] ?? model;
      recipe.surface = surface;
      if (r.seed != null) recipe.settings = { ...settings, seed: r.seed };
    } else if (provider === 'local' && editOf) {
      const img = await sourceImage(editOf, fetchImpl);
      const d = await jsonFetch(fetchImpl, `${LOCAL_SD()}/sdapi/v1/img2img`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, init_images: [img.buf.toString('base64')], denoising_strength: Number(settings.strength ?? 0.55), steps: Number(settings.steps ?? 25) }),
      }).catch((e) => { throw new Error(`no Stable Diffusion server answered at ${LOCAL_SD()} (${e.message})`); });
      fs.mkdirSync(dir, { recursive: true });
      files = (d.images ?? []).map((b64, i) => writeB64(dir, i, String(b64).replace(/^data:image\/\w+;base64,/, ''), 'png'));
    } else if (provider === 'fal' && editOf && !/^https?:/.test(editOf)) {
      // fal takes the source as a data URI when it is a local file.
      media = { ...media, start: [dataUri(await sourceImage(editOf, fetchImpl))] };
      delete media.edit;
      return generate({ provider, model: model || 'fal-ai/flux-pro/kontext', prompt, settings, media, fetchImpl, onStatus, wait, env });
    } else if (provider === 'openai') {
      const d = await jsonFetch(fetchImpl, `${(env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '')}/images/generations`, {
        method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: model || 'gpt-image-2', prompt, ...(settings.size ? { size: settings.size } : {}), ...(settings.quality ? { quality: settings.quality } : {}), ...(settings.n ? { n: Number(settings.n) } : {}), ...(settings.outputFormat ? { output_format: settings.outputFormat } : {}) }),
      });
      fs.mkdirSync(dir, { recursive: true });
      const ext = settings.outputFormat === 'jpeg' ? 'jpg' : settings.outputFormat || 'png';
      for (const [i, item] of (d.data ?? []).entries()) {
        if (item.b64_json) files.push(writeB64(dir, i, item.b64_json, ext));
        else if (item.url) { urls.push(item.url); files.push(await download(item.url, path.join(dir, `${i + 1}.${ext}`), fetchImpl)); }
      }
    } else if (provider === 'comfyui') {
      let graph;
      if (settings.workflow) {
        // Your own graph, exported with "Save (API)"; {{prompt}} marks where the prompt goes.
        graph = JSON.parse(fs.readFileSync(String(settings.workflow).replace(/^~(?=\/)/, os.homedir()), 'utf8').split('{{prompt}}').join(JSON.stringify(String(prompt)).slice(1, -1)));
      } else {
        let ckpt = model && model !== 'default' ? model : null;
        if (!ckpt) {
          const info = await jsonFetch(fetchImpl, `${COMFY()}/object_info/CheckpointLoaderSimple`).catch((e) => { throw new Error(`no ComfyUI answered at ${COMFY()} (${e.message}). Start it (python main.py) or set OX_COMFYUI_URL`); });
          ckpt = info?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0]?.[0];
          if (!ckpt) throw new Error('ComfyUI has no checkpoint: put a model in ComfyUI/models/checkpoints');
        }
        graph = comfyTxt2img({ ckpt, prompt, negative: settings.negative ?? '', width: Number(settings.width ?? 1024), height: Number(settings.height ?? 1024), steps: Number(settings.steps ?? 25), n: Number(settings.n ?? 1), ...(settings.seed != null ? { seed: Number(settings.seed) } : {}) });
        recipe.label = `ComfyUI · ${ckpt}`;
      }
      files = await runComfy({ graph, dir, fetchImpl, onStatus });
      if (!files.length) throw new Error('ComfyUI finished without an image');
      if (files.some((f) => /\.(mp4|webm|gif)$/i.test(f))) { surface = 'video'; recipe.surface = 'video'; }
    } else if (provider === 'local') {
      const d = await jsonFetch(fetchImpl, `${LOCAL_SD()}/sdapi/v1/txt2img`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, negative_prompt: settings.negative ?? '', steps: Number(settings.steps ?? 25), width: Number(settings.width ?? 1024), height: Number(settings.height ?? 1024), batch_size: Number(settings.n ?? 1), ...(settings.seed != null ? { seed: Number(settings.seed) } : {}) }),
      }).catch((e) => { throw new Error(`no Stable Diffusion server answered at ${LOCAL_SD()} (${e.message}). Start Draw Things, Forge or AUTOMATIC1111 with its API on, or set OX_SD_URL`); });
      fs.mkdirSync(dir, { recursive: true });
      files = (d.images ?? []).map((b64, i) => writeB64(dir, i, String(b64).replace(/^data:image\/\w+;base64,/, ''), 'png'));
    } else if (provider === 'hf') {
      if (!/^[\w.-]+\/[\w.-]+$/.test(String(model))) throw new Error('a Hugging Face model id looks like black-forest-labs/FLUX.1-schnell');
      const base = (env.HF_INFERENCE_BASE || 'https://router.huggingface.co/hf-inference/models').replace(/\/$/, '');
      const r = await fetchImpl(`${base}/${model}`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ inputs: prompt, ...(Object.keys(settings).length ? { parameters: settings } : {}) }), signal: AbortSignal.timeout(300_000) });
      if (!r.ok) throw new Error(`Hugging Face: ${(await r.text()).slice(0, 200) || r.status}`);
      const type = r.headers.get('content-type') || '';
      if (!type.startsWith('image/')) throw new Error(`Hugging Face answered without an image (${type || 'no type'})`);
      fs.mkdirSync(dir, { recursive: true });
      const f = path.join(dir, `1.${type.includes('jpeg') ? 'jpg' : type.includes('webp') ? 'webp' : 'png'}`);
      fs.writeFileSync(f, Buffer.from(await r.arrayBuffer()));
      files.push(f);
    } else if (provider === 'fal') {
      if (!/^[\w.-]+\/[\w./-]+$/.test(String(model)) || String(model).includes('..')) throw new Error('a fal model id looks like fal-ai/flux/schnell');
      const base = (env.FAL_QUEUE_BASE || 'https://queue.fal.run').replace(/\/$/, '');
      const auth = { Authorization: `Key ${key}` };
      const input = { ...(String(prompt).trim() ? { prompt } : {}), ...settings };
      // A local file goes up as a data URI; links pass as they are.
      for (const [role, list] of Object.entries(media)) if (list?.length) input[role === 'start' ? 'image_url' : `${role}_url`] = /^(https?|data):/.test(String(list[0])) ? list[0] : dataUri(await sourceImage(list[0], fetchImpl));
      const q = await jsonFetch(fetchImpl, `${base}/${model}`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
      note({ id, requestId: q.request_id });
      const statusUrl = q.status_url ?? `${base}/${model}/requests/${q.request_id}/status`;
      const responseUrl = q.response_url ?? `${base}/${model}/requests/${q.request_id}`;
      const client = { status: async () => { const s = await jsonFetch(fetchImpl, statusUrl, { headers: auth }); const st = String(s.status ?? '').toUpperCase(); return { status: st === 'COMPLETED' ? (s.error ? 'failed' : 'completed') : st.toLowerCase(), error: s.error ?? null }; } };
      const done = await waitFor(client, q.request_id, { onStatus, ...(wait ?? {}) });
      if (done.status !== 'completed') { status = done.status; error = done.error ? String(done.error) : null; }
      else {
        const res = await jsonFetch(fetchImpl, responseUrl, { headers: auth });
        // Shapes: video.url, images[].url, image.url (upscale, cutout), audio_file.url (audio).
        const audioUrl = res.audio_file?.url ?? res.audio?.url ?? null;
        urls = res.video?.url ? [res.video.url] : audioUrl ? [audioUrl] : res.image?.url ? [res.image.url] : (res.images ?? []).map((x) => x?.url).filter(Boolean);
        surface = res.video?.url ? 'video' : audioUrl ? 'audio' : 'image';
        fs.mkdirSync(dir, { recursive: true });
        for (const [i, u] of urls.entries()) {
          const ext = (/\.(png|jpe?g|webp|gif|mp4|mov|webm|wav|mp3)(?:\?|$)/i.exec(u)?.[1] ?? (surface === 'video' ? 'mp4' : surface === 'audio' ? 'wav' : 'png')).toLowerCase();
          try { files.push(await download(u, path.join(dir, `${i + 1}.${ext}`), fetchImpl)); } catch {}
        }
      }
    }
  } catch (e) {
    status = 'failed'; error = e.message;
  }
  const row = { id, status, surface, urls, files, error, doneAt: Date.now(), label: recipe.label, settings: recipe.settings };
  note(row);
  if (status === 'failed' && error && !files.length) { const err = new Error(error); err.record = { ...recipe, ...row }; throw err; }
  return { ...recipe, ...row };
}

export function remove(id) { note({ id, deleted: true }); }
export function favorite(id, on = true) { note({ id, favorite: !!on }); }

// The operation a device model runs. The model names it; a source image alone
// means "edit" only for the image models. (Written as `editOf || model ===
// 'mac-edit' ? …` this turned every upscale and cut-out with a source into an
// unprompted edit, labelled as the upscale or cut-out.)
export function deviceOp(model, editOf = null, settings = {}) {
  return settings.op ?? (model === 'mac-video' ? 'video' : model === 'mac-upscale' ? 'upscale' : model === 'mac-cutout' ? 'cutout' : (editOf || model === 'mac-edit') ? 'edit' : 'image');
}
