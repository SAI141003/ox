// A real terminal for the app: your shell in a pseudo-terminal, so full-screen
// programs (vim, htop, less, a password prompt) work, with no native module.
// On macOS and Linux a few lines of Python's standard `pty` module hold the
// terminal; resizes go over a side pipe (fd 3). On Windows, where that is not
// available, the shell runs on plain pipes (line-based programs only).
//
// Sessions live in this process; the app reaches them through /ox/term routes
// (same local-only guard as every other app route).
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

export const PTY_HELPER = String.raw`
import os, pty, sys, select, fcntl, termios, struct, signal
cols, rows, shell = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]
pid, fd = pty.fork()
if pid == 0:
    os.environ['TERM'] = 'xterm-256color'
    os.environ['COLORTERM'] = 'truecolor'
    os.execvp(shell, [shell, '-l'])
def size(c, r):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', r, c, 0, 0))
size(cols, rows)
ins = [0, 3]
ctl = b''
while True:
    try:
        r, _, _ = select.select([fd] + ins, [], [])
    except InterruptedError:
        continue
    if fd in r:
        try:
            data = os.read(fd, 65536)
        except OSError:
            break
        if not data:
            break
        os.write(1, data)
    if 0 in r:
        data = os.read(0, 65536)
        if not data:
            ins.remove(0)
            os.kill(pid, signal.SIGHUP)
        else:
            os.write(fd, data)
    if 3 in r:
        data = os.read(3, 1024)
        if not data:
            ins.remove(3)
        ctl += data
        while b'\n' in ctl:
            line, ctl = ctl.split(b'\n', 1)
            try:
                c, rr = map(int, line.split())
                size(c, rr)
            except Exception:
                pass
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status) if hasattr(os, 'waitstatus_to_exitcode') else 0)
`;

const sessions = new Map();

export class TermSession extends EventEmitter {
  constructor({ cwd = os.homedir(), cols = 100, rows = 30, shell = null } = {}) {
    super();
    this.id = randomUUID();
    this.cwd = cwd;
    this.buffer = '';
    this.exited = null;
    this.decoder = new StringDecoder('utf8');  // a character split across reads stays whole
    const env = { ...process.env, TERM: 'xterm-256color' };
    delete env.NODE_TEST_CONTEXT;
    if (process.platform === 'win32') {
      this.child = spawn(shell || process.env.ComSpec || 'cmd.exe', [], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
      this.child.stderr.on('data', (d) => this.out(d));
      this.pty = false;
    } else {
      const sh = shell || process.env.SHELL || '/bin/zsh';
      const py = process.env.OX_PYTHON || 'python3';
      this.child = spawn(py, ['-c', PTY_HELPER, String(cols), String(rows), sh], { cwd, env, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
      this.child.stderr.on('data', (d) => this.out(d));
      this.pty = true;
    }
    this.child.stdout.on('data', (d) => this.out(d));
    this.child.on('error', (e) => this.out(`\r\n[the terminal could not start: ${e.message}]\r\n`));
    this.child.on('close', (code) => { this.exited = code ?? 0; this.emit('exit', this.exited); sessions.delete(this.id); });
  }

  out(d) {
    const s = typeof d === 'string' ? d : this.decoder.write(d);
    if (!s) return;
    // The last ~200 KB, so a page that opens late still sees the screen.
    this.buffer = (this.buffer + s).slice(-200_000);
    this.emit('data', s);
  }

  write(s) { if (this.exited == null) try { this.child.stdin.write(s); } catch {} }

  resize(cols, rows) {
    cols = Math.max(10, Math.min(500, Math.floor(cols))); rows = Math.max(3, Math.min(200, Math.floor(rows)));
    if (this.pty && this.exited == null) try { this.child.stdio[3].write(`${cols} ${rows}\n`); } catch {}
  }

  kill() { try { this.child.stdin.end(); } catch {} setTimeout(() => { try { this.child.kill('SIGKILL'); } catch {} }, 1500).unref?.(); }
}

export function openTerm(opts) {
  const t = new TermSession(opts);
  sessions.set(t.id, t);
  return t;
}
export const getTerm = (id) => sessions.get(String(id)) ?? null;
export const listTerms = () => [...sessions.values()].map((t) => ({ id: t.id, cwd: t.cwd, pty: t.pty }));
export function closeAllTerms() { for (const t of sessions.values()) t.kill(); }
