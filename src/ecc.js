// ECC (affaan-m/everything-claude-code, MIT, © 2026 Affaan Mustafa) in ox:
// its skills, agents, commands and per-language rules, taken at a pinned
// commit and put where ox already reads them.
//
//   skills    → ~/.ox/skills/<name>, each one scanned by ox's skill denylist first;
//               a refused one is named. Not ~/.agents/skills: other tools read that
//               one too, and with ECC in it the ChatGPT plan's Codex spent about
//               8,000 tokens a request on a list so long it dropped the descriptions
//   agents    → ox agents (~/.ox/agents), as `ox import` turns subagents
//   commands  → skills too (a command is a prompt you call by name)
//   rules     → only when you ask, for one language: ox rules <lang> writes them
//               to this project's .ox/rules/ecc-<lang>.md, which ox reads
//   hooks     → listed, never installed: they run scripts on every tool call
//
// Nothing of yours is overwritten: a skill or agent with the same name stays.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const ECC_REPO = 'https://github.com/affaan-m/everything-claude-code.git';
export const ECC_PIN = 'b38be6a7f6350964d59328b52f0624e1d1d552d1';
export const eccDir = (env = process.env) => path.join(env.OX_HOME || path.join(os.homedir(), '.ox'), 'vendor', 'ecc');

/** The ECC checkout at the pinned commit (cloned once; `update` moves it to the newest). */
export function fetchEcc({ env = process.env, update = false, source = null } = {}) {
  if (source) return path.resolve(source);
  const dir = eccDir(env);
  const git = (args, cwd) => spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 180_000 });
  if (!fs.existsSync(path.join(dir, '.git'))) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    const r = git(['clone', '-q', '--filter=blob:none', ECC_REPO, dir]);
    if (r.status !== 0) throw new Error(`could not fetch ECC: ${(r.stderr || '').trim().slice(0, 200)}`);
  }
  if (update) git(['pull', '-q', '--ff-only'], dir);
  else if (git(['checkout', '-q', ECC_PIN], dir).status !== 0) { git(['fetch', '-q', 'origin', ECC_PIN], dir); git(['checkout', '-q', ECC_PIN], dir); }
  return dir;
}

const fm = (text) => {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(String(text));
  const meta = {};
  if (m) for (const l of m[1].split('\n')) { const kv = /^([\w-]+):\s*(.*)$/.exec(l); if (kv) meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, ''); }
  return { meta, body: m ? String(text).slice(m[0].length).trim() : String(text).trim() };
};
const safeName = (s) => String(s).replace(/[^\w.-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);

/** What ECC holds, read from its folders. */
export function inventory(dir) {
  const list = (d, f) => { try { return fs.readdirSync(path.join(dir, d), { withFileTypes: true }).filter(f).map((e) => e.name); } catch { return []; } };
  return {
    skills: list('skills', (e) => e.isDirectory() && fs.existsSync(path.join(dir, 'skills', e.name, 'SKILL.md'))),
    agents: list('agents', (e) => e.isFile() && e.name.endsWith('.md')),
    commands: list('commands', (e) => e.isFile() && e.name.endsWith('.md')),
    rules: list('rules', (e) => e.isDirectory()),
    hooks: list('hooks', (e) => e.isFile() || e.isDirectory()),
  };
}

// Taken out at the owner's request; a later install must not put them back.
const LEFT_OUT_AGENTS = new Set(['bengali-reviewer']);
const oxSkillsDir = (home) => path.join(home, '.ox', 'skills');
const isEccSkill = (dir) => { try { return /From ECC \(everything-claude-code/.test(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8')); } catch { return false; } };

/**
 * Move the ECC skills ox put in the shared ~/.agents/skills to ox's own folder.
 * Only what carries ox's own ECC credit moves, never your other skills; a name
 * already taken there stays where it is. Once is enough. → { moved, kept }
 */
export function moveEccSkills({ home = os.homedir() } = {}) {
  const shared = path.join(home, '.agents', 'skills');
  const dest = oxSkillsDir(home);
  const out = { moved: 0, kept: 0 };
  let names = [];
  try { names = fs.readdirSync(shared); } catch { return out; }
  for (const name of names) {
    const from = path.join(shared, name);
    if (!isEccSkill(from)) continue;
    const to = path.join(dest, name);
    if (fs.existsSync(to)) { out.kept++; continue; }
    fs.mkdirSync(dest, { recursive: true });
    fs.renameSync(from, to);
    out.moved++;
  }
  return out;
}

/**
 * Put ECC into ox. what: any of skills, agents, commands. → { skills, agents,
 * commands: { added, kept, refused: [{ name, why }] } }
 */
export async function installEcc(dir, { what = ['skills', 'agents', 'commands'], home = os.homedir(), env = process.env } = {}) {
  const inv = inventory(dir);
  const out = {};
  moveEccSkills({ home });
  const skillsDest = oxSkillsDir(home);
  const { scanSkillSource } = await import('./skill-add.js');
  const credit = (name, kind) => `\n\n---\n_From ECC (everything-claude-code by Affaan Mustafa, MIT), ${kind} \`${name}\` at ${ECC_PIN.slice(0, 7)}._\n`;
  if (what.includes('skills')) {
    const r = out.skills = { added: 0, kept: 0, refused: [] };
    fs.mkdirSync(skillsDest, { recursive: true });
    for (const name of inv.skills) {
      const src = path.join(dir, 'skills', name), dest = path.join(skillsDest, safeName(name));
      if (fs.existsSync(dest)) { r.kept++; continue; }
      const scan = scanSkillSource(src);
      if (scan.findings.length) { r.refused.push({ name, why: scan.findings.slice(0, 2).map((f) => `${f.file}:${f.line} ${f.pattern}`).join('; ') }); continue; }
      fs.cpSync(src, dest, { recursive: true, dereference: true });
      fs.appendFileSync(path.join(dest, 'SKILL.md'), credit(name, 'skill'));
      r.added++;
    }
  }
  if (what.includes('commands')) {
    const r = out.commands = { added: 0, kept: 0, refused: [] };
    for (const file of inv.commands) {
      const text = fs.readFileSync(path.join(dir, 'commands', file), 'utf8');
      const { meta, body } = fm(text);
      const name = `ecc-${safeName(file.replace(/\.md$/, ''))}`;
      const dest = path.join(skillsDest, name);
      if (fs.existsSync(dest)) { r.kept++; continue; }
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ox-ecc-'));
      try {
        const desc = (meta.description || body.split('\n').find((l) => l.trim() && !l.startsWith('#')) || name).replace(/\n/g, ' ').slice(0, 240);
        fs.writeFileSync(path.join(tmp, 'SKILL.md'), `---\nname: ${name}\ndescription: ${JSON.stringify(desc)}\n---\n\n${body.replace(/\$ARGUMENTS/g, 'what the user asked for')}${credit(file, 'command')}`);
        const scan = scanSkillSource(tmp);
        if (scan.findings.length) { r.refused.push({ name, why: scan.findings.slice(0, 2).map((f) => `${f.file}:${f.line} ${f.pattern}`).join('; ') }); continue; }
        fs.cpSync(tmp, dest, { recursive: true });
        r.added++;
      } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    }
  }
  if (what.includes('agents')) {
    const r = out.agents = { added: 0, kept: 0, refused: [] };
    const A = await import('./agents.js');
    for (const file of inv.agents) {
      const { meta, body } = fm(fs.readFileSync(path.join(dir, 'agents', file), 'utf8'));
      const name = safeName(meta.name || file.replace(/\.md$/, '')).toLowerCase();
      if (!A.AGENT_NAME.test(name)) { r.refused.push({ name, why: 'not a usable agent name' }); continue; }
      if (LEFT_OUT_AGENTS.has(name)) continue;
      if (A.loadAgent(name)) { r.kept++; continue; }
      const tools = meta.tools ? meta.tools.split(/[,\s]+/).map((t) => t.trim()).filter(Boolean) : null;
      A.saveAgent(name, { description: meta.description ?? '', ...(tools ? { tools } : {}), systemPrompt: `${body}${credit(file, 'agent')}` });
      r.added++;
    }
  }
  return out;
}

/** One language's ECC rules (plus the common ones) for this project: .ox/rules/ecc-<lang>.md. */
export function installRules(dir, lang, { cwd = process.cwd() } = {}) {
  const inv = inventory(dir);
  const l = String(lang).toLowerCase();
  if (!inv.rules.includes(l)) throw new Error(`ECC has no rules for "${lang}": ${inv.rules.filter((x) => x !== 'common').join(', ')}`);
  const read = (d) => { try { return fs.readdirSync(path.join(dir, 'rules', d)).filter((f) => f.endsWith('.md')).map((f) => `<!-- ${d}/${f} -->\n${fm(fs.readFileSync(path.join(dir, 'rules', d, f), 'utf8')).body}`); } catch { return []; } };
  const text = `# ECC rules: ${l}\n\nFrom ECC (everything-claude-code by Affaan Mustafa, MIT) at ${ECC_PIN.slice(0, 7)}. Edit or delete freely.\n\n${[...read('common'), ...read(l)].join('\n\n')}\n`;
  const file = path.join(cwd, '.ox', 'rules', `ecc-${l}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return { file, chars: text.length };
}
