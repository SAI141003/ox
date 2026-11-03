// ox's own terminal emulator: a VT100/xterm screen model and a small DOM
// renderer, enough for shells, prompts, colours, vim, less, htop and npm's
// progress lines. No dependencies; the Screen half runs in Node for tests.
//
//   const screen = new Screen(cols, rows, { reply: (s) => send(s) });
//   screen.write(data);            // bytes from the pty, as text
//   screen.text()                  // what is on screen, for tests
//   mountTerminal(el, { send, resize }) → { write, fit, focus }

const DEFAULT = Object.freeze({ fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, inverse: false });
const blank = (attr = DEFAULT) => ({ ch: ' ', attr });
const row = (cols, attr) => Array.from({ length: cols }, () => blank(attr));

export class Screen {
  constructor(cols = 80, rows = 24, { reply = () => {}, scrollback = 2000 } = {}) {
    this.cols = cols; this.rows = rows; this.reply = reply; this.maxBack = scrollback;
    this.main = { lines: Array.from({ length: rows }, () => row(cols)), back: [] };
    this.alt = { lines: Array.from({ length: rows }, () => row(cols)), back: [] };
    this.buf = this.main;
    this.x = 0; this.y = 0; this.attr = DEFAULT; this.saved = null;
    this.top = 0; this.bottom = rows - 1;
    this.appCursor = false; this.cursorVisible = true; this.autowrap = true; this.wrapPending = false; this.bracketed = false;
    this.state = 'normal'; this.seq = '';
    this.title = '';
    this.dirty = true;
  }

  get lines() { return this.buf.lines; }
  get scrollback() { return this.buf.back; }

  resize(cols, rows) {
    for (const b of [this.main, this.alt]) {
      for (const l of b.lines) { while (l.length < cols) l.push(blank()); l.length = cols; }
      while (b.lines.length < rows) b.lines.push(row(cols));
      while (b.lines.length > rows) { const l = b.lines.shift(); if (b === this.main) this.pushBack(l); if (this.y > 0) this.y--; }
    }
    this.cols = cols; this.rows = rows; this.top = 0; this.bottom = rows - 1;
    this.x = Math.min(this.x, cols - 1); this.y = Math.min(this.y, rows - 1);
    this.dirty = true;
  }

  pushBack(l) { if (this.buf !== this.main) return; this.main.back.push(l); if (this.main.back.length > this.maxBack) this.main.back.shift(); }

  scrollUp(n = 1) {
    for (let i = 0; i < n; i++) {
      const gone = this.lines.splice(this.top, 1)[0];
      if (this.top === 0) this.pushBack(gone);
      this.lines.splice(this.bottom, 0, row(this.cols, this.bgAttr()));
    }
  }
  scrollDown(n = 1) {
    for (let i = 0; i < n; i++) {
      this.lines.splice(this.bottom, 1);
      this.lines.splice(this.top, 0, row(this.cols, this.bgAttr()));
    }
  }
  bgAttr() { return this.attr.bg ? { ...DEFAULT, bg: this.attr.bg } : DEFAULT; }

  newline() {
    this.wrapPending = false;
    if (this.y === this.bottom) this.scrollUp();
    else if (this.y < this.rows - 1) this.y++;
  }

  put(ch) {
    if (this.wrapPending && this.autowrap) { this.x = 0; this.newline(); }
    this.wrapPending = false;
    this.lines[this.y][this.x] = { ch, attr: this.attr };
    if (this.x === this.cols - 1) this.wrapPending = true; else this.x++;
  }

  write(data) {
    for (const ch of String(data)) this.feed(ch);
    this.dirty = true;
  }

  feed(ch) {
    const c = ch.codePointAt(0);
    if (this.state === 'normal') {
      if (c === 0x1b) { this.state = 'esc'; return; }
      if (c === 0x0d) { this.x = 0; this.wrapPending = false; return; }
      if (c === 0x0a || c === 0x0b || c === 0x0c) { this.newline(); return; }
      if (c === 0x08) { if (this.x > 0) this.x--; this.wrapPending = false; return; }
      if (c === 0x09) { this.x = Math.min(this.cols - 1, (Math.floor(this.x / 8) + 1) * 8); return; }
      if (c < 0x20 || c === 0x7f) return;  // bell and other controls
      this.put(ch);
      return;
    }
    if (this.state === 'esc') {
      this.state = 'normal';
      if (ch === '[') { this.state = 'csi'; this.seq = ''; return; }
      if (ch === ']') { this.state = 'osc'; this.seq = ''; return; }
      if (ch === '(' || ch === ')' || ch === '*' || ch === '+') { this.state = 'charset'; return; }
      if (ch === '7') { this.saveCursor(); return; }
      if (ch === '8') { this.restoreCursor(); return; }
      if (ch === 'D') { this.newline(); return; }
      if (ch === 'E') { this.x = 0; this.newline(); return; }
      if (ch === 'M') { if (this.y === this.top) this.scrollDown(); else if (this.y > 0) this.y--; return; }
      if (ch === 'c') { this.reset(); return; }
      return;  // = > and others: no visible effect
    }
    if (this.state === 'charset') { this.state = 'normal'; return; }
    if (this.state === 'osc') {
      if (c === 0x07) { this.osc(this.seq); this.state = 'normal'; return; }
      if (c === 0x1b) { this.state = 'osc-esc'; return; }
      if (this.seq.length < 4096) this.seq += ch;
      return;
    }
    if (this.state === 'osc-esc') { this.osc(this.seq); this.state = 'normal'; if (ch !== '\\') this.feed(ch); return; }
    if (this.state === 'csi') {
      if (c >= 0x40 && c <= 0x7e) { this.state = 'normal'; this.csi(this.seq, ch); return; }
      if (this.seq.length < 256) this.seq += ch;
    }
  }

  osc(s) { const m = /^(?:0|2);(.*)$/s.exec(s); if (m) this.title = m[1]; }

  saveCursor() { this.saved = { x: this.x, y: this.y, attr: this.attr }; }
  restoreCursor() { if (this.saved) { this.x = this.saved.x; this.y = this.saved.y; this.attr = this.saved.attr; } this.wrapPending = false; }

  reset() {
    this.buf = this.main; this.main.lines = Array.from({ length: this.rows }, () => row(this.cols));
    this.x = 0; this.y = 0; this.attr = DEFAULT; this.top = 0; this.bottom = this.rows - 1;
    this.appCursor = false; this.cursorVisible = true; this.autowrap = true; this.wrapPending = false;
  }

  erase(line, from, to) { for (let i = Math.max(0, from); i < Math.min(this.cols, to); i++) line[i] = blank(this.bgAttr()); }

  csi(seq, final) {
    const priv = /^[?>=]/.test(seq) ? seq[0] : '';
    const ps = (priv ? seq.slice(1) : seq).replace(/[^0-9;:]/g, '').split(';').map((p) => (p === '' ? NaN : parseInt(p, 10)));
    const p = (i, d = 1) => (Number.isFinite(ps[i]) && ps[i] > 0 ? ps[i] : d);
    const clampY = () => { this.y = Math.max(0, Math.min(this.rows - 1, this.y)); };
    const clampX = () => { this.x = Math.max(0, Math.min(this.cols - 1, this.x)); };
    this.wrapPending = false;
    switch (final) {
      case 'A': this.y = Math.max(this.y >= this.top ? this.top : 0, this.y - p(0)); break;
      case 'B': this.y = Math.min(this.y <= this.bottom ? this.bottom : this.rows - 1, this.y + p(0)); break;
      case 'C': this.x += p(0); clampX(); break;
      case 'D': this.x -= p(0); clampX(); break;
      case 'E': this.x = 0; this.y += p(0); clampY(); break;
      case 'F': this.x = 0; this.y -= p(0); clampY(); break;
      case 'G': case '`': this.x = p(0) - 1; clampX(); break;
      case 'd': this.y = p(0) - 1; clampY(); break;
      case 'H': case 'f': this.y = p(0) - 1; this.x = p(1) - 1; clampY(); clampX(); break;
      case 'J': {
        const m = Number.isFinite(ps[0]) ? ps[0] : 0;
        if (m === 0) { this.erase(this.lines[this.y], this.x, this.cols); for (let i = this.y + 1; i < this.rows; i++) this.erase(this.lines[i], 0, this.cols); }
        else if (m === 1) { this.erase(this.lines[this.y], 0, this.x + 1); for (let i = 0; i < this.y; i++) this.erase(this.lines[i], 0, this.cols); }
        else { for (let i = 0; i < this.rows; i++) this.erase(this.lines[i], 0, this.cols); if (m === 3) this.buf.back = []; }
        break;
      }
      case 'K': {
        const m = Number.isFinite(ps[0]) ? ps[0] : 0;
        const l = this.lines[this.y];
        if (m === 0) this.erase(l, this.x, this.cols); else if (m === 1) this.erase(l, 0, this.x + 1); else this.erase(l, 0, this.cols);
        break;
      }
      case 'L': if (this.y >= this.top && this.y <= this.bottom) for (let i = 0; i < p(0); i++) { this.lines.splice(this.bottom, 1); this.lines.splice(this.y, 0, row(this.cols, this.bgAttr())); } break;
      case 'M': if (this.y >= this.top && this.y <= this.bottom) for (let i = 0; i < p(0); i++) { this.lines.splice(this.y, 1); this.lines.splice(this.bottom, 0, row(this.cols, this.bgAttr())); } break;
      case 'P': { const l = this.lines[this.y]; l.splice(this.x, p(0)); while (l.length < this.cols) l.push(blank(this.bgAttr())); break; }
      case '@': { const l = this.lines[this.y]; for (let i = 0; i < p(0); i++) l.splice(this.x, 0, blank(this.bgAttr())); l.length = this.cols; break; }
      case 'X': this.erase(this.lines[this.y], this.x, this.x + p(0)); break;
      case 'S': this.scrollUp(p(0)); break;
      case 'T': this.scrollDown(p(0)); break;
      case 'r': this.top = p(0) - 1; this.bottom = Math.min(this.rows - 1, p(1, this.rows) - 1); if (this.top >= this.bottom) { this.top = 0; this.bottom = this.rows - 1; } this.x = 0; this.y = 0; break;
      case 's': this.saveCursor(); break;
      case 'u': this.restoreCursor(); break;
      case 'm': this.sgr(ps); break;
      case 'n': if (ps[0] === 6) this.reply(`\x1b[${this.y + 1};${this.x + 1}R`); else if (ps[0] === 5) this.reply('\x1b[0n'); break;
      case 'c': if (!priv) this.reply('\x1b[?1;2c'); break;
      case 'h': case 'l': {
        const on = final === 'h';
        if (priv === '?') for (const m of ps) {
          if (m === 1) this.appCursor = on;
          else if (m === 7) this.autowrap = on;
          else if (m === 25) this.cursorVisible = on;
          else if (m === 2004) this.bracketed = on;
          else if (m === 47 || m === 1047 || m === 1049) {
            if (on && this.buf !== this.alt) {
              if (m === 1049) this.saveCursor();
              this.buf = this.alt; this.alt.lines = Array.from({ length: this.rows }, () => row(this.cols));
            } else if (!on && this.buf === this.alt) {
              this.buf = this.main; if (m === 1049) this.restoreCursor();
            }
          }
        }
        break;
      }
      default: break;
    }
  }

  sgr(ps) {
    if (!ps.length || (ps.length === 1 && !Number.isFinite(ps[0]))) { this.attr = DEFAULT; return; }
    const a = { ...this.attr };
    for (let i = 0; i < ps.length; i++) {
      const n = Number.isFinite(ps[i]) ? ps[i] : 0;
      if (n === 0) Object.assign(a, DEFAULT);
      else if (n === 1) a.bold = true;
      else if (n === 2) a.dim = true;
      else if (n === 3) a.italic = true;
      else if (n === 4) a.underline = true;
      else if (n === 7) a.inverse = true;
      else if (n === 22) { a.bold = false; a.dim = false; }
      else if (n === 23) a.italic = false;
      else if (n === 24) a.underline = false;
      else if (n === 27) a.inverse = false;
      else if (n >= 30 && n <= 37) a.fg = n - 30;
      else if (n >= 90 && n <= 97) a.fg = n - 90 + 8;
      else if (n === 39) a.fg = null;
      else if (n >= 40 && n <= 47) a.bg = n - 40;
      else if (n >= 100 && n <= 107) a.bg = n - 100 + 8;
      else if (n === 49) a.bg = null;
      else if (n === 38 || n === 48) {
        const key = n === 38 ? 'fg' : 'bg';
        if (ps[i + 1] === 5) { a[key] = ps[i + 2] ?? 0; i += 2; }
        else if (ps[i + 1] === 2) { a[key] = `rgb(${ps[i + 2] ?? 0},${ps[i + 3] ?? 0},${ps[i + 4] ?? 0})`; i += 4; }
      }
    }
    this.attr = Object.freeze(a);
  }

  /** The screen as plain text (trailing spaces trimmed). */
  text({ withBack = false } = {}) {
    const ls = withBack ? [...this.buf.back, ...this.lines] : this.lines;
    return ls.map((l) => l.map((c) => c.ch).join('').replace(/\s+$/, '')).join('\n').replace(/\n+$/, '');
  }
}

// ---------------------------------------------------------------------------
// Keys → bytes
// ---------------------------------------------------------------------------

export function keyToBytes(e, { appCursor = false } = {}) {
  const ss3 = appCursor ? '\x1bO' : '\x1b[';
  const map = {
    Enter: '\r', Backspace: e.altKey ? '\x1b\x7f' : '\x7f', Tab: e.shiftKey ? '\x1b[Z' : '\t', Escape: '\x1b',
    ArrowUp: `${ss3}A`, ArrowDown: `${ss3}B`, ArrowRight: `${ss3}C`, ArrowLeft: `${ss3}D`,
    Home: `${ss3}H`, End: `${ss3}F`, PageUp: '\x1b[5~', PageDown: '\x1b[6~', Delete: '\x1b[3~', Insert: '\x1b[2~',
    F1: '\x1bOP', F2: '\x1bOQ', F3: '\x1bOR', F4: '\x1bOS',
  };
  if (e.metaKey) return null;   // ⌘C / ⌘V / ⌘K stay the app's
  if (map[e.key]) {
    if (e.altKey && /^Arrow(Left|Right)$/.test(e.key)) return e.key === 'ArrowLeft' ? '\x1bb' : '\x1bf';
    return map[e.key];
  }
  if (e.ctrlKey && e.key.length === 1) {
    const k = e.key.toLowerCase();
    if (k >= 'a' && k <= 'z') return String.fromCharCode(k.charCodeAt(0) - 96);
    if (k === '[') return '\x1b'; if (k === '\\') return '\x1c'; if (k === ']') return '\x1d'; if (k === ' ' || k === '@') return '\x00';
    return null;
  }
  if (e.key.length === 1 || [...e.key].length === 1) return (e.altKey ? '\x1b' : '') + e.key;
  return null;
}

// ---------------------------------------------------------------------------
// The DOM side
// ---------------------------------------------------------------------------

const PALETTE = ['#1d1f21', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#d0d0d0',
  '#5c6370', '#ff7b86', '#b5e890', '#ffd68a', '#82c4ff', '#de9bf0', '#7fd8e4', '#ffffff'];
export function colour(c) {
  if (c == null) return null;
  if (typeof c === 'string') return c;
  if (c < 16) return PALETTE[c];
  if (c < 232) { const n = c - 16, v = (x) => (x ? x * 40 + 55 : 0); return `rgb(${v(Math.floor(n / 36))},${v(Math.floor(n / 6) % 6)},${v(n % 6)})`; }
  const g = (c - 232) * 10 + 8; return `rgb(${g},${g},${g})`;
}
const escHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function styleOf(a) {
  let fg = colour(a.fg), bg = colour(a.bg);
  if (a.bold && typeof a.fg === 'number' && a.fg < 8) fg = colour(a.fg + 8);
  if (a.inverse) { [fg, bg] = [bg || 'var(--term-bg)', fg || 'var(--term-fg)']; }
  let s = '';
  if (fg) s += `color:${fg};`;
  if (bg) s += `background:${bg};`;
  if (a.bold) s += 'font-weight:700;';
  if (a.dim) s += 'opacity:.6;';
  if (a.italic) s += 'font-style:italic;';
  if (a.underline) s += 'text-decoration:underline;';
  return s;
}

export function lineHtml(line, cursorX = -1) {
  let out = '', run = '', cur = null;
  const flush = () => { if (run) out += cur ? `<span style="${cur}">${escHtml(run)}</span>` : escHtml(run); run = ''; };
  line.forEach((cell, i) => {
    if (i === cursorX) { flush(); out += `<span class="term-cursor">${escHtml(cell.ch)}</span>`; cur = null; return; }
    const s = cell.attr === DEFAULT ? '' : styleOf(cell.attr);
    if (s !== (cur ?? '')) { flush(); cur = s || null; }
    run += cell.ch;
  });
  flush();
  return out;
}

/**
 * A terminal in `el`. send(bytes) gets what the user types; resize(cols, rows)
 * is called when the size changes. → { write, fit, focus, screen }
 */
export function mountTerminal(el, { send, resize = () => {} }) {
  el.classList.add('term');
  el.tabIndex = 0;
  el.innerHTML = '<div class="term-rows"></div><span class="term-measure">MMMMMMMMMM</span>';
  const rowsEl = el.querySelector('.term-rows');
  const measure = el.querySelector('.term-measure');
  const screen = new Screen(80, 24, { reply: send });
  let raf = 0, stick = true;
  const draw = () => {
    raf = 0;
    const back = screen.buf === screen.main ? screen.scrollback.slice(-500) : [];
    const cy = screen.cursorVisible && document.activeElement === el ? screen.y : -1;
    rowsEl.innerHTML = [...back.map((l) => lineHtml(l)), ...screen.lines.map((l, i) => lineHtml(l, i === cy ? screen.x : -1))]
      .map((h) => `<div class="term-row">${h || ' '}</div>`).join('');
    if (stick) el.scrollTop = el.scrollHeight;
  };
  const schedule = () => { if (!raf) raf = requestAnimationFrame(draw); };
  el.addEventListener('scroll', () => { stick = el.scrollTop + el.clientHeight >= el.scrollHeight - 4; });
  el.addEventListener('keydown', (e) => {
    const b = keyToBytes(e, { appCursor: screen.appCursor });
    if (b == null) return;
    e.preventDefault();
    stick = true;
    send(b);
  });
  el.addEventListener('paste', (e) => {
    const t = e.clipboardData?.getData('text') ?? '';
    if (!t) return;
    e.preventDefault();
    send(screen.bracketed ? `\x1b[200~${t}\x1b[201~` : t);
  });
  el.addEventListener('focus', schedule);
  el.addEventListener('blur', schedule);
  const fit = () => {
    const w = measure.getBoundingClientRect().width / 10 || 8, h = measure.getBoundingClientRect().height || 16;
    const cols = Math.max(20, Math.floor((el.clientWidth - 16) / w)), rows = Math.max(5, Math.floor((el.clientHeight - 12) / h));
    if (cols !== screen.cols || rows !== screen.rows) { screen.resize(cols, rows); resize(cols, rows); schedule(); }
  };
  new ResizeObserver(fit).observe(el);
  return { screen, write: (d) => { screen.write(d); schedule(); }, fit, focus: () => el.focus() };
}
