import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const CHECKPOINT_DIR = '.agent/checkpoints';
const MANIFEST_FILE = 'checkpoints.jsonl';

function getCheckpointPath(cwd) {
  return path.join(cwd, CHECKPOINT_DIR);
}

function getManifestPath(cwd) {
  return path.join(getCheckpointPath(cwd), MANIFEST_FILE);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function readFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function writeFileSafe(filePath, content) {
  const dir = path.dirname(filePath);
  ensureDir(dir);
  fs.writeFileSync(filePath, content, 'utf8');
}

function hashContent(content) {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

function snapshotFiles(cwd, files) {
  const snapshots = {};
  for (const file of files) {
    const fullPath = path.join(cwd, file);
    const content = readFileSafe(fullPath);
    if (content !== null) {
      snapshots[file] = content;
    }
  }
  return snapshots;
}

function saveSnapshot(cwd, id, snapshots) {
  const snapshotDir = path.join(getCheckpointPath(cwd), id);
  ensureDir(snapshotDir);
  for (const [file, content] of Object.entries(snapshots)) {
    const filePath = path.join(snapshotDir, file);
    writeFileSafe(filePath, content);
  }
}

function loadSnapshot(cwd, id) {
  const snapshotDir = path.join(getCheckpointPath(cwd), id);
  if (!fs.existsSync(snapshotDir)) return {};
  const snapshots = {};
  function walk(dir, base = '') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.join(base, entry.name);
      if (entry.isDirectory()) {
        walk(full, rel);
      } else {
        snapshots[rel] = fs.readFileSync(full, 'utf8');
      }
    }
  }
  walk(snapshotDir);
  return snapshots;
}

function appendManifest(cwd, entry) {
  ensureDir(getCheckpointPath(cwd));
  fs.appendFileSync(getManifestPath(cwd), JSON.stringify(entry) + '\n', 'utf8');
}

function readManifest(cwd) {
  const manifestPath = getManifestPath(cwd);
  if (!fs.existsSync(manifestPath)) return [];
  const content = fs.readFileSync(manifestPath, 'utf8');
  return content.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function writeManifest(cwd, entries) {
  ensureDir(getCheckpointPath(cwd));
  fs.writeFileSync(getManifestPath(cwd), entries.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function getSnapshotSize(cwd, id) {
  const snapshotDir = path.join(getCheckpointPath(cwd), id);
  if (!fs.existsSync(snapshotDir)) return 0;
  let size = 0;
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        size += fs.statSync(full).size;
      }
    }
  }
  walk(snapshotDir);
  return size;
}

export function takeCheckpoint({ cwd, turn = '', files = [] }) {
  const timestamp = new Date().toISOString();
  const id = `${timestamp.replace(/[:.]/g, '-')}-${crypto.randomBytes(4).toString('hex')}`;
  const snapshots = snapshotFiles(cwd, files);
  const fileCount = Object.keys(snapshots).length;
  saveSnapshot(cwd, id, snapshots);
  const entry = {
    id,
    timestamp,
    turn,
    fileCount,
    files: Object.keys(snapshots),
    hashes: Object.fromEntries(Object.entries(snapshots).map(([f, c]) => [f, hashContent(c)]))
  };
  appendManifest(cwd, entry);
  return { id, timestamp, turn, files: Object.keys(snapshots) };
}

export function listCheckpoints({ cwd }) {
  const entries = readManifest(cwd);
  return entries.map(e => ({
    id: e.id,
    timestamp: e.timestamp,
    turn: e.turn,
    fileCount: e.fileCount,
    size: formatSize(getSnapshotSize(cwd, e.id))
  }));
}

function restoreSnapshot(cwd, snapshots) {
  const restored = [];
  const removed = [];
  const added = [];
  for (const [file, content] of Object.entries(snapshots)) {
    const fullPath = path.join(cwd, file);
    const existed = fs.existsSync(fullPath);
    if (existed) {
      const current = readFileSafe(fullPath);
      if (current !== content) {
        writeFileSafe(fullPath, content);
        restored.push(file);
      }
    } else {
      writeFileSafe(fullPath, content);
      added.push(file);
    }
  }
  const currentFiles = new Set(Object.keys(snapshots));
  function walk(dir, base = '') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.join(base, entry.name);
      if (entry.isDirectory()) {
        walk(full, rel);
      } else if (!currentFiles.has(rel)) {
        fs.unlinkSync(full);
        removed.push(rel);
      }
    }
  }
  const snapshotDir = path.join(getCheckpointPath(cwd), Object.keys(snapshots)[0]?.split(path.sep)[0] || '');
  return { restored, removed, added };
}

async function applyCheckpoint(cwd, targetId) {
  const snapshots = loadSnapshot(cwd, targetId);
  return restoreSnapshot(cwd, snapshots);
}

export async function undoCheckpoint({ cwd, target = 'last' }) {
  const entries = readManifest(cwd);
  if (entries.length < 2) {
    throw new Error('Not enough checkpoints to undo');
  }
  let targetEntry;
  if (target === 'last') {
    targetEntry = entries[entries.length - 2];
  } else {
    targetEntry = entries.find(e => e.id === target || e.turn === target);
    if (!targetEntry) throw new Error(`Checkpoint not found: ${target}`);
  }
  return applyCheckpoint(cwd, targetEntry.id);
}

export async function rewindCheckpoint({ cwd, target }) {
  const entries = readManifest(cwd);
  const targetEntry = entries.find(e => e.id === target || e.turn === target);
  if (!targetEntry) throw new Error(`Checkpoint not found: ${target}`);
  return applyCheckpoint(cwd, targetEntry.id);
}

export function diffCheckpoints({ cwd, from, to }) {
  const entries = readManifest(cwd);
  const fromEntry = entries.find(e => e.id === from || e.turn === from);
  const toEntry = entries.find(e => e.id === to || e.turn === to);
  if (!fromEntry || !toEntry) throw new Error('Checkpoint not found');
  const fromSnap = loadSnapshot(cwd, fromEntry.id);
  const toSnap = loadSnapshot(cwd, toEntry.id);
  const allFiles = new Set([...Object.keys(fromSnap), ...Object.keys(toSnap)]);
  let diff = '';
  for (const file of [...allFiles].sort()) {
    const fromContent = fromSnap[file] || '';
    const toContent = toSnap[file] || '';
    if (fromContent !== toContent) {
      diff += `--- a/${file}\n+++ b/${file}\n`;
      const fromLines = fromContent.split('\n');
      const toLines = toContent.split('\n');
      const maxLines = Math.max(fromLines.length, toLines.length);
      for (let i = 0; i < maxLines; i++) {
        const f = fromLines[i];
        const t = toLines[i];
        if (f !== t) {
          if (f !== undefined) diff += `-${f}\n`;
          if (t !== undefined) diff += `+${t}\n`;
        }
      }
      diff += '\n';
    }
  }
  return diff || 'No differences';
}

export function pruneCheckpoints({ cwd, keep = 10 }) {
  const entries = readManifest(cwd);
  if (entries.length <= keep) return { pruned: 0 };
  const toPrune = entries.slice(0, entries.length - keep);
  let pruned = 0;
  for (const entry of toPrune) {
    const snapshotDir = path.join(getCheckpointPath(cwd), entry.id);
    if (fs.existsSync(snapshotDir)) {
      fs.rmSync(snapshotDir, { recursive: true, force: true });
      pruned++;
    }
  }
  writeManifest(cwd, entries.slice(entries.length - keep));
  return { pruned };
}
