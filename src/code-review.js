import fs from "node:fs";
import path from "node:path";

export const CODE_REVIEW_SCHEMA_VERSION = "1.0.0";

const SUSPICIOUS_PATTERNS = [
  { name: "eval-usage", pattern: /\beval\s*\(/, severity: "high", category: "security" },
  { name: "child-process-shell", pattern: /exec\s*\(\s*['"]/, severity: "high", category: "security" },
  { name: "hardcoded-secret", pattern: /(api[_-]?key|secret|password|token)\s*=\s*['"][^'"]{8,}['"]/, severity: "high", category: "security" },
  { name: "sql-injection", pattern: /query\s*\(\s*\$\{|SELECT.*\+/, severity: "high", category: "security" },
  { name: "console-log", pattern: /console\.(log|debug)/, severity: "low", category: "style" },
  { name: "todo-comment", pattern: /TODO|FIXME|HACK/, severity: "medium", category: "maintainability" },
  { name: "long-line", pattern: /.{120,}/, severity: "low", category: "style" },
  { name: "empty-catch", pattern: /catch\s*\([^)]*\)\s*\{\s*\}/, severity: "medium", category: "bugs" },
];

export function reviewDiff(diff) {
  const findings = [];
  if (!diff) return { findings, summary: "no diff" };
  const lines = diff.split("\n");
  let currentFile = "";
  for (const line of lines) {
    if (line.startsWith("+++ b/")) {
      currentFile = line.slice(6);
    } else if (line.startsWith("--- a/")) {
      continue;
    }
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    const code = line.slice(1);
    for (const p of SUSPICIOUS_PATTERNS) {
      if (p.pattern.test(code)) {
        findings.push({
          file: currentFile,
          line: 0,
          pattern: p.name,
          severity: p.severity,
          category: p.category,
          message: "Detected " + p.name + " in " + currentFile,
          code: code.trim(),
        });
      }
    }
  }
  return { findings, summary: findings.length + " finding(s)" };
}

export function formatReviewReport(findings) {
  if (!findings || findings.length === 0) return "No findings.";
  const lines = [];
  lines.push("=".repeat(50));
  lines.push("CODE REVIEW REPORT");
  lines.push("=".repeat(50));
  for (const f of findings) {
    lines.push("[" + f.severity.toUpperCase() + "] " + f.category + " - " + f.pattern);
    lines.push("  File: " + f.file);
    lines.push("  " + f.message);
  }
  lines.push("=".repeat(50));
  return lines.join("\n");
}

export function createCodeReviewer(cwd) {
  const state = { findings: [], reviews: [] };

  function reviewCode(code, file) {
    const findings = [];
    for (const p of SUSPICIOUS_PATTERNS) {
      const lines = code.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (p.pattern.test(lines[i])) {
          findings.push({
            file: file || "unknown",
            line: i + 1,
            pattern: p.name,
            severity: p.severity,
            category: p.category,
            message: "Detected " + p.name,
            code: lines[i].trim(),
          });
        }
      }
    }
    return findings;
  }

  return {
    review(diff, context) {
      const result = reviewDiff(diff);
      const review = {
        id: "rev-" + Date.now(),
        type: "diff",
        diff: diff || "",
        context: context || "",
        findings: result.findings,
        summary: result.summary,
        timestamp: Date.now(),
      };
      state.reviews.push(review);
      state.findings.push(...result.findings);
      return review;
    },
    reviewFile(p) {
      const full = path.join(cwd, p);
      let code = "";
      try { code = fs.readFileSync(full, "utf8"); } catch { return { findings: [], file: p }; }
      const findings = reviewCode(code, p);
      const review = { id: "rev-" + Date.now(), type: "file", file: p, findings, timestamp: Date.now() };
      state.reviews.push(review);
      state.findings.push(...findings);
      return review;
    },
    reviewPatch(patch) {
      return this.review(patch, "patch");
    },
    getFindings() {
      return state.findings;
    },
    formatReview(review) {
      if (!review) return "";
      const lines = [];
      lines.push("=".repeat(50));
      lines.push("CODE REVIEW");
      lines.push("=".repeat(50));
      lines.push("Type: " + (review.type || "unknown"));
      lines.push("Summary: " + (review.summary || ""));
      lines.push("-".repeat(50));
      for (const f of (review.findings || [])) {
        lines.push("[" + f.severity.toUpperCase() + "] " + f.category + " - " + f.pattern);
        lines.push("  " + (f.file || "") + ":" + (f.line || 0));
        lines.push("  " + f.message);
      }
      lines.push("=".repeat(50));
      return lines.join("\n");
    },
    summarizeReview(review) {
      if (!review) return {};
      const counts = { high: 0, medium: 0, low: 0 };
      for (const f of (review.findings || [])) {
        counts[f.severity] = (counts[f.severity] || 0) + 1;
      }
      return { total: (review.findings || []).length, ...counts };
    },
  };
}
