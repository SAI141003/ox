// Tiered trust/permission system. Replaces binary approve/deny with five
// named levels, so the user can dial in the right amount of autonomy
// for the task at hand.
//
// Five levels (least to most permissive):
//   paranoid  — every tool call requires explicit approval
//   strict    — read-only auto-allowed; writes/network require approval
//   balanced  — read-only and project-local writes auto-allowed
//   trusted   — most things auto-allowed; only destructive ops require approval
//   yolo      — nothing requires approval
//
// Public API:
//   resolveTrustLevel({ config, env, flags })
//     → { level, source } — the effective trust level and where it came from
//
//   checkTrust({ name, args, trustLevel, ctx })
//     → { allowed, reason, requiresApproval }
//
//   saveTrustLevel(level)
//     → { saved, path }
//
//   describeTrustLevel(level)
//     → { name, description, autoAllowed, requiresApproval }

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const TRUST_LEVELS = ['paranoid', 'strict', 'balanced', 'trusted', 'yolo'];

const DESCRIPTIONS = {
  paranoid: {
    name: 'Paranoid',
    description: 'Every tool call requires explicit approval. Use for high-stakes work or unfamiliar code.',
    autoAllowed: [],
    requiresApproval: ['everything'],
  },
  strict: {
    name: 'Strict (default)',
    description: 'Read-only tools are auto-allowed. Writes, network, and shell commands require approval.',
    autoAllowed: ['read_file', 'list_dir', 'grep', 'glob', 'read_only'],
    requiresApproval: ['write_file', 'edit_file', 'bash', 'network'],
  },
  balanced: {
    name: 'Balanced',
    description: 'Read-only and project-local writes auto-allowed. External commands and deletes require approval.',
    autoAllowed: ['read_file', 'list_dir', 'grep', 'glob', 'write_file', 'edit_file'],
    requiresApproval: ['bash (external)', 'rm', 'force_push', 'network (external)'],
  },
  trusted: {
    name: 'Trusted',
    description: 'Most operations auto-allowed. Only destructive operations require approval.',
    autoAllowed: ['read_file', 'list_dir', 'grep', 'glob', 'write_file', 'edit_file', 'bash', 'network'],
    requiresApproval: ['rm -rf', 'force push', 'drop table', 'delete database'],
  },
  yolo: {
    name: 'YOLO',
    description: 'Nothing requires approval. Use at your own risk.',
    autoAllowed: ['everything'],
    requiresApproval: [],
  },
};

const DESTRUCTIVE_PATTERNS = [
  /rm\s+-rf?\s+\//,
  /rm\s+-rf?\s+~/,
  /rm\s+-rf?\s+\*/,
  /:\(\)\s*\{\s*:\|:&\s*\}\s*;\s*:/,  // fork bomb
  />\s*\/dev\/sd/,
  /mkfs/,
  /dd\s+if=/,
  /push\s+.*--force|force[_-]?push|--force\b/,
  /drop\s+(table|database|schema)/i,
  /truncate\s+table/i,
  /delete\s+from\s+\w+\s*;?\s*$/i,
];

function isDestructive(command) {
  return DESTRUCTIVE_PATTERNS.some((re) => re.test(command));
}

// Balanced trust auto-allows writes it can see as project-local. This classifier
// runs BEFORE the tool does, on the RAW argument, and the file tools now accept
// a path relative to ctx.cwd — so it has to resolve that argument the same way
// they do. Without the resolve, `src/a.js` and `/abs/cwd/src/a.js` name the
// same file but got opposite verdicts, and the relative form became a way to
// skip the approval prompt its own absolute twin still asked for.
//
// Resolution is the conservative direction: it can only move a path from
// "relative" to "absolute", and an absolute path was never auto-allowed here.
// Nothing that resolves outside the cwd, escapes with '..', or lands in a .git
// segment is project-local. The fs tools re-check the resolved path afterwards
// regardless (/\.git/ refusal, sensitive dirs, outside-workspace creation), so
// this only decides prompt-vs-silence, never what is allowed to be touched.
function isProjectLocal(args, cwd) {
  const raw = String(args?.path ?? args?.file ?? args?.file_path ?? '');
  if (!raw) return false;
  if (raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')) return false;
  const base = path.resolve(cwd);
  const rel = path.relative(base, path.resolve(base, raw));
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  if (rel.split(path.sep).some((seg) => seg.toLowerCase() === '.git')) return false;
  return true;
}

function isExternalCommand(command) {
  // Heuristic: commands that touch the network or external systems
  return /\b(curl|wget|nc|netcat|ssh|scp|rsync|ping|nmap)\b/.test(command) ||
    /\b(npm\s+install|pip\s+install|yarn\s+add|pnpm\s+add)\b/.test(command) ||
    /https?:\/\//.test(command);
}

export function resolveTrustLevel({ config = {}, env = process.env, flags = {} } = {}) {
  if (flags.yolo === true || flags.trust === 'yolo') return { level: 'yolo', source: 'flag' };
  if (flags.trust && TRUST_LEVELS.includes(flags.trust)) return { level: flags.trust, source: 'flag' };
  if (env.OX_TRUST && TRUST_LEVELS.includes(env.OX_TRUST)) return { level: env.OX_TRUST, source: 'env' };
  if (config.trust && TRUST_LEVELS.includes(config.trust)) return { level: config.trust, source: 'config' };
  if (config.yolo === true) return { level: 'yolo', source: 'config' };
  return { level: 'strict', source: 'default' };
}

const READONLY = new Set(['read_file', 'list_dir', 'grep', 'glob', 'git_status', 'git_log', 'git_diff']);

export function checkTrust({ name, args = {}, trustLevel = 'strict', ctx = {} } = {}) {
  const cwd = ctx?.cwd ?? process.cwd();

  if (trustLevel === 'yolo') {
    return { allowed: true, reason: 'yolo mode', requiresApproval: false };
  }

  if (trustLevel === 'paranoid') {
    return { allowed: false, reason: 'paranoid mode requires explicit approval', requiresApproval: true };
  }

  if (READONLY.has(name)) {
    return { allowed: true, reason: 'read-only tool', requiresApproval: false };
  }

  if (name === 'bash') {
    const command = String(args?.command ?? '');
    if (isDestructive(command)) {
      return { allowed: false, reason: 'destructive command requires approval', requiresApproval: true };
    }
    if (trustLevel === 'strict') {
      return { allowed: false, reason: 'strict mode requires approval for shell commands', requiresApproval: true };
    }
    if (trustLevel === 'balanced') {
      if (isExternalCommand(command)) {
        return { allowed: false, reason: 'balanced mode requires approval for external commands', requiresApproval: true };
      }
      return { allowed: true, reason: 'project-local shell command', requiresApproval: false };
    }
    if (trustLevel === 'trusted') {
      return { allowed: true, reason: 'trusted mode auto-allows non-destructive shell', requiresApproval: false };
    }
  }

  if (name === 'write_file' || name === 'edit_file') {
    if (trustLevel === 'strict') {
      return { allowed: false, reason: 'strict mode requires approval for writes', requiresApproval: true };
    }
    if (trustLevel === 'balanced') {
      if (isProjectLocal(args, cwd)) {
        return { allowed: true, reason: 'project-local write', requiresApproval: false };
      }
      return { allowed: false, reason: 'balanced mode requires approval for external writes', requiresApproval: true };
    }
    if (trustLevel === 'trusted') {
      return { allowed: true, reason: 'trusted mode auto-allows writes', requiresApproval: false };
    }
  }

  if (name === 'network' || name === 'fetch' || name === 'http') {
    if (trustLevel === 'trusted') {
      return { allowed: true, reason: 'trusted mode auto-allows network', requiresApproval: false };
    }
    return { allowed: false, reason: `${trustLevel} mode requires approval for network`, requiresApproval: true };
  }

  // Unknown tool: defer to approval
  return { allowed: false, reason: 'unknown tool requires approval', requiresApproval: true };
}

export function saveTrustLevel(level) {
  if (!TRUST_LEVELS.includes(level)) {
    return { saved: false, error: `invalid trust level: ${level}` };
  }
  const dir = path.join(os.homedir(), '.ox');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'config.json');
  let config = {};
  try {
    if (fs.existsSync(file)) config = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { /* ignore */ }
  config.trust = level;
  if (level === 'yolo') config.yolo = true;
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
  return { saved: true, path: file };
}

export function describeTrustLevel(level) {
  return DESCRIPTIONS[level] ?? { name: level, description: 'unknown', autoAllowed: [], requiresApproval: [] };
}
