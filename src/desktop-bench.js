// How many tokens it costs ox to "see" an app, measured, three ways:
//   1. a screenshot of the window, priced as an image (Claude: about w×h/750
//      after scaling to 1568 px on the long side; GPT-4o: 85 + 170 per 512-px
//      tile after its own scaling), the way computer-use agents look;
//   2. agent-desktop's full accessibility snapshot (the JSON);
//   3. what ox actually sends: the interactive controls as one short line each
//      (ui_elements), and a targeted find that returns only what matches.
// Text is counted with ox's own estimate (src/agent.js tokensOf).
import { tokensOf } from './agent.js';

export function claudeImageTokens(w, h) {
  const s = Math.min(1, 1568 / Math.max(w, h));
  let W = Math.round(w * s), H = Math.round(h * s);
  // ~1.15 megapixels is the most an image is sent at.
  const mp = (W * H) / 1_150_000;
  if (mp > 1) { W = Math.round(W / Math.sqrt(mp)); H = Math.round(H / Math.sqrt(mp)); }
  return Math.ceil((W * H) / 750);
}

export function gpt4oImageTokens(w, h) {
  let s = Math.min(1, 2048 / Math.max(w, h));
  let W = w * s, H = h * s;
  s = Math.min(1, 768 / Math.min(W, H));
  W *= s; H *= s;
  return 85 + 170 * Math.ceil(W / 512) * Math.ceil(H / 512);
}

export const textTokens = (text) => tokensOf([{ role: 'user', content: String(text ?? '') }]);

/** The report from what was measured. → { rows, best, times } */
export function report({ width, height, snapshotJson, controlsText, findText }) {
  const rows = [];
  if (width && height) {
    rows.push({ how: 'screenshot (Claude)', tokens: claudeImageTokens(width, height) });
    rows.push({ how: 'screenshot (GPT-4o)', tokens: gpt4oImageTokens(width, height) });
  }
  if (snapshotJson) rows.push({ how: 'accessibility snapshot, full JSON', tokens: textTokens(snapshotJson) });
  if (controlsText) rows.push({ how: 'ox ui_elements (one line per control)', tokens: textTokens(controlsText) });
  if (findText) rows.push({ how: 'ox desktop find (only the match)', tokens: textTokens(findText) });
  const shot = rows.find((r) => r.how === 'screenshot (Claude)')?.tokens ?? null;
  const ox = rows.find((r) => r.how.startsWith('ox ui_elements'))?.tokens ?? null;
  const find = rows.find((r) => r.how.startsWith('ox desktop find'))?.tokens ?? null;
  return {
    rows,
    times: shot && ox ? Math.round((shot / ox) * 10) / 10 : null,
    findTimes: shot && find ? Math.round((shot / find) * 10) / 10 : null,
  };
}

/** Measure an app on this machine (needs agent-desktop, Accessibility and Screen Recording). */
export async function measure(app, { find = null } = {}) {
  const A = await import('./agent-desktop.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const { describeElements } = await import('./mac-control.js');
  const { describeFound } = await import('./tools/desktop.js');
  if (!A.available()) throw new Error('agent-desktop is not installed (npm install -g agent-desktop)');
  const out = { app };
  const png = path.join(os.tmpdir(), `ox-bench-${process.pid}.png`);
  const shot = await A.run(['screenshot', '--app', app, png], { timeoutMs: 30_000 });
  if (shot.ok && fs.existsSync(png)) {
    const r = spawnSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', png], { encoding: 'utf8' });
    out.width = Number(/pixelWidth: (\d+)/.exec(r.stdout)?.[1]) || null;
    out.height = Number(/pixelHeight: (\d+)/.exec(r.stdout)?.[1]) || null;
    fs.rmSync(png, { force: true });
  } else out.shotError = shot.error?.message ?? 'no screenshot';
  const snap = await A.run(['snapshot', '--app', app, '--compact', '--max-depth', '25'], { timeoutMs: 30_000 });
  if (snap.ok) out.snapshotJson = JSON.stringify(snap.data); else out.snapError = snap.error?.message;
  const list = await A.listElements(app);
  if (!list.error) out.controlsText = describeElements(list); else out.listError = list.error;
  if (find) {
    const f = await A.run(['find', '--app', app, '--text', find], { timeoutMs: 20_000 });
    if (f.ok) out.findText = describeFound(f.data);
  }
  return { ...out, ...report(out) };
}
