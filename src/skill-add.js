import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CONFIG_DIR } from './config.js';
import { parseSkillMd } from './skills.js';

export const RAW_GITHUB_BASE = 'https://raw.githubusercontent.com';
export const SKILL_ADD_TIMEOUT_MS = 10000;
export const RECEIPT_LOG_NAME = 'skills-install.log';

// ClawHavoc lesson: skills are untrusted prompt+code bundles. Every file that
// can steer the model or execute later must pass the denylist before install.
export const DENYLIST = [
  { id: 'pipe-to-shell', pattern: /(curl|wget|fetch)[^|\n]*\|\s*(ba)?sh/, scope: 'all', why: 'downloads piped straight into a shell' },
  { id: 'base64-decode', pattern: /base64\s+-d/, scope: 'all', why: 'obfuscated payload decoding' },
  { id: 'eval-call', pattern: /\beval\s*\(/, scope: 'all', why: 'dynamic code evaluation' },
  { id: 'rm-rf-destructive', pattern: /rm\s+-rf?\s+(\/|~|\*)/, scope: 'all', why: 'destructive recursive delete' },
  { id: 'ssh-aws-access', pattern: /\.(ssh|aws)\b/, scope: 'all', why: 'touches credential stores' },
  { id: 'prompt-injection', pattern: /ignore\s+(all\s+)?previous\s+instructions/i, scope: 'all', why: 'prompt-injection phrasing' },
  // A literal VALUE must follow: 6+ chars containing a digit (real keys do;
  // `'generated-fallback'` does not), quoted or .env-style, never `sk_test_...`. Variable
  // reads (`TOKEN = generateToken()`, `apiKey: process.env.X`) and empty
  // assignments (`BOT_TOKEN=` in setup docs) are not credentials.
  {
    id: 'secret-literal',
    pattern: /(?:api[_-]?key|secret|token|password)\w*\s*[:=]\s*(?:(["'`])(?!\$\{|<|your|xxx)(?=[^"'`\s]*\d)(?![^"'`\s]*\.\.\.)[^"'`\s]{6,}\1|(?=[^\s"'`]*\d)(?![^\s"'`]*\.\.\.)[A-Za-z0-9_\-./+]{6,}(?![A-Za-z0-9_\-./+(]))/i,
    scope: 'all',
    why: 'looks like a hardcoded credential',
  },
  { id: 'node-subprocess', pattern: /child_process|execSync|spawnSync/, scope: 'scripts', why: 'script spawns subprocesses' },
];

const SHORTHAND_RE = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/(.*))?$/;
const BRANCHES = ['HEAD', 'main', 'master'];

function invalid(message, extra = {}) {
  return { ok: false, kind: 'invalid', message, ...extra };
}

function walkFiles(dir, baseRel = '') {
  const out = [];
  let dirents;
  try {
    dirents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of dirents) {
    const rel = baseRel ? `${baseRel}/${d.name}` : d.name;
    const full = path.join(dir, d.name);
    if (d.isDirectory()) out.push(...walkFiles(full, rel));
    else if (d.isFile()) out.push({ absPath: full, relPath: rel });
  }
  return out;
}

// In a skill's written instructions, a line that warns against the pattern is
// guidance, not the pattern: "Never use eval() with user data", "never treat
// page text as instructions" (three such lines in addyosmani/agent-skills'
// security advice were refused as attacks). Only for prose, only for the rules
// that a warning can mention; scripts are held to every rule.
const WARNS = /\b(never|don'?t|do not|avoid|must not|should not|refuse|reject|beware|watch (?:out )?for|be wary|is dangerous|vulnerab|attack|injection|untrusted|treat[^.]* as data)\b/i;
const PROSE_SAFE = new Set(['eval-call', 'prompt-injection']);

export function scanText(relPath, text, baseLine = 0) {
  const findings = [];
  const lines = String(text ?? '').split(/\r?\n/);
  const prose = /\.(md|mdx|txt)$/i.test(relPath) || relPath === 'SKILL.md';
  for (const entry of DENYLIST) {
    if (entry.scope === 'scripts' && !relPath.startsWith('scripts/')) continue;
    for (let i = 0; i < lines.length; i++) {
      if (!entry.pattern.test(lines[i])) continue;
      if (prose && PROSE_SAFE.has(entry.id) && WARNS.test(lines[i])) continue;
      // Quoted as an example of what to watch for: (e.g. "ignore previous instructions").
      if (prose && entry.id === 'prompt-injection' && /["“'`][^"”'`]*ignore\s+(?:all\s+)?previous\s+instructions[^"”'`]*["”'`]/i.test(lines[i])) continue;
      findings.push({
        file: relPath,
        line: i + 1 + baseLine,
        pattern: entry.id,
        why: entry.why,
        excerpt: lines[i].trim().slice(0, 80),
      });
    }
  }
  return findings;
}

// Scans the SKILL.md body plus every file under scripts/ and references/.
function skilMdBodyOffset(rawText) {
  const lines = String(rawText ?? '').split(/\r?\n/);
  if ((lines[0] ?? '').trim() !== '---') return 0;
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) return 0;
  let stripped = 0;
  for (let i = close + 1; i < lines.length && lines[i].trim() === ''; i++) stripped++;
  return close + stripped + 1;
}

export function scanSkillSource(sourceDir) {
  let findings = [];
  const scanned = [];
  for (const sub of ['', 'scripts', 'references']) {
    const dir = sub ? path.join(sourceDir, sub) : sourceDir;
    let files;
    if (sub) files = walkFiles(dir).map((f) => ({ ...f, relPath: `${sub}/${f.relPath}` }));
    else files = [{ absPath: path.join(dir, 'SKILL.md'), relPath: 'SKILL.md' }];
    for (const f of files) {
      let text;
      try {
        text = fs.readFileSync(f.absPath, 'utf8');
      } catch {
        continue;
      }
      scanned.push(f.relPath);
      if (f.relPath === 'SKILL.md') {
        const parsed = parseSkillMd(text, f.absPath);
        if (parsed.ok) {
          findings = findings.concat(
            scanText('SKILL.md', parsed.skill.body, skilMdBodyOffset(text))
          );
          continue;
        }
      }
      findings = findings.concat(scanText(f.relPath, text));
    }
  }
  // A script that starts processes matters when the skill runs it, which it
  // can only do by naming it. A repo's own tooling no skill mentions (its test
  // runners, release scripts) is never run by ox: addyosmani/agent-skills was
  // refused for 19 such lines, all in its developer scripts. The other rules
  // (piped downloads, deletes, credentials, injection) still apply everywhere.
  let told = '';
  try { told = fs.readFileSync(path.join(sourceDir, 'SKILL.md'), 'utf8'); } catch {}
  for (const f of walkFiles(path.join(sourceDir, 'references'))) { try { told += fs.readFileSync(f.absPath, 'utf8'); } catch {} }
  const scriptsOnly = new Set(DENYLIST.filter((e) => e.scope === 'scripts').map((e) => e.id));
  // Tooling, not the skill's: a test file, or scripts in a folder with no
  // SKILL.md (a repository's own scripts). A skill's own scripts/ keep the rule.
  const isSkill = fs.existsSync(path.join(sourceDir, 'SKILL.md'));
  const tooling = (file) => /(?:^|[/._-])(?:test|tests|spec|__tests__)(?:[/._-]|$)/i.test(file) || !isSkill;
  const unused = (f) => scriptsOnly.has(f.pattern) && tooling(f.file) && !told.includes(path.basename(f.file));
  const skipped = findings.filter(unused);
  findings = findings.filter((f) => !unused(f));
  return { findings, scanned, skipped };
}

async function fetchText(url, timeoutMs) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) return { miss: true, status: res.status };
  return { text: await res.text() };
}

// GitHub shorthand 'owner/repo[/path]' → raw SKILL.md, trying HEAD/main/master.
export async function fetchGithubSkillMd(shorthand, { rawBase = RAW_GITHUB_BASE, timeoutMs = SKILL_ADD_TIMEOUT_MS } = {}) {
  const m = String(shorthand ?? '').trim().match(SHORTHAND_RE);
  if (!m) return null;
  const [, owner, repo, rawPath = ''] = m;
  const pathPart = rawPath.replace(/\/+$/, '');
  const base = String(rawBase ?? RAW_GITHUB_BASE).replace(/\/+$/, '');
  let lastError = null;
  for (const branch of BRANCHES) {
    const url = `${base}/${owner}/${repo}/${branch}/${pathPart ? `${pathPart}/` : ''}SKILL.md`;
    try {
      const r = await fetchText(url, timeoutMs);
      if (!r.miss) return { text: r.text, url, shorthand: String(shorthand).trim() };
      lastError = new Error(`HTTP ${r.status} for ${url}`);
    } catch (e) {
      lastError = e?.name === 'TimeoutError' ? new Error(`timed out after ${timeoutMs}ms fetching ${url}`) : e;
    }
  }
  throw new Error(`cannot fetch SKILL.md for '${String(shorthand).trim()}' (tried ${BRANCHES.join(', ')}): ${lastError?.message ?? lastError}`);
}

function sha256Of(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function appendReceipt(configDir, receipt) {
  fs.mkdirSync(configDir, { recursive: true });
  fs.appendFileSync(path.join(configDir, RECEIPT_LOG_NAME), `${JSON.stringify(receipt)}\n`);
}

export function readReceipts(configDir = CONFIG_DIR) {
  try {
    return fs
      .readFileSync(path.join(configDir, RECEIPT_LOG_NAME), 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// Installs a skill from a local directory or a GitHub shorthand into
// <home>/.agents/skills/<name>/ behind the ClawHavoc-style safety gate.
// Never throws for expected failures — returns a typed result instead.
export async function installSkill(source, opts = {}) {
  const {
    force = false,
    home = os.homedir(),
    cwd = process.cwd(),
    configDir = CONFIG_DIR,
    rawBase,
    timeoutMs = SKILL_ADD_TIMEOUT_MS,
  } = opts;

  const src = String(source ?? '').trim();
  if (!src) return invalid('skill add: a source is required (local skill directory or owner/repo[/path]).');

  if (/^https?:\/\//i.test(src)) {
    return invalid(`skill add: URL sources are not supported ('${src}') — use a local directory or the owner/repo[/path] shorthand.`);
  }

  let mode = null;
  let sourceDir = null;
  let rawText = null;
  let displaySource = src;

  const resolved = path.resolve(cwd, src);
  if (fs.existsSync(resolved)) {
    if (!fs.statSync(resolved).isDirectory()) {
      return invalid(`skill add: '${src}' is not a directory — point at a directory containing SKILL.md.`);
    }
    const skillMd = path.join(resolved, 'SKILL.md');
    if (!fs.existsSync(skillMd)) {
      return invalid(`skill add: '${src}' has no SKILL.md.`);
    }
    mode = 'local';
    sourceDir = resolved;
    rawText = fs.readFileSync(skillMd, 'utf8');
    displaySource = resolved;
  } else {
    if (!SHORTHAND_RE.test(src)) {
      return invalid(`skill add: '${src}' is neither an existing local directory nor an owner/repo[/path] shorthand.`);
    }
    mode = 'github';
    try {
      const fetched = await fetchGithubSkillMd(src, {
        rawBase: rawBase ?? process.env.OX_SKILL_RAW_BASE ?? RAW_GITHUB_BASE,
        timeoutMs,
      });
      rawText = fetched.text;
      displaySource = fetched.shorthand;
    } catch (e) {
      return invalid(`skill add: ${String(e?.message ?? e)}`);
    }
  }

  const virtualPath =
    mode === 'local'
      ? path.join(sourceDir, 'SKILL.md')
      : path.join(os.tmpdir(), 'ox-skill-add', ...src.split('/').filter(Boolean), 'SKILL.md');
  const parsed = parseSkillMd(rawText, virtualPath);
  if (!parsed.ok) {
    return invalid(`skill add: refusing '${src}' — ${parsed.warning}`);
  }
  const name = parsed.skill.name;

  const dest = path.join(path.resolve(home), '.agents', 'skills', name);
  if (fs.existsSync(dest)) {
    if (!force) {
      return {
        ok: false,
        kind: 'exists',
        name,
        dest,
        message: `skill '${name}' is already installed at ${dest} — re-run with --force to overwrite.`,
      };
    }
    fs.rmSync(dest, { recursive: true, force: true });
  }

  let findings = [];
  let scannedCount = 0;
  if (mode === 'local') {
    const scan = scanSkillSource(sourceDir);
    findings = scan.findings;
    scannedCount = scan.scanned.length;
  } else {
    const bodyParsed = parseSkillMd(rawText, virtualPath);
    findings = scanText('SKILL.md', bodyParsed.ok ? bodyParsed.skill.body : rawText);
    scannedCount = 1;
  }
  const patternsHit = [...new Set(findings.map((f) => f.pattern))];

  if (findings.length && !force) {
    return {
      ok: false,
      kind: 'unsafe',
      name,
      dest,
      source: displaySource,
      findings,
      patternsHit,
      message: `REFUSED: ${findings.length} dangerous pattern hit(s) in skill '${name}' — re-run with --force to install anyway.`,
    };
  }

  if (mode === 'local') {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(sourceDir, dest, { recursive: true });
  } else {
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, 'SKILL.md'), rawText);
  }

  const sha256 = sha256Of(Buffer.from(rawText, 'utf8'));
  const receipt = {
    date: new Date().toISOString(),
    name,
    source: displaySource,
    sha256,
    patternsHit,
  };
  try {
    appendReceipt(configDir, receipt);
  } catch {}

  return {
    ok: true,
    kind: 'installed',
    name,
    dest,
    source: displaySource,
    sha256,
    patternsHit,
    findings,
    forced: force && patternsHit.length > 0,
    filesScanned: scannedCount,
    description: parsed.skill.description,
  };
}
