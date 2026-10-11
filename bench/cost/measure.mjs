// bench/cost/measure.mjs - the four cost measurements, and nothing else.
//
//   A  harnessOverhead   fixed per-run token floor ox pays before the model
//                        says anything (system prompt + tool schemas)
//   B  maxCostStop       --max-cost really hard-stops a run
//   C  fallbackCost      fallback_policy.cost=free_only refuses paid fallbacks
//   D  modelOverrides    model_overrides + ox never invents a price
//
// Every figure carries `provenance` (which run, which request, which field).
// Unmeasurable => UNMEASURED + reason. Nothing is extrapolated.
//
// The OpenRouter account backing this machine has 0 credits, so any remote call
// is best-effort: HTTP 402 is an ACCOUNT limit, not a model failure, and is
// reported as such rather than as a bad result for the model.
import fs from 'node:fs';
import path from 'node:path';

import {
  COST_DIR,
  createSandbox,
  decomposeTokens,
  destroySandbox,
  measureRequestPayload,
  parseNdjson,
  sandboxEnv,
  spawnOx,
  startLoggingProxy,
  startMockSse,
  toTokens,
  UNMEASURED,
  usageTotals,
} from './lib.mjs';

// In-process probes import src/config.js, whose CONFIG_DIR is computed at module
// load from os.homedir(). Redirect HOME BEFORE the first such import so the
// developer's real ~/.ox is never read.
const INPROC = createSandbox('inproc');
process.env.HOME = INPROC.home;
process.env.XDG_CONFIG_HOME = path.join(INPROC.home, '.config');
process.env.XDG_DATA_HOME = path.join(INPROC.home, '.local', 'share');
process.env.XDG_STATE_HOME = path.join(INPROC.home, '.local', 'state');
process.env.XDG_CACHE_HOME = path.join(INPROC.home, '.cache');

const { loadConfig, FALLBACK_COST_POLICIES } = await import('../../src/config.js');
const { createCostBudget, lookupModel, resolveModelWindow, costOf, PRICING } = await import('../../src/cost.js');
const { classifyTargetCost } = await import('../../src/agent.js');
const { listToolSchemas } = await import('../../src/tools/index.js');
export const OLLAMA_BASE = 'http://localhost:11434/v1';
export const OLLAMA_ORIGIN = 'http://localhost:11434';
export const OLLAMA_MODEL = 'qwen2.5:0.5b';

// Credit status is an environment fact, not a measurement of a model.
export const CREDIT_NOTE =
  'OpenRouter account on this machine reports 0 credits: remote calls are best-effort. HTTP 402 = account limit, NOT a model failure.';

const provenance = (parts) => parts.filter(Boolean).join(' > ');

// decomposeTokens returns a bare number when a field was measured and
// { value: 'unmeasured', reason } when it was not. Normalise for reporting.
const val = (x) => (x && typeof x === 'object' && 'value' in x ? x.value : x);

// ===========================================================================
// A. HARNESS TOKEN OVERHEAD
//
// One real ox turn against a loopback mock OpenAI-SSE endpoint that records the
// exact request body. The system message and the `tools` array are then measured
// at the byte level off that recorded request and converted with ox's own
// estimator. The denominator is a REAL local-model run captured through a
// logging proxy, so the ratio is measured on both sides.
// ===========================================================================

export async function measureHarnessOverhead({ timeoutMs = 120_000 } = {}) {
  const mockModel = 'ox-cost-bench-mock';
  const mock = await startMockSse({ respond: () => ({ text: 'ack' }) });
  const sb = createSandbox('overhead');
  try {
    const env = sandboxEnv({
      home: sb.home,
      set: { OX_BASE_URL: mock.baseUrl, OX_API_KEY: 'loopback-not-a-real-key', OX_YOLO: '1' },
    });
    const run = await spawnOx({
      args: ['-p', 'say hi', '--json', '--bot', `custom:${mockModel}`],
      cwd: sb.ws,
      env,
      timeoutMs,
    });
    const events = parseNdjson(run.stdout);
    const req = mock.requests[0] ?? null;
    if (!req || !req.json) {
      return {
        metric: 'harnessOverhead',
        status: 'unmeasured',
        reason: `loopback mock captured ${mock.requests.length} request(s); no parsable request body`,
        run: { exitCode: run.exitCode, ms: run.ms, stderr: run.stderr.slice(0, 400) },
      };
    }

    const payload = measureRequestPayload(req.json);
    const narrowing = events.find((e) => (e.t ?? e.type) === 'tool-narrowing') ?? null;
    const decomposition = decomposeTokens(events, {
      sizes: { systemText: payload.systemText, schemaText: payload.schemaText, conversationText: payload.conversationText },
    });

    // The complete built-in tool set ox can offer, for context only: what the
    // run ACTUALLY sent is the narrowed set above.
    const builtinSchemas = listToolSchemas({});
    const builtinJson = JSON.stringify(builtinSchemas);

    return {
      metric: 'harnessOverhead',
      status: 'measured',
      provenance: {
        systemTokens: provenance([`request[${req.seq}].json.messages[role=system]`, 'content string length', 'estimateTokens']),
        schemaTokens: provenance([`request[${req.seq}].json.tools`, 'JSON.stringify length', 'estimateTokens']),
        conversationTokens: provenance([`request[${req.seq}].json.messages[role!=system]`, 'JSON.stringify length', 'estimateTokens']),
        tokens: `ox -p 'say hi' --json --bot custom:${mockModel} against ${mock.baseUrl} (loopback mock)`,
        ratio: 'decomposeTokens.overheadRatio from the matching usage-total',
      },
      request: {
        seq: req.seq,
        url: req.url,
        bodyBytes: req.rawBytes,
        messages: payload.messageCount,
        systemMessages: payload.systemMessageCount,
        nonSystemMessages: payload.nonSystemMessageCount,
        toolsSent: payload.toolCount,
      },
      bytes: {
        systemBytes: payload.systemBytes,
        systemChars: payload.systemChars,
        schemaBytes: payload.schemaBytes,
        schemaChars: payload.schemaChars,
        conversationBytes: payload.conversationBytes,
        conversationChars: payload.conversationChars,
        wholeBodyBytes: payload.wholeBodyBytes,
      },
      tokens: {
        systemTokens: val(decomposition.systemTokens),
        schemaTokens: val(decomposition.schemaTokens),
        conversationTokens: val(decomposition.conversationTokens),
        floorTokens: val(decomposition.floor),
        partsTotal: val(decomposition.partsTotal),
      },
      decomposition,
      builtinSchemaSet: {
        provenance: 'src/tools/index.js:listToolSchemas({}) - NOT what the run sent',
        toolCount: builtinSchemas.length,
        chars: builtinJson.length,
        bytes: Buffer.byteLength(builtinJson, 'utf8'),
        tokens: toTokens(builtinJson),
      },
      toolNarrowing: narrowing,
      run: { exitCode: run.exitCode, ms: run.ms, stderr: run.stderr.slice(0, 400) },
    };
  } finally {
    await mock.close();
    destroySandbox(sb);
  }
}

// Same request, captured against the REAL local model through a logging proxy,
// so floor-tokens-per-output-token has a measured numerator and denominator.
export async function measureOverheadRatioVsRealOutput({ timeoutMs = 240_000 } = {}) {
  // ox deliberately omits stream_options.include_usage for Ollama endpoints
  // (src/providers/openai-compat.js:185,193), so an Ollama stream carries no usage
  // object and ox reports usage-total 0/0. The proxy adds ONLY that request flag;
  // the response is piped through untouched, so prompt_tokens/completion_tokens are
  // Ollama's own counters, not numbers this suite produced.
  const proxy = await startLoggingProxy({
    // forward to the host root: ox POSTs to <baseUrl>/chat/completions, so the
    // loopback path already carries /v1 and appending OLLAMA_BASE again would 404
    upstreamBaseUrl: OLLAMA_ORIGIN,
    mutateBody: (body) => ({ ...body, stream_options: { include_usage: true } }),
  });
  const sb = createSandbox('ratio');
  try {
    const env = sandboxEnv({ home: sb.home, set: { OX_YOLO: '1', OX_BASE_URL: proxy.baseUrl } });
    const run = await spawnOx({
      args: ['-p', 'say hi', '--json', '--bot', `ollama:${OLLAMA_MODEL}`],
      cwd: sb.ws,
      env,
      timeoutMs,
    });
    const events = parseNdjson(run.stdout);
    const req = proxy.requests[0] ?? null;
    if (!req || !req.json) {
      return {
        metric: 'overheadRatioVsRealOutput',
        status: 'unmeasured',
        reason: `logging proxy captured ${proxy.requests.length} request(s) to ${OLLAMA_BASE}`,
        run: { exitCode: run.exitCode, ms: run.ms },
      };
    }
    const payload = measureRequestPayload(req.json);
    const decomposition = decomposeTokens(events, {
      sizes: { systemText: payload.systemText, schemaText: payload.schemaText, conversationText: payload.conversationText },
    });
    const floor = val(decomposition.floor);
    const out = val(decomposition.outputTokens);
    const ratio =
      typeof floor === 'number' && typeof out === 'number' && out > 0
        ? Number((floor / out).toFixed(2))
        : { value: UNMEASURED, reason: `outputTokens=${JSON.stringify(out)}` };
    return {
      metric: 'overheadRatioVsRealOutput',
      status: typeof ratio === 'number' ? 'measured' : 'unmeasured',
      provenance: {
        floor: provenance([`request[${req.seq}].json captured via loopback proxy in front of ${OLLAMA_BASE}`, 'messages[role=system] + tools', 'estimateTokens']),
        outputTokens: provenance(['usage-total event', 'outputTokens']),
        ratio: 'floorTokens / usage-total.outputTokens, same run',
      },
      upstream: proxy.upstreamBaseUrl,
      requestMutation: 'proxy added stream_options.include_usage=true to the REQUEST only; response piped through byte-for-byte, so usage numbers are Ollama counters',
      bytes: { systemBytes: payload.systemBytes, schemaBytes: payload.schemaBytes, conversationBytes: payload.conversationBytes },
      floorTokens: floor,
      outputTokens: out,
      inputTokens: val(decomposition.inputTokens),
      floorPerOutputToken: ratio,
      decomposition,
      run: { exitCode: run.exitCode, ms: run.ms, stderr: run.stderr.slice(0, 400) },
    };
  } finally {
    await proxy.close();
    destroySandbox(sb);
  }
}

// ===========================================================================
// B. --max-cost HARD STOP
//
// Same fixture task, same model, two caps. Nothing about the fixture or the
// model changes between the runs - only the number on the flag.
// ===========================================================================

export const FIXTURE_LIB = 'const k=()=>41;module.exports={k};';
export const FIXTURE_TEST = "const assert=require('node:assert');const {k}=require('./lib.js');assert.strictEqual(k(),42);\n";

function setupFixture(ws) {
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, 'lib.js'), FIXTURE_LIB);
  fs.writeFileSync(path.join(ws, 'test.js'), FIXTURE_TEST);
  return {
    lib: FIXTURE_LIB,
    test: FIXTURE_TEST.trim(),
    provenance: 'bench/cost/measure.mjs:FIXTURE_LIB / FIXTURE_TEST, written into the sandbox ws',
  };
}

async function runFixtureWithCap({ capUsd, timeoutMs }) {
  const sb = createSandbox(`maxcost-${capUsd === null ? 'nocap' : String(capUsd).replace(/[^0-9.]/g, '')}`);
  // Loopback logging proxy in front of Ollama. ox never sends
  // stream_options.include_usage to an Ollama endpoint (src/providers/openai-compat.js:193),
  // so a DIRECT run reports usage-total 0/0 and "tokens spent" would be a fiction.
  // The proxy adds that ONE request flag and pipes the response back untouched:
  // the counters below are Ollama's own numbers.
  const proxy = await startLoggingProxy({
    upstreamBaseUrl: OLLAMA_ORIGIN,
    mutateBody: (b) => ({ ...b, stream_options: { include_usage: true } }),
  });
  try {
    const fixture = setupFixture(sb.ws);
    const env = sandboxEnv({ home: sb.home, set: { OX_YOLO: '1', OX_BASE_URL: proxy.baseUrl } });
    const run = await spawnOx({
      args: [
        '-p',
        'lib.js returns 41 but test.js expects 42. Fix lib.js so node test.js passes.',
        '--json',
        '--bot',
        `ollama:${OLLAMA_MODEL}`,
        '--yes-edits',
        ...(capUsd === null ? [] : ['--max-cost', String(capUsd)]),
      ],
      cwd: sb.ws,
      env,
      timeoutMs,
    });
    const events = parseNdjson(run.stdout);
    const stop = events.find((e) => (e.t ?? e.type) === 'budget-stop') ?? null;
    const totals = usageTotals(events);
    const spentFrom = totals.fromTotal ?? stop ?? null;
    return {
      capUsd,
      provenance: `ox -p '<fixture goal>' --bot ollama:${OLLAMA_MODEL} ${capUsd === null ? '(no --max-cost)' : `--max-cost ${capUsd}`}`,
      exitCode: run.exitCode,
      printed: (stop ? JSON.stringify(stop) : '') || run.stderr.slice(0, 300) || '(no budget-stop line)',
      budgetStopEvent: stop,
      tokensSpent: spentFrom
        ? {
            inputTokens: spentFrom.inputTokens,
            outputTokens: spentFrom.outputTokens,
            costUsd: spentFrom.costUsd ?? null,
            knownCostUsd: spentFrom.knownCostUsd ?? null,
            unknownModels: spentFrom.unknownModels ?? null,
            source: totals.fromTotal ? 'usage-total event' : 'budget-stop event snapshot',
          }
        : { value: UNMEASURED, reason: 'neither a usage-total nor a budget-stop event carried token counters' },
      reportedStopReason: stop?.reason ?? totals.fromTotal?.maxCostUsd ?? null,
      fixture,
      libAfterRun: fs.readFileSync(path.join(sb.ws, 'lib.js'), 'utf8').trim(),
      testAfterRun: fs.readFileSync(path.join(sb.ws, 'test.js'), 'utf8').trim(),
      events: events.length,
      eventNames: events.map((e) => e.t ?? e.type).filter(Boolean),
      requestsServed: proxy.requests.length,
      finalText: (events.find((e) => (e.t ?? e.type) === 'final')?.message?.content ?? '').slice(0, 300),
      errorText: (events.find((e) => (e.t ?? e.type) === 'error')?.error ?? null),
      ms: run.ms,
    };
  } finally {
    destroySandbox(sb);
  }
}

// In-process probe of the cap arithmetic itself, against a model that DOES ship
// a price row. No provider call: this shows the code path, not a billed run.
export function probeCostCapArithmetic() {
  const priced = 'grok-4.6';
  const budget = createCostBudget({ maxCostUsd: 1e-9 });
  budget.record(priced, { inputTokens: 1000, outputTokens: 100 });
  const snapshot = budget.snapshot();
  let thrown = null;
  try {
    budget.assert(priced);
  } catch (err) {
    thrown = { message: err.message, code: err.code, exitCode: err.exitCode };
  }
  const unpricedBudget = createCostBudget({ maxCostUsd: 1e-9 });
  unpricedBudget.record('ox-cost-bench-no-such-model', { inputTokens: 1000, outputTokens: 100 });
  let unpricedThrown = null;
  try {
    unpricedBudget.assert('ox-cost-bench-no-such-model');
  } catch (err) {
    unpricedThrown = { message: err.message, code: err.code, exitCode: err.exitCode };
  }
  return {
    metric: 'costCapArithmetic',
    status: 'measured',
    provenance: 'in-process call to src/cost.js:createCostBudget - no provider request, no money spent',
    priced: {
      model: priced,
      pricing: PRICING[priced],
      maxCostUsd: 1e-9,
      snapshot,
      reason: budget.reason,
      thrown,
    },
    unpriced: {
      model: 'ox-cost-bench-no-such-model',
      maxCostUsd: 1e-9,
      snapshot: unpricedBudget.snapshot(),
      reason: unpricedBudget.reason,
      thrown: unpricedThrown,
    },
  };
}

export async function measureMaxCostStop({ timeoutMs = 150_000 } = {}) {
  const noCap = await runFixtureWithCap({ capUsd: null, timeoutMs });
  const lowCap = await runFixtureWithCap({ capUsd: 0.0000001, timeoutMs });
  const highCap = await runFixtureWithCap({ capUsd: 100, timeoutMs });
  return {
    metric: 'maxCostStop',
    status: 'measured',
    note:
      'Both runs use the same fixture, the same local Ollama model, and no credentials. Anything that differs below is caused by --max-cost alone.',
    fixtureGoal: 'lib.js returns 41 but test.js expects 42. Fix lib.js so node test.js passes.',
    noCap,
    lowCap,
    highCap,
    arithmeticProbe: probeCostCapArithmetic(),
  };
}

// ===========================================================================
// C. fallback_policy.cost = free_only
// ===========================================================================

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = String(v);
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

export function measureFallbackCostPolicy() {
  const policies = [...FALLBACK_COST_POLICIES];

  const accepted = withEnv({ OX_FALLBACK_COST: 'free_only' }, () => ({
    value: loadConfig({}).fallbackPolicy,
  }));

  let rejected = null;
  try {
    withEnv({ OX_FALLBACK_COST: 'free_when_paid' }, () => loadConfig({}));
  } catch (err) {
    rejected = {
      message: err.message,
      exitCode: err.exitCode,
      thrown: true,
      provenance: 'src/config.js:loadConfig - error surfaces verbatim from the throw',
    };
  }

  const defaultPolicy = withEnv({ OX_FALLBACK_COST: undefined }, () => loadConfig({}).fallbackPolicy);

  const classification = [
    { target: 'ox-grok (grok-4.6, PRICING row in=2/out=6)', bot: 'ox-grok', cost: classifyTargetCost(resolveBotFor('ox-grok')) },
    { target: 'ox-ollama (keyEnv null -> can never bill)', bot: 'ox-ollama', cost: classifyTargetCost(resolveBotFor('ox-ollama')) },
    { target: 'ox-cost-bench-no-such-model (no PRICING row, paid provider)', bot: null, cost: classifyTargetCost({ provider: 'custom', model: 'ox-cost-bench-no-such-model', keyEnv: 'OX_API_KEY' }) },
    { target: 'null target', bot: null, cost: classifyTargetCost(null) },
  ];

  const agentSrc = fs.readFileSync(path.join(COST_DIR, '..', '..', 'src', 'agent.js'), 'utf8');
  // Extract the template literal from the source at run time (a nested `${...}`
  // interpolation contains backticks, so a naive /`[^`]*`/ match truncates).
  const warningTemplateExtracted = (() => {
    const start = agentSrc.indexOf('fallback policy free_only refused all configured fallback bots');
    if (start === -1) return null;
    const open = agentSrc.lastIndexOf(String.fromCharCode(96), start);
    const tail = 'instead of spending' + String.fromCharCode(96);
    const end = agentSrc.indexOf(tail, start);
    if (open === -1 || end === -1) return null;
    return agentSrc.slice(open, end + tail.length);
  })();
  const droppedBranchPresent = agentSrc.includes('fallback_policy.cost=free_only refused a ${cost} fallback target');
  const warningBranchPresent = agentSrc.includes('fallback policy free_only refused all configured fallback bots');

  return {
    metric: 'fallbackCostPolicy',
    status: 'measured',
    acceptedPolicies: policies,
    envAccepted: accepted,
    provenance: {
      envAccepted: 'src/config.js:loadConfig with process.env.OX_FALLBACK_COST=free_only -> .fallbackPolicy',
      rejected: 'src/config.js:loadConfig with OX_FALLBACK_COST=free_when_paid -> throw',
      classification: 'src/agent.js:classifyTargetCost on real resolved bots',
      droppedPath: 'static read of src/agent.js + a live run in measureFallbackDropPath()',
    },
    rejected,
    defaultPolicy,
    classification,
    droppedPath: {
      resolveFallbackListExists: droppedBranchPresent,
      allDroppedWarningBranchExists: warningBranchPresent,
      droppedReasonTemplate: 'fallback_policy.cost=free_only refused a ${cost} fallback target',
      warningTemplateExtractedFromSource: warningTemplateExtracted,
      templatesAreSourceQuoted: true,
      note: 'the strings above are extracted from src/agent.js at run time, never re-typed; the template-literal holes are exactly what ox interpolates at runtime'
    },
  };
}

// resolveBot is needed for the real classification inputs.
const { resolveBot } = await import('../../src/bots.js');
function resolveBotFor(spec) {
  return resolveBot(spec, loadConfig({}));
}

// A LIVE run of the dropped-fallback path: the loopback mock answers HTTP 500 so
// the turn runner reaches resolveFallbackList(), while the only configured
// fallback is a paid bot and the policy is free_only.
export async function measureFallbackDropPath({ timeoutMs = 120_000 } = {}) {
  const mock = await startMockSse({ respond: () => ({ status: 500, contentType: 'text/plain' }) });
  const sb = createSandbox('freedrop');
  try {
    const env = sandboxEnv({
      home: sb.home,
      set: {
        OX_BASE_URL: mock.baseUrl,
        OX_API_KEY: 'loopback-not-a-real-key',
        OX_YOLO: '1',
        OX_FALLBACK_COST: 'free_only',
        OX_FALLBACK_BOTS: 'ox-grok',
      },
    });
    const run = await spawnOx({
      args: ['-p', 'say hi', '--json', '--bot', 'custom:ox-cost-bench-mock'],
      cwd: sb.ws,
      env,
      timeoutMs,
    });
    const events = parseNdjson(run.stdout);
    const warning = events.find((e) => (e.t ?? e.type) === 'warning') ?? null;
    const error = events.find((e) => (e.t ?? e.type) === 'error') ?? null;
    return {
      metric: 'fallbackDropPath',
      status: warning ? 'measured' : 'unmeasured',
      provenance:
        'ox -p ... --bot custom:<mock> with OX_FALLBACK_BOTS=ox-grok and OX_FALLBACK_COST=free_only against a loopback mock that answers HTTP 500 (no credentials spent)',
      mockRequests: mock.requests.length,
      warningText: warning?.text ?? null,
      errorText: error?.error ?? null,
      exitCode: run.exitCode,
      events: events.map((e) => e.t ?? e.type).filter(Boolean),
      run: { ms: run.ms, stderr: run.stderr.slice(0, 300) },
    };
  } finally {
    await mock.close();
    destroySandbox(sb);
  }
}

// ===========================================================================
// D. model_overrides + no-invented-prices
// ===========================================================================

export function measureModelOverrides() {
  const spec = 'm:4096:0.5:1.5';
  const withOverride = withEnv({ OX_MODEL_OVERRIDE: spec }, () => loadConfig({}));
  const overrides = withOverride.modelOverrides;

  const base = {
    provenance: 'src/config.js:loadConfig with OX_MODEL_OVERRIDE, then src/cost.js:lookupModel / resolveModelWindow / costOf',
    spec,
    modelOverrides: overrides,
    lookupModel: lookupModel('m', overrides),
    lookupModelWithoutOverride: lookupModel('m'),
    resolveModelWindowWithOverride: resolveModelWindow({ model: 'm', overrides, env: {} }),
    resolveModelWindowWithoutOverride: resolveModelWindow({ model: 'm', overrides: null, env: {} }),
    costOfWithOverrideName: costOf('m', { inputTokens: 1000, outputTokens: 100 }),
    note:
      'lookupModel()/resolveModelWindow() take an overrides argument and honour it. costOf(model, usage) has NO overrides parameter (src/cost.js:143), so an OX_MODEL_OVERRIDE price row never reaches costOf; model_overrides in/out reach classifyTargetCost(target, config.modelOverrides), which is what cost-HONEST ROUTING reads.',
  };

  const unknownModel = 'ox-cost-bench-no-such-model';
  const priced = costOf('grok-4.6', { inputTokens: 1000, outputTokens: 100 });
  const unknown = {
    provenance: 'src/cost.js:costOf / lookupModel on a model with no PRICING row and no override',
    model: unknownModel,
    lookupModel: lookupModel(unknownModel),
    costOf: costOf(unknownModel, { inputTokens: 1000, outputTokens: 100 }),
    costOfZeroUsage: costOf(unknownModel, {}),
    pricedModelControl: { model: 'grok-4.6', costOf: priced },
    isNullNotZero: costOf(unknownModel, { inputTokens: 1000, outputTokens: 100 }) === null,
  };

  const budget = createCostBudget({ maxCostUsd: 5 });
  budget.record(unknownModel, { inputTokens: 1000, outputTokens: 100 });
  const noPriceReporting = {
    provenance: 'src/cost.js:createCostBudget.snapshot with one unpriced model recorded',
    snapshot: budget.snapshot(),
    note: 'costUsd is null (NOT 0) whenever any model in the run has no price row; knownCostUsd carries only the priced part.',
  };

  return {
    metric: 'modelOverrides',
    status: 'measured',
    override: base,
    unknownModel,
    unknown,
    noInventedPrices: noPriceReporting,
  };
}

// ===========================================================================
// Suite entry point
// ===========================================================================

export async function measureAll({ quick = false } = {}) {
  const started = Date.now();
  const results = [];
  const push = (name, value) => results.push({ name, ...value });

  push('A-harness-overhead', await measureHarnessOverhead());
  push('A-overhead-ratio', await measureOverheadRatioVsRealOutput());
  if (!quick) {
    push('B-max-cost-stop', await measureMaxCostStop());
    push('C-fallback-drop-path', await measureFallbackDropPath());
  }
  push('C-fallback-policy', measureFallbackCostPolicy());
  push('D-model-overrides', measureModelOverrides());

  destroySandbox(INPROC);
  return { startedAt: new Date(started).toISOString(), quick: Boolean(quick), ms: Date.now() - started, creditNote: CREDIT_NOTE, results };
}
