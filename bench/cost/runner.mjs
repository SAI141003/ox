#!/usr/bin/env node
// bench/cost/runner.mjs - CLI for the cost-measurement suite.
//
//   node bench/cost/runner.mjs                    full run, writes bench/cost/RESULTS.md
//   node bench/cost/runner.mjs --quick            skip the slow live-model runs
//   node bench/cost/runner.mjs --json <path>      also write the raw result tree as JSON
//   node bench/cost/runner.mjs --explain <metric> where a given number came from
//
// Every number printed here was measured in the run that produced it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { COST_DIR, REPO_ROOT } from './lib.mjs';
import { CREDIT_NOTE, measureAll, OLLAMA_MODEL } from './measure.mjs';

const RESULTS_MD = path.join(COST_DIR, 'RESULTS.md');

function parseArgs(argv) {
  const out = { quick: false, json: null, explain: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--quick') out.quick = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--json') {
      i++;
      if (!argv[i]) throw new Error('--json needs a path');
      out.json = path.resolve(argv[i]);
    } else if (a === '--explain') {
      i++;
      if (!argv[i]) throw new Error('--explain needs a metric name');
      out.explain = argv[i];
    } else throw new Error(`unknown flag: ${a}`);
  }
  return out;
}

export const OLLAMA_MODEL_NAME = OLLAMA_MODEL;

const USAGE = `usage: node bench/cost/runner.mjs [--quick] [--json <path>] [--explain <metric>]`;

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function fmt(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : String(v);
  if (typeof v === 'object' && 'value' in v) return v.value === 'unmeasured' ? `unmeasured (${v.reason})` : String(v.value);
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function mdCell(v, n) {
  const t = String(fmt(v)).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  return n && t.length > n ? t.slice(0, n - 1) + '...' : t;
}

function explainFor(name, results) {
  const r = results.find((x) => x.name.toLowerCase().includes(String(name).toLowerCase()));
  if (!r) {
    return [`no metric matching '${name}' in this run. Available: ${results.map((x) => x.name).join(', ')}`];
  }
  const lines = [`metric: ${r.name}`, `status: ${r.status ?? 'measured'}`];
  if (r.reason) lines.push(`reason: ${r.reason}`);
  if (r.provenance && typeof r.provenance === 'object') {
    for (const [k, v] of Object.entries(r.provenance)) lines.push(`  ${k}: ${v}`);
  }
  return lines;
}

function renderMarkdown(report) {
  const L = [];
  L.push('# bench/cost results');
  L.push('');
  L.push(`- run started: ${report.startedAt}`);
  L.push(`- mode: ${report.quick ? 'quick (live max-cost + dropped-fallback runs skipped)' : 'full'}`);
  L.push(`- node: ${process.version} · platform: ${process.platform}/${process.arch}`);
  L.push(`- wall clock: ${report.ms} ms`);
  L.push(`- token estimator: every token figure below is \`src/context.js:estimateTokens\` (ceil(chars/4)) applied to bytes measured in this run. It is NOT a provider tokenizer.`);
  L.push('');
  L.push(`> ${CREDIT_NOTE}`);
  L.push('');
  L.push('Integrity: every figure is read off something observed in this run. Nothing is estimated,');
  L.push('extrapolated, or carried over from a previous run. Unmeasurable fields read `unmeasured`');
  L.push('with a reason. External figures (none are used here) would be labelled EXTERNAL.');
  L.push('');

  for (const r of report.results) {
    L.push(`## ${r.name}`);
    L.push('');
    if (r.status === 'unmeasured') {
      L.push(`**unmeasured** — ${r.reason}`);
      L.push('');
      continue;
    }

    if (r.name === 'A-harness-overhead') {
      L.push(`Fixed per-run token floor paid before the model says anything, measured off the request`);
      L.push(`ox actually sent to the loopback mock.`);
      L.push('');
      L.push('| field | value | where it came from |');
      L.push('|---|---|---|');
      L.push(`| request captured | #${r.request.seq} → ${r.request.url} | loopback mock request log |`);
      L.push(`| system message | ${mdCell(r.bytes.systemBytes)} B (${r.bytes.systemChars} chars) | \`messages[role=system]\` |`);
      L.push(`| tool schemas | ${mdCell(r.bytes.schemaBytes)} B (${r.bytes.schemaChars} chars) | \`tools\` (${r.request.toolsSent} sent) |`);
      L.push(`| conversation | ${mdCell(r.bytes.conversationBytes)} B | non-system messages |`);
      L.push(`| **floor (system + schemas)** | **${mdCell(r.tokens.floorTokens)} tok** | (${r.tokens.systemTokens} + ${r.tokens.schemaTokens}) |`);
      L.push(`| system tokens | ${mdCell(r.tokens.systemTokens)} tok | estimateTokens(systemChars) |`);
      L.push(`| schema tokens | ${mdCell(r.tokens.schemaTokens)} tok | estimateTokens(schemaChars) |`);
      L.push(`| conversation tokens | ${mdCell(r.tokens.conversationTokens)} tok | estimateTokens(conversationChars) |`);
      L.push(`| full builtin schema set (NOT what this run sent) | ${r.builtinSchemaSet.toolCount} tools, ${r.builtinSchemaSet.bytes} B, ${r.builtinSchemaSet.tokens} tok | listToolSchemas({}) |`);
      if (r.toolNarrowing) L.push(`| tool narrowing in this run | offered ${r.toolNarrowing.offered} of ${r.toolNarrowing.total} | tool-narrowing event |`);
      L.push('');
    }

    if (r.name === 'A-overhead-ratio') {
      L.push(`Floor tokens per output token, both sides measured in the same run (real local model via a`);
      L.push(`logging reverse proxy in front of Ollama).`);
      L.push('');
      L.push('| field | value |');
      L.push('|---|---|');
      L.push(`| floor tokens | ${mdCell(r.floorTokens)} |`);
      L.push(`| input tokens (provider usage-total) | ${mdCell(r.inputTokens)} |`);
      L.push(`| output tokens (provider usage-total) | ${mdCell(r.outputTokens)} |`);
      L.push(`| **floor per output token** | **${mdCell(r.floorPerOutputToken)}** |`);
      L.push(`| overheadRatio (input/output) | ${mdCell(r.decomposition?.overheadRatio)} |`);
      L.push(`| residual (provider − estimator) | ${mdCell(r.decomposition?.residualTokens)} |`);
      L.push(`| upstream | ${r.upstream} |`);
      L.push('');
    }

    if (r.name === 'B-max-cost-stop') {
      L.push(`Same fixture, same local Ollama model, no credentials. Only \`--max-cost\` differs.`);
      L.push('');
      L.push(`fixture: \`lib.js\` = \`${r.lowCap.fixture.lib}\``);
      L.push('');
      L.push('| cap | exit code | tokens spent before stop | ox printed | fixture after run |');
      L.push('|---|---|---|---|---|');
      for (const c of [r.noCap, r.lowCap, r.highCap]) {
        const cap = c.capUsd === null ? '(none)' : String(c.capUsd);
        const spent = typeof c.tokensSpent === 'object' && 'inputTokens' in c.tokensSpent
          ? `in=${c.tokensSpent.inputTokens} out=${c.tokensSpent.outputTokens} (${c.tokensSpent.source})`
          : mdCell(c.tokensSpent);
        const printed = c.budgetStopEvent ? `budget-stop reason=${c.budgetStopEvent.reason} costUsd=${c.budgetStopEvent.costUsd}` : '(no budget-stop)';
        L.push(`| ${cap} | ${c.exitCode} | ${spent} | ${mdCell(printed)} | lib.js = \`${mdCell(c.libAfterRun)}\` |`);
      }
      L.push('');
      L.push('Per-run detail, exactly as observed:');
      L.push('');
      for (const c of [r.noCap, r.lowCap, r.highCap]) {
        const cap = c.capUsd === null ? '(none)' : String(c.capUsd);
        const names = [...new Set(c.eventNames || [])].join(', ');
        L.push(`- ${cap}: ${c.requestsServed} provider request(s); distinct events ${mdCell(names)}; ${c.ms} ms`);
        if (c.errorText) L.push(`- ${cap}: ox reported error \`${mdCell(c.errorText, 200)}\``);
        if (c.finalText) L.push(`- ${cap}: final message \`${mdCell(c.finalText, 240)}\``);
      }
      L.push('');      const localModel = r.arithmeticProbe.unpriced.model === 'ox-cost-bench-no-such-model' ? OLLAMA_MODEL_NAME : r.arithmeticProbe.unpriced.model;
      L.push(`Read this table literally: the local model ${localModel} ships no price row, so ox`);
      L.push('cannot evaluate ANY cap against it and fails closed with reason `unknown-cost`. A cap low');
      L.push('and a cap high therefore behave identically here; the no-cap run is the control showing that');
      L.push('the stop is caused by the cap, not by the fixture. Headless mode prints `budget-stop` and');
      L.push('exits 0 (observed exit code above); the deterministic exit code 2 comes from the');
      L.push('in-process throw below, not from the CLI.');
      L.push('');
      const p = r.arithmeticProbe;
      L.push(`In-process probe of the cap arithmetic (no provider call, no money spent):`);
      L.push('');
      L.push(`- priced model \`${p.priced.model}\` (in=${p.priced.pricing.in}, out=${p.priced.pricing.out} $/Mtok), cap ${p.priced.maxCostUsd}: reason \`${p.priced.reason}\`, snapshot ${JSON.stringify(p.priced.snapshot)}, throw ${JSON.stringify(p.priced.thrown)}`);
      L.push(`- unpriced model \`${p.unpriced.model}\`, cap ${p.unpriced.maxCostUsd}: reason \`${p.unpriced.reason}\`, snapshot ${JSON.stringify(p.unpriced.snapshot)}, throw ${JSON.stringify(p.unpriced.thrown)}`);
      L.push('');
    }

    if (r.name === 'C-fallback-policy') {
      L.push('| probe | result |');
      L.push('|---|---|');
      L.push(`| \`OX_FALLBACK_COST=free_only\` → loadConfig().fallbackPolicy | \`${mdCell(JSON.stringify(r.envAccepted.value))}\` |`);
      L.push(`| accepted policy values | ${r.acceptedPolicies.map((x) => `\`${x}\``).join(', ')} |`);
      L.push(`| default when unset | \`${mdCell(JSON.stringify(r.defaultPolicy))}\` |`);
      L.push(`| invalid value \`free_when_paid\` | ${r.rejected ? `**rejected** — \`${r.rejected.message}\` (exitCode ${r.rejected.exitCode})` : 'NOT REJECTED'} |`);
      L.push(`| dropped-fallback branch present in src/agent.js | ${r.droppedPath.resolveFallbackListExists} |`);
      L.push(`| all-dropped warning branch present | ${r.droppedPath.allDroppedWarningBranchExists} |`);
      for (const c of r.classification) L.push(`| classifyTargetCost(${c.target}) | \`${c.cost}\` |`);
      L.push('');
      L.push('Exact dropped-fallback reason string (quoted from src/agent.js):');
      L.push('');
      L.push('```');
      L.push(r.droppedPath.droppedReasonTemplate);
      L.push('```');
      L.push('');
      L.push('Exact all-dropped warning TEMPLATE, extracted from src/agent.js at run time (the `${...}` holes are what ox interpolates):');
      L.push('');
      L.push('```');
      L.push(String(r.droppedPath.warningTemplateExtractedFromSource ?? 'unavailable'));
      L.push('```');
      L.push('');
      L.push('The warning ox actually EMITTED on the live run is printed verbatim under C-fallback-drop-path below.');
      L.push('');
    }

    if (r.name === 'C-fallback-drop-path') {
      L.push(`Live run of the dropped-fallback path: mock answers HTTP 500, the only configured`);
      L.push(`fallback (\`ox-grok\`) is priced, so \`free_only\` must drop it. No credentials spent.`);
      L.push('');
      L.push(`- status: ${r.status}`);
      L.push(`- requests that hit the mock: ${r.mockRequests}`);
      L.push(`- exit code: ${r.exitCode}`);
      if (r.warningText) {
        L.push('- ox emitted this warning verbatim:');
        L.push('');
        L.push('```');
        L.push(r.warningText);
        L.push('```');
      } else {
        L.push('- ox emitted no warning event');
      }
      L.push(`- events: ${r.events.join(', ')}`);
      L.push('');
    }

    if (r.name === 'D-model-overrides') {
      const o = r.override;
      const u = r.unknown;
      L.push('| probe | result |');
      L.push('|---|---|');
      L.push(`| \`OX_MODEL_OVERRIDE="${o.spec}"\` → config.modelOverrides | \`${mdCell(JSON.stringify(o.modelOverrides))}\` |`);
      L.push(`| lookupModel('m', overrides) | \`${mdCell(JSON.stringify(o.lookupModel))}\` |`);
      L.push(`| lookupModel('m') with NO override | \`${mdCell(JSON.stringify(o.lookupModelWithoutOverride))}\` |`);
      L.push(`| resolveModelWindow('m', with override) | ${mdCell(o.resolveModelWindowWithOverride)} |`);
      L.push(`| resolveModelWindow('m', no override) | ${mdCell(o.resolveModelWindowWithoutOverride)} |`);
      L.push(`| costOf('m', 1000in/100out, overrides) | ${mdCell(o.costOfWithOverrideName)} |`);
      L.push(`| lookupModel('${u.model}') | \`${mdCell(JSON.stringify(u.lookupModel))}\` |`);
      L.push(`| **costOf('${u.model}', 1000in/100out)** | **${u.isNullNotZero ? '`null` (not 0)' : mdCell(u.costOf)}** |`);
      L.push(`| control costOf('${u.pricedModelControl.model}', 1000in/100out) | ${mdCell(u.pricedModelControl.costOf)} |`);
      L.push(`| budget.snapshot() with one unpriced model | \`${mdCell(JSON.stringify(r.noInventedPrices.snapshot))}\` |`);
      L.push('');
      L.push(`> ${r.noInventedPrices.note}`);
      L.push('');
      L.push(`> ${o.note}`);
      L.push('');
    }
  }

  L.push('---');
  L.push('');
  L.push('What this suite does NOT measure: see `bench/cost/README.md`.');
  L.push('');
  return L.join('\n');
}

function printConsole(report, args) {
  console.log(`ox cost suite — ${report.quick ? 'QUICK' : 'FULL'} — node ${process.version} — ${report.ms} ms`);
  console.log(CREDIT_NOTE);
  console.log('');
  for (const r of report.results) {
    if (r.status === 'unmeasured') {
      console.log(`  ${r.name.padEnd(24)} unmeasured — ${r.reason}`);
      continue;
    }
    if (r.name === 'A-harness-overhead') {
      console.log(`  ${r.name.padEnd(24)} floor=${r.tokens.floorTokens} tok (system ${r.tokens.systemTokens} + schemas ${r.tokens.schemaTokens}); request #${r.request.seq} ${r.request.toolsSent} tools, body ${r.request.bodyBytes} B`);
    } else if (r.name === 'A-overhead-ratio') {
      console.log(`  ${r.name.padEnd(24)} floor=${fmt(r.floorTokens)} tok, output=${fmt(r.outputTokens)} tok → floor/output=${fmt(r.floorPerOutputToken)}; overheadRatio=${fmt(r.decomposition?.overheadRatio)}`);
    } else if (r.name === 'B-max-cost-stop') {
      console.log(`  ${r.name.padEnd(24)} low cap ${r.lowCap.capUsd}: exit ${r.lowCap.exitCode}, ${r.lowCap.budgetStopEvent ? `budget-stop(${r.lowCap.budgetStopEvent.reason})` : 'no budget-stop'}; high cap ${r.highCap.capUsd}: exit ${r.highCap.exitCode}, ${r.highCap.budgetStopEvent ? `budget-stop(${r.highCap.budgetStopEvent.reason})` : 'no budget-stop'}`);
      console.log(`  ${''.padEnd(24)} in-process: priced+cap → ${r.arithmeticProbe.priced.reason}; unpriced+cap → ${r.arithmeticProbe.unpriced.reason}`);
    } else if (r.name === 'C-fallback-policy') {
      console.log(`  ${r.name.padEnd(24)} free_only → ${JSON.stringify(r.envAccepted.value)}; invalid → ${r.rejected ? `rejected (${r.rejected.message})` : 'NOT REJECTED'}`);
      for (const c of r.classification) console.log(`  ${''.padEnd(24)}   classify ${c.cost.padEnd(7)} ← ${c.target}`);
    } else if (r.name === 'C-fallback-drop-path') {
      console.log(`  ${r.name.padEnd(24)} ${r.status}: ${r.warningText ? `warning: ${r.warningText}` : `no warning (${r.errorText ?? 'no error event'})`}`);
    } else if (r.name === 'D-model-overrides') {
      const o = r.override;
      console.log(`  ${r.name.padEnd(24)} override ${o.spec} → ${JSON.stringify(o.lookupModel)}, window ${o.resolveModelWindowWithOverride} (was ${o.resolveModelWindowWithoutOverride})`);
      console.log(`  ${''.padEnd(24)} costOf('${r.unknownModel}', 1000in/100out) = ${fmt(r.unknown.costOf)} — null, not 0`);
      console.log(`  ${''.padEnd(24)} budget.snapshot costUsd = ${JSON.stringify(r.noInventedPrices.snapshot.costUsd)} with one unpriced model (null, not 0)`);
    }
  }
  if (args.explain) {
    console.log('');
    for (const line of explainFor(args.explain, report.results)) console.log(`explain[${args.explain}] ${line}`);
  }
}

// ---------------------------------------------------------------------------

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`ox-cost: ${err.message}\n${USAGE}`);
    process.exitCode = 3;
    return;
  }
  if (args.help) {
    console.log(USAGE);
    return;
  }

  const report = await measureAll({ quick: args.quick });
  report.repoRoot = REPO_ROOT;
  report.host = os.hostname();

  if (args.json) {
    fs.mkdirSync(path.dirname(args.json), { recursive: true });
    fs.writeFileSync(args.json, JSON.stringify(report, null, 2));
    console.log(`wrote ${args.json}`);
  }

  fs.writeFileSync(RESULTS_MD, renderMarkdown(report));
  printConsole(report, args);
  console.log('');
  console.log(`wrote ${path.relative(REPO_ROOT, RESULTS_MD)}`);
  // Loopback servers and node's keep-alive socket pool can hold the event loop
  // open after the last line is printed; this is a CLI, so exit deliberately.
  process.exit(0);
}

main().catch((err) => {
  console.error(`ox-cost: runner failed: ${err?.stack ?? err}`);
  process.exitCode = 1;
});
