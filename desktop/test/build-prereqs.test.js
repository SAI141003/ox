import { describe, it } from "node:test";
import assert from "node:assert";
import { checkPrereqs } from "../scripts/build.mjs";

// Fake execSync that records the command and returns ok / throws.
function fakeExecSync(outcomes) {
  const calls = [];
  const fn = (cmd, opts) => {
    calls.push(cmd);
    const outcome = outcomes[calls.length - 1];
    if (outcome === undefined || outcome === "ok") return "";
    if (outcome === "timeout") {
      const err = new Error("timed out");
      err.killed = true;
      throw err;
    }
    const err = new Error(`command not found: ${cmd}`);
    err.exitCode = 127;
    throw err;
  };
  fn.calls = calls;
  return fn;
}

function fakeExistsSync(mapping) {
  return (p) => p in mapping ? mapping[p] : false;
}

function fakeReadFileSync(mapping) {
  return (p) => {
    if (p in mapping) return mapping[p];
    const err = new Error(`no such file: ${p}`);
    err.code = "ENOENT";
    throw err;
  };
}

const MAIN_OK = "fn main() {\n    run();\n}\n";
const MAIN_NO_MAIN = "pub fn run() {\n    tauri::Builder::default()\n        .run(tauri::generate_context!())\n        .expect(\"x\");\n}\n";

describe("checkPrereqs", () => {
  it("all present → empty array", () => {
    const problems = checkPrereqs({
      execSync: fakeExecSync(["ok", "ok"]),
      existsSync: fakeExistsSync({ "/x/node_modules": true }),
      readFileSync: fakeReadFileSync({ "/x/main.rs": MAIN_OK }),
      mainRsPath: "/x/main.rs",
      nodeModulesPath: "/x/node_modules",
    });
    assert.deepStrictEqual(problems, []);
  });

  it("cargo missing → exit-3 message", () => {
    const problems = checkPrereqs({
      execSync: fakeExecSync(["nope", "ok"]),
      existsSync: fakeExistsSync({ "/x/node_modules": true }),
      readFileSync: fakeReadFileSync({ "/x/main.rs": MAIN_OK }),
      mainRsPath: "/x/main.rs",
      nodeModulesPath: "/x/node_modules",
    });
    assert.ok(problems.some((p) => /cargo not found on PATH/.test(p)), problems);
  });

  it("rustc missing → exit-3 message", () => {
    const problems = checkPrereqs({
      execSync: fakeExecSync(["ok", "nope"]),
      existsSync: fakeExistsSync({ "/x/node_modules": true }),
      readFileSync: fakeReadFileSync({ "/x/main.rs": MAIN_OK }),
      mainRsPath: "/x/main.rs",
      nodeModulesPath: "/x/node_modules",
    });
    assert.ok(problems.some((p) => /rustc not found on PATH/.test(p)), problems);
  });

  it("node_modules missing → exit-3 message", () => {
    const problems = checkPrereqs({
      execSync: fakeExecSync(["ok", "ok"]),
      existsSync: fakeExistsSync({}),
      readFileSync: fakeReadFileSync({ "/x/main.rs": MAIN_OK }),
      mainRsPath: "/x/main.rs",
      nodeModulesPath: "/x/node_modules",
    });
    assert.ok(problems.some((p) => /node_modules missing/.test(p)), problems);
  });

  it("main() absent from main.rs → exit-3 message", () => {
    const problems = checkPrereqs({
      execSync: fakeExecSync(["ok", "ok"]),
      existsSync: fakeExistsSync({ "/x/node_modules": true }),
      readFileSync: fakeReadFileSync({ "/x/main.rs": MAIN_NO_MAIN }),
      mainRsPath: "/x/main.rs",
      nodeModulesPath: "/x/node_modules",
    });
    assert.ok(problems.some((p) => /no Rust main\(\) entry point/.test(p)), problems);
  });

  it("main.rs unreadable → exit-3 message", () => {
    const problems = checkPrereqs({
      execSync: fakeExecSync(["ok", "ok"]),
      existsSync: fakeExistsSync({ "/x/node_modules": true }),
      readFileSync: fakeReadFileSync({}),
      mainRsPath: "/x/main.rs",
      nodeModulesPath: "/x/node_modules",
    });
    assert.ok(problems.some((p) => /cannot read/.test(p)), problems);
  });

  it("multiple failures are all reported together", () => {
    const problems = checkPrereqs({
      execSync: fakeExecSync(["nope", "nope"]),
      existsSync: fakeExistsSync({}),
      readFileSync: fakeReadFileSync({ "/x/main.rs": MAIN_NO_MAIN }),
      mainRsPath: "/x/main.rs",
      nodeModulesPath: "/x/node_modules",
    });
    assert.ok(problems.some((p) => /cargo/.test(p)));
    assert.ok(problems.some((p) => /rustc/.test(p)));
    assert.ok(problems.some((p) => /node_modules/.test(p)));
    assert.ok(problems.some((p) => /no Rust main\(\) entry point/.test(p)));
  });

  it("fakes are used for every path (no real subprocess/fs)", () => {
    const es = fakeExecSync(["ok", "ok"]);
    const ex = fakeExistsSync({ "/x/node_modules": true });
    const rf = fakeReadFileSync({ "/x/main.rs": MAIN_OK });
    checkPrereqs({
      execSync: es,
      existsSync: ex,
      readFileSync: rf,
      mainRsPath: "/x/main.rs",
      nodeModulesPath: "/x/node_modules",
    });
    assert.strictEqual(es.calls.length, 2);
    assert.ok(es.calls[0].startsWith("cargo"));
    assert.ok(es.calls[1].startsWith("rustc"));
  });
});
