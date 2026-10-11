import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { dispatchTool } from "./tools/index.js";
import { assertCostBudget } from "./cost.js";
import { recordDecision, recordOutcome } from "./audit.js";

export const VERIFY_SCHEMA_VERSION = "1.0.0";

function readSafe(p) {
  try { return fs.readFileSync(p, "utf8"); } catch { return null; }
}

export async function runVerificationCommand(cmd, ctx = {}, execute = dispatchTool) {
  assertCostBudget();
  const args = { command: cmd, timeout_ms: 120000 };
  let blocked = null;
  let rule = "verification-approved";
  if (typeof cmd !== "string" || !cmd.trim()) blocked = "verification command is required";
  else if (ctx.signal?.aborted) blocked = "verification aborted";
  else if (ctx.approval === "plan") blocked = "plan mode is read-only";
  else if (ctx.sandbox?.blocksTool?.("bash", args)) blocked = "sandbox denied verification";
  else if (ctx.strictApprovals || (typeof ctx.requestApproval === "function" && !ctx.yolo)) {
    let approved = ctx.yolo === true && !ctx.strictApprovals;
    try {
      approved = approved || (typeof ctx.requestApproval === "function" &&
        (await ctx.requestApproval("bash", args, cmd)) === true);
    } catch {}
    if (!approved) blocked = "verification command requires approval";
  } else rule = ctx.yolo ? "verification-yolo" : "verification-approved";
  assertCostBudget();
  if (ctx.signal?.aborted) blocked = "verification aborted";
  const ref = recordDecision({ session: ctx.sessionId, tool: "bash", args, detail: cmd,
    decision: blocked ? "deny" : "allow", rule: blocked || rule, actor: "policy" });
  let result;
  try {
    result = blocked ? { content: blocked, isError: true } : await execute("bash", args, ctx);
  } catch (error) {
    result = { content: String(error?.message ?? error), isError: true };
  }
  assertCostBudget();
  const output = String(result?.content ?? "");
  const match = output.match(/^exit (\d+)(?:\s|$)/);
  const code = match ? Number(match[1]) : null;
  const ok = result?.isError !== true && code === 0;
  recordOutcome({ ref, ok, error: ok ? undefined : output });
  return { ok, output, code };
}

export const VerificationCriteria = {
  tests: true,
  lint: true,
  build: true,
  security: true,
  deploy: false,
  custom: [],
};

export function createVerifier(cwd, { ctx = {}, execute = dispatchTool } = {}) {
  const state = { runs: [] };
  const runCmd = (cmd) => runVerificationCommand(cmd, { ...ctx, cwd }, execute);

  async function runTests() {
    const pkg = readSafe(path.join(cwd, "package.json"));
    let cmd = "npm test";
    if (pkg) {
      try {
        const j = JSON.parse(pkg);
        if (j.scripts && j.scripts.test) cmd = "npm test";
        else if (j.scripts && j.scripts["test:unit"]) cmd = "npm run test:unit";
      } catch {}
    }
    const r = await runCmd(cmd, cwd);
    return { name: "tests", passed: r.ok, output: (r.output || "").slice(-2000), exitCode: r.code };
  }

  async function runLint() {
    const pkg = readSafe(path.join(cwd, "package.json"));
    let cmd = null;
    if (pkg) {
      try {
        const j = JSON.parse(pkg);
        if (j.scripts && j.scripts.lint) cmd = "npm run lint";
        else if (j.scripts && j.scripts.eslint) cmd = "npm run eslint";
      } catch {}
    }
    if (!cmd) {
      const eslint = path.join(cwd, "node_modules", ".bin", "eslint");
      if (fs.existsSync(eslint)) cmd = "'" + eslint.replaceAll("'", "'\\''") + "' .";
    }
    if (!cmd) return { name: "lint", passed: true, output: "no linter configured", exitCode: 0 };
    const r = await runCmd(cmd, cwd);
    return { name: "lint", passed: r.ok, output: (r.output || "").slice(-2000), exitCode: r.code };
  }

  async function runBuild() {
    const pkg = readSafe(path.join(cwd, "package.json"));
    let cmd = null;
    if (pkg) {
      try {
        const j = JSON.parse(pkg);
        if (j.scripts && j.scripts.build) cmd = "npm run build";
      } catch {}
    }
    if (!cmd) return { name: "build", passed: true, output: "no build script", exitCode: 0 };
    const r = await runCmd(cmd, cwd);
    return { name: "build", passed: r.ok, output: (r.output || "").slice(-2000), exitCode: r.code };
  }

  async function runSecurity() {
    const pkg = readSafe(path.join(cwd, "package.json"));
    let cmd = null;
    if (pkg) {
      try {
        const j = JSON.parse(pkg);
        if (j.scripts && j.scripts.audit) cmd = "npm audit --json";
      } catch {}
    }
    if (!cmd) return { name: "security", passed: true, output: "no audit configured", exitCode: 0 };
    const r = await runCmd(cmd, cwd);
    let passed = r.ok;
    if (r.ok) {
      try {
        const audit = JSON.parse(r.output);
        const total = audit.vulnerabilities ? JSON.stringify(audit.vulnerabilities).length : 0;
        passed = total === 0 || (audit.metadata && audit.metadata.vulnerabilities && audit.metadata.vulnerabilities.total === 0);
      } catch {}
    }
    return { name: "security", passed, output: (r.output || "").slice(-2000), exitCode: r.code };
  }

  async function runDeploy() {
    const pkg = readSafe(path.join(cwd, "package.json"));
    let cmd = null;
    if (pkg) {
      try {
        const j = JSON.parse(pkg);
        if (j.scripts && j.scripts.deploy) cmd = "npm run deploy";
      } catch {}
    }
    if (!cmd) return { name: "deploy", passed: true, output: "no deploy script", exitCode: 0 };
    const r = await runCmd(cmd, cwd);
    return { name: "deploy", passed: r.ok, output: (r.output || "").slice(-2000), exitCode: r.code };
  }

  function buildReport(task, result, checks) {
    return {
      id: crypto.randomBytes(8).toString("hex"),
      task: task || "",
      result: result || "",
      timestamp: Date.now(),
      checks,
      passed: checks.every(function(c) { return c.passed; }),
      summary: checks.map(function(c) { return (c.passed ? "PASS" : "FAIL") + " " + c.name; }).join("\n"),
    };
  }

  return {
    async verify(task, result, criteria) {
      criteria = Object.assign({}, VerificationCriteria, criteria || {});
      const checks = [];
      if (criteria.tests) checks.push(await runTests());
      if (criteria.lint) checks.push(await runLint());
      if (criteria.build) checks.push(await runBuild());
      if (criteria.security) checks.push(await runSecurity());
      if (criteria.deploy) checks.push(await runDeploy());
      for (const c of criteria.custom || []) {
        const r = await runCmd(c.cmd, cwd);
        checks.push({ name: c.name || c.cmd, passed: r.ok, output: (r.output || "").slice(-2000), exitCode: r.code });
      }
      const report = buildReport(task, result, checks);
      state.runs.push(report);
      return report;
    },
    verifyTests() { return runTests(); },
    verifyLint() { return runLint(); },
    verifyBuild() { return runBuild(); },
    verifySecurity() { return runSecurity(); },
    verifyDeploy() { return runDeploy(); },
    getReport() { return state.runs; },
    formatReport(report) {
      return formatVerificationReport(report);
    },
  };
}

export function formatVerificationReport(report) {
  if (!report) return "";
  const lines = [];
  lines.push("=".repeat(50));
  lines.push("VERIFICATION REPORT");
  lines.push("=".repeat(50));
  lines.push("Task: " + (report.task || ""));
  lines.push("Result: " + (report.result || ""));
  lines.push("Time: " + new Date(report.timestamp).toISOString());
  lines.push("Passed: " + (report.passed ? "YES" : "NO"));
  lines.push("-".repeat(50));
  for (const c of report.checks || []) {
    lines.push((c.passed ? "[PASS]" : "[FAIL]") + " " + c.name + " (exit " + (c.exitCode || 0) + ")");
    if (!c.passed && c.output) {
      lines.push(c.output.split("\n").slice(-5).map(function(l) { return "  " + l; }).join("\n"));
    }
  }
  lines.push("=".repeat(50));
  return lines.join("\n");
}
