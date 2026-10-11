import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const ARCH_MEMORY_SCHEMA_VERSION = "1.0.0";

const ARCH_DIR = ".agent/architecture";

function archDir(cwd) { return path.join(cwd, ARCH_DIR); }
function archPath(cwd) { return path.join(archDir(cwd), "architecture.json"); }
function ensureDir(cwd) { const d = archDir(cwd); if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }
function readSafe(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } }

export function queryArchitecture(arch, component) {
  if (!arch) return null;
  const comps = arch.components || [];
  return comps.find(c => c.id === component || c.name === component || (c.name || "").toLowerCase() === (component || "").toLowerCase()) || null;
}

export function exportArchitectureContext(arch, maxTokens = 4000) {
  if (!arch) return "";
  let out = JSON.stringify(arch);
  if (out.length <= maxTokens) return out;
  const slim = { components: (arch.components || []).slice(0, 50), decisions: (arch.decisions || []).slice(0, 50) };
  out = JSON.stringify(slim);
  if (out.length > maxTokens) {
    return out.slice(0, maxTokens);
  }
  return out;
}

export function createArchMemory(cwd) {
  ensureDir(cwd);

  function load() {
    return readSafe(archPath(cwd)) || { components: [], decisions: [], version: "1.0.0" };
  }

  function save(arch) {
    ensureDir(cwd);
    fs.writeFileSync(archPath(cwd), JSON.stringify(arch, null, 2), "utf8");
  }

  return {
    recordArchitecture(component, decision, rationale) {
      const arch = load();
      let comp = (arch.components || []).find(c => (c.name || "").toLowerCase() === (component || "").toLowerCase());
      if (!comp) {
        comp = { id: "comp-" + crypto.randomBytes(6).toString("hex"), name: component, decisions: [], createdAt: Date.now() };
        arch.components.push(comp);
      }
      const dec = {
        id: "dec-" + crypto.randomBytes(6).toString("hex"),
        component: component,
        decision: decision || "",
        rationale: rationale || "",
        alternatives: [],
        timestamp: Date.now(),
      };
      arch.decisions.push(dec);
      comp.decisions.push(dec.id);
      arch.updatedAt = Date.now();
      save(arch);
      return comp;
    },
    query(component) {
      return queryArchitecture(load(), component);
    },
    getDecisions(component) {
      const arch = load();
      if (component) {
        const comp = queryArchitecture(arch, component);
        if (!comp) return [];
        return (arch.decisions || []).filter(d => comp.decisions.includes(d.id));
      }
      return arch.decisions || [];
    },
    getRationale(decisionId) {
      const arch = load();
      const d = (arch.decisions || []).find(x => x.id === decisionId);
      return d ? d.rationale : null;
    },
    updateComponent(id, patch = {}) {
      const arch = load();
      const comp = (arch.components || []).find(c => c.id === id);
      if (!comp) throw new Error("Component not found: " + id);
      Object.assign(comp, patch);
      comp.updatedAt = Date.now();
      arch.updatedAt = Date.now();
      save(arch);
      return comp;
    },
    listComponents() {
      return (load().components || []).map(c => ({ id: c.id, name: c.name, decisions: c.decisions.length }));
    },
    // The raw record, for callers that need the object rather than its text --
    // exportArchitectureContext() budgets an arch object, not a JSON string.
    architecture() {
      return load();
    },
    exportArchitecture() {
      return JSON.stringify(load(), null, 2);
    },
    formatArchitecture() {
      const arch = load();
      const lines = [];
      lines.push("=".repeat(50));
      lines.push("ARCHITECTURE MEMORY");
      lines.push("=".repeat(50));
      lines.push(`Components: ${(arch.components || []).length}`);
      lines.push(`Decisions: ${(arch.decisions || []).length}`);
      lines.push("-".repeat(50));
      for (const c of (arch.components || [])) {
        lines.push(`${c.name} (${c.decisions.length} decisions)`);
      }
      lines.push("=".repeat(50));
      return lines.join("\n");
    },
  };
}
