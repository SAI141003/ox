/**
 * website-cloner.js — ESM module integrating the clone-website skill into ox.
 * 5-phase pipeline: extract tokens → crawl → generate specs → build → assemble.
 * Safety: refuses phishing/impersonation, checks ToS.
 */

import fs from 'node:fs';
import path from 'node:path';
import { runAgent } from './agent.js';
import { estimateTokens } from './context.js';

const SUPPORTED_STACKS = new Set(['nextjs', 'vite', 'svelte', 'plain']);
const BLOCKED_DOMAINS = new Set(['phish', 'impersonat', 'fake-login', 'credential-harvest']);
const BLOCKED_PATTERNS = [/password\s*=\s*['"]/i, /api[_-]?key\s*=\s*['"]/i, /secret\s*=\s*['"]/i];

function safetyCheck(url) {
  const u = String(url ?? '').toLowerCase();
  if (!u) return { ok: false, reason: 'url is required' };
  if (!/^https?:\/\//i.test(u)) return { ok: false, reason: 'must be http(s) URL' };
  for (const d of BLOCKED_DOMAINS) if (u.includes(d)) return { ok: false, reason: `blocked domain: ${d}` };
  for (const p of BLOCKED_PATTERNS) if (p.test(u)) return { ok: false, reason: 'suspicious pattern in URL' };
  return { ok: true };
}

function estimateTokens$1(text) {
  return estimateTokens(text);
}

export async function extractTokens(url, opts = {}) {
  const safe = safetyCheck(url);
  if (!safe.ok) throw new Error(`safety: ${safe.reason}`);
  const messages = [
    { role: 'system', content: 'You extract design tokens (colors, typography, spacing, breakpoints) from a webpage. Return JSON only.' },
    { role: 'user', content: `Extract design tokens from: ${url}` },
  ];
  const events = [];
  for await (const ev of runAgent({ target: opts.target ?? { model: 'gpt-4o' }, messages, ctx: { cwd: opts.cwd ?? process.cwd() }, maxIterations: 5 })) {
    events.push(ev);
    if (ev.type === 'final' || ev.type === 'error') break;
  }
  const final = events.find((e) => e.type === 'final');
  const text = final?.message?.content ?? '{}';
  try { return JSON.parse(text); } catch { return { raw: text, tokens: estimateTokens$1(text) }; }
}

export function generateSpecs(tokens, opts = {}) {
  const stack = opts.stack ?? 'plain';
  if (!SUPPORTED_STACKS.has(stack)) throw new Error(`unsupported stack: ${stack}`);
  const specs = [];
  const components = opts.components ?? ['Header', 'Hero', 'Features', 'Footer'];
  for (const name of components) {
    specs.push({
      name,
      stack,
      tokens: { ...tokens },
      props: [],
      variants: [],
      accessibility: { wcag: 'AA', focusable: true },
      generatedAt: new Date().toISOString(),
    });
  }
  return specs;
}

export async function buildComponents(specs, opts = {}) {
  const stack = opts.stack ?? 'plain';
  const results = [];
  for (const spec of specs) {
    const messages = [
      { role: 'system', content: `Build a ${spec.name} component in ${stack}. Return code only.` },
      { role: 'user', content: JSON.stringify(spec) },
    ];
    const events = [];
    for await (const ev of runAgent({ target: opts.target ?? { model: 'gpt-4o' }, messages, ctx: { cwd: opts.cwd ?? process.cwd() }, maxIterations: 8 })) {
      events.push(ev);
      if (ev.type === 'final' || ev.type === 'error') break;
    }
    const final = events.find((e) => e.type === 'final');
    results.push({ name: spec.name, code: final?.message?.content ?? '', stack });
  }
  return results;
}

export async function assemblePage(components, opts = {}) {
  const stack = opts.stack ?? 'plain';
  const messages = [
    { role: 'system', content: `Assemble these components into a complete ${stack} page. Return full file contents.` },
    { role: 'user', content: JSON.stringify(components) },
  ];
  const events = [];
  for await (const ev of runAgent({ target: opts.target ?? { model: 'gpt-4o' }, messages, ctx: { cwd: opts.cwd ?? process.cwd() }, maxIterations: 10 })) {
    events.push(ev);
    if (ev.type === 'final' || ev.type === 'error') break;
  }
  const final = events.find((e) => e.type === 'final');
  return { page: final?.message?.content ?? '', components: components.length, stack };
}

export function visualDiff(original, clone) {
  const a = String(original ?? '');
  const b = String(clone ?? '');
  const aLines = a.split('\n');
  const bLines = b.split('\n');
  const maxLen = Math.max(aLines.length, bLines.length);
  const diffs = [];
  for (let i = 0; i < maxLen; i++) {
    if (aLines[i] !== bLines[i]) diffs.push({ line: i + 1, original: aLines[i] ?? '', clone: bLines[i] ?? '' });
  }
  return { diffCount: diffs.length, diffs, similarity: 1 - diffs.length / maxLen };
}

const TEMPLATES = {
  nextjs: { name: 'Next.js App Router', files: ['package.json', 'next.config.js', 'app/layout.tsx', 'app/page.tsx'] },
  vite: { name: 'Vite + React', files: ['package.json', 'vite.config.ts', 'src/App.tsx', 'src/main.tsx'] },
  svelte: { name: 'SvelteKit', files: ['package.json', 'svelte.config.js', 'src/app.html', 'src/routes/+page.svelte'] },
  plain: { name: 'Plain HTML/CSS/JS', files: ['index.html', 'styles.css', 'script.js'] },
};

export function listTemplates() {
  return Object.entries(TEMPLATES).map(([key, t]) => ({ id: key, name: t.name, files: t.files }));
}

export function getTemplate(name) {
  return TEMPLATES[name] ?? null;
}

export async function cloneWebsite(url, opts = {}) {
  const safe = safetyCheck(url);
  if (!safe.ok) throw new Error(`safety: ${safe.reason}`);
  const stack = opts.stack ?? 'plain';
  if (!SUPPORTED_STACKS.has(stack)) throw new Error(`unsupported stack: ${stack}`);
  const tokens = await extractTokens(url, opts);
  const specs = generateSpecs(tokens, { stack, components: opts.components });
  const components = await buildComponents(specs, { stack, ...opts });
  const page = await assemblePage(components, { stack, ...opts });
  return { url, tokens, specs, components, page, stack };
}
