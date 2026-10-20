import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import * as macControl from '../mac-control.js';

function err(msg) { return { content: msg, isError: true }; }

function isMac() { return os.platform() === 'darwin'; }
function isLinux() { return os.platform() === 'linux'; }
function isWindows() { return os.platform() === 'win32'; }

function needsApproval(name) {
  return ['open_app', 'type_text', 'open_url', 'open_path', 'open_window', 'screenshot', 'notify'].includes(name);
}

export function osCmd(action, target) {
  if (isMac()) {
    switch (action) {
      case 'open_app': return ['open', '-a', target];
      case 'open_url': return ['open', target];
      case 'open_path': return ['open', target.startsWith('-') ? `./${target}` : target];
      // Text reaches AppleScript as argv, never spliced into the script: a quote
      // in a model-chosen string must not be able to become `do shell script`.
      case 'open_window': return ['osascript', '-e', 'on run argv', '-e', 'tell application "System Events" to set frontmost of process (item 1 of argv) to true', '-e', 'end run', target];
      case 'screenshot': return ['screencapture', '-x', target];
      case 'notify': return ['osascript', '-e', 'on run argv', '-e', 'display notification (item 1 of argv) with title "ox"', '-e', 'end run', target];
      case 'type_text': return ['osascript', '-e', 'on run argv', '-e', 'tell application "System Events" to keystroke (item 1 of argv)', '-e', 'end run', target];
    }
  }
  if (isLinux()) {
    switch (action) {
      case 'open_app': return ['xdg-open', target];
      case 'open_url': return ['xdg-open', target];
      case 'open_path': return ['xdg-open', target];
      case 'open_window': return ['xdotool', 'search', '--name', target, 'windowactivate'];
      case 'screenshot': return ['import', target];
      case 'notify': return ['notify-send', 'ox', target];
      case 'type_text': return ['xdotool', 'type', target];
    }
  }
  if (isWindows()) {
    // cmd.exe re-parses its command line, so metacharacters in a target would
    // run as commands; refuse them rather than try to escape cmd's rules.
    if (action !== 'notify' && action !== 'open_url' && action !== 'type_text' && /[&|<>^%"\r\n]/.test(target)) return null;
    switch (action) {
      case 'open_app': return ['cmd', '/c', `start`, '', target];
      // No cmd.exe in between, so a URL's `&` stays part of the URL.
      case 'open_url': return ['rundll32', 'url.dll,FileProtocolHandler', target];
      case 'open_path': return ['cmd', '/c', 'start', '', target];
      // The text travels in an environment variable, not inside the command.
      case 'notify': return ['powershell', '-NoProfile', '-Command', "[System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms') | Out-Null; [System.Windows.Forms.MessageBox]::Show($env:OX_NOTIFY_TEXT, 'ox') | Out-Null"];
      // Typed by pasting (any language, several lines; a paste never presses Enter).
      // The text travels in OX_TYPE_TEXT, never inside the command.
      case 'type_text': return ['powershell', '-NoProfile', '-Command', "Set-Clipboard -Value $env:OX_TYPE_TEXT; Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')"];
    }
  }
  return null;
}

export async function open_app(args = {}, ctx = {}) {
  const name = args?.name;
  if (!name) return err('operator open_app: name is required');
  if (!ctx?.yolo) {
    if (ctx?.requestApproval) {
      const v = await ctx.requestApproval('open_app', { name }, `Open application "${name}"?`);
      if (!v) return { content: 'User declined open_app' };
    } else {
      return err('open_app requires approval. Run with --yes or configure trust level.');
    }
  }
  const cmd = osCmd('open_app', name);
  if (!cmd) return err(`No open_app support on ${os.platform()}`);
  return runCmd(cmd, `open -a ${name}`);
}

export async function open_url(args = {}, ctx = {}) {
  const url = args?.url;
  if (!url) return err('operator open_url: url is required');
  if (!/^https?:\/\//.test(url)) return err('open_url: must start with http:// or https://');
  if (!ctx?.yolo) {
    if (ctx?.requestApproval) {
      const v = await ctx.requestApproval('open_url', { url }, `Open URL ${url}?`);
      if (!v) return { content: 'User declined open_url' };
    } else {
      return err('open_url requires approval');
    }
  }
  const cmd = osCmd('open_url', url);
  if (!cmd) return err(`No open_url support on ${os.platform()}`);
  return runCmd(cmd, `open ${url}`);
}

export async function open_path(args = {}, ctx = {}) {
  const p = args?.path;
  if (!p) return err('operator open_path: path is required');
  if (!ctx?.yolo) {
    if (ctx?.requestApproval) {
      const v = await ctx.requestApproval('open_path', { path: p }, `Open path ${p}?`);
      if (!v) return { content: 'User declined open_path' };
    } else {
      return err('open_path requires approval');
    }
  }
  const cmd = osCmd('open_path', p);
  if (!cmd) return err(`No open_path support on ${os.platform()}`);
  return runCmd(cmd, `open ${p}`);
}

export async function open_window(args = {}, ctx = {}) {
  const name = args?.name;
  if (!name) return err('operator open_window: name is required');
  if (!ctx?.yolo) {
    if (ctx?.requestApproval) {
      const v = await ctx.requestApproval('open_window', { name }, `Focus window "${name}"?`);
      if (!v) return { content: 'User declined open_window' };
    } else {
      return err('open_window requires approval');
    }
  }
  const cmd = osCmd('open_window', name);
  if (!cmd) return err(`No open_window support on ${os.platform()}`);
  return runCmd(cmd, `focus ${name}`);
}

export async function type_text(args = {}, ctx = {}) {
  const text = args?.text;
  if (!text) return err('operator type_text: text is required');
  if (!ctx?.yolo) {
    if (ctx?.requestApproval) {
      const v = await ctx.requestApproval('type_text', { text: text.slice(0, 100) }, `Type text into front app?`);
      if (!v) return { content: 'User declined type_text' };
    } else {
      return err('type_text requires approval');
    }
  }
  // On a Mac the text is pasted (any language; a newline in it never presses
  // Return, so a chat box is filled, not sent): src/mac-control.js.
  if (isMac()) return macRun(() => macControl.typeText({ app: args.app, text, into: args.into }, { dryRun: isDry() }));
  const cmd = osCmd('type_text', text);
  if (!cmd) return err(`No type_text support on ${os.platform()}`);
  return runCmd(cmd, `type "${text.slice(0, 50)}..."`, isWindows() ? { OX_TYPE_TEXT: String(text) } : undefined);
}

const isDry = () => !!(process.env.NODE_TEST_CONTEXT || process.env.OX_OPERATOR_DRY === '1');
async function macRun(fn) {
  if (!isMac()) return err(`click and type work on macOS only (this is ${os.platform()})`);
  const r = await fn();
  return { content: r.text, isError: !!r.isError };
}

// The controls of an app's window: read-only, so no approval.
export async function ui_elements(args = {}) {
  if (!isMac()) return err(`ui_elements works on macOS only (this is ${os.platform()})`);
  if (isDry()) return { content: `done (dry run: would list the controls of ${args.app || 'the app in front'})` };
  const l = await macControl.listElements(args.app);
  return l.error ? err(l.error) : { content: macControl.describeElements(l) };
}

export async function click(args = {}, ctx = {}) {
  if (args.element == null && (args.x == null || args.y == null)) return err('operator click: element, or x and y, is required');
  if (!ctx?.yolo) {
    if (!ctx?.requestApproval) return err('click requires approval');
    const v = await ctx.requestApproval('click', { app: args.app, element: args.element, x: args.x, y: args.y }, `Click ${args.element ? `"${args.element}"` : `${args.x},${args.y}`}${args.app ? ` in ${args.app}` : ''}?`);
    if (!v) return { content: 'User declined click' };
  }
  return macRun(() => macControl.click(args, { dryRun: isDry() }));
}

// Draw with the cursor (Vovy carving a pumpkin): a shape in a box, or points.
export async function draw(args = {}, ctx = {}) {
  if (!args.shape && !Array.isArray(args.points)) return err('operator draw: shape (with x, y, w, h) or points is required');
  if (!ctx?.yolo) {
    if (!ctx?.requestApproval) return err('draw requires approval');
    const v = await ctx.requestApproval('draw', { app: args.app, shape: args.shape, x: args.x, y: args.y, w: args.w, h: args.h }, `Take the cursor and draw ${args.label || args.shape || 'a path'}${args.app ? ` in ${args.app}` : ''}? (Move the mouse to stop it.)`);
    if (!v) return { content: 'User declined draw' };
  }
  return macRun(() => macControl.draw(args, { dryRun: isDry() }));
}

export async function press_key(args = {}, ctx = {}) {
  if (!args.key) return err('operator press_key: key is required');
  const k = macControl.parseKey(args.key);
  if (k.error) return err(k.error);
  if (!ctx?.yolo) {
    if (!ctx?.requestApproval) return err('press_key requires approval');
    const v = await ctx.requestApproval('press_key', { app: args.app, key: args.key }, `Press ${args.key}${args.app ? ` in ${args.app}` : ''}?`);
    if (!v) return { content: 'User declined press_key' };
  }
  return macRun(() => macControl.pressKey(args, { dryRun: isDry() }));
}

export async function screenshot(args = {}, ctx = {}) {
  const outPath = args?.output || path.join(os.tmpdir(), `ox-screenshot-${Date.now()}.png`);
  if (!ctx?.yolo) {
    if (ctx?.requestApproval) {
      const v = await ctx.requestApproval('screenshot', { output: outPath }, `Take screenshot to ${outPath}?`);
      if (!v) return { content: 'User declined screenshot' };
    } else {
      return err('screenshot requires approval');
    }
  }
  const cmd = osCmd('screenshot', outPath);
  if (!cmd) return err(`No screenshot support on ${os.platform()}`);
  return runCmd(cmd, `screenshot → ${outPath}`);
}

export async function notify(args = {}, ctx = {}) {
  const message = args?.message || 'ox notification';
  const cmd = osCmd('notify', message);
  if (!cmd) return err(`No notify support on ${os.platform()}`);
  return runCmd(cmd, `notify: ${message}`, { OX_NOTIFY_TEXT: String(message) });
}

function runCmd(cmd, label, env = {}) {
  // Under the test runner nothing is opened or typed on the real machine: every
  // unit run used to open a browser tab and a Finder window on the owner's Mac,
  // and failed on a CI runner with no desktop. OX_OPERATOR_DRY=1 does the same.
  if (process.env.NODE_TEST_CONTEXT || process.env.OX_OPERATOR_DRY === '1') {
    return Promise.resolve({ content: `done (dry run: would ${label})` });
  }
  return new Promise((resolve) => {
    const child = spawn(cmd[0], cmd.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000, env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (e) => resolve({ content: `Failed: ${e.message}`, isError: true }));
    child.on('close', (code) => {
      if (code !== 0 && code !== null) {
        resolve({ content: `${label} exited ${code}. ${stderr.trim() || stdout.trim()}`, isError: true });
      } else {
        resolve({ content: `${label} done${stdout.trim() ? ': ' + stdout.trim().slice(0, 200) : ''}` });
      }
    });
    child.on('timeout', () => {
      child.kill();
      resolve({ content: `${label} timed out`, isError: true });
    });
  });
}

export const OPERATOR_TOOLS = [
  { name: 'open_app', description: 'Open an application by name (macOS: open -a, Linux: xdg-open, Windows: start). Args: name (REQUIRED). Requires approval.' },
  { name: 'open_url', description: 'Open a URL in the default browser. Args: url (REQUIRED, http:// or https://). Requires approval.' },
  { name: 'open_path', description: 'Open a file or folder in the OS file manager. Args: path (REQUIRED). Requires approval.' },
  { name: 'open_window', description: 'Focus a window by name. Args: name (REQUIRED). Requires approval.' },
  { name: 'type_text', description: 'Type text into the front app (never presses Return). Args: text (REQUIRED), app, into (a box from ui_elements). Requires approval.' },
  { name: 'screenshot', description: 'Capture the screen or active window. Args: output (optional, default temp path). Requires approval.' },
  { name: 'notify', description: 'Send an OS notification. Args: message (optional, default "ox notification"). No approval prompt: notify() never calls requestApproval or checks ctx.yolo, unlike the six tools above it.' },
  { name: 'ui_elements', description: "List the controls of an app's front window (buttons, text boxes, rows, labels) with a number and screen position (macOS). Args: app (optional, default the app in front). Read-only." },
  { name: 'click', description: 'Click a control (macOS): element (its name or number from ui_elements), role (optional: button, text field, row), or x and y in screen points; app (optional); double (optional). Never presses Send, Pay, Buy, Delete or the like. Requires approval.' },
  { name: 'press_key', description: 'Press a key (macOS): tab, shift+tab, escape, space, delete, arrows, home, end, pageup, pagedown, or cmd with a c f k l n t v x z. Never Return or Enter. Args: key (REQUIRED), app, times. Requires approval.' },
  { name: 'draw', description: 'Draw with the cursor (macOS): shape (circle smile frown line v triangle rectangle star zigzag) in a box x, y, w, h (screen points; find it with screenshot), or points [[x,y],…]; label says what it is. Requires approval.' },
];

export const OPERATOR_TOOL_SCHEMAS = OPERATOR_TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  inputSchema: {
    type: 'object',
    properties: t.name === 'open_app' ? { name: { type: 'string', description: 'Application name, e.g. Chrome, VS Code' } }
      : t.name === 'open_url' ? { url: { type: 'string', description: 'URL to open' } }
      : t.name === 'open_path' ? { path: { type: 'string', description: 'File or folder path' } }
      : t.name === 'open_window' ? { name: { type: 'string', description: 'Window title to focus' } }
      : t.name === 'type_text' ? { text: { type: 'string', description: 'Text to type' }, app: { type: 'string' }, into: { type: 'string' } }
      : t.name === 'ui_elements' ? { app: { type: 'string', description: 'App name (default: the app in front)' } }
      : t.name === 'click' ? { app: { type: 'string' }, element: { type: 'string', description: 'Control name or number from ui_elements' }, role: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, double: { type: 'boolean' } }
      : t.name === 'draw' ? { shape: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' }, points: { type: 'array' }, label: { type: 'string' }, app: { type: 'string' } }
      : t.name === 'press_key' ? { app: { type: 'string' }, key: { type: 'string', description: 'tab, shift+tab, escape, down, cmd+f…' }, times: { type: 'number' } }
      : t.name === 'screenshot' ? { output: { type: 'string', description: 'Output image path' } }
      : { message: { type: 'string', description: 'Notification message' } },
  },
}));
