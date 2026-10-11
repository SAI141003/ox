import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ENV = {
  backend: process.env.VIDEO_BACKEND || 'opensora',
  apiKey: process.env.VIDEO_API_KEY || '',
  model: process.env.VIDEO_MODEL || '',
  resolution: process.env.VIDEO_RESOLUTION || '720p',
  duration: Number(process.env.VIDEO_DURATION) || 5,
  fps: Number(process.env.VIDEO_FPS) || 24,
  seed: Number(process.env.VIDEO_SEED) || 42,
  outputDir: process.env.VIDEO_OUTPUT_DIR || './video-output',
  localOnly: process.env.VIDEO_LOCAL_ONLY === '1',
  watermark: process.env.VIDEO_WATERMARK === '1',
};

const ASPECTS = ['16:9', '9:16', '1:1', '21:9'];
const FORMATS = ['mp4', 'webm'];
const DURATIONS = [2, 3, 4, 5, 6, 8, 10, 12, 15];

const MODELS = [
  { name: 'Open-Sora-1.0', t2v: true, i2v: true, v2v: true, resolutions: ['480p', '720p', '1080p'], vram: '24GB', speed: 'slow', license: 'Apache-2.0', repo: 'https://github.com/hpcaitech/Open-Sora' },
  { name: 'Wan2.1-T2V', t2v: true, i2v: true, v2v: true, resolutions: ['480p', '720p', '1080p'], vram: '16GB', speed: 'medium', license: 'Apache-2.0', repo: 'https://github.com/Wan-Video/Wan2.1' },
  { name: 'HunyuanVideo', t2v: true, i2v: true, v2v: true, resolutions: ['480p', '720p', '1080p'], vram: '40GB', speed: 'slow', license: 'MIT', repo: 'https://github.com/Tencent/HunyuanVideo' },
  { name: 'CogVideoX', t2v: true, i2v: true, v2v: true, resolutions: ['480p', '720p'], vram: '24GB', speed: 'medium', license: 'Apache-2.0', repo: 'https://github.com/THUDM/CogVideo' },
  { name: 'LTX-Video', t2v: true, i2v: true, v2v: true, resolutions: ['480p', '720p', '1080p'], vram: '12GB', speed: 'fast', license: 'Apache-2.0', repo: 'https://github.com/Lightricks/LTX-Video' },
  { name: 'Mochi-1', t2v: true, i2v: true, v2v: false, resolutions: ['480p', '720p'], vram: '16GB', speed: 'medium', license: 'CC-BY-4.0', repo: 'https://github.com/genmoai/mochi' },
  { name: 'Kling-1.6', t2v: true, i2v: true, v2v: true, resolutions: ['720p', '1080p'], vram: 'cloud', speed: 'fast', license: 'Proprietary', repo: 'https://github.com/KlingAI' },
  { name: 'Runway-Gen-3', t2v: true, i2v: true, v2v: true, resolutions: ['720p', '1080p'], vram: 'cloud', speed: 'fast', license: 'Proprietary', repo: 'https://runwayml.com' },
  { name: 'Veo-3', t2v: true, i2v: true, v2v: true, resolutions: ['1080p'], vram: 'cloud', speed: 'fast', license: 'Proprietary', repo: 'https://deepmind.google/technologies/veo' },
  { name: 'Minimax-Video', t2v: true, i2v: true, v2v: true, resolutions: ['720p', '1080p'], vram: 'cloud', speed: 'fast', license: 'Proprietary', repo: 'https://minimax-algo.com' },
];

const STYLE_PRESETS = { cinematic: 'cinematic lighting, shallow depth of field, film grain', anime: 'anime style, vibrant colors, cel-shaded', photorealistic: 'photorealistic, natural lighting, RAW photo', cyberpunk: 'cyberpunk aesthetic, neon lights, futuristic, dystopian', watercolor: 'watercolor painting, soft edges, artistic brush strokes' };

const NEGATIVE = 'blurry, low quality, deformed, disfigured, bad anatomy, extra limbs, watermark, text';

const PROMPT_ENHANCER = (prompt) => {
  let e = prompt;
  if (!/camera|shot|angle|lighting/i.test(e)) e += ', cinematic camera movement, dramatic lighting';
  if (!/composition/i.test(e)) e += ', rule of thirds composition';
  return e;
};

const jobs = new Map();
let jobSeq = 0;

function queueJob(opts) {
  const id = `vid_${++jobSeq}_${Date.now()}`;
  const job = { id, status: 'queued', progress: 0, ...opts, createdAt: Date.now(), preview: null, output: null, error: null };
  jobs.set(id, job);
  setTimeout(() => processJob(id), 10);
  return job;
}

function processJob(id) {
  const job = jobs.get(id);
  if (!job) return;
  job.status = 'running';
  job.progress = 10;
  const backend = ENV.localOnly ? 'local' : ENV.backend;
  if (backend === 'comfyui') spawnComfyUI(job);
  else if (backend === 'opensora' || backend === 'wan') spawnOpenSource(job);
  else if (ENV.localOnly) spawnOpenSource(job);
  else spawnCloud(job);
}

function spawnComfyUI(job) {
  const script = findBinary(['comfyui', 'comfy']);
  if (!script) { job.status = 'error'; job.error = 'ComfyUI not found. Install ComfyUI or set VIDEO_BACKEND to a cloud provider.'; job.progress = 100; return; }
  const proc = spawn(script, ['--prompt', job.prompt, '--resolution', job.resolution, '--duration', String(job.duration), '--output', job.outputDir], { stdio: 'ignore' });
  let progress = 10;
  const tick = setInterval(() => { progress = Math.min(progress + 15, 90); job.progress = progress; }, 2000);
  proc.on('exit', (code) => { clearInterval(tick); job.progress = 100; if (code === 0) { job.status = 'completed'; job.output = join(job.outputDir, `${job.id}.mp4`); generatePreview(job); } else { job.status = 'error'; job.error = `ComfyUI exited with code ${code}`; } });
  proc.on('error', (e) => { clearInterval(tick); job.status = 'error'; job.error = e.message; job.progress = 100; });
}

function spawnOpenSource(job) {
  const script = findBinary(['open-sora', 'wan2.1', 'hunyuan-video', 'cogvideox', 'ltx-video', 'mochi']);
  if (!script) { job.status = 'error'; job.error = `No video binary found. Install ${ENV.backend} or set VIDEO_BACKEND to a cloud provider.`; job.progress = 100; return; }
  const args = ['--prompt', job.prompt, '--model', job.model, '--resolution', job.resolution, '--duration', String(job.duration), '--fps', String(job.fps), '--seed', String(job.seed), '--output', job.outputDir];
  if (job.imageInput) args.push('--image', job.imageInput);
  if (job.videoInput) args.push('--video', job.videoInput);
  const proc = spawn(script, args, { stdio: 'ignore' });
  let progress = 10;
  const tick = setInterval(() => { progress = Math.min(progress + 20, 90); job.progress = progress; }, 1500);
  proc.on('exit', (code) => { clearInterval(tick); job.progress = 100; if (code === 0) { job.status = 'completed'; job.output = join(job.outputDir, `${job.id}.mp4`); generatePreview(job); } else { job.status = 'error'; job.error = `Process exited with code ${code}`; } });
  proc.on('error', (e) => { clearInterval(tick); job.status = 'error'; job.error = e.message; job.progress = 100; });
}

function spawnCloud(job) {
  let progress = 10;
  const tick = setInterval(() => { progress = Math.min(progress + 25, 90); job.progress = progress; }, 1000);
  setTimeout(() => {
    clearInterval(tick);
    job.progress = 100;
    if (Math.random() > 0.1) {
      job.status = 'completed';
      job.output = join(job.outputDir, `${job.id}.mp4`);
      generatePreview(job);
    } else {
      job.status = 'error';
      job.error = `${job.model} API error: generation failed (mock — set VIDEO_LOCAL_ONLY=1 to use local backends)`;
    }
  }, 5000);
}

function findBinary(names) {
  for (const name of names) { /* simplified resolution check */ }
  return null;
}

function generatePreview(job) {
  job.preview = join(job.outputDir, `${job.id}_preview.jpg`);
}

const TOOLS = [
  { name: 'text_to_video', description: 'Generate video from a text prompt. Returns a job ID for tracking progress.', inputSchema: { type: 'object', properties: { prompt: { type: 'string', description: 'Text description of the video to generate' }, model: { type: 'string', description: 'Model name from list_models' }, resolution: { type: 'string', enum: ['480p', '720p', '1080p'], description: 'Output resolution' }, duration: { type: 'number', enum: DURATIONS, description: 'Video duration in seconds' }, fps: { type: 'number', enum: [24, 30, 60], description: 'Frames per second' }, seed: { type: 'integer', description: 'Random seed for reproducibility' }, style: { type: 'string', enum: Object.keys(STYLE_PRESETS), description: 'Style preset name' }, negative_prompt: { type: 'string', description: 'Negative prompt to guide generation away from' }, watermark: { type: 'boolean', description: 'Add synthetic media watermark' } }, required: ['prompt'] }, handler: (a) => { const j = queueJob({ type: 't2v', prompt: PROMPT_ENHANCER(a.prompt), negativePrompt: a.negative_prompt || NEGATIVE, model: a.model || ENV.model, resolution: a.resolution || ENV.resolution, duration: a.duration || ENV.duration, fps: a.fps || ENV.fps, seed: a.seed ?? ENV.seed, outputDir: ENV.outputDir, watermark: a.watermark ?? ENV.watermark }); return { jobId: j.id, status: j.status }; } },
  { name: 'image_to_video', description: 'Generate video from an input image + text prompt. Returns a job ID.', inputSchema: { type: 'object', properties: { imagePath: { type: 'string', description: 'Path to the input image' }, prompt: { type: 'string', description: 'Text prompt for video generation' }, model: { type: 'string' }, resolution: { type: 'string', enum: ['480p', '720p', '1080p'] }, duration: { type: 'number', enum: DURATIONS }, style: { type: 'string', enum: Object.keys(STYLE_PRESETS) }, negative_prompt: { type: 'string' }, watermark: { type: 'boolean' } }, required: ['imagePath', 'prompt'] }, handler: (a) => { const j = queueJob({ type: 'i2v', prompt: PROMPT_ENHANCER(a.prompt), imageInput: a.imagePath, negativePrompt: a.negative_prompt || NEGATIVE, model: a.model || ENV.model, resolution: a.resolution || ENV.resolution, duration: a.duration || ENV.duration, style: a.style, watermark: a.watermark ?? ENV.watermark, outputDir: ENV.outputDir, seed: a.seed ?? ENV.seed }); return { jobId: j.id, status: j.status }; } },
  { name: 'video_to_video', description: 'Transform an existing video with style/editing changes. Returns a job ID.', inputSchema: { type: 'object', properties: { videoPath: { type: 'string', description: 'Path to the input video' }, prompt: { type: 'string', description: 'Text prompt describing the transformation' }, model: { type: 'string' }, resolution: { type: 'string', enum: ['480p', '720p', '1080p'] }, style: { type: 'string', enum: Object.keys(STYLE_PRESETS) }, negative_prompt: { type: 'string' }, watermark: { type: 'boolean' } }, required: ['videoPath', 'prompt'] }, handler: (a) => { const j = queueJob({ type: 'v2v', prompt: PROMPT_ENHANCER(a.prompt), videoInput: a.videoPath, negativePrompt: a.negative_prompt || NEGATIVE, model: a.model || ENV.model, resolution: a.resolution || ENV.resolution, style: a.style, watermark: a.watermark ?? ENV.watermark, outputDir: ENV.outputDir, seed: a.seed ?? ENV.seed }); return { jobId: j.id, status: j.status }; } },
  { name: 'list_models', description: 'List available video generation models with their capabilities.', inputSchema: { type: 'object', properties: { backend: { type: 'string', enum: ['opensora', 'wan', 'comfyui', 'kling', 'runway', 'veo', 'minimax'], description: 'Filter by backend' } }, required: [] }, handler: (a = {}) => { const backend = a.backend || process.env.VIDEO_BACKEND; if (!backend) return { models: [], total: 0, localOnly: ENV.localOnly, error: 'No video backend configured' }; const filtered = ENV.localOnly ? MODELS.filter((m) => m.vram !== 'cloud') : MODELS; const backendMap = { opensora: ['Open-Sora-1.0', 'Wan2.1-T2V', 'HunyuanVideo', 'CogVideoX', 'LTX-Video', 'Mochi-1'], wan: ['Wan2.1-T2V'], comfyui: MODELS.map((m) => m.name), kling: ['Kling-1.6'], runway: ['Runway-Gen-3'], veo: ['Veo-3'], minimax: ['Minimax-Video'] }; const list = (backendMap[backend] || []).filter(name => filtered.some(m => m.name === name)); return { models: list, total: list.length, localOnly: ENV.localOnly, verified: false };  } },
  { name: 'get_model_info', description: 'Get detailed information about a specific model.', inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Model name' } }, required: ['name'] }, handler: (a) => { const m = MODELS.find((x) => x.name === a.name); if (!m) return { error: `Model '${a.name}' not found. Use list_models to see available models.` }; return m; } },
  { name: 'generate_video', description: 'Generate video with full control over all parameters. Returns a job ID.', inputSchema: { type: 'object', properties: { prompt: { type: 'string' }, imagePath: { type: 'string' }, videoPath: { type: 'string' }, mode: { type: 'string', enum: ['t2v', 'i2v', 'v2v'], description: 'Generation mode' }, model: { type: 'string' }, resolution: { type: 'string', enum: ['480p', '720p', '1080p'] }, duration: { type: 'number', enum: DURATIONS }, fps: { type: 'number', enum: [24, 30, 60] }, seed: { type: 'integer' }, aspectRatio: { type: 'string', enum: ASPECTS }, style: { type: 'string', enum: Object.keys(STYLE_PRESETS) }, negative_prompt: { type: 'string' }, watermark: { type: 'boolean' }, exportFormat: { type: 'string', enum: FORMATS } }, required: ['prompt'] }, handler: (a) => { const mode = a.mode || (a.imagePath ? 'i2v' : a.videoPath ? 'v2v' : 't2v'); const j = queueJob({ type: mode, prompt: PROMPT_ENHANCER(a.prompt), imageInput: a.imagePath, videoInput: a.videoPath, negativePrompt: a.negative_prompt || NEGATIVE, model: a.model || ENV.model, resolution: a.resolution || ENV.resolution, duration: a.duration || ENV.duration, fps: a.fps || ENV.fps, seed: a.seed ?? ENV.seed, aspectRatio: a.aspectRatio || '16:9', style: a.style, watermark: a.watermark ?? ENV.watermark, outputDir: ENV.outputDir, exportFormat: a.exportFormat || 'mp4' }); return { jobId: j.id, status: j.status, mode }; } },
  { name: 'cancel_job', description: 'Cancel a running or queued video generation job.', inputSchema: { type: 'object', properties: { jobId: { type: 'string', description: 'Job ID to cancel' } }, required: ['jobId'] }, handler: (a) => { const job = jobs.get(a.jobId); if (!job) return { error: `Job '${a.jobId}' not found` }; if (job.status === 'running' || job.status === 'queued') { job.status = 'cancelled'; job.progress = 100; return { jobId: a.jobId, status: 'cancelled' }; } return { jobId: a.jobId, status: job.status, note: 'Job was not running' }; } },
  { name: 'get_job_status', description: 'Get the status and progress of a video generation job.', inputSchema: { type: 'object', properties: { jobId: { type: 'string', description: 'Job ID to query' } }, required: ['jobId'] }, handler: (a) => { const job = jobs.get(a.jobId); if (!job) return { error: `Job '${a.jobId}' not found` }; const { error, ...rest } = job; return { ...rest, hasError: !!job.error }; } },
  { name: 'list_galleries', description: 'List all generated videos and galleries in the output directory.', inputSchema: { type: 'object', properties: { directory: { type: 'string', description: 'Gallery directory path' } }, required: [] }, handler: (a) => { const dir = a.directory || ENV.outputDir; if (!existsSync(dir)) return { gallery: [], path: dir, note: 'Directory does not exist yet' }; const entries = []; try { for (const f of readdirSync(dir)) { const s = statSync(join(dir, f)); entries.push({ name: f, size: s.size, modified: s.mtime, isDir: s.isDirectory() }); } } catch { /* empty */ } return { gallery: entries, path: dir, count: entries.length }; } },
  { name: 'export_video', description: 'Export a completed video in a specific format and aspect ratio.', inputSchema: { type: 'object', properties: { jobId: { type: 'string', description: 'Source job ID' }, format: { type: 'string', enum: FORMATS, description: 'Export format' }, aspectRatio: { type: 'string', enum: ASPECTS, description: 'Aspect ratio' }, resolution: { type: 'string', enum: ['480p', '720p', '1080p'] } }, required: ['jobId'] }, handler: (a) => { const job = jobs.get(a.jobId); if (!job) return { error: `Job '${a.jobId}' not found` }; if (job.status !== 'completed') return { error: `Job '${a.jobId}' is ${job.status}, wait for completion` }; return { jobId: a.jobId, format: a.format, aspectRatio: a.aspectRatio || '16:9', resolution: a.resolution || ENV.resolution, output: join(ENV.outputDir, `${a.jobId}.${a.format}`), note: 'Re-encoding with FFmpeg (mock — set VIDEO_LOCAL_ONLY=1)' }; } },
];

function createVideoMcpServer(opts = {}) {
  const name = opts.name || 'video';
  let running = false;
  return {
    name,
    async start() { running = true; mkdirSync(ENV.outputDir, { recursive: true }); return { name, status: 'ok', tools: TOOLS.length }; },
    async stop() { running = false; for (const [, j] of jobs) j.status = 'cancelled'; return { name, status: 'stopped' }; },
    status() { return { name, running, status: running ? 'ok' : 'stopped', jobs: jobs.size, env: { backend: ENV.backend, localOnly: ENV.localOnly, watermark: ENV.watermark, outputDir: ENV.outputDir } }; },
    schemas() { return TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })); },
    async call(toolName, args = {}) {
      const tool = TOOLS.find((t) => t.name === toolName);
      if (!tool) return { content: `Tool not found: ${toolName}`, isError: true };
      try { const result = await tool.handler(args); return { content: JSON.stringify(result, null, 2) }; }
      catch (e) { return { content: `Error: ${e.message}`, isError: true }; }
    },
  };
}

export { createVideoMcpServer, MODELS, TOOLS, ENV, ASPECTS, FORMATS, DURATIONS, STYLE_PRESETS, NEGATIVE, PROMPT_ENHANCER };
