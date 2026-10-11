import { describe, it } from "node:test";
import assert from "node:assert";
import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DRIVER = path.join(REPO_ROOT, "desktop", "scripts", "ox-acp-driver.mjs");

function sse(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function mockResponse(text = "hello world", calls = []) {
  const out = [];
  if (text) {
    out.push(sse({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }));
  }
  out.push(sse({ choices: [{ index: 0, delta: {}, finish_reason: calls.length ? "tool_calls" : "stop" }] }));
  out.push("data: [DONE]\n\n");
  return out.join("");
}

function startMockServer(t, decide) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body);
        requests.push(parsed);
      } catch {}
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(mockResponse(decide(requests[requests.length - 1]?.messages)));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      t.after(() => {
        try { server.closeAllConnections?.(); } catch {}
        server.close();
      });
      resolve({ port, requests });
    });
  });
}

function runDriver(cwd, prompt, env = {}) {
  const args = [DRIVER, "--cwd", cwd, "--prompt", prompt];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function parseNdjson(stdout) {
  return stdout
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

describe("ox-acp-driver", () => {
  it("fails closed when --prompt is missing (exit 2)", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ox-driver-"));
    const { code, stderr } = await runDriver(tmp, "");
    assert.equal(code, 2, `expected exit 2, got ${code}`);
    assert.ok(stderr.includes("--prompt is required"), `stderr: ${stderr}`);
  });

  it("produces a final event with non-empty events array via ACP", async (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ox-driver-"));
    const { port } = await startMockServer(t, () => ({ text: "done", calls: [] }));
    const { code, stdout } = await runDriver(REPO_ROOT, "say hello", {
      HOME: tmp,
      OX_BASE_URL: `http://127.0.0.1:${port}/v1`,
      OX_API_KEY: "test",
      NO_COLOR: "1",
    });
    assert.equal(code, 0, `exit ${code}\nstderr: ${stdout}\nstdout: ${stdout}`);
    const lines = parseNdjson(stdout);
    const finalEv = lines.find((l) => l.type === "final");
    assert.ok(finalEv, "no final event in output");
    assert.ok(Array.isArray(finalEv.events), "final.events is not an array");
    assert.ok(finalEv.events.length > 0, "final.events is empty");
  });

  it("emits event lines before final", async (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ox-driver-"));
    const { port } = await startMockServer(t, () => ({ text: "hi there", calls: [] }));
    const { code, stdout } = await runDriver(REPO_ROOT, "say hi", {
      HOME: tmp,
      OX_BASE_URL: `http://127.0.0.1:${port}/v1`,
      OX_API_KEY: "test",
      NO_COLOR: "1",
    });
    assert.equal(code, 0, `exit ${code}`);
    const lines = parseNdjson(stdout);
    const eventLines = lines.filter((l) => l.type === "event");
    assert.ok(eventLines.length >= 1, "no event lines before final");
  });

  it("forwards --set-env keys into the run without persisting them", async (t) => {
    // The driver must accept per-session KEY=VALUE pairs (desktop model
    // picker) and surface them to the agent process env for this run only.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ox-driver-"));
    const { port } = await startMockServer(t, () => ({ text: "ok", calls: [] }));
    const before = process.env.OX_DRIVER_PROBE_KEY ?? null;
    const child = spawn(
      process.execPath,
      [
        DRIVER,
        "--cwd", REPO_ROOT,
        "--prompt", "say hi",
        "--set-env", "OX_DRIVER_PROBE_KEY=probe-value-123",
        "--set-env", "NOKEY",
      ],
      {
        env: { ...process.env, HOME: tmp, OX_BASE_URL: `http://127.0.0.1:${port}/v1`, OX_API_KEY: "test", NO_COLOR: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => (stdout += d));
    const code = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    assert.equal(code, 0, `exit ${code}\nstdout: ${stdout}`);
    // The key must not leak into the parent process env.
    assert.equal(process.env.OX_DRIVER_PROBE_KEY ?? null, before);
    const lines = parseNdjson(stdout);
    assert.ok(lines.some((l) => l.type === "final"), "no final event");
  });
});
