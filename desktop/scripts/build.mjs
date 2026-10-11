/**
 * ox desktop prerequisite checker.
 *
 * Fails closed: every missing prerequisite is collected and reported in one
 * message, exit code 3. Exits 0 only when all checks pass.
 *
 * Injectable for testing: `checkPrereqs(opts)` accepts fake
 * `execSync`, `existsSync`, and `readFileSync` so tests never touch the
 * real filesystem or subprocess layer.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DESKTOP_ROOT = join(__dirname, "..");
const MAIN_RS = join(DESKTOP_ROOT, "src-tauri", "src", "main.rs");
const NODE_MODULES = join(DESKTOP_ROOT, "node_modules");
const EXEC_TIMEOUT_MS = 5000;

function checkCommand(execSyncImpl, cmd) {
  try {
    execSyncImpl(`${cmd} --version`, { timeout: EXEC_TIMEOUT_MS, stdio: "ignore" });
    return null;
  } catch (err) {
    if (err.killed || err.signal === "SIGTERM" || /timed out/i.test(String(err?.message ?? ""))) {
      return `${cmd} check timed out after ${EXEC_TIMEOUT_MS}ms`;
    }
    return `${cmd} not found on PATH`;
  }
}

function checkNodeModules(existsSyncImpl, nodeModulesPath) {
  if (!existsSyncImpl(nodeModulesPath)) {
    return "desktop/node_modules missing — run `npm install` in desktop/";
  }
  return null;
}

function checkMainEntry(readFileSyncImpl, mainRsPath) {
  let src;
  try {
    src = readFileSyncImpl(mainRsPath, "utf8");
  } catch (err) {
    return `cannot read ${mainRsPath}: ${err?.message ?? err}`;
  }
  if (!/\bfn\s+main\s*\(\s*\)/.test(src)) {
    return `no Rust main() entry point in ${mainRsPath} — desktop cannot build`;
  }
  return null;
}

/**
 * @param {object} opts
 * @param {Function} opts.execSync  - child_process.execSync substitute
 * @param {Function} opts.existsSync - fs.existsSync substitute
 * @param {Function} opts.readFileSync - fs.readFileSync substitute
 * @param {string} [opts.mainRsPath]  - override path for main.rs
 * @param {string} [opts.nodeModulesPath] - override path for node_modules
 * @returns {string[]} list of missing-prerequisite messages (empty = all good)
 */
export function checkPrereqs({
  execSync: execSyncImpl = execSync,
  existsSync: existsSyncImpl = existsSync,
  readFileSync: readFileSyncImpl = readFileSync,
  mainRsPath = MAIN_RS,
  nodeModulesPath = NODE_MODULES,
} = {}) {
  const problems = [];

  const cargo = checkCommand(execSyncImpl, "cargo");
  if (cargo) problems.push(cargo);

  const rustc = checkCommand(execSyncImpl, "rustc");
  if (rustc) problems.push(rustc);

  const nmPath = isAbsolute(nodeModulesPath) ? nodeModulesPath : join(DESKTOP_ROOT, nodeModulesPath);
  const nm = checkNodeModules(existsSyncImpl, nmPath);
  if (nm) problems.push(nm);

  const mainPath = isAbsolute(mainRsPath) ? mainRsPath : join(DESKTOP_ROOT, mainRsPath);
  const mainErr = checkMainEntry(readFileSyncImpl, mainPath);
  if (mainErr) problems.push(mainErr);

  return problems;
}

function main() {
  const problems = checkPrereqs();
  if (problems.length > 0) {
    console.error("ox desktop build prerequisites failed:");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(3);
  }
  console.log("ox desktop prerequisites OK (cargo, rustc, node_modules, main.rs)");
  process.exit(0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
