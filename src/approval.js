import readline from 'node:readline';
import { c, renderDiff } from './ui.js';
import { evaluateToolPolicy, READONLY_TOOLS } from './guards.js';

const WRITE_TOOLS = new Set(['write_file', 'edit_file']);

export { READONLY_TOOLS };

// Re-export for backward compatibility (delegates to the guard pipeline).
export function readOnlyAutoVerdict(name, args = {}, ctx = {}) {
  if (name !== 'bash') return { auto: false };
  if (ctx?.yolo === true) return { auto: false };
  if (ctx?.strictApprovals === true) return { auto: false };
  if ((ctx?.approval ?? 'default') !== 'default') return { auto: false };
  const command = String(args?.command ?? '');
  if (!command.trim()) return { auto: false };
  const { decision, rule } = evaluateToolPolicy({ name, args, ctx });
  return decision === 'allow' && rule === 'readonly-classifier'
    ? { auto: true, rule: 'readonly-auto' }
    : { auto: false };
}

export function isWriteTool(name) {
  return WRITE_TOOLS.has(name);
}

function diffFromDetail(args, detail) {
  if (typeof detail === 'string' && /^[+-@]/m.test(detail)) {
    const nl = detail.indexOf('\n');
    return nl === -1 ? detail : detail.slice(nl + 1);
  }
  if (typeof args.content === 'string') {
    return ['+++ ' + (args.path ?? ''), ...args.content.split('\n').map((l) => `+${l}`)].join('\n');
  }
  if (args.old_string != null || args.new_string != null) {
    const removed = String(args.old_string ?? '').split('\n').map((l) => `-${l}`);
    const added = String(args.new_string ?? '').split('\n').map((l) => `+${l}`);
    return [...removed, ...added].join('\n');
  }
  return '';
}

function renderDetail(name, args = {}, detail) {
  if (isWriteTool(name)) {
    const diff = diffFromDetail(args, detail);
    if (diff !== '') return renderDiff(diff);
  } else if (name === 'bash') {
    const command = args.command ?? (typeof detail === 'string' ? detail : '');
    return c.dim(`$ ${truncateCommand(command)}`);
  }
  try {
    return c.dim(JSON.stringify(args ?? {}).slice(0, 300));
  } catch {
    return c.dim(String(detail ?? name).slice(0, 300));
  }
}

function truncateCommand(command) {
  const text = String(command ?? '');
  return text.length <= 300 ? text : `${text.slice(0, 299)}…`;
}

// `external` is an optional out-of-band approver seam, e.g. the IPC GUI bridge
// (src/ipc.js -> createIpcApprover). Shape: { hasClient(): boolean, ask(req):
// Promise<{decision}> }. It is consulted ONLY after the interactive terminal
// prompt has been ruled out, and only an explicit 'allow' from it can allow
// anything: 'ask', an unrecognised verdict, a timeout, a disconnect, a
// malformed frame, a throw, or no client at all all fall through to the
// pre-existing non-TTY decline. The default posture is therefore unchanged.
export function makeApprover({ mode = 'default', yolo = false, sandbox = null, mcpPolicy = null, strictApprovals = false, external = null } = {}) {
  let acceptAll = false;
  let noticedNonTTY = false;

  return async function requestApproval(name, args = {}, detail) {
    // The SANDBOX deny is checked before the yolo short-circuit, and only that
    // one rule. src/guards.js already documents a sandbox deny as monotonic
    // ("beats yolo everywhere"), but the `yolo` early return below used to run
    // first, so `--yolo` could hand out a tool the active profile forbids.
    // Everything else about yolo/acceptAll is untouched.
    if (sandbox && typeof sandbox.blocksTool === 'function') {
      let blocked = false;
      try {
        blocked = sandbox.blocksTool(name, args) === true;
      } catch {
        blocked = false;
      }
      if (blocked) return false;
    }
    if (acceptAll || yolo) return true;

    // Monotonic guard pipeline (DeepSeek dsh pattern): deny-wins, can only tighten.
    const ctx = { approval: mode, yolo, sandbox, mcpPolicy, strictApprovals };
    const { decision, rule } = evaluateToolPolicy({ name, args, ctx });
    if (decision === 'allow') return true;
    if (decision === 'deny') return false;

    // Fall through to interactive prompt only on 'ask'.
    if (mode === 'accept-edits' && isWriteTool(name)) return true;

    // 2. A TTY: the human at the terminal is the primary approver. When a GUI
    // client (OX Island) is also connected, both are asked at once and the
    // FIRST answer wins -- but only a literal 'allow' from the GUI can allow;
    // its 'ask'/timeout/disconnect leaves the terminal prompt waiting.
    if (process.stdin.isTTY) {
      const live = external && typeof external.hasClient === 'function' && typeof external.ask === 'function' && external.hasClient() === true;
      return promptTerminal(name, args, detail, live ? external : null);
    }

    // 3. No TTY: give a connected external approver exactly one chance, and
    //    only when a client is actually there to answer. Everything except a
    //    literal 'allow' is treated as silence, and silence is a decline.
    const ext = external;
    if (ext && typeof ext.hasClient === 'function' && typeof ext.ask === 'function' && ext.hasClient() === true) {
      let answer = null;
      try {
        answer = await ext.ask({ tool: name, args, detail, cwd: process.cwd() });
      } catch {
        answer = null; // a throwing bridge is silence, and silence declines
      }
      const decision = String(answer?.decision ?? '').trim().toLowerCase();
      if (decision === 'always') {
        acceptAll = true;
        return true;
      }
      if (decision === 'allow') return true;
      if (decision === 'deny') {
        const who = String(answer?.clientId ?? '').trim() || 'unknown client';
        process.stdout.write(`${c.dim(`(denied by IPC client ${who})`)}\n`);
        return false;
      }
      // 'ask' / unrecognised / no answer at all => fall through to (4).
    }

    // 4. No TTY and nobody answered: decline, exactly as before IPC existed.
    if (!noticedNonTTY) {
      noticedNonTTY = true;
      process.stdout.write(`${c.dim('(stdin is not a TTY — approval prompts unavailable, declining)')}\n`);
    }
    return false;
  };

  async function promptTerminal(name, args, detail, gui = null) {
    const preview = renderDetail(name, args, detail);
    if (preview) process.stdout.write(`${preview}\n`);

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let settled = false;
    const verdict = await new Promise((resolve) => {
      const finish = (value, note) => {
        if (settled) return;
        settled = true;
        if (note) process.stdout.write(`\n${c.dim(note)}\n`);
        resolve(value);
      };
      rl.on('close', () => finish(false));
      rl.on('error', () => finish(false));
      rl.question(`Allow ${name}? [y]es / [n]o / [a]lways this session: `, (answer) => {
        const choice = String(answer ?? '').trim().toLowerCase();
        if (choice === 'a' || choice === 'always') {
          acceptAll = true;
          finish(true);
        } else {
          finish(choice === 'y' || choice === 'yes');
        }
      });
      if (gui) {
        Promise.resolve()
          .then(() => gui.ask({ tool: name, args, detail, cwd: process.cwd() }))
          .then((answer) => {
            const d = String(answer?.decision ?? '').trim().toLowerCase();
            if (d === 'always') {
              acceptAll = true;
              finish(true, '(allowed for the rest of this session from OX Island)');
            } else if (d === 'allow') finish(true, '(allowed from OX Island)');
            else if (d === 'deny') finish(false, '(denied from OX Island)');
            // anything else: the terminal prompt keeps waiting
          })
          .catch(() => { /* a broken bridge is silence */ });
      }
    });
    rl.close();
    // Answered here first: withdraw the GUI's copy so it cannot linger.
    if (gui && typeof gui.cancel === 'function') gui.cancel('answered-in-terminal');
    return verdict;
  }
}
