import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const REGRESSION_GUARD_SCHEMA_VERSION = "1.0.0";

const BASELINE_DIR = ".agent/baselines";

function baseDir(cwd) { return path.join(cwd, BASELINE_DIR); }
function baselinePath(cwd, name) { return path.join(baseDir(cwd), name + ".json"); }
function ensureDir(cwd) { const d = baseDir(cwd); if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }
function readSafe(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } }

export function detectRegressions(current, baseline) {
  const cur = current || {};
  const base = baseline || {};
  const curKeys = new Set(Object.keys(cur));
  const baseKeys = new Set(Object.keys(base));
  const added = [];
  const removed = [];
  const changed = [];
  const unchanged = [];
  for (const k of curKeys) {
    if (!baseKeys.has(k)) {
      added.push(k);
    } else if (cur[k] !== base[k]) {
      changed.push(k);
    } else {
      unchanged.push(k);
    }
  }
  for (const k of baseKeys) {
    if (!curKeys.has(k)) removed.push(k);
  }
  return { added, removed, changed, unchanged };
}

export function formatRegressionReport(report) {
  if (!report) return "";
  const lines = [];
  lines.push("=".repeat(50));
  lines.push("REGRESSION REPORT");
  lines.push("=".repeat(50));
  lines.push("Baseline: " + (report.baseline || "none"));
  lines.push("Current: " + (report.current || "none"));
  lines.push("-".repeat(50));
  lines.push("Added: " + (report.added || []).length);
  lines.push("Removed: " + (report.removed || []).length);
  lines.push("Changed: " + (report.changed || []).length);
  lines.push("Unchanged: " + (report.unchanged || []).length);
  lines.push("Regressions: " + (report.regressions || []).length);
  lines.push("=".repeat(50));
  return lines.join("\n");
}

export function createRegressionGuard(cwd) {
  ensureDir(cwd);

  function hashContent(content) {
    return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
  }

  function snapshotFiles(files) {
    const snaps = {};
    for (const f of files || []) {
      const full = path.join(cwd, f);
      try {
        snaps[f] = fs.readFileSync(full, "utf8");
      } catch {}
    }
    return snaps;
  }

  function loadSnapshot(id) {
    return readSafe(path.join(baseDir(cwd), id + ".snap.json")) || {};
  }

  function saveSnapshot(id, snaps) {
    ensureDir(cwd);
    fs.writeFileSync(path.join(baseDir(cwd), id + ".snap.json"), JSON.stringify(snaps), "utf8");
  }

  return {
    snapshot(label) {
      const id = "snap-" + crypto.randomBytes(6).toString("hex");
      const snaps = {};
      return { id, snaps, label: label || id, timestamp: Date.now() };
    },
    restore(label) {
      const snaps = loadSnapshot(label);
      return snaps;
    },
    diffSnapshots(labelA, labelB) {
      const a = loadSnapshot(labelA);
      const b = loadSnapshot(labelB);
      return detectRegressions(b, a);
    },
    detectRegressions(current, baseline) {
      return detectRegressions(current, baseline);
    },
    listSnapshots() {
      const d = baseDir(cwd);
      if (!fs.existsSync(d)) return [];
      return fs.readdirSync(d).filter(f => f.endsWith(".snap.json")).map(f => f.slice(0, -".snap.json".length));
    },
    saveBaseline(name, files) {
      ensureDir(cwd);
      const snaps = snapshotFiles(files);
      fs.writeFileSync(baselinePath(cwd, name), JSON.stringify({ name, files, snaps, savedAt: Date.now() }, null, 2), "utf8");
      return { name, files, savedAt: Date.now() };
    },
    checkBaseline(name, currentFiles) {
      const base = readSafe(baselinePath(cwd, name));
      if (!base) throw new Error("Baseline not found: " + name);
      const cur = snapshotFiles(currentFiles);
      const reg = detectRegressions(cur, base.snaps);
      return { baseline: name, current: cur, ...reg, report: formatRegressionReport({ baseline: name, ...reg }) };
    },
    formatRegressionReport(report) {
      return formatRegressionReport(report);
    },
  };
}
