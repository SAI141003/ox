// Remote desktop primitives for a *paired* Ox machine.  This is deliberately
// narrower than a shell: a peer can see a screenshot, inspect accessibility
// controls, and use the same safe computer-use actions that Ox uses locally.
// The policy in mac-control.js still refuses Send/Pay/Delete-like controls and
// Return/Enter.  The mesh service owns the permission and audit boundary.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import * as mac from './mac-control.js';

const fail = (message) => ({ error: message });

function capture(file) {
  return new Promise((resolve) => {
    const p = spawn('screencapture', ['-x', file], { stdio: 'ignore' });
    p.on('error', (e) => resolve(fail(`screen capture failed: ${e.message}`)));
    p.on('close', (code) => resolve(code === 0 ? { ok: true } : fail(`screen capture exited ${code}`)));
  });
}

/**
 * Execute one intentionally-small remote desktop request.  A test may supply
 * this API through startNode({ remoteControl }) so mesh protocol tests never
 * touch the owner's real screen or Accessibility permission.
 */
export async function remoteControl(op, args = {}) {
  if (process.platform !== 'darwin') return fail(`remote screen and control currently require macOS (this machine is ${process.platform})`);

  if (op === 'screen') {
    const file = path.join(os.tmpdir(), `ox-mesh-screen-${process.pid}-${Date.now()}.png`);
    try {
      const r = await capture(file);
      if (r.error) return r;
      return { mime: 'image/png', data: await fs.readFile(file) };
    } catch (e) {
      return fail(`screen capture failed: ${e.message}`);
    } finally {
      await fs.rm(file, { force: true }).catch(() => {});
    }
  }

  if (op === 'control-list') {
    const r = await mac.listElements(args.app, { max: Math.max(1, Math.min(300, Number(args.max) || 150)) });
    return r.error ? fail(r.error) : { app: r.app, window: r.window, elements: r.elements, ms: r.ms };
  }

  let r;
  if (op === 'control-click') r = await mac.click({ app: args.app, element: args.element, role: args.role, x: args.x, y: args.y, double: !!args.double });
  else if (op === 'control-type') r = await mac.typeText({ app: args.app, text: args.text, into: args.into });
  else if (op === 'control-key') r = await mac.pressKey({ app: args.app, key: args.key, times: args.times });
  else return fail(`unknown remote-control operation ${op}`);
  return r.isError ? fail(r.text) : { text: r.text };
}

/** Never put typed text into the control machine's audit log. */
export function controlAuditDetail(op, args = {}) {
  const app = args.app ? ` app:${String(args.app).slice(0, 80)}` : '';
  if (op === 'control-type') return `type ${String(args.text ?? '').length} chars${app}`;
  if (op === 'control-click') return `click ${args.element ?? `${args.x ?? '?'},${args.y ?? '?'}`}${app}`.slice(0, 180);
  if (op === 'control-key') return `key ${String(args.key ?? '').slice(0, 40)}${app}`;
  if (op === 'control-list') return `list${app}`;
  return 'screen';
}
