// OX Studio's open-weights models (docs/STUDIO_ARCHITECTURE.md): what each
// makes, its licence, what it is good at, and where it runs. Every fal id was
// checked against fal's model pages on Oct 18, 2026 (fal answers 200 even for
// a made-up id, so each was checked by its page title).
export const OPEN_MODELS = Object.freeze([
  // On this Mac's own chip (src/studio-local.js): no key, nothing leaves the machine.
  { id: 'mac-image', name: 'SD-Turbo on this Mac', kind: 'image', license: 'Stability AI Community', good: 'your own chip, no key: about 25 s an image (12 s fast)', device: 'image' },
  { id: 'mac-edit', name: 'SD-Turbo edit on this Mac', kind: 'edit', license: 'Stability AI Community', good: 'your own chip: keeps the layout, changes the look', device: 'edit' },
  { id: 'mac-video', name: 'Living picture on this Mac', kind: 'video', license: 'Stability AI Community', good: 'your own chip: a generated scene, its camera move, re-imagined keyframes and smooth frames between (about 3 min for 5 s)', device: 'video' },
  { id: 'mac-upscale', name: 'Hires fix on this Mac', kind: 'upscale', license: 'Stability AI Community', good: 'your own chip: 2x, the model redraws fine detail (a few minutes), or a quick sharp resize', device: 'upscale' },
  { id: 'mac-cutout', name: 'Apple Vision cut-out', kind: 'cutout', license: 'built into macOS', good: 'your own chip, no download: the subject on a clear background', device: 'cutout' },
  { id: 'flux-schnell', name: 'FLUX.1 [schnell]', kind: 'image', license: 'Apache-2.0', good: 'fast, 1-4 steps', fal: 'fal-ai/flux/schnell', hf: 'black-forest-labs/FLUX.1-schnell', price: { per: 'megapixel', usd: 0.003 } },
  { id: 'qwen-image', name: 'Qwen-Image', kind: 'image', license: 'Apache-2.0', good: 'text inside images, posters, signs', fal: 'fal-ai/qwen-image', price: { per: 'megapixel', usd: 0.02 } },
  { id: 'hidream-i1', name: 'HiDream-I1 Full', kind: 'image', license: 'MIT', good: 'detail, long prompts', fal: 'fal-ai/hidream-i1-full', price: { per: 'megapixel', usd: 0.05 } },
  { id: 'sd35-large', name: 'Stable Diffusion 3.5 Large', kind: 'image', license: 'Stability AI Community', good: 'broad styles', fal: 'fal-ai/stable-diffusion-v35-large', hf: 'stabilityai/stable-diffusion-3.5-large', price: { per: 'megapixel', usd: 0.065 } },
  { id: 'sdxl', name: 'SDXL', kind: 'image', license: 'CreativeML OpenRAIL++-M', good: 'styles, LoRAs', fal: 'fal-ai/fast-sdxl', hf: 'stabilityai/stable-diffusion-xl-base-1.0' },
  { id: 'qwen-image-edit', name: 'Qwen-Image-Edit', kind: 'edit', license: 'Apache-2.0', good: 'edit by instruction, keeps text and faces', fal: 'fal-ai/qwen-image-edit', price: { per: 'megapixel', usd: 0.03 } },
  { id: 'flux-kontext-dev', name: 'FLUX.1 Kontext [dev]', kind: 'edit', license: 'FLUX.1 [dev] Non-Commercial', good: 'consistent characters across edits', fal: 'fal-ai/flux-kontext/dev', price: { per: 'megapixel', usd: 0.025 } },
  { id: 'wan-2.2', name: 'Wan 2.2 A14B', kind: 'video', license: 'Apache-2.0', good: 'the strongest open video model; follows camera moves', fal: 'fal-ai/wan/v2.2-a14b/text-to-video', falFromImage: 'fal-ai/wan/v2.2-a14b/image-to-video', price: { per: 'video-second', usd: 0.08 } },
  { id: 'ltx-video', name: 'LTX-Video 13B distilled', kind: 'video', license: 'LTXV Open Weights', good: 'fast, many takes', fal: 'fal-ai/ltx-video-13b-distilled', price: { per: 'video', usd: 0.04 } },
  { id: 'hunyuan-video', name: 'HunyuanVideo', kind: 'video', license: 'Tencent Hunyuan Community', good: 'cinematic motion', fal: 'fal-ai/hunyuan-video', price: { per: 'video', usd: 0.4 } },
  { id: 'mochi-1', name: 'Mochi 1', kind: 'video', license: 'Apache-2.0', good: 'smooth motion', fal: 'fal-ai/mochi-v1', price: { per: 'video', usd: 0.4 } },
  { id: 'cogvideox-5b', name: 'CogVideoX-5B', kind: 'video', license: 'CogVideoX License', good: 'steady short clips', fal: 'fal-ai/cogvideox-5b', price: { per: 'video', usd: 0.2 } },
  // Video to video (Higgsfield Genjutsu's two modes, open models): keep a clip's motion, change who or what is in it.
  { id: 'wan-animate-move', name: 'Wan 2.2 Animate Move', kind: 'restyle', license: 'Apache-2.0', good: 'motion transfer: the person in your picture does what the video shows', fal: 'fal-ai/wan/v2.2-14b/animate/move', price: { per: 'video-second', usd: 0.08 } },
  { id: 'wan-animate-replace', name: 'Wan 2.2 Animate Replace', kind: 'restyle', license: 'Apache-2.0', good: 'swap: the person in the video becomes the one in your picture, same scene and light', fal: 'fal-ai/wan/v2.2-14b/animate/replace', price: { per: 'video-second', usd: 0.08 } },
  { id: 'wan-vace', name: 'Wan VACE 14B (depth)', kind: 'restyle', license: 'Apache-2.0', good: 'same motion and layout, a new look or world from a prompt', fal: 'fal-ai/wan-vace-14b/depth', price: { per: 'video-second', usd: 0.08 } },
  { id: 'esrgan', name: 'Real-ESRGAN', kind: 'upscale', license: 'BSD-3-Clause', good: '4x detail', fal: 'fal-ai/esrgan' },
  { id: 'birefnet', name: 'BiRefNet', kind: 'cutout', license: 'MIT', good: 'background removal', fal: 'fal-ai/birefnet' },
  { id: 'latentsync', name: 'LatentSync', kind: 'lipsync', license: 'Apache-2.0', good: 'a face speaks the audio', fal: 'fal-ai/latentsync', price: { per: 'video', usd: 0.2 } },
  { id: 'stable-audio', name: 'Stable Audio Open', kind: 'audio', license: 'Stability AI Community', good: 'sound effects, loops', fal: 'fal-ai/stable-audio' },
]);

/** Camera moves the open video models follow when written into the prompt (Higgsfield-style presets). */
export const CAMERA = Object.freeze({
  'dolly-in': 'slow dolly in toward the subject',
  'dolly-out': 'slow dolly out, revealing the scene',
  'crash-zoom': 'sudden fast crash zoom onto the subject',
  orbit: 'the camera orbits 180 degrees around the subject',
  'crane-up': 'crane shot rising up and over the scene',
  'whip-pan': 'fast whip pan to the subject',
  handheld: 'handheld camera, natural shake',
  fpv: 'FPV drone flying fast through the scene',
  'bullet-time': 'bullet time, frozen moment, camera arcs around',
  'push-in': 'gentle push in, shallow depth of field',
  static: 'locked-off static camera',
});

/** Recipes an agent follows for a production (Higgsfield's get_workflow_instructions, ox's own). */
export const WORKFLOWS = Object.freeze({
  'product-photoshoot': {
    title: 'Product photoshoot',
    steps: [
      'Ask for (or receive) the product photo; remove its background with remove_background.',
      'Pick a mode: studio (seamless backdrop, softbox light), lifestyle (in use, natural light), hero banner (wide, space for text), Pinterest (vertical, styled flat lay).',
      'edit_image with qwen-image-edit: "place this product on <scene for the mode>, keep the product exactly as it is, matching light and shadow".',
      'Make 4 variants; upscale the chosen one with upscale.',
    ],
  },
  'youtube-thumbnail': {
    title: 'YouTube thumbnail',
    steps: [
      'One idea, one face or object, at most four words of text.',
      'generate_image with qwen-image (best at text), 16:9: big readable words, strong contrast, the subject large on one side.',
      'Three variants with different words or colours; keep the truest one (no promise the video does not keep).',
      'upscale the winner.',
    ],
  },
  'character-sheet': {
    title: 'Character sheet (one character across shots)',
    steps: [
      'generate_image the character once, front view, plain background; write down the exact description used.',
      'edit_image with flux-kontext-dev (non-commercial) or qwen-image-edit from that image: side view, back view, three expressions, two outfits — same face and colours each time.',
      'Use the sheet as the reference for every later shot (image to video with wan-2.2).',
    ],
  },
  'explainer-video': {
    title: 'Explainer video',
    steps: [
      'Write 4-8 steps as "Label: what happens".',
      'explainer_video turns them into slides with a lit diagram and crossfades (runs on this machine).',
      'Optional: generate_video a b-roll clip per step with wan-2.2 and add them with video_edit op join.',
    ],
  },
  'scene-animation': {
    title: 'Scene-by-scene animation from a video or a script (Flick-style)',
    steps: [
      'Get the words: a video or audio file (transcribed here with Whisper), a transcript, or the script itself.',
      'Ask the aspect (9:16 for Shorts/Reels, 16:9, 1:1 or 4:5), brand colours and a logo if they have one, and their opinion of the tone.',
      'animate_script with plan_only true: read plan.md back to them (scene, animation, length, words on screen) and change it until they approve.',
      'animate_script with the folder to render: each scene becomes its own MP4 and poster, with sound effects only where something moves in; all.mp4 joins them.',
      'Change one scene: edit its entry in scene-spec.json, then animate_script with redo set to that scene. Ask which scenes to keep for later runs (save).',
    ],
  },
  'video-restyle': {
    title: 'Restyle a video, keep its motion (Genjutsu-style)',
    steps: [
      'Pick the mode: motion transfer (a picture of someone does what the video shows: wan-animate-move), swap (the person in the video becomes the one in the picture: wan-animate-replace), or a new look or world from words (wan-vace).',
      'Clip 4-10 s works best; trim it first with video_edit op cut. The video and picture are links (upload first if they are files).',
      'For a swap or a transfer, make the reference picture first if needed (generate_image, then edit_image for the outfit), full body, plain background, the same pose as the video\'s first frame.',
      'restyle_video, then jobs_wait. Check the face and hands frame by frame before calling it done; run again with another seed if they drift.',
      'Use only footage and faces you have the right to use.',
    ],
  },
  'app-store-kit': {
    title: 'App store kit: icons, store screenshots, a demo video',
    steps: [
      'Icon: one square image at 1024 px or more (make it with generate_image on this Mac, or use theirs); app_assets op icons gives the iOS set, macOS .icns, Android mipmaps and web favicons.',
      'Screenshots: take 3-6 of the real app (portrait for phones). Write one short benefit headline each ("Every task, on one board"), not feature names.',
      'app_assets op shots with those captions: App Store 6.9", 6.5", iPad 13" and Google Play sizes.',
      'app_assets op demo with the same screenshots and captions: a 1080x1920 demo video for the store or social.',
      'All of it runs on this machine and costs nothing; say where the files are.',
    ],
  },
  'short-ad': {
    title: 'Short-form ad (9:16)',
    steps: [
      'Hook in the first second: one surprising visual. Write 3 shots: hook, product in use, result plus call to action.',
      'generate_video each shot with wan-2.2 at 9:16, 5 s, with a camera move (crash-zoom for the hook, dolly-in for the product).',
      'video_edit op join with the three clips, then op captions on the result; keep it under 15 s.',
    ],
  },
});

// fal's listed prices (read from each model page, Oct 21 2026). Models priced by
// compute time (SDXL, Real-ESRGAN, BiRefNet, Stable Audio) cost fractions of a cent.
/** About what one request costs on the host, in US dollars; 0 on this Mac, null if unknown. */
export function estimateCost(m, { aspect = '1:1', n = 1, seconds = 5 } = {}) {
  if (!m) return null;
  if (m.device) return 0;
  const p = m.price;
  if (!p) return null;
  const [w, h] = String(aspect).split(':').map(Number);
  const mp = w && h ? (1024 * 1024 * Math.max(w, h) / Math.min(w, h)) / 1e6 : 1.05;
  const each = p.per === 'megapixel' ? p.usd * mp : p.per === 'video-second' ? p.usd * seconds : p.usd;
  return Math.round(each * Math.max(1, n) * 1000) / 1000;
}

/** "about $0.40 on fal" / "free on this Mac" / "" */
export function costLine(m, opts) {
  const c = estimateCost(m, opts);
  if (c === 0) return 'free on this Mac';
  if (c == null) return '';
  return `about $${c < 0.01 ? c.toFixed(3) : c.toFixed(2)} on fal`;
}

export const find = (ref) => OPEN_MODELS.find((m) => m.id === ref || m.fal === ref || m.name.toLowerCase() === String(ref).toLowerCase()) ?? null;
export const byKind = (kind) => OPEN_MODELS.filter((m) => m.kind === kind);

/** The default model for a kind (the strongest open one). */
export const DEFAULTS = Object.freeze({ image: 'mac-image', text: 'qwen-image', edit: 'mac-edit', video: 'mac-video', upscale: 'mac-upscale', cutout: 'mac-cutout', lipsync: 'latentsync', audio: 'stable-audio', restyle: 'wan-animate-move' });

export function withCamera(prompt, move) {
  const m = CAMERA[move];
  return m ? `${prompt}. Camera: ${m}.` : prompt;
}
