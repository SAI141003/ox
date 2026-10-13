// What every chat channel shares: pairing, commands, one run at a time, a
// live status line, approvals as buttons, the answer sent back. A channel
// (Telegram, Discord) only supplies how to send, edit and acknowledge.
//
//   adapter.send(chat, text, buttons?) -> { id }     buttons: [{ label, data, danger? }]
//   adapter.edit(chat, id, text)
//   adapter.ack(ref, text)                          answer a button press
//
// Safety is the same everywhere: until a chat sends the pairing code nothing
// runs; afterwards only that chat is listened to; approvals stay approvals
// (silence or a timeout declines); runs are normal ox runs in the project.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectIpcClient, socketPathFor } from './ipc.js';
import { createWatchState, applyMessage, currentTool } from './ipc-watch.js';
import { MODE_NAMES, normalizeMode } from './modes.js';

const OX_CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ox.js');
export const MAX_MESSAGE = 1900; // fits Discord (2000) and Telegram (4096)

export function splitMessage(text, max = MAX_MESSAGE) {
  const out = [];
  let s = String(text ?? '').trim() || '(no text)';
  while (s.length > max) {
    let cut = s.lastIndexOf('\n', max);
    if (cut < max / 2) cut = max;
    out.push(s.slice(0, cut));
    s = s.slice(cut).replace(/^\n/, '');
  }
  out.push(s);
  return out;
}

// What ox printed, minus its own progress lines.
export const cleanAnswer = (s) => String(s ?? '').split('\n')
  .filter((l) => !/^[·●✓✗] /.test(l) && !/^\s+~ /.test(l))
  .join('\n').replace(/\n{3,}/g, '\n\n').trim();

export const HELP = [
  'ox — send a message and ox works on it in your project.',
  '/status  what is running',
  '/stop    stop the current run',
  `/mode <name>  ${['auto', ...MODE_NAMES].join(' | ')}`,
  '/new     start a fresh conversation',
  '/where   which project ox works in',
].join('\n');

export function createRemoteCore({ adapter, state, persist, cwd, agent = null, env = process.env, log = console.log, socketDir, channel = 'chat' }) {
  if (!state.mode) state.mode = 'auto';
  if (state.fresh === undefined) state.fresh = true;
  if (!state.owner && !state.pairCode) state.pairCode = String(crypto.randomInt(100000, 1000000));
  persist();
  let run = null;

  async function startRun(chat, text) {
    const id = crypto.randomBytes(4).toString('hex');
    const sock = socketDir ? socketPathFor(`${channel}-${id}`, socketDir) : socketPathFor(`${channel}-${id}`);
    const args = [OX_CLI, '-p', text, `--ipc=${sock}`, '--mode', state.mode || 'auto', ...(agent ? ['--agent', agent] : []), ...(state.fresh ? [] : ['-c'])];
    const status = await adapter.send(chat, '⏳ working…');
    // A phone is slower to answer than a desk: approvals wait 10 minutes
    // (unless set), then decline as usual.
    const childEnv = { OX_IPC_APPROVAL_TIMEOUT_MS: '600000', ...env, OX_IPC_WAIT_CLIENT_MS: '15000', OX_ISLAND: '0', NO_COLOR: '1' };
    const child = spawn(process.execPath, args, { cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    run = { id, chat, child, sock, statusId: status.id, started: Date.now(), watch: createWatchState(), client: null, asked: new Set(), lastEdit: 0, lastShown: '' };
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    state.fresh = false;
    persist();
    connectWhenReady(run);
    child.on('close', async (code) => {
      const r = run;
      run = null;
      try { r.client?.close(); } catch {}
      const secs = Math.round((Date.now() - r.started) / 1000);
      try { await adapter.edit(chat, r.statusId, code === 0 ? `✓ done in ${secs}s` : `✗ stopped (exit ${code}) after ${secs}s`); } catch {}
      for (const part of splitMessage(cleanAnswer(out))) await adapter.send(chat, part).catch(() => {});
    });
  }

  // The run's IPC socket appears a moment after it starts.
  function connectWhenReady(r, tries = 0) {
    if (run !== r) return;
    const client = connectIpcClient({ socketPath: r.sock, clientId: `${channel}-${process.pid}`, connectTimeoutMs: 500 });
    client.on('open', () => { r.client = client; });
    client.on('message', (msg) => onRunMessage(r, msg));
    client.on('close', (info) => {
      if (!info?.connected && tries < 60 && run === r) setTimeout(() => connectWhenReady(r, tries + 1), 250);
    });
  }

  async function onRunMessage(r, msg) {
    r.watch = applyMessage(r.watch, msg, { now: Date.now() });
    if (msg?.type === 'approval-request' && !r.asked.has(msg.id)) {
      r.asked.add(msg.id);
      await adapter.send(r.chat, `ox wants to run ${msg.tool}\n\n${String(msg.argsPreview ?? '').slice(0, 600)}`, [
        { label: 'Allow', data: `ap:${r.id}:${msg.id}:allow` },
        { label: 'Deny', data: `ap:${r.id}:${msg.id}:deny`, danger: true },
      ]).catch(() => {});
      return;
    }
    // One status line, edited at most every 2s, only when it changes.
    const tool = currentTool(r.watch);
    const line = tool ? `⏳ ${tool.name}${tool.preview ? ` ${String(tool.preview).slice(0, 80)}` : ''}` : null;
    if (line && line !== r.lastShown && Date.now() - r.lastEdit > 2000) {
      r.lastShown = line;
      r.lastEdit = Date.now();
      adapter.edit(r.chat, r.statusId, line).catch(() => {});
    }
  }

  async function onMessage(chat, rawText) {
    const text = String(rawText ?? '').trim();
    if (!chat || !text) return;
    if (!state.owner) {
      const code = /^\/pair\s+(\d{6})$/.exec(text)?.[1];
      if (code && code === state.pairCode) {
        state.owner = chat;
        delete state.pairCode;
        persist();
        log(`paired with ${channel} chat ${chat}`);
        await adapter.send(chat, `Paired. I work in ${path.basename(cwd)}.\n\n${HELP}`);
      } else {
        await adapter.send(chat, `This ox is not paired yet. Send /pair <code> — the code is shown in the terminal running ox gateway.`);
      }
      return;
    }
    if (String(chat) !== String(state.owner)) return; // not yours: ignored, and told nothing
    const [cmd, ...rest] = text.split(/\s+/);
    switch (cmd.toLowerCase()) {
      case '/start': case '/help': return void adapter.send(chat, HELP);
      case '/where': return void adapter.send(chat, `${cwd}\nmode: ${state.mode}${agent ? `\nagent: ${agent}` : ''}`);
      case '/new': state.fresh = true; persist(); return void adapter.send(chat, 'Fresh conversation from the next message.');
      case '/mode': {
        const m = normalizeMode(rest[0]);
        if (!m) return void adapter.send(chat, `modes: ${['auto', ...MODE_NAMES].join(', ')} (now: ${state.mode})`);
        state.mode = m;
        persist();
        return void adapter.send(chat, `mode: ${m}`);
      }
      case '/status': {
        if (!run) return void adapter.send(chat, 'Nothing running.');
        const tool = currentTool(run.watch);
        return void adapter.send(chat, `Working for ${Math.round((Date.now() - run.started) / 1000)}s — ${tool ? `${tool.name} ${tool.preview ?? ''}` : run.watch.phase}`);
      }
      case '/stop': {
        if (!run) return void adapter.send(chat, 'Nothing running.');
        run.child.kill('SIGINT');
        return void adapter.send(chat, 'Stopping.');
      }
      default:
        if (run) return void adapter.send(chat, 'Still on the last one. /status to see it, /stop to stop it.');
        return startRun(chat, text);
    }
  }

  // A button press: `ref` is whatever the adapter needs to acknowledge it.
  async function onButton(chat, data, ref, original = null) {
    if (!state.owner || String(chat) !== String(state.owner)) return adapter.ack(ref, null).catch(() => {});
    const [, runId, approvalId, decision] = String(data ?? '').split(':');
    const ok = run && run.id === runId && run.client && ['allow', 'deny'].includes(decision)
      ? run.client.answer(approvalId, decision)
      : false;
    await adapter.ack(ref, ok ? (decision === 'allow' ? 'Allowed' : 'Denied') : 'That request has expired', original && ok ? `${original}\n\n→ ${decision === 'allow' ? 'allowed' : 'denied'}` : null).catch(() => {});
    return ok;
  }

  return { onMessage, onButton, stop: () => { if (run) run.child.kill('SIGINT'); }, get running() { return !!run; } };
}
