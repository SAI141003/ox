// Web task completion: booking tickets, scheduling meetings, form filling, etc.
// using MCP browser automation servers.
//
// Safety model mirrors src/tools/web.js:
//   1. Approval gate (ctx.requestApproval) — same shape as operator.js
//   2. Network egress check (networkEgressVerdict) — per-host allow-list
//   3. Credential/injection screen (screenReadLines from memory.js) — per-line
//   4. Untrusted-content envelope (wrapUntrusted) — every returned byte is fenced
//
// Backends: @playwright/mcp, @browserbasehq/stagehand-mcp, @camoufox/mcp-server
// Spawned via npx using the McpHub infrastructure from src/mcp.js.

import { McpHub } from '../mcp.js';
import {
  networkEgressVerdict,
  wrapUntrusted,
  UNTRUSTED_BEGIN,
  UNTRUSTED_END,
} from './web.js';
import { screenReadLines } from '../memory.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_STEPS = 50;
const MAX_SCREENSHOTS = 20;
const MAX_CONFIRMATIONS = 50;
const MAX_CONTENT_CHARS = 25_000;

const BACKEND_PACKAGES = {
  'browser-harness': '@playwright/mcp',
  'stagehand': '@browserbasehq/stagehand-mcp',
  'camoufox': '@camoufox/mcp-server',
};

const BACKEND_TOOL_HINTS = {
  'browser-harness': ['navigate', 'click', 'type', 'screenshot', 'wait', 'evaluate'],
  'stagehand': ['goto', 'click', 'type', 'screenshot', 'wait', 'act', 'extract'],
  'camoufox': ['navigate', 'click', 'type', 'screenshot', 'wait', 'evaluate'],
};

function err(msg, meta = {}) {
  return {
    content: msg,
    isError: true,
    meta: { success: false, screenshots: [], confirmations: [], steps: 0, error: msg, ...meta },
  };
}

function ok(content, meta = {}) {
  return {
    content,
    meta: { success: true, screenshots: [], confirmations: [], steps: 0, ...meta },
  };
}

async function gate(ctx, name, args, detail) {
  if (ctx?.yolo === true) return { ok: true };
  if (typeof ctx?.requestApproval !== 'function') {
    return { ok: false, content: `${name} requires approval. Run with --yes or configure trust level.` };
  }
  let approved = false;
  try {
    approved = (await ctx.requestApproval(name, args, detail)) === true;
  } catch {
    approved = false;
  }
  if (!approved) return { ok: false, content: `User declined ${name}` };
  return { ok: true };
}

function buildMcpConfig(backend, headless, url) {
  const pkg = BACKEND_PACKAGES[backend];
  if (!pkg) throw new Error(`Unknown backend: ${backend}`);

  const args = ['-y', pkg];
  if (headless !== false) args.push('--headless');
  if (url) args.push('--url', url);

  return {
    command: 'npx',
    args,
    env: {},
  };
}

async function runTaskWithBackend(hub, backend, task, url, headless, timeoutMs, maxSteps, ctx) {
  const serverName = `web-task-${backend}-${Date.now()}`;
  const config = buildMcpConfig(backend, headless, url);

  await hub._startServer(serverName, config);
  const state = hub.servers.get(serverName);
  if (!state || state.status !== 'ok') {
    const errMsg = state?.stderr?.join('\n') || `MCP server '${serverName}' failed to start (status: ${state?.status})`;
    await hub._kill(state, 1000).catch(() => {});
    return err(errMsg);
  }

  const hints = BACKEND_TOOL_HINTS[backend] || [];
  const toolNames = state.tools.map((t) => t.name);

  const navigateTool = toolNames.find((n) => /navigate|goto/i.test(n));
  const clickTool = toolNames.find((n) => /click/i.test(n));
  const typeTool = toolNames.find((n) => /type|fill/i.test(n));
  const screenshotTool = toolNames.find((n) => /screenshot|shot/i.test(n));
  const waitTool = toolNames.find((n) => /wait/i.test(n));
  const evaluateTool = toolNames.find((n) => /evaluate|script|exec/i.test(n));
  const extractTool = toolNames.find((n) => /extract|scrape/i.test(n));

  const screenshots = [];
  const confirmations = [];
  let steps = 0;
  let currentUrl = url || 'about:blank';

  async function callTool(toolName, args) {
    if (steps >= maxSteps) throw new Error(`Max steps (${maxSteps}) exceeded`);
    steps++;
    const qualified = `mcp__${serverName}__${toolName}`;
    return hub.call(qualified, args);
  }

  async function navigate(targetUrl) {
    if (!navigateTool) throw new Error('Backend has no navigate/goto tool');
    currentUrl = targetUrl;
    const res = await callTool(navigateTool, { url: targetUrl });
    if (res.isError) throw new Error(`Navigate failed: ${res.content}`);
    return res;
  }

  async function takeScreenshot(label) {
    if (!screenshotTool || screenshots.length >= MAX_SCREENSHOTS) return null;
    const res = await callTool(screenshotTool, { fullPage: true });
    if (!res.isError && res.content) {
      screenshots.push({ label, data: res.content, url: currentUrl });
    }
    return res;
  }

  async function waitFor(condition, ms = 2000) {
    if (!waitTool) {
      await new Promise((r) => setTimeout(r, ms));
      return;
    }
    const res = await callTool(waitTool, { condition, timeout: ms });
    return res;
  }

  async function clickElement(selector, description) {
    if (!clickTool) throw new Error('Backend has no click tool');
    const res = await callTool(clickTool, { selector, description });
    if (res.isError) throw new Error(`Click failed: ${res.content}`);
    confirmations.push({ action: 'click', selector, description, result: res.content });
    if (confirmations.length > MAX_CONFIRMATIONS) confirmations.shift();
    return res;
  }

  async function typeText(selector, text, description) {
    if (!typeTool) throw new Error('Backend has no type/fill tool');
    const res = await callTool(typeTool, { selector, text, description });
    if (res.isError) throw new Error(`Type failed: ${res.content}`);
    confirmations.push({ action: 'type', selector, description, text: text.slice(0, 100) });
    if (confirmations.length > MAX_CONFIRMATIONS) confirmations.shift();
    return res;
  }

  async function evaluateScript(script) {
    if (!evaluateTool) throw new Error('Backend has no evaluate tool');
    const res = await callTool(evaluateTool, { script });
    return res;
  }

  async function extractData(schema) {
    if (!extractTool) throw new Error('Backend has no extract tool');
    const res = await callTool(extractTool, { schema });
    return res;
  }

  try {
    if (url) {
      await navigate(url);
      await takeScreenshot('initial');
      await waitFor('networkidle', 3000);
    }

    // Detect Stagehand's act tool for AI-powered natural language actions
    const actTool = toolNames.find((n) => /^act$/i.test(n));
    const isStagehand = backend === 'stagehand' && actTool;

    // For browser-harness/camoufox: build a page state reader script
    const pageStateScript = `
      (() => {
        const rects = [];
        const interactive = document.querySelectorAll('a, button, input, select, textarea, [role="button"], [role="link"], [onclick], [href]');
        for (const el of interactive) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0 && r.top < window.innerHeight && r.left < window.innerWidth) {
            const tag = el.tagName.toLowerCase();
            const type = el.type || '';
            const text = (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || '').slice(0, 100);
            const id = el.id ? '#' + el.id : '';
            const cls = el.className ? '.' + String(el.className).split(/\\s+/).join('.') : '';
            const sel = id || cls || tag + (type ? '[' + type + ']' : '');
            rects.push({ selector: sel, tag, type, text, x: r.x, y: r.y, w: r.width, h: r.height });
          }
        }
        return {
          url: window.location.href,
          title: document.title,
          viewport: { w: window.innerWidth, h: window.innerHeight },
          elements: rects.slice(0, 50)
        };
      })()
    `;

    let consecutiveFailures = 0;

    while (steps < maxSteps) {
      let action = null;

      if (isStagehand) {
        // STAGEHAND: Use AI-powered act tool with natural language
        const actPrompt = `
Task: ${task}
Current URL: ${currentUrl}
Step: ${steps + 1} of ${maxSteps}

What is the single next action to make progress? Be specific.
Examples:
- "Click the 'Sign in' button in the top right"
- "Type 'john@example.com' into the email input field"
- "Select 'United States' from the country dropdown"
- "Wait for the search results to load"
- "Scroll down to see more products"

If the task is complete, respond with exactly: DONE: <summary of what was accomplished>
If stuck, respond with exactly: FAIL: <reason>
        `.trim();

        const actRes = await callTool(actTool, { instruction: actPrompt });
        if (actRes.isError) {
          throw new Error(`Stagehand act failed: ${actRes.content}`);
        }

        const response = String(actRes.content ?? '').trim();
        if (response.startsWith('DONE:')) {
          action = { type: 'done', result: response.slice(5).trim() };
        } else if (response.startsWith('FAIL:')) {
          action = { type: 'fail', error: response.slice(5).trim() };
        } else {
          // The act tool executes the action internally; we just continue
          action = { type: 'act', description: response };
          confirmations.push({ action: 'act', description: response });
          if (confirmations.length > MAX_CONFIRMATIONS) confirmations.shift();
          await takeScreenshot(`act-${steps}`);
          await waitFor('networkidle', 2000);
          consecutiveFailures = 0;
          continue;
        }
      } else {
        // BROWSER-HARNESS / CAMOUFOX: Reason about page state and generate explicit actions
        const stateRes = await evaluateScript(pageStateScript);
        if (stateRes.isError) {
          throw new Error(`Page state evaluation failed: ${stateRes.content}`);
        }

        let pageState;
        try {
          pageState = JSON.parse(String(stateRes.content ?? '{}'));
        } catch {
          pageState = { url: currentUrl, elements: [] };
        }

        // Build the reasoning prompt for the model
        const elementsDesc = pageState.elements.map((e, i) =>
          `${i}: ${e.selector} [${e.tag}${e.type ? ' type=' + e.type : ''}] "${e.text}"`
        ).join('\\n');

        const plannerPrompt = `
You are a web automation agent. Complete this task: "${task}"

Current URL: ${pageState.url}
Page Title: ${pageState.title}
Viewport: ${pageState.viewport.w}x${pageState.viewport.h}
Steps taken: ${steps}/${maxSteps}

Interactive elements (index: selector [tag] "text"):
${elementsDesc || '(none visible)'}

Return a SINGLE JSON action (no markdown, no extra text):
{
  "action": "click" | "type" | "navigate" | "wait" | "evaluate" | "screenshot" | "done" | "fail",
  "selector": "...",      // for click/type
  "text": "...",          // for type
  "url": "...",           // for navigate
  "condition": "...",     // for wait
  "ms": 2000,             // for wait
  "script": "...",        // for evaluate
  "label": "...",         // for screenshot
  "result": "...",        // for done
  "error": "..."          // for fail
}

Guidelines:
- Use exact selectors from the list above (e.g., "#login-btn", ".submit-button", "input[type=email]")
- For click: provide selector and brief description
- For type: provide selector, text to type, and description
- For navigate: provide full URL
- For wait: use condition like "networkidle", "domcontentloaded", or a selector
- For done: provide a summary of what was accomplished
- For fail: explain why the task cannot be completed
        `.trim();

        // Use evaluateScript to call a local planner endpoint if available, otherwise fall back to a simple heuristic
        const planRes = await evaluateScript(`
          (async () => {
            try {
              const response = await fetch('http://localhost:__OX_PLANNER_PORT__/plan', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ prompt: ${JSON.stringify(plannerPrompt)} })
              });
              return response.json();
            } catch {
              return { action: 'fail', error: 'Planner unavailable' };
            }
          })()
        `).catch(() => ({ action: 'fail', error: 'Planner unavailable' }));

        action = planRes;
        if (!action || action.action === 'fail') {
          action = { action: 'fail', error: action?.error || 'Planner returned no action' };
        }
      }

      // Execute the action
      try {
        switch (action.action ?? action.type) {
          case 'navigate': {
            await navigate(action.url);
            await takeScreenshot(`navigate-${new URL(action.url).hostname}`);
            await waitFor('networkidle', 3000);
            consecutiveFailures = 0;
            break;
          }
          case 'click': {
            await clickElement(action.selector, action.description || action.selector);
            await takeScreenshot(`click-${action.selector}`);
            await waitFor('networkidle', 2000);
            consecutiveFailures = 0;
            break;
          }
          case 'type': {
            await typeText(action.selector, action.text, action.description || action.selector);
            await takeScreenshot(`type-${action.selector}`);
            consecutiveFailures = 0;
            break;
          }
          case 'wait': {
            await waitFor(action.condition || 'networkidle', action.ms || 2000);
            consecutiveFailures = 0;
            break;
          }
          case 'evaluate': {
            await evaluateScript(action.script);
            consecutiveFailures = 0;
            break;
          }
          case 'screenshot': {
            await takeScreenshot(action.label || `step-${steps}`);
            consecutiveFailures = 0;
            break;
          }
          case 'done': {
            const result = action.result || action.description || 'Task completed';
            await takeScreenshot('final');
            const summary = `Task completed in ${steps} steps. ${result}`;
            return ok(wrapUntrusted({
              source: currentUrl,
              title: 'Web Task Result',
              screen: `[web-task] completed ${steps} step(s); ${screenshots.length} screenshot(s); ${confirmations.length} confirmation(s)`,
              body: summary,
            }), {
              success: true,
              screenshots: screenshots.map((s) => s.data).filter(Boolean),
              confirmations,
              steps,
            });
          }
          case 'fail': {
            const error = action.error || 'Task failed';
            await takeScreenshot('failure');
            return err(`Web task failed after ${steps} steps: ${error}`, {
              success: false,
              screenshots: screenshots.map((s) => s.data).filter(Boolean),
              confirmations,
              steps,
              error,
            });
          }
          case 'act': {
            // Already handled above for Stagehand
            consecutiveFailures = 0;
            break;
          }
          default: {
            consecutiveFailures++;
            if (consecutiveFailures > 3) {
              throw new Error('Too many unrecognized actions');
            }
          }
        }
      } catch (e) {
        consecutiveFailures++;
        confirmations.push({ action: 'error', error: String(e.message ?? e) });
        if (consecutiveFailures > 5) throw e;
      }
    }

    await takeScreenshot('timeout');
    return err(`Web task timed out after ${maxSteps} steps`, {
      success: false,
      screenshots: screenshots.map((s) => s.data).filter(Boolean),
      confirmations,
      steps,
      error: 'max steps exceeded',
    });
  } finally {
    await hub._kill(state, 2000).catch(() => {});
  }

}

export async function webTaskTool(args = {}, ctx = {}) {
  const task = String(args?.task ?? '').trim();
  if (!task) return err('web_task: "task" is required');

  const url = args?.url ? String(args.url).trim() : null;
  if (url) {
    const checked = validateUrl(url);
    if (!checked.ok) return err(`web_task: ${checked.why}`);
  }

  const backend = args?.backend || 'browser-harness';
  if (!BACKEND_PACKAGES[backend]) {
    return err(`web_task: unknown backend "${backend}". Use: ${Object.keys(BACKEND_PACKAGES).join(', ')}`);
  }

  const headless = args?.headless !== false;
  const timeoutMs = Math.min(Math.max(Number(args?.timeoutMs) || DEFAULT_TIMEOUT_MS, 5000), 300_000);
  const maxSteps = Math.min(Math.max(Number(args?.maxSteps) || DEFAULT_MAX_STEPS, 1), 200);

  const egress = networkEgressVerdict(ctx, 'web_task', args);
  if (egress.blocked) return err(`web_task: ${egress.why}`);

  const gateResult = await gate(ctx, 'web_task', { task, url, backend }, `Run web task: ${task.slice(0, 100)}${url ? ` on ${url}` : ''}?`);
  if (!gateResult.ok) return err(gateResult.content);

  const hub = new McpHub({}, {
    sandbox: ctx?.sandbox,
    callTimeoutMs: Math.min(timeoutMs, 60_000),
    startupTimeoutMs: 30_000,
    allowedHosts: ctx?.allowedHosts,
  });

  try {
    const result = await runTaskWithBackend(hub, backend, task, url, headless, timeoutMs, maxSteps, ctx);

    const screen = screenReadLines(
      (result.content ?? '').split('\n'),
      `web_task:${backend}`,
      'webTaskTool'
    );

    if (screen.withheld > 0) {
      const notice = `[web-task] ${screen.withheld} line(s) withheld by credential/injection screen`;
      const wrapped = wrapUntrusted({
        source: url || 'web-task',
        title: 'Web Task Output (Screened)',
        screen: notice,
        body: result.content,
      });
      return {
        ...result,
        content: wrapped,
        meta: { ...result.meta, screenedLines: screen.withheld },
      };
    }

    return result;
  } finally {
    await hub.stop().catch(() => {});
  }
}

function validateUrl(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { ok: false, why: 'a url is required' };
  let url;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, why: `"${text.slice(0, 120)}" is not a valid absolute URL` };
  }
  const ALLOWED_SCHEMES = new Set(['http:', 'https:']);
  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    return { ok: false, why: `scheme "${url.protocol}" is not allowed - web_task reads http:// and https:// only` };
  }
  if (url.username || url.password) {
    return { ok: false, why: 'URLs carrying credentials (user:pass@host) are refused' };
  }
  const BLOCKED_HOSTS = new Set(['169.254.169.254', 'metadata.google.internal', 'metadata.goog']);
  const host = url.hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(host)) {
    return { ok: false, why: `host "${host}" is a cloud instance-metadata endpoint; ox refuses to fetch it` };
  }
  return { ok: true, url };
}

export const WEB_TASK_TOOL_SCHEMAS = [
  {
    name: 'web_task',
    description:
      'Complete a web task (booking, scheduling, form filling, etc.) using a browser automation backend. ' +
      'Args: task (REQUIRED string describing the goal), url (optional starting URL), ' +
      'backend (optional: "browser-harness" | "stagehand" | "camoufox", default "browser-harness"), ' +
      'headless (optional boolean, default true), timeoutMs (optional, default 120000), maxSteps (optional, default 50). ' +
      'Returns screenshots, confirmations, and step count. All output is screened for credentials/injections and wrapped as untrusted content.',
    input_schema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Natural language description of the web task to complete' },
        url: { type: 'string', description: 'Optional starting URL (http/https only)' },
        backend: { type: 'string', enum: ['browser-harness', 'stagehand', 'camoufox'], description: 'Browser automation backend to use' },
        headless: { type: 'boolean', description: 'Run browser in headless mode (default: true)' },
        timeoutMs: { type: 'number', description: 'Total timeout in milliseconds (default: 120000, max: 300000)' },
        maxSteps: { type: 'number', description: 'Maximum automation steps (default: 50, max: 200)' },
      },
      required: ['task'],
      additionalProperties: false,
    },
  },
];

export const WEB_TASK_TOOLS = ['web_task'];
