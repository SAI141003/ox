// What a repository's own files may do on this machine. A clone's .mcp.json and hooks
// are its author's commands, so neither runs until you say so, for those exact contents
// in that folder. A change asks again. The same class of hole produced CVEs in other
// agents (repository config gaining authority before consent).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const trustFile = () => path.join(process.env.OX_HOME || path.join(os.homedir(), '.ox'), 'trusted-hooks.json');
const digestOf = (file) => { try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return null; } };
const read = () => { try { return JSON.parse(fs.readFileSync(trustFile(), 'utf8')) ?? {}; } catch { return {}; } };
const warned = new Set();

export function projectFileTrusted(cwd, rel) {
  // For ox's own test runs only. A repository cannot set a variable in your environment.
  if (process.env.OX_TRUST_PROJECT_FILES === '1') return true;
  const file = path.resolve(cwd, rel);
  const digest = digestOf(file);
  return !!digest && read()[file] === digest;
}

export function trustProjectFile(cwd, rel) {
  const file = path.resolve(cwd, rel);
  const digest = digestOf(file);
  if (!digest) throw new Error(`no ${rel} in ${cwd}`);
  const doc = read();
  doc[file] = digest;
  fs.mkdirSync(path.dirname(trustFile()), { recursive: true });
  fs.writeFileSync(trustFile(), JSON.stringify(doc, null, 2), { mode: 0o600 });
  return digest;
}

/** Say once per run what was held back and how to allow it. */
export function warnUntrusted(cwd, rel, what, how) {
  const file = path.resolve(cwd, rel);
  if (warned.has(file) || !fs.existsSync(file)) return;
  warned.add(file);
  process.stderr.write(`ox: not using ${file}: ${what}. Read it, then: ${how}\n`);
}
