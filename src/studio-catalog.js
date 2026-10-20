// OX Studio's open-weights models (docs/STUDIO_ARCHITECTURE.md): what each
// makes, its licence, what it is good at, and where it runs. Every fal id was
// checked against fal's model pages on Oct 18, 2026 (fal answers 200 even for
// a made-up id, so each was checked by its page title).
export const OPEN_MODELS = Object.freeze([
  { id: 'flux-schnell', name: 'FLUX.1 [schnell]', kind: 'image', license: 'Apache-2.0', good: 'fast, 1-4 steps', fal: 'fal-ai/flux/schnell', hf: 'black-forest-labs/FLUX.1-schnell' },
  { id: 'qwen-image', name: 'Qwen-Image', kind: 'image', license: 'Apache-2.0', good: 'text inside images, posters, signs', fal: 'fal-ai/qwen-image' },
  { id: 'hidream-i1', name: 'HiDream-I1 Full', kind: 'image', license: 'MIT', good: 'detail, long prompts', fal: 'fal-ai/hidream-i1-full' },
  { id: 'sd35-large', name: 'Stable Diffusion 3.5 Large', kind: 'image', license: 'Stability AI Community', good: 'broad styles', fal: 'fal-ai/stable-diffusion-v35-large', hf: 'stabilityai/stable-diffusion-3.5-large' },
  { id: 'sdxl', name: 'SDXL', kind: 'image', license: 'CreativeML OpenRAIL++-M', good: 'styles, LoRAs', fal: 'fal-ai/fast-sdxl', hf: 'stabilityai/stable-diffusion-xl-base-1.0' },
  { id: 'qwen-image-edit', name: 'Qwen-Image-Edit', kind: 'edit', license: 'Apache-2.0', good: 'edit by instruction, keeps text and faces', fal: 'fal-ai/qwen-image-edit' },
  { id: 'flux-kontext-dev', name: 'FLUX.1 Kontext [dev]', kind: 'edit', license: 'FLUX.1 [dev] Non-Commercial', good: 'consistent characters across edits', fal: 'fal-ai/flux-kontext/dev' },
  { id: 'wan-2.2', name: 'Wan 2.2 A14B', kind: 'video', license: 'Apache-2.0', good: 'the strongest open video model; follows camera moves', fal: 'fal-ai/wan/v2.2-a14b/text-to-video', falFromImage: 'fal-ai/wan/v2.2-a14b/image-to-video' },
  { id: 'ltx-video', name: 'LTX-Video 13B distilled', kind: 'video', license: 'LTXV Open Weights', good: 'fast, many takes', fal: 'fal-ai/ltx-video-13b-distilled' },
  { id: 'hunyuan-video', name: 'HunyuanVideo', kind: 'video', license: 'Tencent Hunyuan Community', good: 'cinematic motion', fal: 'fal-ai/hunyuan-video' },
  { id: 'mochi-1', name: 'Mochi 1', kind: 'video', license: 'Apache-2.0', good: 'smooth motion', fal: 'fal-ai/mochi-v1' },
  { id: 'cogvideox-5b', name: 'CogVideoX-5B', kind: 'video', license: 'CogVideoX License', good: 'steady short clips', fal: 'fal-ai/cogvideox-5b' },
  // Video to video (Higgsfield Genjutsu's two modes, open models): keep a clip's motion, change who or what is in it.
  { id: 'wan-animate-move', name: 'Wan 2.2 Animate Move', kind: 'restyle', license: 'Apache-2.0', good: 'motion transfer: the person in your picture does what the video shows', fal: 'fal-ai/wan/v2.2-14b/animate/move' },
  { id: 'wan-animate-replace', name: 'Wan 2.2 Animate Replace', kind: 'restyle', license: 'Apache-2.0', good: 'swap: the person in the video becomes the one in your picture, same scene and light', fal: 'fal-ai/wan/v2.2-14b/animate/replace' },
  { id: 'wan-vace', name: 'Wan VACE 14B (depth)', kind: 'restyle', license: 'Apache-2.0', good: 'same motion and layout, a new look or world from a prompt', fal: 'fal-ai/wan-vace-14b/depth' },
  { id: 'esrgan', name: 'Real-ESRGAN', kind: 'upscale', license: 'BSD-3-Clause', good: '4x detail', fal: 'fal-ai/esrgan' },
  { id: 'birefnet', name: 'BiRefNet', kind: 'cutout', license: 'MIT', good: 'background removal', fal: 'fal-ai/birefnet' },
  { id: 'latentsync', name: 'LatentSync', kind: 'lipsync', license: 'Apache-2.0', good: 'a face speaks the audio', fal: 'fal-ai/latentsync' },
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
  'short-ad': {
    title: 'Short-form ad (9:16)',
    steps: [
      'Hook in the first second: one surprising visual. Write 3 shots: hook, product in use, result plus call to action.',
      'generate_video each shot with wan-2.2 at 9:16, 5 s, with a camera move (crash-zoom for the hook, dolly-in for the product).',
      'video_edit op join with the three clips, then op captions on the result; keep it under 15 s.',
    ],
  },
});

export const find = (ref) => OPEN_MODELS.find((m) => m.id === ref || m.fal === ref || m.name.toLowerCase() === String(ref).toLowerCase()) ?? null;
export const byKind = (kind) => OPEN_MODELS.filter((m) => m.kind === kind);

/** The default model for a kind (the strongest open one). */
export const DEFAULTS = Object.freeze({ image: 'flux-schnell', text: 'qwen-image', edit: 'qwen-image-edit', video: 'wan-2.2', upscale: 'esrgan', cutout: 'birefnet', lipsync: 'latentsync', audio: 'stable-audio', restyle: 'wan-animate-move' });

export function withCamera(prompt, move) {
  const m = CAMERA[move];
  return m ? `${prompt}. Camera: ${m}.` : prompt;
}
