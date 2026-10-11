import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const SPEC_TRACKER_SCHEMA_VERSION = "1.0.0";

const SPEC_DIR = ".agent/specs";

function specDir(cwd) { return path.join(cwd, SPEC_DIR); }
function specPath(cwd, id) { return path.join(specDir(cwd), id + ".json"); }
function ensureDir(cwd) { const d = specDir(cwd); if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }
function readSafe(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } }

export function reconcileSpec(spec) {
  if (!spec) return "missing";
  const reqs = Array.isArray(spec.requirements) ? spec.requirements : [];
  const artifacts = spec.artifacts || [];
  const resolved = reqs.filter(function(r) { return r.resolved; }).length;
  const total = reqs.length;
  if (spec.deprecated) return "deprecated";
  if (total === 0 && artifacts.length === 0) return "missing";
  if (resolved === total && artifacts.length > 0) return "complete";
  if (resolved > 0 || artifacts.length > 0) return "partial";
  return "missing";
}

export function formatSpecReport(spec) {
  if (!spec) return "";
  const status = reconcileSpec(spec);
  const lines = [];
  lines.push("=".repeat(50));
  lines.push("SPEC REPORT");
  lines.push("=".repeat(50));
  lines.push("ID: " + (spec.id || ""));
  lines.push("Title: " + (spec.title || "Untitled"));
  lines.push("Status: " + status);
  lines.push("Created: " + new Date(spec.createdAt).toISOString());
  lines.push("Updated: " + new Date(spec.updatedAt).toISOString());
  lines.push("-".repeat(50));
  lines.push("Requirements:");
  for (const r of (spec.requirements || [])) {
    lines.push("  [" + (r.resolved ? "x" : " ") + "] " + (r.id || "") + " " + (r.text || ""));
  }
  lines.push("Artifacts:");
  for (const a of (spec.artifacts || [])) {
    lines.push("  - " + (a.type || "file") + ": " + (a.path || a.name || ""));
  }
  lines.push("=".repeat(50));
  return lines.join("\n");
}

export function createSpecTracker(cwd) {
  ensureDir(cwd);

  function save(spec) {
    ensureDir(cwd);
    fs.writeFileSync(specPath(cwd, spec.id), JSON.stringify(spec, null, 2), "utf8");
  }

  function newReq(r) {
    if (typeof r === "string") return { id: "req-" + crypto.randomBytes(4).toString("hex"), text: r, resolved: false };
    return { id: r.id || "req-" + crypto.randomBytes(4).toString("hex"), text: r.text || "", resolved: !!r.resolved };
  }

  return {
    createSpec(title, requirements) {
      requirements = requirements || [];
      const spec = {
        id: "spec-" + crypto.randomBytes(6).toString("hex"),
        title: title || "Untitled",
        requirements: requirements.map(newReq),
        artifacts: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      save(spec);
      return spec;
    },
    addRequirement(specId, req) {
      const spec = this.getSpec(specId);
      if (!spec) throw new Error("Spec not found: " + specId);
      spec.requirements.push(newReq(req));
      spec.updatedAt = Date.now();
      save(spec);
      return spec;
    },
    updateSpec(specId, patch) {
      patch = patch || {};
      const spec = this.getSpec(specId);
      if (!spec) throw new Error("Spec not found: " + specId);
      Object.assign(spec, patch);
      spec.updatedAt = Date.now();
      save(spec);
      return spec;
    },
    getSpec(id) {
      return readSafe(specPath(cwd, id));
    },
    listSpecs() {
      const d = specDir(cwd);
      if (!fs.existsSync(d)) return [];
      return fs.readdirSync(d).filter(function(f) { return f.endsWith(".json"); }).map(function(f) { return f.slice(0, -5); });
    },
    linkArtifact(specId, artifact) {
      artifact = artifact || {};
      const spec = this.getSpec(specId);
      if (!spec) throw new Error("Spec not found: " + specId);
      spec.artifacts.push({ id: "art-" + crypto.randomBytes(4).toString("hex"), type: artifact.type || "file", path: artifact.path || artifact.name || "", name: artifact.name || "" });
      spec.updatedAt = Date.now();
      save(spec);
      return spec;
    },
    getArtifact(specId) {
      const spec = this.getSpec(specId);
      return spec ? spec.artifacts || [] : [];
    },
    reconcile(specId) {
      const spec = this.getSpec(specId);
      return spec ? reconcileSpec(spec) : "missing";
    },
    exportSpec(id) {
      const spec = this.getSpec(id);
      return spec ? JSON.stringify(spec, null, 2) : null;
    },
    formatSpec(spec) {
      return formatSpecReport(spec);
    },
  };
}
