// src/terminal.js — Built-in terminal with agent awareness.
// ESM, node built-ins only.

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import { detectShell } from './shell.js';

export const TERMINAL_SCHEMA_VERSION = '1.0.0';

// Resolve the bundled agent module relative to THIS file, not the session cwd.
const AGENT_URL = new URL('./agent.js', import.meta.url);

const MAX_OUTPUT_LINES = 1000;
const MAX_OUTPUT_CHARS = 1024 * 1024;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

function stripAnsi(str) {
  return String(str)
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b[()][0-9A-Za-z]/g, '');
}

export function formatTerminalOutput(lines) {
  if (Array.isArray(lines)) return lines.map(l => stripAnsi(l)).join('\n');
  return stripAnsi(lines);
}

export class TerminalSession extends EventEmitter {
  constructor(cwd, opts = {}) {
    super();
    this.cwd = cwd || process.cwd();
    this.cols = opts.cols || DEFAULT_COLS;
    this.rows = opts.rows || DEFAULT_ROWS;
    this.shell = opts.shell || detectShell().path;
    this.outputBuffer = [];
    this._proc = null;
    this._state = null;
    this._outputCallbacks = [];
    this._closed = false;
    this._spawnProcess = opts.spawnProcess || spawn;
  }

  _start(file, args, env) {
    if (this._proc) this.kill();
    this.outputBuffer = [];
    this._closed = true;
    const proc = this._spawnProcess(file, args, {
      cwd: this.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const state = { proc, output: '', done: false, cancel: null };
    this._state = state;
    this._proc = proc;
    this._closed = false;
    proc.on('error', e => {
      if (state.cancel) state.cancel(e);
      else state.done = true;
      this._clear(proc);
      if (this._state === state && this.listenerCount('error') > 0) this.emit('error', e);
    });
    proc.on('close', code => {
      this._clear(proc);
      if (this._state === state) this.emit('close', code);
    });
    return state;
  }

  _clear(proc) {
    if (this._proc === proc) {
      this._proc = null;
      this._closed = true;
    }
  }

  _spawn(command) {
    const state = this._start(this.shell, ['-c', command], {
      ...process.env, TERM: 'xterm-256color', COLUMNS: String(this.cols), LINES: String(this.rows),
    });
    this._streams(state);
    return state;
  }

  _streams(state, consume = () => {}) {
    const stdout = new StringDecoder('utf8');
    const stderr = new StringDecoder('utf8');
    const push = (decoder, data, isStdout) => {
      if (state.done) return;
      const text = data === undefined ? decoder.end() : decoder.write(data);
      this._handleData(text, state);
      if (isStdout) consume(text);
    };
    state.proc.stdout.on('data', d => push(stdout, d, true));
    state.proc.stderr.on('data', d => push(stderr, d, false));
    state.flush = () => {
      push(stdout, undefined, true);
      push(stderr, undefined, false);
    };
  }

  _handleData(text, state) {
    if (!text || state.done) return;
    state.output = (state.output + text).slice(-MAX_OUTPUT_CHARS).split('\n').slice(-MAX_OUTPUT_LINES).join('\n');
    if (this._state !== state) return;
    this.outputBuffer = state.output.split('\n');
    for (const cb of this._outputCallbacks) cb(text);
    this.emit('output', text);
  }

  _wait(state, result) {
    return new Promise((resolve, reject) => {
      const settle = (error, value) => {
        if (state.done) return;
        state.done = true;
        state.cancel = null;
        if (error) reject(error);
        else resolve(value);
      };
      state.cancel = error => settle(error);
      state.proc.once('close', code => {
        if (state.done) return;
        try {
          state.flush();
          settle(null, result(code));
        } catch (e) { settle(e); }
      });
    });
  }

  write(data) {
    if (!this._proc) this._spawn('cat');
    this._proc.stdin.write(data);
  }

  resize(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    if (this._proc) {
      try { process.kill(this._proc.pid, 'SIGWINCH'); } catch {}
    }
  }

  getOutput() {
    return this.outputBuffer.slice();
  }

  kill() {
    const proc = this._proc;
    if (proc) {
      const state = this._state;
      if (state.cancel) state.cancel(new Error('Terminal process cancelled'));
      state.done = true;
      this._clear(proc);
      try { proc.kill('SIGTERM'); } catch {}
      try { proc.stdin && proc.stdin.end(); } catch {}
    }
    if (!this._proc) this._closed = true;
  }

  onOutput(callback) {
    this._outputCallbacks.push(callback);
    return () => {
      const idx = this._outputCallbacks.indexOf(callback);
      if (idx >= 0) this._outputCallbacks.splice(idx, 1);
    };
  }

  async run(command) {
    const state = this._spawn(command);
    return this._wait(state, code => {
      if (code !== 0) throw new Error(`Command exited with code ${code}\n${state.output}`);
      return { exitCode: code, output: state.output };
    });
  }

  async runAgent(task, opts = {}) {
    const target = opts.target ?? {};
    const inline = `
      import(${JSON.stringify(AGENT_URL.href)}).then(async (m) => {
        const events = m.runAgent({
          target: ${JSON.stringify(target)},
          messages: [{ role: 'user', content: ${JSON.stringify(String(task ?? ''))} }],
          ctx: { cwd: process.cwd() },
        });
        for await (const ev of events) {
          if (ev && ev.type === 'text-delta') process.stdout.write(JSON.stringify({ t: 'delta', text: ev.text }) + '\\n');
          else if (ev && ev.type === 'final') process.stdout.write(JSON.stringify({ t: 'final', text: ev.message?.content ?? '' }) + '\\n');
          else if (ev && ev.type === 'error') {
            process.stdout.write(JSON.stringify({ t: 'error', error: ev.error }) + '\\n');
            process.exitCode = 1;
          }
        }
      }).catch((e) => { process.stderr.write(String(e?.message ?? e)); process.exitCode = 1; });
    `;
    const state = this._start(process.execPath, ['-e', inline], { ...process.env });
    let lastText = '';
    let lastError;
    let sawError = false;
    let sawFinal = false;
    let malformed = false;
    let buf = '';
    const parseLine = line => {
      if (!line.trim()) return;
      try {
        const ev = JSON.parse(line);
        if (ev?.t === 'error') {
          sawError = true;
          lastError = ev.error;
        } else if ((ev?.t === 'final' || ev?.t === 'delta') && typeof ev.text === 'string') {
          if (ev.t === 'final') {
            sawFinal = true;
            lastText = ev.text;
          }
        } else malformed = true;
      } catch { malformed = true; }
    };
    this._streams(state, text => {
      if (malformed) return;
      buf += text;
      let newline;
      while ((newline = buf.indexOf('\n')) >= 0) {
        if (newline > MAX_OUTPUT_CHARS) { malformed = true; buf = ''; return; }
        parseLine(buf.slice(0, newline));
        buf = buf.slice(newline + 1);
      }
      if (buf.length > MAX_OUTPUT_CHARS) { malformed = true; buf = ''; }
    });
    return this._wait(state, code => {
      parseLine(buf);
      buf = '';
      if (sawError) throw new Error(`Agent error: ${lastError ?? ''}`);
      if (malformed) throw new Error('Agent emitted malformed protocol output');
      if (code !== 0) throw new Error(`Agent exited with code ${code}`);
      if (!sawFinal) throw new Error('Agent did not report a final result');
      return { exitCode: code, output: lastText };
    });
  }
}

export function createTerminalSession(cwd, opts) {
  return new TerminalSession(cwd, opts);
}
