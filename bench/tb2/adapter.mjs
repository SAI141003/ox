import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSandbox, destroySandbox, parseNdjsonEvents } from '../harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TB2_ROOT = path.resolve(__dirname, 'tasks');

export function loadTask(taskDir) {
  const jsonPath = path.join(taskDir, 'task.json');
  const promptPath = path.join(taskDir, 'prompt');
  const testSh = path.join(taskDir, 'tests', 'test.sh');
  const testOutputSh = path.join(taskDir, 'tests', 'test_output.sh');
  const scriptPath = path.join(taskDir, 'script.mjs');

  const taskJson = fs.existsSync(jsonPath)
    ? JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
    : {};
  const prompt = fs.existsSync(promptPath)
    ? fs.readFileSync(promptPath, 'utf8').trim()
    : '';
  const tests = {
    testSh: fs.existsSync(testSh) ? fs.readFileSync(testSh, 'utf8') : null,
    testOutputSh: fs.existsSync(testOutputSh) ? fs.readFileSync(testOutputSh, 'utf8') : null,
  };
  const scriptPathExists = fs.existsSync(scriptPath);

  return {
    taskJson,
    prompt,
    tests,
    scriptPath,
    scriptPathExists,
    dir: taskDir,
  };
}

export async function tb2ToScenario(taskDir) {
  const task = loadTask(taskDir);
  const name = task.taskJson.name || path.basename(taskDir);
  const category = task.taskJson.category || 'tb2';
  const description = task.taskJson.description || '';
  const difficulty = task.taskJson.difficulty || '';

  let scriptFn = null;
  if (task.scriptPathExists) {
    const mod = await import(pathToFileURL(task.scriptPath).href);
    if (typeof mod.default === 'function') scriptFn = mod.default;
    else if (typeof mod.script === 'function') scriptFn = mod.script;
    else if (typeof mod === 'function') scriptFn = mod;
  }

  return {
    name,
    description,
    category,
    prompt: task.prompt,
    difficulty,
    tokensPerTurn: { in: 800, out: 120 },

    hasScript: !!scriptFn,

    async setup(sb) {
      const entries = fs.readdirSync(task.dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === 'tests' || entry.name === 'setup.sh' || entry.name === 'task.json' || entry.name === 'prompt' || entry.name === 'script.mjs') continue;
        const src = path.join(task.dir, entry.name);
        const dst = path.join(sb.ws, entry.name);
        if (entry.isDirectory()) {
          copyRecursive(src, dst);
        } else {
          fs.mkdirSync(path.dirname(dst), { recursive: true });
          fs.copyFileSync(src, dst);
        }
      }
      // Terminal-Bench's setup step: run in the workspace (it was copied, never run).
      const setupSh = path.join(task.dir, 'setup.sh');
      if (fs.existsSync(setupSh)) {
        const r = spawnSync('bash', [setupSh], { cwd: sb.ws, encoding: 'utf8', timeout: 60_000 });
        if (r.status !== 0) throw new Error(`setup.sh failed: ${(r.stderr || r.stdout || `exit ${r.status}`).trim().slice(0, 200)}`);
      }
    },

    async script(body, ws, state) {
      if (scriptFn) {
        return await scriptFn(body, ws, state);
      }
      const { turn } = await import('../harness.mjs');
      const lastUser = [...(body?.messages ?? [])].reverse().find((m) => m.role === 'user');
      const text = lastUser?.content || '';
      return turn({ text, usage: { in: 800, out: 120 } });
    },

    async check(r) {
      const result = await runTests({
        taskDir: task.dir,
        workspace: r.ws,
        agentOutput: r.stdout,
        exitCode: r.exitCode,
        events: r.events,
      });
      return {
        pass: result.pass,
        detail: result.detail || (result.pass ? 'tb2 tests passed' : 'tb2 tests failed'),
      };
    },

    _tb2Task: task,
  };
}

function copyRecursive(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyRecursive(s, d);
    else {
      fs.mkdirSync(path.dirname(d), { recursive: true });
      fs.copyFileSync(s, d);
    }
  }
}

export async function runTests({ taskDir, workspace, agentOutput, exitCode, events = [] }) {
  const task = loadTask(taskDir);
  const details = [];

  if (task.tests.testSh) {
    const result = await runShellScript(
      path.join(task.dir, 'tests', 'test.sh'),
      workspace,
      { TB2_WORKSPACE: workspace, TB2_EXIT_CODE: String(exitCode) }
    );
    if (!result.pass) details.push(`test.sh: ${result.detail}`);
  }

  if (task.tests.testOutputSh) {
    const outputFile = path.join(workspace, '.tb2_agent_output.txt');
    fs.writeFileSync(outputFile, agentOutput);
    const result = await runShellScript(
      path.join(task.dir, 'tests', 'test_output.sh'),
      workspace,
      { TRANSCRIPT: outputFile, TB2_AGENT_OUTPUT: outputFile, TB2_WORKSPACE: workspace, TB2_EXIT_CODE: String(exitCode) },
      [outputFile],
    );
    if (!result.pass) details.push(`test_output.sh: ${result.detail}`);
  }

  const pass = details.length === 0 && exitCode === 0;
  return {
    pass,
    detail: details.join('; ') || (pass ? 'ok' : 'failed'),
  };
}

function runShellScript(scriptPath, cwd, extraEnv, args = []) {
  return new Promise((resolve) => {
    const env = { ...process.env, ...extraEnv };
    const child = spawn('bash', [scriptPath, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      resolve({
        pass: code === 0,
        exitCode: code,
        stdout,
        stderr,
        detail: stdout.trim() || stderr.trim() || `exit ${code}`,
      });
    });
    child.on('error', (err) => {
      resolve({ pass: false, exitCode: null, stdout: '', stderr: err.message, detail: err.message });
    });
  });
}
