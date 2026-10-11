import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CLICKY_SCHEMA_VERSION = '1.0.0';
export const CLICKY_MODES = { GUIDE: 'guide', ASSIST: 'assist', AUTOPILOT: 'autopilot' };

const CLICKY_DIR = path.join(os.homedir(), '.ox', 'clicky');
const FLOWS_FILE = path.join(CLICKY_DIR, 'flows.json');

function ensureDir() {
  fs.mkdirSync(CLICKY_DIR, { recursive: true });
}

function loadFlows() {
  try {
    if (!fs.existsSync(FLOWS_FILE)) return {};
    return JSON.parse(fs.readFileSync(FLOWS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveFlows(flows) {
  ensureDir();
  fs.writeFileSync(FLOWS_FILE, JSON.stringify(flows, null, 2));
}

function semanticMatch(question) {
  const q = question.toLowerCase();
  const patterns = [
    { re: /button|btn/i, selector: 'button, [role="button"], .btn, [type="submit"]', label: 'button' },
    { re: /input|field|form/i, selector: 'input, textarea, [contenteditable]', label: 'input field' },
    { re: /link|href/i, selector: 'a[href]', label: 'link' },
    { re: /nav|menu/i, selector: 'nav, [role="navigation"], .menu, [class*="nav"]', label: 'navigation' },
    { re: /modal|dialog/i, selector: '[role="dialog"], .modal, [class*="modal"]', label: 'modal' },
    { re: /table|row/i, selector: 'table, [role="table"]', label: 'table' },
    { re: /search/i, selector: 'input[type="search"], [role="searchbox"], .search', label: 'search box' },
    { re: /submit|save|create|add/i, selector: 'button, [type="submit"]', label: 'action button' },
  ];
  for (const p of patterns) {
    if (p.re.test(q)) return { selector: p.selector, label: p.label };
  }
  return { selector: 'body', label: 'page' };
}

function parseSteps(question) {
  const match = semanticMatch(question);
  return [
    { selector: match.selector, explanation: `Clicky found a ${match.label} for you.`, action: 'click' },
  ];
}

export function createClicky(cwd) {
  return new ClickyEngine(cwd);
}

export class ClickyEngine {
  constructor(cwd) {
    this.cwd = cwd || process.cwd();
    this.active = false;
    this.mode = CLICKY_MODES.GUIDE;
    this.currentFlow = null;
    this.stepsCompleted = 0;
    this.callbacks = { guide: [], assist: [], autopilot: [] };
  }

  start() {
    this.active = true;
    return { started: true, mode: this.mode };
  }

  stop() {
    this.active = false;
    this.currentFlow = null;
    this.stepsCompleted = 0;
    return { stopped: true };
  }

  isActive() {
    return this.active;
  }

  setMode(mode) {
    if (!Object.values(CLICKY_MODES).includes(mode)) {
      throw new Error(`Unknown mode: ${mode}. Valid: ${Object.values(CLICKY_MODES).join(', ')}`);
    }
    this.mode = mode;
    const cbs = this.callbacks[mode] || [];
    for (const cb of cbs) try { cb({ mode }); } catch {}
    return { mode: this.mode };
  }

  ask(question) {
    const steps = parseSteps(question);
    const first = steps[0];
    return {
      selector: first.selector,
      explanation: first.explanation,
      steps,
    };
  }

  guideTo(selector, explanation) {
    this.active = true;
    return { guided: true, element: selector, explanation: explanation || '' };
  }

  recordFlow(name) {
    ensureDir();
    const flows = loadFlows();
    const flow = { id: name, name, mode: this.mode, steps: [], createdAt: new Date().toISOString() };
    flows[name] = flow;
    saveFlows(flows);
    this.currentFlow = name;
    return { flowId: name, steps: [] };
  }

  replayFlow(name) {
    const flows = loadFlows();
    const flow = flows[name];
    if (!flow) throw new Error(`Flow "${name}" not found`);
    this.currentFlow = name;
    this.stepsCompleted = 0;
    return { replaying: true, flowId: name, steps: flow.steps.length };
  }

  listFlows() {
    const flows = loadFlows();
    return Object.values(flows).map(f => ({ id: f.id, name: f.name, mode: f.mode, steps: f.steps.length, createdAt: f.createdAt }));
  }

  generateWalkthrough(source) {
    const steps = [];
    if (typeof source === 'string' && source.startsWith('http')) {
      steps.push({ selector: 'body', explanation: 'Welcome to the walkthrough. Follow each step.', action: 'view' });
    } else if (typeof source === 'string') {
      const lines = source.split('\n').filter(l => l.trim());
      for (const line of lines) {
        const m = line.match(/(?:step\s*\d+[:.\)]\s*)?(.+)/i);
        if (m) steps.push({ selector: 'body', explanation: m[1].trim(), action: 'view' });
      }
    }
    if (steps.length === 0) steps.push({ selector: 'body', explanation: 'No steps found.', action: 'view' });
    return { steps };
  }

  onGuide(cb) { this.callbacks.guide.push(cb); }
  onAssist(cb) { this.callbacks.assist.push(cb); }
  onAutopilot(cb) { this.callbacks.autopilot.push(cb); }

  getStatus() {
    return {
      active: this.active,
      mode: this.mode,
      currentFlow: this.currentFlow,
      stepsCompleted: this.stepsCompleted,
    };
  }
}
