// ox attach — watch a detached session, and answer its approvals, without
// owning it.
//
// The one behaviour that makes this worth having: DISCONNECTING DOES NOT STOP
// THE WORKER. The worker belongs to the supervisor, not to whoever is watching.
// So attach can be opened and closed as often as anyone likes, and closing it
// only removes a client socket from the session's ipc.js server — exactly the
// socket the GUI bridge would have been. The run keeps going, and the next
// attach picks up the live stream (with the durable replay from the JSONL
// beneath it).
//
// On approvals it is deliberately the IMPLICIT part of the existing contract: it
// is an ordinary ipc.js client, so an approval it does not answer is a hold that
// ends in the pre-existing decline. 'q', Ctrl-C, a closed pipe, a timeout, an
// unknown id, a malformed frame — every one of them is silence, and silence is
// never an allow. attach has no private "approve anyway" path, and there is no
// way for it to upgrade a decision to something the protocol does not allow.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { connectIpcClient } from './ipc.js';
import { c, renderToolStart, truncate } from './ui.js';
import { controlRequest, readPidFile, resolveWorkerId, screenSocketPath } from './daemon.js';

// Bounded connect retries: the worker binds its socket a few hundred ms after it
// spawns, and a first connect that misses is a normal race, not a failure.
const CONNECT_TRIES = 40;
const CONNECT_INTERVAL_MS = 100;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stamp(ms) {
  if (!ms) return '-';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// Replay the tail of the append-only transcript before the live stream starts,
// so attaching late does not mean attaching blind. Read-only and bounded: this
// is a convenience, never a substitute for the file.
function replayTail(file, lines = 20) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      if (ev?.t === 'user') out.push({ at: null, kind: 'user', text: typeof ev.text === 'string' ? ev.text : JSON.stringify(ev.content ?? '') });
      else if (ev?.t === 'assistant' && ev.text) out.push({ at: null, kind: 'assistant', text: ev.text });
      else if (ev?.t === 'tool-result') out.push({ at: null, kind: 'tool', text: `${ev.name}: ${truncate(String(ev.content ?? ''), 120)}` });
    } catch { /* torn line: skip it, the file is append-only and may be mid-write */ }
  }
  return out.slice(-lines);
}

// `once: true` streams until the worker finishes; otherwise it streams until the
// user detaches (the worker keeps running either way).
export async function attachSession({ ref, replay = true, once = false } = {}) {
  const resolved = resolveWorkerId(ref);
  if (!resolved.ok) return { code: 3, error: resolved.reason, candidates: resolved.candidates };
  const record = resolved.record;

  // Prefer the supervisor's own live view: it is the authority, and it can name a
  // socket the record has not been told about yet.
  let live = null;
  const liveRes = await controlRequest('session-info', { workerId: resolved.id });
  if (liveRes.ok) live = liveRes.result;

  const state = live?.state ?? record.state ?? 'unknown';
  const pid = live?.pid ?? record.pid ?? null;
  const restarts = live?.restarts ?? record.restarts ?? 0;

  // The socket path comes off the wire, so it is screened rather than trusted:
  // right directory, right owner, no group/other bits. A path that fails the
  // screen is refused, never connected to.
  const socketPath = live?.socketPath ?? record.socketPath ?? null;
  if (!socketPath) {
    return { code: 3, error: `worker ${resolved.id} has no session socket recorded (state: ${state})` };
  }
  const verdict = screenSocketPath(socketPath);
  if (!verdict.ok) return { code: 3, error: `refusing to attach: ${verdict.reason}` };
  if (!verdict.exists) {
    return {
      code: 3,
      error:
        `worker ${resolved.id} is ${state} and has no socket at ${path.basename(socketPath)} — nothing is running to watch` +
        (pid ? ` (recorded pid ${pid})` : ''),
    };
  }

  console.log(c.bold(`attach ${resolved.id}`));
  console.log(c.dim(`  state ${state}${pid ? ` · pid ${pid}` : ''}${restarts ? ` · ${restarts} restart(s)` : ''} · socket ${socketPath}`));
  if (record.prompt) console.log(c.dim(`  task   ${truncate(record.prompt, 160)}`));
  console.log(c.dim('  the worker keeps running when you detach (q, or ctrl-c)'));

  // The worker binds a few hundred ms after it spawns, so a first connect that
  // misses is a normal race. Every attempt is itself bounded by the client's
  // connectTimeoutMs, so this loop cannot hang either.
  let client = null;
  for (let i = 0; i < CONNECT_TRIES; i++) {
    const attempt = connectIpcClient({ socketPath, clientId: `ox-attach-${process.pid}`, connectTimeoutMs: 250 });
    const opened = await new Promise((resolve) => {
      attempt.once('open', () => resolve(true));
      attempt.once('close', () => resolve(false));
    });
    if (opened) { client = attempt; break; }
    try { attempt.close(); } catch {}
    await sleep(CONNECT_INTERVAL_MS);
  }
  if (!client) return { code: 3, error: `worker ${resolved.id} did not answer on ${socketPath}` };

  if (replay && record.transcript) {
    const tail = replayTail(record.transcript);
    if (tail.length) {
      console.log(c.dim(`  transcript ${record.transcript} (last ${tail.length})`));
      for (const row of tail) {
        const label = row.kind === 'user' ? 'you' : row.kind === 'assistant' ? 'ox ' : '   ';
        console.log(c.dim(`  ${label}  ${truncate(String(row.text).replace(/\s+/g, ' '), 160)}`));
      }
    }
  }
  console.log(c.dim('  -- live --'));

  const tty = Boolean(process.stdin.isTTY);
  const rl = tty ? readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false }) : null;
  let pending = null;
  let done = false;
  let settle = null;
  const finished = new Promise((resolve) => { settle = resolve; });

  const close = () => {
    try { client.close(); } catch {}
    try { rl?.close(); } catch {}
    if (tty) { try { process.stdin.pause(); } catch {} }
  };

  const detach = () => {
    if (done) return;
    done = true;
    close();
    console.log(c.dim(`\ndetached from ${resolved.id} — the worker keeps running (ox attach ${resolved.id} to come back)`));
    settle({ code: 0, id: resolved.id, detached: true });
  };

  if (rl) {
    process.stdin.on('data', (chunk) => {
      for (const raw of String(chunk).split('\n')) {
        const line = raw.trim().toLowerCase();
        if (!line) continue;
        if (line === 'q') { detach(); return; }
        if (!pending) {
          // Say so instead of swallowing it. A decision typed before its panel is
          // on screen is not buffered for the next approval — that would be a
          // pre-approval, and the whole point of this path is that nothing is
          // allowed without an answer to a specific request. But silently eating
          // an operator's 'y' is its own bug: they asked a question and got no
          // reply, then sat there while the approval timed out and declined.
          if (line === 'y' || line === 'yes' || line === 'n' || line === 'no' || line === 'a') {
            console.log(c.dim('  (no approval is waiting — y/n/a only answer an approval that is on screen; this one was not held)'));
          }
          continue;
        }
        // y/yes -> allow, n/no -> deny, a -> allow. Anything else stays SILENCE,
        // which the protocol already treats as 'ask': the hold simply runs out
        // and declines. There is no third path here.
        const decision = line === 'y' || line === 'yes' || line === 'a' ? 'allow' : line === 'n' || line === 'no' ? 'deny' : null;
        if (!decision) continue;
        const target = pending;
        pending = null;
        client.answer(target.id, decision);
      }
    });
    process.stdin.resume();
  }

  client.on('message', (msg) => {
    if (msg?.type === 'hello') return;
    if (msg?.type === 'approval-request') {
      console.log('');
      console.log(c.yellow(`! approval · ${msg.tool}`));
      console.log(`  ${truncate(String(msg.argsPreview ?? ''), 400)}`);
      if (msg.cwd) console.log(c.dim(`  cwd ${msg.cwd}`));
      if (rl) console.log(c.bold('  allow? [y]es / [n]o / [q] detach   (silence declines)'));
      else console.log(c.dim('  no TTY on stdin — this approval will time out and DECLINE'));
      pending = msg;
      return;
    }
    if (msg?.type !== 'event') return;
    const ev = msg.event;
    const at = c.dim(stamp(msg.at));
    switch (ev?.type) {
      case 'text-delta':
        process.stdout.write(ev.text ?? '');
        break;
      case 'tool-start': {
        let args = {};
        try { args = JSON.parse(ev.argsPreview ?? '{}'); } catch {}
        console.log(`\n${at} ${renderToolStart(ev.name, args)}`);
        break;
      }
      case 'tool-end':
        console.log(c.dim(`  ${ev.name}: ${ev.ms}ms${ev.isError ? ' · error' : ''}`));
        break;
      case 'turn-end':
        console.log(c.dim(`  turn ${ev.iterations ?? '?'}`));
        break;
      case 'subagent-spawn':
      case 'subagent-start':
      // The terminal cancel, listed so the attach surface names it as its own
      // event rather than dropping it. It follows the 'subagent-end' for the
      // same agent, so it prints one extra dim line stating the agent stopped
      // and carrying the same may-still-complete qualification every other
      // surface uses -- not a second claim that it halted.
      case 'subagent-cancelled':
      case 'subagent-end':
        console.log(c.dim(`  ${ev.type} ${ev.id ?? ''} ${truncate(String(ev.description ?? ''), 80)}`));
        break;
      case 'error':
        console.log(c.red(`  error: ${truncate(String(ev.error ?? ''), 300)}`));
        break;
      case 'final':
        process.stdout.write('\n');
        break;
      case 'usage-total':
        console.log(c.dim(`  tokens ${ev.inputTokens ?? 0} in / ${ev.outputTokens ?? 0} out${ev.costUsd != null ? ` · $${Number(ev.costUsd).toFixed(4)}` : ''}`));
        break;
      default:
        break;
    }
  });

  client.on('error', (err) => {
    console.log(c.dim(`session socket: ${err?.message ?? err}`));
  });

  client.on('close', () => {
    if (done) return;
    done = true;
    close();
    console.log(c.dim(`\n${resolved.id} closed its session socket`));
    settle({ code: 0, id: resolved.id, ended: true });
  });

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.once(sig, () => {
      if (done) return;
      detach();
    });
  }

  // `once` is for scripted callers that want to end when the session ends; a
  // human always ends by detaching, which never stops the worker.
  if (once) return finished.then(() => ({ code: 0, id: resolved.id, ended: true }));
  return finished;
}

export { replayTail as _replayTail, readPidFile as _readPidFile };
