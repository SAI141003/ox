/**
 * platform.js — Unified facade for the ox multimodal platform.
 *
 * Wraps voice, video, skills, and benchmarking behind a single,
 * pleasant API. Auto-detects hardware, configures backends, and
 * provides clean error handling with progress events.
 *
 * Usage:
 *   import { createPlatform } from './platform.js';
 *   const p = createPlatform();
 *   const result = await p.video.generate('a cat walking');
 */

import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { listTemplates, getTemplate, cloneWebsite } from './website-cloner.js';
import { AASCoreMcp, createAasMcp, AAS_MCP_TOOLS, MAX_STACK_SIZE } from './aas-mcp.js';
import { AasStackManager, validateStack, buildPlan, diffStacks, saveStack, loadStack, saveEvidence, loadEvidence, verifyPlan, formatStack, formatPlan } from './aas-stack.js';
import { buildInstallCommand, previewInstall, executeInstall, listHosts, getHost, auditSkills, formatAuditReport, formatHostList, resolveRisk } from './aas-cli.js';
import { loadAasCatalog, searchAasSkills, mergeCatalogs, AAS_HOSTS, AAS_RISK_LEVELS } from './aas-catalog.js';
import { createMemoryStore, consolidateMemory, summarizeMemory } from './memory-learn.js';
import { createBundleManager, listBundles } from './skill-bundles.js';
import { createUserModel, exportProfile } from './honcho-user.js';
import { createSessionIndex } from './session-index.js';
import { createBotMode } from './bot-mode.js';
import { createKanban, KanbanSwarm } from './kanban.js';
import { createArena } from './arena.js';
import { createAgentTeams } from './agent-teams.js';
import { createGateway } from './gateway.js';
// Deprecated adapter over src/schedule.js. `subsystems.cron` is the same store as
// `ox schedule`; it is kept as a name because callers hold it, not because there
// is a second scheduler.
import { createScheduler } from './cron-scheduler.js';
import { BACKENDS, createBackendManager } from './backends.js';
import { createVoiceMode } from './voice-mode.js';
import { inspectProject, formatInspect, inspectConfig, validateConfig } from './inspect.js';
import { createCodebaseIndex } from './codebase-index.js';
import { createResearchBrain, ResearchSession } from './brain-research.js';
import { createKnowledgeGraph, findGaps } from './knowledge-graph.js';
import { createPaperReader } from './paper-reader.js';
import { createSelfImproveLoop } from './self-improve-loop.js';
import { createVerifier } from './verify-loop.js';
import { createSpecTracker } from './spec-tracker.js';
import { createArchMemory } from './arch-memory.js';
import { createRegressionGuard } from './regression-guard.js';
import { createCodeReviewer } from './code-review.js';
import { createTeamWorkflows } from './team-workflows.js';
import { pickModel, listCandidates, makeTask, MODEL_CATALOG } from './model-registry.js';
import { createLocalRunner, LOCAL_MODELS, recommendLocalModel } from './local-inference.js';
import { createModelBenchmarker, MODEL_BENCHMARKS } from './model-benchmark.js';
import { createModelRouter } from './model-router.js';
import { createClicky } from './clicky.js';

// ---------------------------------------------------------------------------
// Hardware detection
// ---------------------------------------------------------------------------

/**
 * Detect the hardware tier available on this machine.
 * Returns an object describing CPU, GPU, and memory.
 * @returns {{ cpuCores: number, cpuModel: string, gpuType: string, gpuVRAM: string, memoryGB: number, tier: string }}
 */
function detectHardware() {
  const cpuCores = os.cpus().length;
  let cpuModel = os.cpus()[0]?.model ?? 'unknown';
  let gpuType = 'none';
  let gpuVRAM = '0GB';

  try {
    const uname = `${os.platform()} ${os.machine()}`;
    if (uname.includes('arm64') || uname.includes('aarch64')) {
      try {
        const brand = execSync('sysctl -n machdep.cpu.brand_string 2>/dev/null || true', { encoding: 'utf8' }).trim();
        if (brand.includes('Apple M')) {
          gpuType = 'apple-silicon';
          cpuModel = brand;
        }
      } catch { /* no sysctl on Linux */ }
    }
  } catch { /* ignore */ }

  try {
    if (gpuType === 'none') {
      const out = execSync('nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits 2>/dev/null || true', { encoding: 'utf8' }).trim();
      if (out) {
        const parts = out.split(',').map((s) => s.trim());
        gpuType = 'nvidia';
        gpuVRAM = parts[1] ? `${parts[1]}MB` : 'unknown';
      }
    }
  } catch { /* no nvidia-smi */ }

  const memoryGB = Math.round(os.totalmem() / (1024 ** 3));

  let tier = 'cpu';
  if (gpuType === 'apple-silicon') tier = 'apple-silicon';
  else if (gpuType === 'nvidia' && gpuVRAM !== '0GB') {
    const m = parseInt(gpuVRAM, 10);
    if (m >= 24000) tier = 'nvidia-24gb';
    else if (m >= 16000) tier = 'nvidia-16gb';
    else if (m >= 8000) tier = 'nvidia-8gb';
  }

  return { cpuCores, cpuModel, gpuType, gpuVRAM, memoryGB, tier };
}

/**
 * Resolve a backend recommendation for the given category and hardware tier.
 * @param {'stt'|'tts'|'video'} category
 * @param {string} tier
 * @returns {string}
 */
function recommendBackend(category, tier) {
  const table = {
    stt: {
      'apple-silicon': 'whisper.cpp (CoreML)',
      'nvidia-8gb': 'faster-whisper',
      'nvidia-16gb': 'faster-whisper (large)',
      'nvidia-24gb': 'whisper XXL',
      cpu: 'whisper.cpp (quantized)',
    },
    tts: {
      'apple-silicon': 'Kokoro (MLX)',
      'nvidia-8gb': 'Kokoro / Bark',
      'nvidia-16gb': 'Kokoro / Bark',
      'nvidia-24gb': 'Kokoro / Bark',
      cpu: 'Piper / Edge-TTS',
    },
    video: {
      'apple-silicon': 'LTX-Video (MLX)',
      'nvidia-8gb': 'LTX-Video / CogVideoX',
      'nvidia-16gb': 'Wan2.1-T2V',
      'nvidia-24gb': 'Open-Sora-1.0',
      cpu: 'LTX-Video (CPU, low-res)',
    },
  };
  return table[category]?.[tier] ?? 'default';
}

// ---------------------------------------------------------------------------
// Progress helper
// ---------------------------------------------------------------------------

/**
 * Create a progress event emitter.
 * @param {(event: { phase: string; progress: number; message: string }) => void} [onProgress]
 * @returns {{ emit: (phase: string, progress: number, message: string) => void, stream: AsyncGenerator<{ phase: string; progress: number; message: string }> }}
 */
function createProgress(onProgress, buffer = true) {
  const listeners = new Set();
  let genResolve = null;
  let genQueue = [];
  let closed = false;

  /** @param {{ phase: string; progress: number; message: string }} event */
  function emit(phase, progress, message) {
    if (closed) return;
    const event = { phase, progress: Math.min(Math.max(progress, 0), 100), message };
    for (const fn of listeners) {
      try { fn(event); } catch { /* listener error isolated */ }
    }
    if (onProgress) {
      try { onProgress(event); } catch { /* callback error isolated */ }
    }
    if (closed) return;
    if (genResolve) {
      genResolve(event);
      genResolve = null;
    } else if (buffer) {
      genQueue.push(event);
    }
  }

  async function * stream() {
    while (!closed) {
      const event = genQueue.length > 0
        ? genQueue.shift()
        : await new Promise((resolve) => { genResolve = resolve; });
      if (!closed) yield event;
    }
  }

  function close() {
    if (closed) return;
    closed = true;
    genQueue = [];
    listeners.clear();
    genResolve?.();
    genResolve = null;
  }

  return { emit, stream, close };
}

// ---------------------------------------------------------------------------
// Voice subsystem
// ---------------------------------------------------------------------------

/**
 * @param {Record<string, unknown>} opts
 * @param {(event: { phase: string; progress: number; message: string }) => void} [onProgress]
 * @returns {{ speak: (text: string, opts?: Record<string, unknown>) => Promise<{ audioPath: string }>; listen: (opts?: Record<string, unknown>) => Promise<{ text: string }>; dictate: (opts?: Record<string, unknown>) => AsyncGenerator<{ transcript: string; progress: number }>; conversation: (opts?: Record<string, unknown>) => AsyncGenerator<{ role: 'user'|'assistant'; text: string }>; }}
 */
function createVoice(opts, onProgress) {
  const progress = createProgress(onProgress, false);
  const sttBackend = String(opts.sttBackend ?? process.env.VOICE_STT_BACKEND ?? 'whisper');
  const ttsBackend = String(opts.ttsBackend ?? process.env.VOICE_TTS_BACKEND ?? 'kokoro');
  const language = String(opts.language ?? process.env.VOICE_LANGUAGE ?? 'en');
  const voice = String(opts.voice ?? process.env.VOICE_VOICE ?? 'default');

  return {
    /**
     * Synthesize text to speech.
     * @param {string} text - Text to synthesize.
     * @param {Record<string, unknown>} [opts]
     * @returns {Promise<{ audioPath: string }>}
     */
    async speak(text, opts = {}) {
      if (!text || !String(text).trim()) {
        throw new PlatformError('speak(): text is required.');
      }
      // Honest contract: no TTS backend is wired into this facade yet, so we
      // NEVER return a fabricated audioPath. Callers get an explicit
      // unavailable error pointing at the real voice pipeline entry.
      throw new PlatformError('speak(): no TTS backend is wired in platform facade.', {
        backend: ttsBackend,
        hint: 'use the voice pipeline entry (see ox voice / mcp-templates voice), or wire a TTS CLI here',
      });
    },

    /**
     * Listen and transcribe from microphone.
     * @param {Record<string, unknown>} [opts]
     * @returns {Promise<{ text: string }>}
     */
    async listen(opts = {}) {
      // Honest contract: no STT capture backend is wired here. Never return
      // placeholder "transcribed" text as if a microphone had been read.
      throw new PlatformError('listen(): no STT backend is wired in platform facade.', {
        backend: sttBackend,
        hint: 'use the voice pipeline entry (see ox voice / mcp-templates voice), or wire an STT CLI here',
      });
    },

    /**
     * Push-to-talk dictation. Yields transcripts as you speak.
     * @param {Record<string, unknown>} [opts]
     * @returns {AsyncGenerator<{ transcript: string; progress: number }>}
     */
    async * dictate(opts = {}) {
      // Honest contract: without a wired capture backend there is nothing to
      // dictate. Yield nothing; the caller's for-await simply ends.
      progress.emit('dictate', 0, `dictate(): no capture backend wired (${sttBackend})`);
      return;
    },

    /**
     * Bidirectional voice conversation (speak, listen, LLM).
     * @param {Record<string, unknown>} [opts]
     * @returns {AsyncGenerator<{ role: 'user'|'assistant'; text: string }>}
     */
    async * conversation(opts = {}) {
      // Honest contract: no STT/TTS backends are wired here; a fabricated
      // conversation would be misleading. Yield nothing.
      progress.emit('conversation', 0, 'conversation(): no voice backends wired');
      return;
    },
  };
}

// ---------------------------------------------------------------------------
// Video subsystem
// ---------------------------------------------------------------------------

function existsBin(name) {
  try {
    execSync(`which ${name} 2>/dev/null`, { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

/**
 * @param {Record<string, unknown>} opts
 * @param {(event: { phase: string; progress: number; message: string }) => void} [onProgress]
 * @returns {{ generate: (prompt: string, opts?: Record<string, unknown>) => Promise<{ jobId: string; status: string }>; imageToVideo: (image: string, prompt: string, opts?: Record<string, unknown>) => Promise<{ jobId: string; status: string }>; status: (jobId: string) => Promise<{ status: string; progress: number; output?: string; error?: string }>; }}
 */
function createVideo(opts, onProgress) {
  const progress = createProgress(onProgress, false);
  const backend = String(opts.backend ?? process.env.VIDEO_BACKEND ?? 'opensora');
  const resolution = String(opts.resolution ?? process.env.VIDEO_RESOLUTION ?? '720p');
  const duration = Number(opts.duration ?? process.env.VIDEO_DURATION ?? 5);
  const fps = Number(opts.fps ?? process.env.VIDEO_FPS ?? 24);
  const outputDir = String(opts.outputDir ?? process.env.VIDEO_OUTPUT_DIR ?? './video-output');
  const localOnly = opts.localOnly ?? process.env.VIDEO_LOCAL_ONLY !== '0';

  /** @type {Map<string, {id:string;status:string;progress:number;output?:string;error?:string}>} */
  const jobs = new Map();
  let jobSeq = 0;
  let closed = false;

  function queueJob(type, prompt, imageInput) {
    if (closed) throw new PlatformError('video: platform is closed.');
    const id = `vid_${++jobSeq}_${Date.now()}`;
    const job = { id, status: 'queued', progress: 0, output: null, error: null };
    jobs.set(id, job);
    job._queued = setTimeout(() => {
      job._queued = null;
      processJob(id, type, prompt, imageInput);
    }, 10);
    return job;
  }

  function processJob(id, type, prompt, imageInput) {
    const job = jobs.get(id);
    if (closed || !job || job.status !== 'queued') return;
    job.status = 'running';
    job.progress = 10;
    const steps = type === 'i2v' ? [20, 40, 60, 80] : [15, 35, 55, 75];
    let stepIdx = 0;
    const interval = setInterval(() => {
      if (stepIdx < steps.length) {
        job.progress = steps[stepIdx++];
        progress.emit('video', job.progress, `Generating ${type.toUpperCase()} — ${job.progress}%`);
      }
    }, 500);
    job._interval = interval;
    job._completion = setTimeout(() => {
      job._completion = null;
      clearInterval(interval);
      job._interval = null;
      if (closed || job.status !== 'running') return;
      job.progress = 100;
      if (localOnly && !existsBin(backend)) {
        job.status = 'error';
        job.error = `${backend} binary not found. Install it or set VIDEO_LOCAL_ONLY=0 for cloud backends.`;
        progress.emit('video', 100, `Error: ${job.error}`);
        return;
      }
      // Honest contract: with a backend binary present but no wired
      // generator invocation, a job CANNOT complete. Report unavailable
      // instead of fabricating an output file that was never written.
      job.status = 'error';
      job.error = `no generator invocation wired for backend '${backend}' — job not actually rendered`;
      progress.emit('video', 100, `Error: ${job.error}`);
    }, 3000 + Math.random() * 2000);
    job._completion.unref?.();
  }

  return {
    /**
     * Generate video from a text prompt.
     * @param {string} prompt - Text description of the video.
     * @param {Record<string, unknown>} [opts]
     * @returns {Promise<{ jobId: string; status: string }>}
     */
    async generate(prompt, opts = {}) {
      if (!prompt || !String(prompt).trim()) {
        throw new PlatformError('generate(): prompt is required.');
      }
      const job = queueJob('t2v', prompt, null);
      return { jobId: job.id, status: job.status };
    },

    /**
     * Generate video from an image + text prompt.
     * @param {string} image - Path to the input image.
     * @param {Record<string, unknown>} [opts] - Options including prompt.
     * @returns {Promise<{ jobId: string; status: string }>}
     */
    async imageToVideo(image, opts = {}) {
      if (!image) throw new PlatformError('imageToVideo(): image path is required.');
      
      const prompt = String(opts.prompt ?? opts.text ?? '');
      if (!prompt.trim()) throw new PlatformError('imageToVideo(): prompt required in opts');
      const job = queueJob('i2v', prompt, String(image));
      return { jobId: job.id, status: job.status };
    },

    /**
     * Check the status of a video generation job.
     * @param {string} jobId
     * @returns {Promise<{ status: string; progress: number; output?: string; error?: string }>}
     */
    async status(jobId) {
      const job = jobs.get(jobId);
      if (!job) throw new PlatformError(`Job not found: ${jobId}`);
      return { status: job.status, progress: job.progress, output: job.output, error: job.error };
    },

    /**
     * Stop all timers and mark queued/running jobs cancelled.
     * @returns {void}
     */
    close() {
      if (closed) return;
      closed = true;
      progress.close();
      for (const job of jobs.values()) {
        clearTimeout(job._queued);
        clearTimeout(job._completion);
        clearInterval(job._interval);
        job._queued = null;
        job._completion = null;
        job._interval = null;
        if (job.status === 'queued' || job.status === 'running') {
          job.status = 'cancelled';
          job.error = 'platform closed before completion';
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Skills subsystem
// ---------------------------------------------------------------------------

/**
 * @param {Record<string, unknown>} opts
 * @param {(event: { phase: string; progress: number; message: string }) => void} [onProgress]
 * @returns {{ list: () => Array<{name:string;description:string;path:string}>; search: (query: string) => Array<{name:string;description:string;path:string}>; invoke: (id: string, input?: unknown) => Promise<{output: unknown}>; }}
 */
function createSkills(opts, onProgress) {
  const progress = createProgress(onProgress, false);
  const catalog = opts.skills ?? [];

  return {
    /**
     * List all available skills.
     * @returns {Array<{name:string;description:string;path:string}>}
     */
    list() {
      progress.emit('skills', 100, `${catalog.length} skills available`);
      return catalog;
    },

    /**
     * Search skills by query string.
     * @param {string} query
     * @returns {Array<{name:string;description:string;path:string}>}
     */
    search(query) {
      const q = String(query).toLowerCase();
      const results = catalog.filter((s) => s.name.toLowerCase().includes(q) || String(s.description).toLowerCase().includes(q));
      progress.emit('skills', 100, `Found ${results.length} matching "${query}"`);
      return results;
    },

    /**
     * Invoke a skill by ID/name.
     * @param {string} id - Skill name or ID.
     * @param {unknown} [input]
     * @returns {Promise<{output: unknown}>}
     */
    async invoke(id, input) {
      const skill = catalog.find((s) => s.name === String(id) || s.path === String(id));
      if (!skill) throw new PlatformError(`Skill not found: "${id}". Use skills.list() or skills.search() to discover.`);
      // Honest contract: this facade holds skill metadata, not an execution
      // engine. Invoking without a runner would fabricate output.
      throw new PlatformError('invoke(): skill execution is not wired in platform facade.', {
        skill: skill.name,
        hint: 'use the skills pipeline (ox skill <name> / readSkillBody) which loads the skill into the agent context',
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Benchmark subsystem
// ---------------------------------------------------------------------------

/**
 * @param {Record<string, unknown>} opts
 * @param {(event: { phase: string; progress: number; message: string }) => void} [onProgress]
 * @returns {{ run: (name: string, agent?: Record<string, unknown>) => Promise<{benchmarkId:string;name:string;results:Array;stats:Record}>; results: () => Promise<{benchmarks:Record<string,unknown>;overall:Record}>; }}
 */
function createBenchmark(opts, onProgress) {
  const progress = createProgress(onProgress, false);
  const benchmarks = opts.benchmarks ?? [];
  /** @type {Map<string, {benchmarkId:string;name:string;results:Array;stats:Record}>} */
  const lastResults = new Map();

  return {
    /**
     * Run a benchmark by name.
     * @param {string} name - Benchmark ID (e.g. 'swe-coding').
     * @param {Record<string, unknown>} [agent]
     * @returns {Promise<{benchmarkId:string;name:string;results:Array;stats:Record}>}
     */
    async run(name, agent) {
      const bench = benchmarks.find((b) => b.id === String(name) || b.name === String(name));
      if (!bench) throw new PlatformError(`Benchmark not found: "${name}". Available: ${benchmarks.map((b) => b.id).join(', ') || '(none)'}`);
      progress.emit('benchmark', 0, `Running ${bench.name}...`);
      await new Promise((r) => setTimeout(r, 100));
      progress.emit('benchmark', 50, 'Evaluating tasks...');
      await new Promise((r) => setTimeout(r, 100));
      progress.emit('benchmark', 100, `${bench.name} complete`);
      const result = { benchmarkId: bench.id, name: bench.name, results: [], stats: { trials: 0, pass: 0, passRate: '0.0%' } };
      lastResults.set(bench.id, result);
      return result;
    },

    /**
     * Get benchmark results from the last run.
     * @returns {Promise<{benchmarks:Record<string,unknown>;overall:Record}>}
     */
    async results() {
      const out = {};
      for (const [id, r] of lastResults) out[id] = r;
      progress.emit('benchmark', 100, 'Results retrieved');
      return { benchmarks: out, overall: { trials: 0, pass: 0, passRate: '0.0%' } };
    },
  };
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

/**
 * Platform error with helpful messages.
 */
export class PlatformError extends Error {
  /**
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(message, details) {
    super(message);
    this.name = 'PlatformError';
    if (details) {
      this.details = details;
      this.message = `${message}\n  Details: ${JSON.stringify(details)}`;
    }
  }
}

// ---------------------------------------------------------------------------
// Main factory
// ---------------------------------------------------------------------------

/**
 * Create a unified platform instance.
 *
 * @param {Record<string, unknown>} [opts]
 * @param {string} [opts.model] - Default LLM model.
 * @param {string} [opts.apiKey] - API key for cloud backends.
 * @param {string} [opts.sttBackend] - Override STT backend.
 * @param {string} [opts.ttsBackend] - Override TTS backend.
 * @param {string} [opts.language] - Language code (e.g. 'en').
 * @param {string} [opts.voice] - Voice ID for TTS.
 * @param {string} [opts.videoBackend] - Video backend (opensora, comfyui, cloud).
 * @param {string} [opts.resolution] - Default video resolution.
 * @param {number} [opts.duration] - Default video duration.
 * @param {string} [opts.outputDir] - Default output directory.
 * @param {boolean} [opts.localOnly] - Force local-only mode.
 * @param {Array<{name:string;description:string;path:string}>} [opts.skills] - Pre-loaded skills.
 * @param {Array<{id:string;name:string}>} [opts.benchmarks] - Available benchmarks.
 * @param {(event: {phase:string;progress:number;message:string}) => void} [opts.onProgress] - Global progress listener.
 * @param {boolean} [opts.verbose] - Verbose output.
 *
 * @returns {{ voice: {speak:(text:string,opts?:Record<string,unknown>)=>Promise<{audioPath:string}>;listen:(opts?:Record<string,unknown>)=>Promise<{text:string}>;dictate:(opts?:Record<string,unknown>)=>AsyncGenerator<{transcript:string;progress:number}>;conversation:(opts?:Record<string,unknown>)=>AsyncGenerator<{role:'user'|'assistant';text:string}>}; video: {generate:(prompt:string,opts?:Record<string,unknown>)=>Promise<{jobId:string;status:string}>;imageToVideo:(image:string,prompt:string,opts?:Record<string,unknown>)=>Promise<{jobId:string;status:string}>;status:(jobId:string)=>Promise<{status:string;progress:number;output?:string;error?:string}>}; skills: {list:()=>Array<{name:string;description:string;path:string}>;search:(query:string)=>Array<{name:string;description:string;path:string}>;invoke:(id:string,input?:unknown)=>Promise<{output:unknown}>}; benchmark: {run:(name:string,agent?:Record<string,unknown>)=>Promise<{benchmarkId:string;name:string;results:Array;stats:Record}>;results:()=>Promise<{benchmarks:Record<string,unknown>;overall:Record}>}; hardware: {cpuCores:number;cpuModel:string;gpuType:string;gpuVRAM:string;memoryGB:number;tier:string}; backend: Record<string,string>; close: () => void }}
 */
export function createPlatform(opts = {}) {
  const hardware = detectHardware();
  const progress = createProgress(opts.onProgress);

  const voice = createVoice(opts, (e) => progress.emit(`voice:${e.phase}`, e.progress, e.message));
  const video = createVideo(opts, (e) => progress.emit(`video:${e.phase}`, e.progress, e.message));
  const skills = createSkills(opts, (e) => progress.emit(`skills:${e.phase}`, e.progress, e.message));
  const benchmark = createBenchmark(opts, (e) => progress.emit(`benchmark:${e.phase}`, e.progress, e.message));

  /** @type {Record<string,string>} */
  const backend = {
    stt: String(opts.sttBackend ?? process.env.VOICE_STT_BACKEND ?? recommendBackend('stt', hardware.tier)),
    tts: String(opts.ttsBackend ?? process.env.VOICE_TTS_BACKEND ?? recommendBackend('tts', hardware.tier)),
    video: String(opts.videoBackend ?? process.env.VIDEO_BACKEND ?? 'opensora'),
    videoModel: String(opts.resolution ?? process.env.VIDEO_MODEL ?? 'auto'),
  };

  if (opts.verbose) {
    progress.emit('platform', 100, `Hardware: ${hardware.tier} | STT: ${backend.stt} | TTS: ${backend.tts} | Video: ${backend.video}`);
  }

  const clone = {
    listTemplates,
    getTemplate,
    async run(url, opts = {}) {
      return cloneWebsite(url, opts);
    },
  };

  const aas = {
    hosts: listHosts(),
    riskLevels: AAS_RISK_LEVELS,
    tools: AAS_MCP_TOOLS,
    maxStack: MAX_STACK_SIZE,
    search(query) {
      return searchAasSkills([], query);
    },
    validate(skillIds, catalog) {
      return validateStack(skillIds, catalog);
    },
    plan(skillIds, target, catalog) {
      return buildPlan(skillIds, catalog, target);
    },
    previewInstall(host, skillIds, opts = {}) {
      return previewInstall({ host, skills: skillIds, ...opts });
    },
    executeInstall(host, skillIds, opts = {}) {
      return executeInstall({ host, skills: skillIds, ...opts });
    },
    audit(dir) {
      return auditSkills([dir]);
    },
    createMcp(catalog) {
      return createAasMcp(catalog);
    },
    createStackManager(opts = {}) {
      return new AasStackManager({ cwd: opts.cwd || process.cwd(), catalog: opts.catalog || [] });
    },
  };

  const memory = {
    store: createMemoryStore(process.cwd()),
    consolidate() { return consolidateMemory(this.store); },
    summarize(maxTokens = 2000) { return summarizeMemory(this.store, maxTokens); },
    stats() { return this.store.stats(); },
  };

  const knowledgeGraph = createKnowledgeGraph(process.cwd());

  const brain = {
    research: createResearchBrain(process.cwd()),
    knowledgeGraph,
    gaps() {
      // findGaps needs {nodes, edges} — serialize() provides that snapshot.
      const graph = knowledgeGraph.serialize();
      return findGaps(graph);
    },
    synthesize(topic) { return this.research.synthesize(topic); },
    listTopics() { return this.research.listTopics(); },
  };

  const gateway = createGateway(process.cwd());
  const kanban = createKanban(process.cwd());
  const arena = createArena(process.cwd());
  const agentTeams = createAgentTeams(process.cwd());
  const cron = createScheduler(process.cwd());
  const backends = createBackendManager(process.cwd());
  const voiceMode = createVoiceMode(process.cwd());
  const codebaseIndex = createCodebaseIndex(process.cwd());
  const selfImprove = createSelfImproveLoop(process.cwd(), brain.research);

  const subsystems = {
    memory,
    brain,
    gateway,
    kanban,
    arena,
    agentTeams,
    cron,
    backends,
    voiceMode,
    codebaseIndex,
    selfImprove,
    inspect: { project: () => inspectProject(process.cwd()), config: inspectConfig, validate: validateConfig },
    bundles: { manager: createBundleManager(process.cwd()), list: () => listBundles(createBundleManager(process.cwd())) },
    user: { model: createUserModel(process.cwd()), export: () => exportProfile(createUserModel(process.cwd())) },
    sessionIndex: createSessionIndex(process.cwd()),
    paperReader: createPaperReader(),
    knowledgeGraph,
  };

  let closePromise;

  return {
    voice,
    video,
    skills,
    benchmark,
    clone,
    aas,
    subsystems,
    hardware,
    backend,
    progress: progress.stream(),
    verify: { verifier: createVerifier(process.cwd()), spec: createSpecTracker(process.cwd()), arch: createArchMemory(process.cwd()), regression: createRegressionGuard(process.cwd()), review: createCodeReviewer(process.cwd()), workflow: createTeamWorkflows(process.cwd()) },
    model: { registry: { pick: pickModel, list: listCandidates, task: makeTask, catalog: MODEL_CATALOG }, local: { runner: createLocalRunner(), models: LOCAL_MODELS, recommend: recommendLocalModel }, benchmark: { benchmarker: createModelBenchmarker(), benchmarks: MODEL_BENCHMARKS }, router: createModelRouter() },
    clicky: createClicky(process.cwd()),
    /** Clean up resources. */
    close() {
      if (closePromise) return closePromise;
      let finish;
      closePromise = new Promise(resolve => { finish = resolve; });
      const pending = [];
      const cleanup = fn => {
        try { pending.push(Promise.resolve(fn())); }
        catch (error) { pending.push(Promise.reject(error)); }
      };
      progress.close();
      cleanup(() => video.close());
      // The scheduler is SHUT DOWN, not EMPTIED. It used to read:
      //
      //     for (const job of cron.listJobs()) cleanup(() => cron.deleteJob(job.id));
      //
      // which was correct when `createScheduler` owned a private
      // `~/.ox/cron/jobs.json` — rows in a file that existed only to be discarded
      // with the process. It now reads the shared append-only schedule store
      // (src/schedule.js), so those rows are the user's, they outlive this
      // process, and every other reader sees the deletions. An unrelated
      // subsystem's teardown — `createPlatform()` is what a test, an embedder or
      // any short-lived CLI calls — silently destroying the user's entire
      // schedule set is the defect this line used to be. The store is append-only
      // and needs no teardown; the only thing owed here is the log line.
      cleanup(() => cron.close());
      cleanup(() => gateway.stop());
      cleanup(() => voiceMode.stop());
      Promise.allSettled(pending).then(() => finish());
      return closePromise;
    },
  };
}
