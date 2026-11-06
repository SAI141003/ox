import { spawnSync } from 'node:child_process';
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

function walkFiles(dir, baseRel = '', links = null) {
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
    if (d.isDirectory()) { if (d.name !== '.git') out.push(...walkFiles(full, rel, links)); }
    else if (d.isFile()) out.push({ absPath: full, relPath: rel });
    else if (d.isSymbolicLink()) links?.push(rel);
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

// Scans everything the install copies: SKILL.md whole (its description goes into
// every prompt) and every other file, wherever it sits. Only scripts/ and
// references/ were read, so a run.sh beside SKILL.md went in unread.
export function scanSkillSource(sourceDir) {
  let findings = [];
  const scanned = [];
  const links = [];
  for (const f of walkFiles(sourceDir, '', links)) {
    let buf;
    try {
      buf = fs.readFileSync(f.absPath);
    } catch {
      continue;
    }
    scanned.push(f.relPath);
    // A picture or a compiled file is not text: its bytes matched patterns by chance.
    if (buf.subarray(0, 8192).includes(0)) continue;
    findings = findings.concat(scanText(f.relPath, buf.toString('utf8')));
  }
  // A link is copied as a link: "data.txt" could be ~/.ssh/id_rsa, read the first time the skill opens it.
  for (const rel of links) findings.push({ file: rel, line: 0, pattern: 'symlink', why: 'a link can point at any file on this machine', excerpt: (() => { try { return fs.readlinkSync(path.join(sourceDir, rel)).slice(0, 80); } catch { return ''; } })() });
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

// The repo's file tree (one unauthenticated GitHub API call; 60 an hour per address).
async function githubTree(owner, repo, timeoutMs) {
  const meta = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'ox' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!meta.ok) throw new Error(`GitHub ${meta.status}`);
  const branch = (await meta.json()).default_branch ?? 'main';
  const r = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'ox' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`GitHub ${r.status}`);
  return { branch, tree: (await r.json()).tree ?? [] };
}

/** Folders holding a SKILL.md inside owner/repo[/path] (up to three levels down). */
export async function githubSkillFolders(shorthand, { timeoutMs = SKILL_ADD_TIMEOUT_MS } = {}) {
  const m = String(shorthand).match(SHORTHAND_RE);
  if (!m) return null;
  const [, owner, repo, sub = ''] = m;
  const prefix = sub.replace(/\/+$/, '');
  const { tree } = await githubTree(owner, repo, timeoutMs);
  const folders = tree.filter((t) => t.type === 'blob' && /(^|\/)SKILL\.md$/.test(t.path))
    .map((t) => t.path.replace(/\/?SKILL\.md$/, ''))
    .filter((p) => p && (!prefix || p.startsWith(`${prefix}/`)) && p.split('/').length - (prefix ? prefix.split('/').length : 0) <= 3)
    .map((p) => ({ path: p, name: p.split('/').pop() }));
  return { owner, repo, folders };
}

// Every other text file in the skill's folder (≤ 60 files, 1 MB in all).
async function githubFolderFiles(shorthand, { timeoutMs = SKILL_ADD_TIMEOUT_MS } = {}) {
  const m = String(shorthand).match(SHORTHAND_RE);
  if (!m) return [];
  const [, owner, repo, sub = ''] = m;
  const folder = sub.replace(/\/+$/, '');
  const { branch, tree } = await githubTree(owner, repo, timeoutMs);
  const files = tree.filter((t) => t.type === 'blob' && (!folder || t.path.startsWith(`${folder}/`)) && !/(^|\/)SKILL\.md$/.test(folder ? t.path.slice(folder.length + 1) : t.path))
    .filter((t) => folder || t.path.split('/').length <= 3)
    .filter((t) => (t.size ?? 0) < 300_000 && !/\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|woff2?|ttf|mp4|mov)$/i.test(t.path))
    .slice(0, 60);
  const out = [];
  let total = 0;
  for (const t of files) {
    const r = await fetch(`${RAW_GITHUB_BASE}/${owner}/${repo}/${branch}/${t.path}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) continue;
    const text = await r.text();
    total += text.length;
    if (total > 1_000_000) break;
    out.push({ rel: folder ? t.path.slice(folder.length + 1) : t.path, text });
  }
  return out;
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
// SkillSpector, static checks only, with no API keys in its environment. Exit 1 means it advises
// against installing; not installed, or failing to run, leaves ox's own scan as the answer.
export function secondScan(dir, skillMd, files = [], { spectorRun = spawnSync, env = process.env } = {}) {
  let target = dir;
  let temp = null;
  try {
    if (!target) {
      temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-skill-scan-'));
      target = temp;
      fs.writeFileSync(path.join(temp, 'SKILL.md'), skillMd ?? '');
      for (const f of files) {
        const out = path.join(temp, f.rel);
        if (!out.startsWith(temp + path.sep)) continue;
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, f.text);
      }
    }
    const r = spectorRun('skillspector', ['scan', target, '--no-llm', '--format', 'json'], {
      encoding: 'utf8', timeout: 120_000, windowsHide: true, env: { PATH: env.PATH ?? '', HOME: env.HOME ?? '' },
    });
    if (r.error || (r.status !== 0 && r.status !== 1)) return { ran: false };
    let score = null;
    try { score = JSON.parse(r.stdout).risk_score ?? null; } catch {}
    return { ran: true, unsafe: r.status === 1, score };
  } catch {
    return { ran: false };
  } finally {
    if (temp) fs.rmSync(temp, { recursive: true, force: true });
  }
}

export async function installSkill(source, opts = {}) {
  const {
    force = false,
    home = os.homedir(),
    cwd = process.cwd(),
    configDir = CONFIG_DIR,
    rawBase,
    timeoutMs = SKILL_ADD_TIMEOUT_MS,
  } = opts;

  let src = String(source ?? '').trim();
  if (!src) return invalid('skill add: a source is required (local skill directory or owner/repo[/path]).');
  // A GitHub link in its usual shapes (github.com/o/r, /tree/<branch>/<path>, …/SKILL.md) or o/r#name.
  let pick = null;
  const hash = /^(.+?)#([\w.-]+)$/.exec(src);
  if (hash) { src = hash[1]; pick = hash[2]; }
  const gh = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/(?:tree|blob)\/[\w.-]+(?:\/(.+?))?)?(?:\/SKILL\.md)?\/?$/i.exec(src);
  if (gh) src = [gh[1], gh[2], gh[3]].filter(Boolean).join('/');
  else if (/^https?:\/\//i.test(src)) return invalid(`skill add: only GitHub links are supported ('${src}') — or a local directory, or owner/repo[/path].`);

  let mode = null;
  let sourceDir = null;
  let rawText = null;
  let displaySource = src;
  let extraFiles = [];

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
      // No SKILL.md at that path: look for the skills inside the repo (skills/<name>/SKILL.md…).
      const found = await githubSkillFolders(src, { timeoutMs }).catch(() => null);
      if (!found?.folders.length) return invalid(`skill add: ${String(e?.message ?? e)}`);
      const want = (pick ?? '').toLowerCase();
      const hit = found.folders.length === 1 ? found.folders[0]
        : found.folders.find((f) => f.name.toLowerCase() === want) ?? (want ? found.folders.find((f) => f.name.toLowerCase().includes(want)) : null);
      if (!hit) {
        return { ok: false, kind: 'choose', name: null, choices: found.folders.map((f) => `${found.owner}/${found.repo}/${f.path}`),
          message: `'${src}' holds ${found.folders.length} skills: ${found.folders.map((f) => f.name).join(', ')} — name one (ox skill add ${found.owner}/${found.repo}#<name>)` };
      }
      return installSkill(`${found.owner}/${found.repo}/${hit.path}`, { ...opts });
    }
    // The skill's other files (scripts, references), each scanned before anything is written.
    extraFiles = await githubFolderFiles(src, { timeoutMs }).catch(() => []);
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
  // A folder that holds the skills folder: removing the old copy would delete part of the source,
  // and the copy would go into itself.
  if (mode === 'local') {
    let real = sourceDir;
    try { real = fs.realpathSync(sourceDir); } catch {}
    if (dest.startsWith(real + path.sep) || dest.startsWith(sourceDir + path.sep)) {
      return invalid(`skill add: '${src}' holds the skills folder itself — choose the skill's own folder.`);
    }
  }
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
    // Replacing a skill with itself deleted it: the copy below had nothing left to copy.
    if (mode === 'local' && (sourceDir === dest || sourceDir.startsWith(dest + path.sep) || fs.realpathSync(sourceDir) === fs.realpathSync(dest))) {
      return invalid(`skill add: '${src}' is the installed skill '${name}' itself — nothing to do.`);
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
    findings = scanText('SKILL.md', rawText);
    for (const f of extraFiles) findings.push(...scanText(f.rel, f.text));
    scannedCount = 1 + extraFiles.length;
  }
  const patternsHit = [...new Set(findings.map((f) => f.pattern))];

  // A second opinion when SkillSpector is installed (ox market: skillspector).
  const spector = force ? { ran: false } : secondScan(mode === 'local' ? sourceDir : null, rawText, extraFiles, opts);
  if (spector.unsafe) {
    return {
      ok: false, kind: 'unsafe', name, dest, source: displaySource, findings, patternsHit,
      message: `REFUSED: SkillSpector rates skill '${name}' ${spector.score ?? 'over 50'} of 100, do not install — re-run with --force to install anyway.`,
    };
  }

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
    fs.cpSync(sourceDir, dest, { recursive: true, filter: (from) => path.basename(from) !== '.git' });
  } else {
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, 'SKILL.md'), rawText);
    for (const f of extraFiles) {
      const out = path.join(dest, f.rel);
      if (!out.startsWith(dest + path.sep)) continue;
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, f.text);
    }
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
