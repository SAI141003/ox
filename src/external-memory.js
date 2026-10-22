// Import user-exported memories without granting ox access to another app's
// private account store. Claude's account memory export is text; Claude Code's
// local project auto-memory has its own path handled by src/import.js.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { remember } from './memory-graph.js';

const MAX_IMPORT_BYTES = 1024 * 1024;

/** Parse one-memory-per-line text such as Claude's documented memory export. */
export function parseClaudeMemoryExport(text) {
  const entries = [];
  let inCodeBlock = false;
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    let line = raw.trim();
    if (/^```/.test(line)) { inCodeBlock = !inCodeBlock; continue; }
    if (!line || /^#{1,6}\s/.test(line)) continue;
    const listed = /^(?:[-*+]\s+|\d+[.)]\s+)/.test(line);
    const hasDate = /^\[\d{4}-\d{2}-\d{2}\]\s*[-–:]/.test(line);
    if (!inCodeBlock && !listed && !hasDate) continue;
    line = line.replace(/^(?:[-*+]\s+|\d+[.)]\s+)/, '');
    const dated = /^\[(\d{4}-\d{2}-\d{2})\]\s*[-–:]\s*(.+)$/.exec(line);
    const entry = (dated ? dated[2] : line).replace(/\s+/g, ' ').trim();
    if (!entry || entry.length > 1000) continue;
    // Export prompts commonly produce bullet lists. Ignore surrounding prose,
    // but also accept plain one-entry-per-line files with no bullet markers.
    if (/^(?:instructions? I've given|personal details:|projects, goals|tools, languages|preferences and corrections|any other context|after the code block)/i.test(entry)) continue;
    entries.push({ text: entry, savedAt: dated?.[1] ?? null });
  }
  return entries;
}

/** Dry-run by default at the caller; writes only reviewed, screened memory facts. */
export function importClaudeMemoryFile(file, { dryRun = true, cwd = process.cwd(), home = os.homedir() } = {}) {
  const absolute = path.resolve(file);
  const stat = fs.statSync(absolute);
  if (!stat.isFile()) throw new Error('memory export path must be a regular file');
  if (stat.size > MAX_IMPORT_BYTES) throw new Error(`memory export exceeds ${MAX_IMPORT_BYTES / 1024} KiB`);
  const entries = parseClaudeMemoryExport(fs.readFileSync(absolute, 'utf8'));
  if (dryRun) return { dryRun: true, found: entries.length, imported: 0, refused: 0, file: absolute };
  let imported = 0;
  let refused = 0;
  const results = [];
  for (const entry of entries) {
    const ref = entry.savedAt ? Date.parse(`${entry.savedAt}T12:00:00`) : Date.now();
    const result = remember(entry.text, {
      scope: 'user', source: 'claude-account-memory-import',
      ref: Number.isFinite(ref) ? ref : Date.now(), cwd, home,
    });
    if (result.op === 'refused') refused++;
    else imported++;
    results.push({ op: result.op, reason: result.reason ?? null });
  }
  return { dryRun: false, found: entries.length, imported, refused, file: absolute, results };
}
