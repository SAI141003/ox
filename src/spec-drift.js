import fs from "node:fs";
import path from "node:path";

const DECISIONS_PATH = path.join(".agent", "architecture", "decisions.json");
const ARCH_DIR = path.join(".agent", "architecture");

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } }

export function loadDecisionLog(cwd) {
  const json = readJson(path.join(cwd, DECISIONS_PATH));
  if (Array.isArray(json)) {
    return json.filter(d => d && (d.id || d.title));
  }
  const dir = path.join(cwd, ARCH_DIR);
  if (!fs.existsSync(dir)) return [];
  const decisions = [];
  for (const f of fs.readdirSync(dir).sort()) {
    if (!f.endsWith(".md")) continue;
    const text = fs.readFileSync(path.join(dir, f), "utf8");
    const m = text.match(/^##\s+Decision:\s*(.+)$/m);
    if (!m) continue;
    const fm = text.match(/^Files:\s*(.+)$/m);
    const files = fm ? fm[1].split(",").map(s => s.trim()).filter(Boolean) : [];
    const rm = text.match(/^Rationale:\s*(.+)$/m);
    decisions.push({
      id: "dec-" + f.replace(/\.md$/, ""),
      title: m[1].trim(),
      decision: m[1].trim(),
      rationale: rm ? rm[1].trim() : "",
      files,
      locked: /^\s*locked:\s*true\s*$/m.test(text),
    });
  }
  return decisions;
}

function normFiles(files) {
  return (files || []).map(f => String(f).replace(/^\.\//, ""));
}

function classify(decision, changed, diffText) {
  const decFiles = normFiles(decision.files);
  const touched = decFiles.filter(f => changed.some(c => c === f || c.endsWith("/" + f)));
  if (!touched.length) return null;
  const diff = diffText || "";
  const removed = diff.split("\n").filter(l => l.startsWith("-") && !l.startsWith("---"));
  const added = diff.split("\n").filter(l => l.startsWith("+") && !l.startsWith("+++"));
  const keywords = String(decision.decision || decision.rationale || "")
    .toLowerCase().split(/\W+/).filter(w => w.length > 4);
  const removedHits = removed.filter(l => keywords.some(k => l.toLowerCase().includes(k))).length;
  const locked = decision.locked === true;
  const deleted = touched.filter(f => !added.some(l => l.toLowerCase().includes(f.toLowerCase()))).length === 0
    && touched.some(f => !fs.existsSync(path.join(decision._cwd, f)));
  if (locked || deleted || removedHits > 0) {
    let explanation = locked
      ? "File(s) " + touched.join(", ") + " are locked by decision '" + decision.title + "'; changes are not permitted."
      : "Diff removes or contradicts decision '" + decision.title + "' (" + removedHits + " keyword line(s) removed).";
    if (deleted) explanation += " Protected file(s) deleted: " + touched.join(", ") + ".";
    return {
      id: decision.id, title: decision.title, severity: "violation",
      files: touched, explanation,
      suggestion: "Restore the decision-protected code or revise the decision log first (update .agent/architecture).",
    };
  }
  if (removed.length === 0 && added.length > 0) {
    return {
      id: decision.id, title: decision.title, severity: "info", files: touched,
      explanation: "Extension only: new lines added to files governed by decision '" + decision.title + "'.",
      suggestion: "No action needed; new code does not contradict the recorded decision.",
    };
  }
  return {
    id: decision.id, title: decision.title, severity: "warning", files: touched,
    explanation: "Decision-protected code in " + touched.join(", ") + " was modified ('" + decision.title + "').",
    suggestion: "Verify the modification still honors: " + (decision.decision || decision.title) + ".",
  };
}

export function detectSpecDrift(cwd, { changedFiles = [], diffText = "" } = {}) {
  const decisions = loadDecisionLog(cwd);
  const changed = normFiles(changedFiles);
  const drifts = [];
  for (const decision of decisions) {
    decision._cwd = cwd;
    const d = classify(decision, changed, diffText);
    if (d) drifts.push(d);
  }
  return { drifts, safe: !drifts.some(d => d.severity === "violation") };
}

export function formatDriftReport(result) {
  const icons = { info: "✓", warning: "⚠", violation: "✗" };
  const lines = [];
  lines.push("=".repeat(50));
  lines.push("SPEC DRIFT REPORT");
  lines.push("=".repeat(50));
  if (!result.drifts.length) {
    lines.push("No spec drift detected. Code is consistent with the decision log.");
  }
  for (const d of result.drifts) {
    lines.push(icons[d.severity] + " [" + d.severity.toUpperCase() + "] " + d.id + ": " + d.title);
    lines.push("    Files: " + d.files.join(", "));
    lines.push("    " + d.explanation);
    lines.push("    Suggestion: " + d.suggestion);
  }
  lines.push("-".repeat(50));
  lines.push(result.safe ? "Result: SAFE to proceed." : "Result: BLOCKED — spec violations present.");
  lines.push("=".repeat(50));
  return lines.join("\n");
}

export function assertNoViolation(driftResult, { allowOverride = false } = {}) {
  if (!driftResult.safe) {
    if (allowOverride || process.env.OX_SPEC_DRIFT_OVERRIDE === "1") {
      return { blocked: false, overridden: true, report: formatDriftReport(driftResult) };
    }
    return { blocked: true, report: formatDriftReport(driftResult) };
  }
  return { blocked: false };
}

export function createDriftGuard(cwd) {
  return {
    check(changedFiles, diffText) {
      return detectSpecDrift(cwd, { changedFiles, diffText });
    },
    format(report) {
      return formatDriftReport(report);
    },
  };
}
