import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const TEAM_WORKFLOWS_SCHEMA_VERSION = "1.0.0";

const WORKFLOW_DIR = ".agent/workflows";

function wfDir(cwd) { return path.join(cwd, WORKFLOW_DIR); }
function wfPath(cwd, id) { return path.join(wfDir(cwd), id + ".json"); }
function ensureDir(cwd) { const d = wfDir(cwd); if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }
function readSafe(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } }

export function formatWorkflowStatus(status) {
  if (!status) return "";
  const lines = [];
  lines.push("=".repeat(50));
  lines.push("WORKFLOW STATUS");
  lines.push("=".repeat(50));
  lines.push("Workflow: " + (status.name || status.id || "unknown"));
  lines.push("Status: " + (status.status || "unknown"));
  lines.push("Steps: " + (status.steps || 0));
  lines.push("Completed: " + (status.completed || 0));
  lines.push("Failed: " + (status.failed || 0));
  lines.push("-".repeat(50));
  for (const s of (status.stepDetails || [])) {
    lines.push("  [" + (s.done ? "x" : " ") + "] " + s.name + " (" + (s.status || "pending") + ")");
  }
  lines.push("=".repeat(50));
  return lines.join("\n");
}

export function runWorkflow(manager, name, input) {
  const wf = manager.getWorkflow(name);
  if (!wf) throw new Error("Workflow not found: " + name);
  const steps = wf.steps || [];
  const results = [];
  let failed = 0;
  for (const step of steps) {
    try {
      const out = manager.executeStep(step, input);
      results.push({ step: step.name, status: "done", output: out });
    } catch (e) {
      results.push({ step: step.name, status: "failed", error: e.message });
      failed++;
    }
  }
  return { workflow: name, steps: steps.length, completed: results.length - failed, failed, results };
}

export function createTeamWorkflows(cwd) {
  ensureDir(cwd);
  const state = { workflows: new Map() };

  function save(wf) {
    ensureDir(cwd);
    fs.writeFileSync(wfPath(cwd, wf.id), JSON.stringify(wf, null, 2), "utf8");
  }

  function loadAll() {
    const d = wfDir(cwd);
    if (!fs.existsSync(d)) return [];
    return fs.readdirSync(d).filter(f => f.endsWith(".json")).map(f => readSafe(path.join(d, f))).filter(Boolean);
  }

  return {
    defineWorkflow(name, steps = []) {
      const wf = {
        id: "wf-" + crypto.randomBytes(6).toString("hex"),
        name: name || "Untitled",
        steps: steps.map(s => typeof s === "string" ? { id: "step-" + crypto.randomBytes(4).toString("hex"), name: s, type: "command", cmd: s } : { id: "step-" + crypto.randomBytes(4).toString("hex"), ...s }),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      save(wf);
      state.workflows.set(wf.id, wf);
      return wf;
    },
    runWorkflow(name, input) {
      return runWorkflow(this, name, input);
    },
    getWorkflow(name) {
      if (state.workflows.has(name)) return state.workflows.get(name);
      const all = loadAll();
      const found = all.find(w => w.id === name || w.name === name);
      if (found) state.workflows.set(found.id, found);
      return found || null;
    },
    listWorkflows() {
      const all = loadAll();
      for (const w of all) state.workflows.set(w.id, w);
      return all.map(w => ({ id: w.id, name: w.name, steps: (w.steps || []).length }));
    },
    addStep(workflowId, step) {
      const wf = this.getWorkflow(workflowId);
      if (!wf) throw new Error("Workflow not found: " + workflowId);
      wf.steps.push({ id: "step-" + crypto.randomBytes(4).toString("hex"), ...step });
      wf.updatedAt = Date.now();
      save(wf);
      return wf;
    },
    executeStep(step, input) {
      if (!step) throw new Error("No step");
      if (step.type === "command" || step.cmd) {
        return { step: step.name, output: "executed: " + (step.cmd || step.name), input };
      }
      if (step.type === "transform") {
        const fn = step.fn || ((x) => x);
        return { step: step.name, output: fn(input), input };
      }
      return { step: step.name, output: input, input };
    },
    getWorkflowStatus(workflowId) {
      const wf = this.getWorkflow(workflowId);
      if (!wf) throw new Error("Workflow not found: " + workflowId);
      const stepDetails = (wf.steps || []).map(s => ({ name: s.name, status: "pending", done: false }));
      return { id: wf.id, name: wf.name, status: "defined", steps: (wf.steps || []).length, completed: 0, failed: 0, stepDetails };
    },
    formatWorkflow(workflow) {
      if (!workflow) return "";
      const lines = [];
      lines.push("=".repeat(50));
      lines.push("WORKFLOW: " + (workflow.name || "Untitled"));
      lines.push("=".repeat(50));
      lines.push("ID: " + workflow.id);
      lines.push("Steps: " + (workflow.steps || []).length);
      lines.push("-".repeat(50));
      for (const s of (workflow.steps || [])) {
        lines.push("  - " + s.name + " (" + (s.type || "command") + ")");
      }
      lines.push("=".repeat(50));
      return lines.join("\n");
    },
  };
}
