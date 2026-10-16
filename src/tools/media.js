// create_media: whatever model drives ox (Claude, GPT, Grok, a local model) can
// make images and video — the Higgsfield idea as a skill of the agent, on the
// providers you already have. The provider is picked from your keys unless the
// model names one: Higgsfield, fal.ai, OpenAI, or a Stable Diffusion server on
// this machine (src/media-studio.js). Every run spends money or GPU time, so the
// call is approval-gated like bash.
import { generate, PROVIDERS, MODELS } from '../media-studio.js';

export const MEDIA_TOOLS = ['create_media'];

export const MEDIA_KEYWORDS = Object.freeze([
  'image', 'images', 'picture', 'photo', 'illustration', 'poster', 'thumbnail', 'logo', 'video', 'clip', 'animation', 'animate',
  'render', 'generate an', 'make an image', 'make a video', 'draw', 'artwork', 'cinematic', 'storyboard',
]);

export const MEDIA_TOOL_SCHEMAS = [
  {
    name: 'create_media',
    description:
      'Generate an image or a video from a prompt and save it under ~/.ox/media. Providers: higgsfield (38 models: images soul-2, soul-cinema, flux-2, ideogram-4, recraft-4.1, qwen-image-3, z-image-turbo, grok-imagine-2; video kling-3-pro, seedance-2.5, wan-3, minimax-h3, ltx-2.5-pro and more), fal (any fal model id, e.g. fal-ai/flux/schnell), openai (gpt-image-2 and other GPT Image models), local (Stable Diffusion on this machine). Leave provider out to use one the user has a key for. Write a rich, concrete prompt (subject, setting, light, lens, motion for video). Returns the saved file paths.',
    input_schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'What to make: subject, style, composition, lighting; for video also the motion and camera.' },
        kind: { type: 'string', enum: ['image', 'video'], description: 'Image or video; used to pick a model when none is given.' },
        provider: { type: 'string', enum: ['higgsfield', 'fal', 'openai', 'local'] },
        model: { type: 'string', description: 'Model id for that provider (ox create --models lists them).' },
        settings: { type: 'object', description: "The model's own settings, e.g. { aspectRatio: '16:9', duration: 5, resolution: '1080p' }." },
        start_image_url: { type: 'string', description: 'Public https URL of a start frame (image-to-video).' },
        reference_urls: { type: 'array', items: { type: 'string' }, description: 'Public https URLs of reference images.' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
];

const ok = (content) => ({ content, isError: false });
const err = (content) => ({ content, isError: true });

// The provider and model to use when the call does not say: the first provider
// with a key that can make this kind of thing; a local server needs no key.
export function pick({ kind = 'image', provider, model } = {}, env = process.env) {
  const has = (p) => !PROVIDERS[p].key || !!env[PROVIDERS[p].key];
  const order = kind === 'video' ? ['higgsfield', 'fal'] : ['higgsfield', 'openai', 'fal', 'local'];
  const p = provider ?? order.find((x) => x !== 'local' && has(x)) ?? (kind === 'image' ? 'local' : null);
  if (!p) return { error: 'No video provider is connected. Add a Higgsfield key (console.higgsfield.ai) or a fal.ai key in Settings › API keys.' };
  if (!PROVIDERS[p]) return { error: `unknown provider ${p}` };
  if (!PROVIDERS[p].kinds.includes(kind)) return { error: `${PROVIDERS[p].label} makes ${PROVIDERS[p].kinds.join(' and ')} only` };
  const m = model ?? (p === 'higgsfield' ? (kind === 'video' ? 'kling-3-pro' : 'soul-2') : p === 'openai' ? 'gpt-image-2' : p === 'fal' ? 'fal-ai/flux/schnell' : 'local');
  if (p === 'higgsfield' && !MODELS.some((x) => x.id === m)) return { error: `unknown Higgsfield model ${m}` };
  return { provider: p, model: m };
}

export async function createMediaTool(args = {}, ctx = {}) {
  const prompt = String(args.prompt ?? '').trim();
  if (!prompt) return err('create_media: a prompt is required.');
  const kind = args.kind === 'video' ? 'video' : (args.model && MODELS.find((m) => m.id === args.model)?.surface) || 'image';
  const choice = pick({ kind, provider: args.provider, model: args.model }, ctx.env ?? process.env);
  if (choice.error) return err(`create_media: ${choice.error}`);
  const media = {};
  if (args.start_image_url) media.start = [String(args.start_image_url)];
  if (Array.isArray(args.reference_urls) && args.reference_urls.length) media.reference = args.reference_urls.map(String);
  try {
    const r = await generate({ provider: choice.provider, model: choice.model, prompt, settings: args.settings && typeof args.settings === 'object' ? args.settings : {}, media, env: ctx.env ?? process.env });
    if (r.status !== 'completed') return err(`create_media: ${choice.provider}/${choice.model} finished as ${r.status}${r.error ? ` — ${r.error}` : ''}.`);
    return ok(`Made with ${choice.provider}/${choice.model}:\n${r.files.map((f) => `- ${f}`).join('\n') || r.urls.join('\n')}\n(also in the app's Studio gallery; reuse it with: ox create --history)`);
  } catch (e) {
    return err(`create_media: ${e.message}`);
  }
}
