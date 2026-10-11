import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadDecisionLog, detectSpecDrift, assertNoViolation, formatDriftReport, createDriftGuard } from "../src/spec-drift.js";

function makeTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ox-drift-"));
}

function setup(cwd) {
  const dir = path.join(cwd, ".agent", "architecture");
  fs.mkdirSync(dir, { recursive: true });
  const decisions = [
    { id: "dec-1", title: "Use HTTP client X", decision: "always use client X for network calls", rationale: "retries built in", files: ["src/net.js"], createdAt: 1 },
    { id: "dec-2", title: "Config schema locked", decision: "config schema is frozen", rationale: "stability", files: ["src/config.js"], locked: true, createdAt: 2 },
  ];
  fs.writeFileSync(path.join(dir, "decisions.json"), JSON.stringify(decisions));
  fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "src", "net.js"), "export function net() { return clientX(); }\n");
  fs.writeFileSync(path.join(cwd, "src", "config.js"), "export const schema = { a: 1 };\n");
}

test("decision log reader", () => {
  const cwd = makeTmp();
  setup(cwd);
  assert.equal(loadDecisionLog(cwd).length, 2);
  assert.deepEqual(loadDecisionLog(makeTmp()), []);
});

test("unchanged files are safe", () => {
  const cwd = makeTmp();
  setup(cwd);
  const r = detectSpecDrift(cwd, { changedFiles: ["src/other.js"], diffText: "+new stuff" });
  assert.equal(r.safe, true);
  assert.deepEqual(r.drifts, []);
});

test("extension change is info and safe", () => {
  const cwd = makeTmp();
  setup(cwd);
  const r = detectSpecDrift(cwd, { changedFiles: ["src/net.js"], diffText: "+function helper() {}\n" });
  assert.equal(r.safe, true);
  assert.equal(r.drifts[0].severity, "info");
});

test("modification of locked file is violation and blocked", () => {
  const cwd = makeTmp();
  setup(cwd);
  const r = detectSpecDrift(cwd, { changedFiles: ["src/config.js"], diffText: "-export const schema = { a: 1 };\n+export const schema = { a: 2 };\n" });
  assert.equal(r.safe, false);
  assert.equal(r.drifts[0].severity, "violation");
  const g = assertNoViolation(r);
  assert.equal(g.blocked, true);
  assert.match(g.report, /BLOCKED/);
});

test("override env allows through", () => {
  const cwd = makeTmp();
  setup(cwd);
  const r = detectSpecDrift(cwd, { changedFiles: ["src/config.js"], diffText: "-export const schema = { a: 1 };\n" });
  process.env.OX_SPEC_DRIFT_OVERRIDE = "1";
  const g = assertNoViolation(r);
  delete process.env.OX_SPEC_DRIFT_OVERRIDE;
  assert.equal(g.blocked, false);
  assert.equal(g.overridden, true);
});

test("format produces readable output", () => {
  const cwd = makeTmp();
  setup(cwd);
  const guard = createDriftGuard(cwd);
  const report = guard.check(["src/config.js"], "-export const schema = { a: 1 };\n");
  const out = guard.format(report);
  assert.match(out, /SPEC DRIFT REPORT/);
  assert.match(out, /config\.js/);
});
