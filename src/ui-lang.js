// OX Canvas: a compact, line-oriented UI language the model writes instead of
// JSON, rendered by ox itself in the terminal and in OX Island.
//
//   root = Stack([kpis, tbl])
//   kpis = Row([Stat("Tests", "412"), Stat("Failing", "3", -2)])
//   tbl = Table([Col("File", rows.file), Col("Lines", rows.n, "number")])
//   rows = Query("grep", {pattern: "TODO", path: "src"}, {lines: []})
//
// Syntax-compatible with the OpenUI Lang v0.5 core (thesysdev/openui, MIT), so
// models that already know that format write this one, but implemented here
// with zero dependencies and built for an agent rather than a web app:
//   - every statement is validated; bad ones are dropped and reported back to
//     the model in a few tokens so it re-sends only those lines (repair loop,
//     no gateway needed);
//   - a later call merges by statement name (patch), so edits cost a few lines;
//   - Query() binds to ox's read-only tools, so live data obeys ox's approval
//     policy; Mutation() never runs without the user;
//   - @Set/@Reset/@Run(query) actions re-render locally for zero tokens.

// ---------------------------------------------------------------- library

// Param spec: [name, type, optional?]. Types: str num bool any node nodes
// list action obj, or 'a|b|c' for an enum.
export const LIBRARY = {
  Stack: { params: [['children', 'nodes'], ['gap', 'tight|normal|loose', true]], desc: 'vertical layout' },
  Row: { params: [['children', 'nodes']], desc: 'side-by-side layout' },
  Card: { params: [['title', 'str'], ['children', 'nodes'], ['tone', 'plain|info|success|warning|error', true]], desc: 'boxed section' },
  Header: { params: [['title', 'str'], ['subtitle', 'str', true]], desc: 'section title' },
  Text: { params: [['text', 'any'], ['style', 'body|muted|strong|large|small', true], ['color', 'str', true]], desc: 'paragraph' },
  Stat: { params: [['label', 'str'], ['value', 'any'], ['delta', 'num', true], ['unit', 'str', true]], desc: 'KPI number' },
  Fields: { params: [['pairs', 'obj']], desc: 'aligned key: value lines' },
  Table: { params: [['columns', 'nodes']], desc: 'table built from Col()s' },
  Col: { params: [['label', 'str'], ['values', 'list'], ['type', 'text|number|currency|percent|status', true]], desc: 'table column', inner: true },
  BarChart: { params: [['labels', 'list'], ['values', 'list'], ['title', 'str', true]], desc: 'horizontal bars' },
  Sparkline: { params: [['values', 'list'], ['label', 'str', true]], desc: 'tiny trend line' },
  Progress: { params: [['label', 'str'], ['value', 'num'], ['max', 'num', true]], desc: 'progress bar' },
  List: { params: [['items', 'list'], ['ordered', 'bool', true]], desc: 'bullet list' },
  Callout: { params: [['tone', 'info|success|warning|error'], ['title', 'str'], ['text', 'str', true]], desc: 'highlighted note' },
  Badge: { params: [['text', 'any'], ['tone', 'plain|info|success|warning|error|purple|pink', true]], desc: 'small tag' },
  Code: { params: [['code', 'str'], ['lang', 'str', true]], desc: 'code block' },
  Diff: { params: [['diff', 'str']], desc: 'unified diff' },
  Divider: { params: [], desc: 'rule' },
  Button: { params: [['label', 'str'], ['action', 'action', true], ['tone', 'primary|plain|danger', true]], desc: 'clickable; no action = ask the assistant' },
  Buttons: { params: [['buttons', 'nodes']], desc: 'button row' },
  Select: { params: [['name', 'str'], ['value', 'any'], ['options', 'nodes']], desc: 'choice bound to a $var' },
  Option: { params: [['value', 'any'], ['label', 'str', true]], desc: 'Select option', inner: true },
  // Form controls (OpenUI's forms): each binds a $var, so every line that
  // reads it recomputes as the user types or drags, for zero tokens.
  Input: { params: [['label', 'str'], ['value', 'any'], ['type', 'number|text', true]], desc: 'field bound to a $var' },
  Slider: { params: [['label', 'str'], ['value', 'num'], ['min', 'num'], ['max', 'num'], ['step', 'num', true]], desc: 'slider bound to a $var' },
  // Answers composed like a page, in colour (ideas from open-intelligent-ui,
  // written here from scratch): titles, captions, grids, charts, drawings.
  SearchImage: { params: [['query', 'str'], ['aspect', 'num', true]], desc: 'a photo of the exact subject, found by name (aspect = width/height)' },
  Title: { params: [['text', 'any'], ['size', 'sm|md|lg|xl', true]], desc: 'heading' },
  Caption: { params: [['text', 'any']], desc: 'small muted label' },
  Column: { params: [['children', 'nodes'], ['gap', 'num', true]], desc: 'vertical group (also written Col([…]), as in OpenUI)' },
  Grid: { params: [['children', 'nodes'], ['cols', 'num', true]], desc: 'grid of cards or tiles' },
  Spacer: { params: [], desc: 'pushes the rest of a Row to the right' },
  Pressable: { params: [['children', 'nodes'], ['action', 'action', true], ['selected', 'bool', true]], desc: 'clickable area' },
  Checkbox: { params: [['label', 'str'], ['value', 'bool']], desc: 'tick bound to a $var' },
  Segmented: { params: [['value', 'any'], ['options', 'list']], desc: 'one-of choice bound to a $var' },
  Chart: { params: [['type', 'bar|line|area|pie|donut'], ['labels', 'list'], ['values', 'list'], ['title', 'str', true], ['format', 'number|currency|percent', true]], desc: 'chart in colour' },
  Svg: { params: [['children', 'nodes'], ['viewBox', 'str', true]], desc: 'drawing (about 240 wide)' },
  Rect: { params: [['x', 'num'], ['y', 'num'], ['w', 'num'], ['h', 'num'], ['fill', 'str', true], ['stroke', 'str', true], ['width', 'num', true]], desc: 'drawing rectangle', inner: true },
  Circle: { params: [['cx', 'num'], ['cy', 'num'], ['r', 'num'], ['fill', 'str', true], ['stroke', 'str', true]], desc: 'drawing circle', inner: true },
  Line: { params: [['x1', 'num'], ['y1', 'num'], ['x2', 'num'], ['y2', 'num'], ['stroke', 'str', true], ['width', 'num', true]], desc: 'drawing line', inner: true },
  Polygon: { params: [['points', 'str'], ['fill', 'str', true], ['stroke', 'str', true]], desc: 'drawing polygon ("x,y x,y …")', inner: true },
  SvgText: { params: [['text', 'any'], ['x', 'num'], ['y', 'num'], ['size', 'num', true], ['fill', 'str', true], ['anchor', 'start|middle|end', true]], desc: 'drawing label', inner: true },
};

// Named colours an answer may use (the app maps them to its palette; any #hex works too).
export const COLORS = 'ink|muted|surface|info|success|warning|danger|purple|pink|chart1|chart2|chart3|chart4|chart5|chart6'.split('|');

// Tools a Query() may call: read-only, no approval needed anywhere in ox.
export const QUERY_TOOLS = new Set(['read_file', 'list_dir', 'glob', 'grep']);

const BUILTINS = {
  Count: (a) => (Array.isArray(a) ? a.length : 0),
  Sum: (a) => nums(a).reduce((x, y) => x + y, 0),
  Avg: (a) => { const n = nums(a); return n.length ? n.reduce((x, y) => x + y, 0) / n.length : 0; },
  Min: (a) => { const n = nums(a); return n.length ? Math.min(...n) : 0; },
  Max: (a) => { const n = nums(a); return n.length ? Math.max(...n) : 0; },
  First: (a) => (Array.isArray(a) ? a[0] ?? null : null),
  Last: (a) => (Array.isArray(a) ? a[a.length - 1] ?? null : null),
  Round: (n, d = 0) => { const f = 10 ** (Number(d) || 0); return Math.round(Number(n) * f) / f; },
  Abs: (n) => Math.abs(Number(n)),
  Pow: (b, e) => Math.pow(Number(b), Number(e)),
  Clamp: (n, lo, hi) => Math.min(Number(hi), Math.max(Number(lo), Number(n))),
  Default: (v, d) => (v === null || v === undefined || v === '' || (typeof v === 'number' && !Number.isFinite(v)) ? d : v),
  Percent: (a, b) => (Number(b) ? Math.round((Number(a) / Number(b)) * 100) : 0),
  Range: (a, b, step = 1) => { const out = []; const st = Number(step) || 1; for (let x = Number(a); st > 0 ? x < Number(b) : x > Number(b); x += st) { out.push(x); if (out.length >= 1000) break; } return out; },
  Format: (n, kind = 'number', digits = null, currency = 'USD') => {
    const v = Number(n);
    if (!Number.isFinite(v)) return '';
    const d = digits == null ? undefined : Number(digits);
    if (kind === 'currency') return v.toLocaleString('en-US', { style: 'currency', currency: String(currency || 'USD'), maximumFractionDigits: d ?? 2, minimumFractionDigits: d ?? (Math.abs(v) >= 1000 ? 0 : 2) });
    if (kind === 'percent') return `${v.toLocaleString('en-US', { maximumFractionDigits: d ?? 1 })}%`;
    if (kind === 'compact') return v.toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: d ?? 1 });
    return v.toLocaleString('en-US', { maximumFractionDigits: d ?? 2 });
  },
  Plural: (n, word, plural = null) => `${n} ${Number(n) === 1 ? word : plural ?? `${word}s`}`,
  Includes: (a, v) => (Array.isArray(a) ? a.some((x) => x === v) : String(a ?? '').includes(String(v))),
  Toggle: (a, v) => { const l = Array.isArray(a) ? a : []; return l.includes(v) ? l.filter((x) => x !== v) : [...l, v]; },
  Append: (a, v) => [...(Array.isArray(a) ? a : []), v],
  Remove: (a, v) => (Array.isArray(a) ? a.filter((x) => x !== v) : []),
  GroupBy: (rows, key, field = null) => {
    const m = new Map();
    for (const r of Array.isArray(rows) ? rows : []) { const k = r?.[key]; m.set(k, (m.get(k) ?? 0) + (field ? Number(r?.[field]) || 0 : 1)); }
    return [...m].map(([k, v]) => ({ key: k, value: v }));
  },
  Upper: (t) => String(t ?? '').toUpperCase(),
  Today: () => new Date().toISOString().slice(0, 10),
  Sqrt: (n) => Math.sqrt(Number(n)),
  Floor: (n) => Math.floor(Number(n)),
  Ceil: (n) => Math.ceil(Number(n)),
  Join: (a, sep = ', ') => (Array.isArray(a) ? a.join(sep) : String(a ?? '')),
  Filter: (a, field, op, value) => (Array.isArray(a) ? a.filter((r) => compare(field == null ? r : r?.[field], op, value)) : []),
  Sort: (a, field, dir = 'asc') => {
    if (!Array.isArray(a)) return [];
    const k = (r) => (field == null ? r : r?.[field]);
    const s = [...a].sort((x, y) => (k(x) > k(y) ? 1 : k(x) < k(y) ? -1 : 0));
    return dir === 'desc' ? s.reverse() : s;
  },
};
const ACTION_STEPS = new Set(['Run', 'Set', 'Reset', 'ToAssistant', 'OpenUrl']);

function nums(a) {
  return (Array.isArray(a) ? a : []).map(Number).filter((n) => Number.isFinite(n));
}
function compare(l, op, r) {
  switch (op) {
    case '==': return l == r; // eslint-disable-line eqeqeq
    case '!=': return l != r; // eslint-disable-line eqeqeq
    case '>': return l > r;
    case '<': return l < r;
    case '>=': return l >= r;
    case '<=': return l <= r;
    case 'contains': return String(l ?? '').toLowerCase().includes(String(r ?? '').toLowerCase());
    default: return false;
  }
}

// ---------------------------------------------------------------- lexer

const PUNCT = ['==', '!=', '>=', '<=', '&&', '||', '(', ')', '[', ']', '{', '}', ',', ':', '.', '?', '=', '+', '-', '*', '/', '%', '>', '<', '!'];

function tokenize(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') { i++; continue; }
    if (ch === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== ch) {
        if (src[j] === '\\' && j + 1 < src.length) {
          const e = src[++j];
          s += e === 'n' ? '\n' : e === 't' ? '\t' : e;
        } else s += src[j];
        j++;
      }
      if (j >= src.length) throw new SyntaxError('unterminated string');
      out.push({ t: 'str', v: s });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      const m = /^[0-9]+(\.[0-9]+)?/.exec(src.slice(i));
      out.push({ t: 'num', v: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_$@]/.test(ch)) {
      const m = /^[$@]?[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
      if (!m) throw new SyntaxError(`unexpected '${ch}'`);
      const w = m[0];
      if (w[0] === '$') out.push({ t: 'state', v: w.slice(1) });
      else if (w[0] === '@') out.push({ t: 'builtin', v: w.slice(1) });
      else if (w === 'true' || w === 'false') out.push({ t: 'bool', v: w === 'true' });
      else if (w === 'null') out.push({ t: 'null', v: null });
      else out.push({ t: 'id', v: w });
      i += w.length;
      continue;
    }
    const p = PUNCT.find((q) => src.startsWith(q, i));
    if (!p) throw new SyntaxError(`unexpected '${ch}'`);
    out.push({ t: 'p', v: p });
    i += p.length;
  }
  return out;
}

// ---------------------------------------------------------------- parser

const BIN_PREC = { '||': 1, '&&': 2, '==': 3, '!=': 3, '>': 4, '<': 4, '>=': 4, '<=': 4, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6 };

function parseExpr(tokens) {
  let i = 0;
  const peek = () => tokens[i];
  const isP = (v) => peek()?.t === 'p' && peek().v === v;
  const expect = (v) => {
    if (!isP(v)) throw new SyntaxError(`expected '${v}'${peek() ? ` near '${peek().v}'` : ' before end of line'}`);
    i++;
  };
  function list(close) {
    const items = [];
    while (!isP(close)) {
      items.push(expr(0));
      if (isP(',')) i++;
      else break;
    }
    expect(close);
    return items;
  }
  function primary() {
    const tk = tokens[i++];
    if (!tk) throw new SyntaxError('unexpected end of expression');
    if (tk.t === 'str' || tk.t === 'num' || tk.t === 'bool' || tk.t === 'null') return { k: 'lit', v: tk.v };
    if (tk.t === 'state') return { k: 'state', name: tk.v };
    if (tk.t === 'builtin') { expect('('); return { k: 'builtin', name: tk.v, args: list(')') }; }
    if (tk.t === 'id') {
      if (isP('(')) { i++; return { k: 'call', name: tk.v, args: list(')') }; }
      return { k: 'ref', name: tk.v };
    }
    if (tk.t === 'p' && tk.v === '[') return { k: 'arr', items: list(']') };
    if (tk.t === 'p' && tk.v === '(') { const e = expr(0); expect(')'); return e; }
    if (tk.t === 'p' && tk.v === '{') {
      const entries = [];
      while (!isP('}')) {
        const key = tokens[i++];
        if (!key || !['id', 'str'].includes(key.t)) throw new SyntaxError('expected an object key');
        expect(':');
        entries.push([String(key.v), expr(0)]);
        if (isP(',')) i++;
        else break;
      }
      expect('}');
      return { k: 'obj', entries };
    }
    if (tk.t === 'p' && (tk.v === '!' || tk.v === '-')) return { k: 'un', op: tk.v, x: postfix(primary()) };
    throw new SyntaxError(`unexpected '${tk.v}'`);
  }
  function postfix(node) {
    for (;;) {
      if (isP('.')) {
        i++;
        const tk = tokens[i++];
        if (!tk || tk.t !== 'id') throw new SyntaxError('expected a field name after "."');
        node = { k: 'member', obj: node, prop: tk.v };
      } else if (isP('[')) {
        // steps[$step], row["name"]: an index into a list or a key into an object.
        i++;
        const at = expr(0);
        expect(']');
        node = { k: 'index', obj: node, at };
      } else return node;
    }
  }
  function expr(minPrec) {
    let left = postfix(primary());
    for (;;) {
      const tk = peek();
      if (tk?.t === 'p' && tk.v === '?' && minPrec === 0) {
        i++;
        const a = expr(0);
        expect(':');
        const b = expr(0);
        left = { k: 'tern', c: left, a, b };
        continue;
      }
      const prec = tk?.t === 'p' ? BIN_PREC[tk.v] : undefined;
      if (prec === undefined || prec < minPrec) break;
      i++;
      left = { k: 'bin', op: tk.v, l: left, r: expr(prec + 1) };
    }
    return left;
  }
  const node = expr(0);
  if (i < tokens.length) throw new SyntaxError(`unexpected '${tokens[i].v}'`);
  return node;
}

/** Strip ``` fences and split source into statements, joining lines while brackets are open. */
export function splitStatements(src) {
  const text = String(src ?? '').replace(/^\s*```[a-z-]*\s*$/gim, '');
  const out = [];
  let buf = '';
  let depth = 0;
  let startLine = 1;
  let line = 1;
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (!buf.trim()) startLine = line;
    buf += ch;
    if (quote) {
      if (ch === '\\') { buf += text[++i] ?? ''; continue; }
      if (ch === quote) quote = null;
      if (ch === '\n') line++;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth = Math.max(0, depth - 1);
    if (ch === '\n') {
      line++;
      // A line that opens with `name =` always starts a new statement, so one
      // unclosed bracket costs its own line and not every line after it.
      const nextIsStmt = /^[ \t]*\$?[A-Za-z_][A-Za-z0-9_]*[ \t]*=(?!=)/.test(text.slice(i + 1, text.indexOf('\n', i + 1) >>> 0));
      if (depth === 0 || nextIsStmt) {
        if (buf.trim()) out.push({ src: buf.trim(), line: startLine, open: depth > 0 });
        buf = '';
        depth = 0;
      }
    }
  }
  if (buf.trim()) out.push({ src: buf.trim(), line: startLine, open: depth > 0 || quote !== null });
  return out;
}

/**
 * Parse a program. Returns { stmts: Map(id -> {ast, src, line}), state: {name: default},
 * errors: [{line, id, code, msg}] }. Invalid statements are dropped, never thrown.
 * With { streaming: true } an unfinished last statement is skipped silently.
 */
export function parseProgram(src, { streaming = false } = {}) {
  const stmts = new Map();
  const state = {};
  const errors = [];
  for (const s of splitStatements(src)) {
    if (s.src.startsWith('//')) continue;
    const m = /^(\$?[A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)\s*([\s\S]*)$/.exec(s.src);
    if (!m) {
      if (!(streaming && s.open)) errors.push({ line: s.line, id: null, code: 'syntax', msg: 'expected `name = Expression`' });
      continue;
    }
    const [, id, body] = m;
    try {
      const ast = parseExpr(tokenize(body));
      if (id.startsWith('$')) {
        if (ast.k !== 'lit' && ast.k !== 'arr' && ast.k !== 'obj') throw new SyntaxError('a $variable default must be a literal');
        state[id.slice(1)] = literal(ast);
      } else {
        stmts.set(id, { ast, src: s.src, line: s.line });
      }
    } catch (e) {
      if (streaming && s.open) continue;
      errors.push({ line: s.line, id, code: 'syntax', msg: e.message });
    }
  }
  return { stmts, state, errors };
}

function literal(ast) {
  if (ast.k === 'lit') return ast.v;
  if (ast.k === 'arr') return ast.items.map(literal);
  if (ast.k === 'obj') return Object.fromEntries(ast.entries.map(([k, v]) => [k, literal(v)]));
  if (ast.k === 'un' && ast.op === '-' && ast.x.k === 'lit') return -ast.x.v;
  return null;
}

/** Merge a patch into an existing program by statement name: same name replaces, new names append. */
export function mergePrograms(base, patch) {
  const a = parseProgram(base);
  const b = parseProgram(patch);
  const lines = [];
  const seen = new Set();
  for (const [k, v] of Object.entries({ ...a.state, ...b.state })) lines.push(`$${k} = ${JSON.stringify(v)}`);
  for (const [id, s] of a.stmts) { lines.push((b.stmts.get(id) ?? s).src); seen.add(id); }
  for (const [id, s] of b.stmts) if (!seen.has(id)) lines.push(s.src);
  return lines.join('\n');
}

// ---------------------------------------------------------------- evaluation

function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length][b.length];
}
function suggest(name, pool) {
  let best = null;
  let bestD = Infinity;
  for (const p of pool) {
    const dist = editDistance(name.toLowerCase(), p.toLowerCase());
    if (dist < bestD) { bestD = dist; best = p; }
  }
  return bestD <= Math.max(2, Math.floor(name.length / 3)) ? best : null;
}

function typeOk(type, v) {
  if (v == null) return true;
  switch (type) {
    case 'str': return ['string', 'number', 'boolean'].includes(typeof v);
    case 'num': return Number.isFinite(Number(v));
    case 'bool': return typeof v === 'boolean';
    case 'list': return Array.isArray(v);
    case 'obj': return typeof v === 'object' && !Array.isArray(v);
    case 'node': return isNode(v);
    case 'nodes': return Array.isArray(v) || isNode(v);
    case 'action': return v?.kind === 'action';
    case 'any': return true;
    default: return type.includes('|') ? type.split('|').includes(String(v)) : true;
  }
}
const isNode = (v) => v && typeof v === 'object' && typeof v.type === 'string' && 'props' in v;

/**
 * Evaluate a parsed program to a render tree: { type, props } nodes.
 * env: { state, data: {queryId: result}, mutations: {id: {status, error}} }.
 * Returns { root, errors, queries: [{id, tool, args, refresh}], mutations: [...] }.
 */
export function evaluate(program, env = {}) {
  const errors = [];
  const queries = [];
  const mutations = [];
  const state = { ...program.state, ...(env.state ?? {}) };
  const data = env.data ?? {};
  const cache = new Map();
  const stack = new Set();
  const reported = new Set();
  const err = (id, code, msg) => {
    const key = `${id}|${code}|${msg}`;
    if (reported.has(key)) return;
    reported.add(key);
    errors.push({ line: program.stmts.get(id)?.line ?? null, id, code, msg });
  };

  // Queries and mutations are declared by statement, so collect them first.
  for (const [id, s] of program.stmts) {
    if (s.ast.k !== 'call' || (s.ast.name !== 'Query' && s.ast.name !== 'Mutation')) continue;
    const [toolN, argsN, defN, refN] = s.ast.args;
    const tool = toolN?.k === 'lit' ? String(toolN.v) : null;
    if (!tool) { err(id, 'query', `${s.ast.name} needs a tool name string first`); continue; }
    const args = argsN ? value(argsN, id) : {};
    if (s.ast.name === 'Query') {
      if (!QUERY_TOOLS.has(tool)) {
        err(id, 'query', `Query can only call read-only tools (${[...QUERY_TOOLS].join(', ')}); use Mutation("${tool}", …) behind a Button`);
        continue;
      }
      queries.push({ id, tool, args: args ?? {}, defaults: defN ? value(defN, id) : null, refresh: refN ? Number(value(refN, id)) || 0 : 0 });
    } else {
      mutations.push({ id, tool, args: args ?? {} });
    }
  }

  function resolve(id, from) {
    if (cache.has(id)) return cache.get(id);
    const s = program.stmts.get(id);
    if (!s) {
      const near = suggest(id, [...program.stmts.keys()]);
      err(from, 'ref', `\`${id}\` is never defined${near ? ` (did you mean \`${near}\`?)` : ''}`);
      return null;
    }
    if (stack.has(id)) { err(id, 'cycle', `\`${id}\` refers to itself`); return null; }
    stack.add(id);
    let v;
    if (s.ast.k === 'call' && s.ast.name === 'Query') {
      const q = queries.find((x) => x.id === id);
      v = data[id] ?? q?.defaults ?? null;
    } else if (s.ast.k === 'call' && s.ast.name === 'Mutation') {
      v = { kind: 'mutation', id, ...(env.mutations?.[id] ?? { status: 'idle' }) };
    } else {
      v = value(s.ast, id);
    }
    stack.delete(id);
    cache.set(id, v);
    return v;
  }

  function member(obj, prop) {
    if (Array.isArray(obj)) return obj.map((r) => (r && typeof r === 'object' ? r[prop] : undefined));
    if (obj && typeof obj === 'object') return obj[prop];
    if (typeof obj === 'string' && prop === 'length') return obj.length;
    return undefined;
  }

  function value(n, id) {
    switch (n.k) {
      case 'lit': return n.v;
      case 'state': return state[n.name] ?? null;
      case 'ref': return resolve(n.name, id);
      case 'arr': return n.items.map((x) => value(x, id)).filter((x) => x !== undefined);
      case 'obj': return Object.fromEntries(n.entries.map(([k, v]) => [k, value(v, id)]));
      case 'member': return member(value(n.obj, id), n.prop) ?? null;
      case 'index': { const o = value(n.obj, id), k = value(n.at, id); return o == null ? null : Array.isArray(o) ? o[Number(k)] ?? null : typeof o === 'object' ? o[k] ?? null : null; }
      case 'tern': return value(n.c, id) ? value(n.a, id) : value(n.b, id);
      case 'un': { const x = value(n.x, id); return n.op === '!' ? !x : -Number(x); }
      case 'bin': {
        const l = value(n.l, id);
        const r = value(n.r, id);
        switch (n.op) {
          case '+': return typeof l === 'string' || typeof r === 'string' ? `${l ?? ''}${r ?? ''}` : Number(l) + Number(r);
          case '-': return Number(l) - Number(r);
          case '*': return Number(l) * Number(r);
          case '/': return Number(r) === 0 ? 0 : Number(l) / Number(r);
          case '%': return Number(l) % Number(r);
          case '&&': return l && r;
          case '||': return l || r;
          default: return compare(l, n.op, r);
        }
      }
      case 'builtin': {
        if (ACTION_STEPS.has(n.name)) return actionStep(n, id);
        if (n.name === 'Each') return each(n, id);
        const fn = BUILTINS[n.name];
        if (!fn) {
          const near = suggest(n.name, [...Object.keys(BUILTINS), 'Each', ...ACTION_STEPS]);
          err(id, 'builtin', `unknown @${n.name}${near ? ` (use @${near})` : ''}`);
          return null;
        }
        return fn(...n.args.map((a) => value(a, id)));
      }
      case 'call': return call(n, id);
      default: return null;
    }
  }

  function each(n, id) {
    const [arrN, varN, tmplN] = n.args;
    const arr = value(arrN, id);
    const name = varN?.k === 'lit' ? String(varN.v) : varN?.k === 'ref' ? varN.name : null;
    if (!Array.isArray(arr) || !name || !tmplN) return [];
    return arr.map((item) => {
      const saved = cache.get(name);
      cache.set(name, item);
      const out = value(tmplN, id);
      if (saved === undefined) cache.delete(name);
      else cache.set(name, saved);
      return out;
    });
  }

  function actionStep(n, id) {
    const arg = n.args[0];
    switch (n.name) {
      case 'Run': return { step: 'run', ref: arg?.k === 'ref' ? arg.name : null };
      case 'Set': return { step: 'set', name: arg?.k === 'state' ? arg.name : null, value: n.args[1] ? value(n.args[1], id) : null };
      case 'Reset': return { step: 'reset', names: n.args.filter((a) => a.k === 'state').map((a) => a.name) };
      case 'ToAssistant': return { step: 'ask', message: String(value(arg, id) ?? '') };
      case 'OpenUrl': return { step: 'open', url: String(value(arg, id) ?? '') };
      default: return null;
    }
  }

  function call(n, id) {
    if (n.name === 'Action') {
      const steps = (value(n.args[0], id) ?? []).flat().filter(Boolean);
      return { kind: 'action', steps };
    }
    if (n.name === 'Query' || n.name === 'Mutation') {
      err(id, 'query', `${n.name}() must be its own statement (\`data = ${n.name}(…)\`)`);
      return null;
    }
    // Col is two things: OpenUI's layout column, Col([a, b]), and ox's table
    // column, Col("Label", values). A list first means the layout.
    if (n.name === 'Col' && n.args[0]?.k === 'arr') n = { ...n, name: 'Column' };
    const spec = LIBRARY[n.name];
    if (!spec) {
      const near = suggest(n.name, Object.keys(LIBRARY));
      err(id, 'component', `unknown component ${n.name}${near ? ` (use ${near})` : ''}`);
      return null;
    }
    if (n.args.length > spec.params.length) {
      err(id, 'arity', `${n.name} takes ${spec.params.length} argument(s): ${signature(n.name)}`);
    }
    const props = {};
    for (let p = 0; p < spec.params.length; p++) {
      const [name, type, optional] = spec.params[p];
      let v = p < n.args.length ? value(n.args[p], id) : undefined;
      if (v === undefined || v === null) {
        if (!optional && p >= n.args.length) {
          err(id, 'missing', `${n.name} is missing \`${name}\`: ${signature(n.name)}`);
          return null;
        }
        continue;
      }
      // OpenUI Lang: "a single action needs no wrapper", so @Set($n, 1) alone is Action([@Set($n, 1)]).
      if (type === 'action' && v && typeof v === 'object' && typeof v.step === 'string') v = { kind: 'action', steps: [v] };
      if (type === 'nodes' && isNode(v)) v = [v];
      if (type === 'nodes' && Array.isArray(v)) v = v.flat().filter(isNode);
      if (!typeOk(type, v)) {
        err(id, 'type', `${n.name}.${name} expects ${type.includes('|') ? `one of ${type.replace(/\|/g, ', ')}` : type}, got ${JSON.stringify(v)?.slice(0, 40)}`);
        continue;
      }
      props[name] = v;
    }
    // A Select's value arg binds a $var: keep the name so actions can set it.
    if (n.name === 'Select' && n.args[1]?.k === 'state') props.bind = n.args[1].name;
    if ((n.name === 'Input' || n.name === 'Slider' || n.name === 'Checkbox') && n.args[1]?.k === 'state') props.bind = n.args[1].name;
    if (n.name === 'Segmented' && n.args[0]?.k === 'state') props.bind = n.args[0].name;
    return { type: n.name, props };
  }

  let root = null;
  if (!program.stmts.has('root')) {
    err(null, 'root', 'no `root = …` statement, so nothing renders');
  } else {
    root = resolve('root', 'root');
    if (root != null && !isNode(root)) {
      if (Array.isArray(root)) root = { type: 'Stack', props: { children: root.filter(isNode) } };
      else { err('root', 'root', 'root must be a component, e.g. root = Stack([...])'); root = null; }
    }
  }
  // Validate statements root does not reach too: an unreachable line is
  // usually a typo the model should hear about, not silently lose.
  for (const [id, s] of program.stmts) {
    if (cache.has(id) || (s.ast.k === 'call' && (s.ast.name === 'Query' || s.ast.name === 'Mutation'))) continue;
    resolve(id, id);
  }
  return { root, errors, queries, mutations, state };
}

export function signature(name) {
  const spec = LIBRARY[name];
  if (!spec) return name;
  return `${name}(${spec.params.map(([n, t, o]) => `${n}${o ? '?' : ''}`).join(', ')})`;
}

// ---------------------------------------------------------------- prompt

/** The language spec as the model sees it. Kept short: it rides in a tool description. */
export function languageSpec() {
  return [
    'Write OX Canvas: one `name = Expression` per line, `root = ...` renders. Positional args only.',
    'Values: "str" 12 true null [a, b] {k: v}, refs to other lines (forward refs ok), a.b plucks a field from every row, cond ? a : b, + - * / == != > < && ||.',
    'Compose like a page: Title, a short Text, then blocks; Grid/Row/Col for layout; colours by name (ink muted surface info success warning danger purple pink chart1 chart2 chart3 chart4 chart5 chart6) or #hex in Badge tone, Text color, Chart and Svg fills. steps[$step] indexes a list. $var = default declares state; Input("Amount", $amount, "number") and Slider("Rate %", $rate, 0, 20, 0.1) let the user change it and every line using it recomputes. @Pow(b, e) @Sqrt @Abs @Floor @Ceil @Clamp(n, lo, hi) @Default(v, d) @Format(n, "currency|percent|compact") @Plural(n, "item") @Percent(a, b) @Range(0, n) @Includes @Toggle @Append @Remove @GroupBy(rows, key, field) @Today @Count @Sum @Avg @Min @Max @First @Last @Round(n, digits) @Join @Filter(rows, field, op, value) @Sort(rows, field, "desc") @Each(rows, "r", Text(r.x)).',
    `Live data: d = Query("${[...QUERY_TOOLS].join('|')}", {args}, {defaults}); d is the tool result ({text, lines} or parsed JSON).`,
    'Buttons: Button("Label", Action([@Set($v, 1), @Run(d), @ToAssistant("msg"), @OpenUrl("u")])). m = Mutation("tool", {args}) runs only via @Run(m) from a Button.',
    'Edit an existing canvas with patch: true and send only changed or new lines.',
  ].join('\n');
}

// ---------------------------------------------------------------- terminal

const ESC = /\x1b\[[0-9;]*m/g;
export const visibleWidth = (s) => [...String(s).replace(ESC, '')].length;

function fit(s, w) {
  const str = String(s ?? '');
  const vw = visibleWidth(str);
  if (vw <= w) return str + ' '.repeat(w - vw);
  // Truncate on visible characters, keeping escapes intact.
  let out = '';
  let n = 0;
  for (const part of str.split(/(\x1b\[[0-9;]*m)/)) {
    if (/^\x1b\[/.test(part)) { out += part; continue; }
    for (const ch of part) {
      if (n >= w - 1) break;
      out += ch;
      n++;
    }
  }
  return `${out}…${color.enabled ? '\x1b[0m' : ''}`;
}

const color = {
  enabled: true,
  w(open, s) { return this.enabled ? `\x1b[${open}m${s}\x1b[0m` : String(s); },
};
const paint = {
  bold: (s) => color.w('1', s),
  dim: (s) => color.w('2', s),
  gold: (s) => color.w('38;2;233;166;107', s),
  info: (s) => color.w('38;2;120;170;255', s),
  success: (s) => color.w('38;2;110;210;140', s),
  warning: (s) => color.w('38;2;240;190;90', s),
  error: (s) => color.w('38;2;240;110;100', s),
  plain: (s) => String(s),
};
const TONE_ICON = { info: 'i', success: '✓', warning: '!', error: '✗', plain: '•' };

function fmtValue(v, type) {
  if (v == null || v === '') return paint.dim('—');
  const n = Number(v);
  switch (type) {
    case 'number': return Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 2 }) : String(v);
    case 'currency': return Number.isFinite(n) ? `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : String(v);
    case 'percent': return Number.isFinite(n) ? `${n.toLocaleString('en-US', { maximumFractionDigits: 1 })}%` : String(v);
    case 'status': {
      const s = String(v).toLowerCase();
      const tone = /fail|error|red|down|blocked/.test(s) ? 'error' : /pass|ok|done|green|up|success/.test(s) ? 'success' : /warn|pending|slow|skip/.test(s) ? 'warning' : 'plain';
      return paint[tone](`${TONE_ICON[tone]} ${v}`);
    }
    default: return typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
}

const BLOCKS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];
function bar(frac, width) {
  const cells = Math.max(0, Math.min(1, frac)) * width;
  const full = Math.floor(cells);
  return '█'.repeat(full) + (full < width ? BLOCKS[Math.round((cells - full) * 7)] : '');
}

/**
 * Render a tree to terminal lines. Buttons and Select options are numbered;
 * the returned `actions` list is what those numbers trigger.
 */
export function renderTerminal(root, { width = 80, colors = true } = {}) {
  color.enabled = colors;
  const actions = [];
  const lines = root ? draw(root, Math.max(24, width), actions) : [];
  return { text: lines.join('\n'), actions };
}

function draw(node, w, actions) {
  if (!node) return [];
  const p = node.props ?? {};
  switch (node.type) {
    case 'Stack': {
      const gap = p.gap === 'tight' ? 0 : p.gap === 'loose' ? 2 : 1;
      const out = [];
      for (const ch of p.children ?? []) {
        const ls = draw(ch, w, actions);
        if (!ls.length) continue;
        if (out.length) for (let i = 0; i < gap; i++) out.push('');
        out.push(...ls);
      }
      return out;
    }
    case 'Column':
    case 'Pressable':
      return draw({ type: 'Stack', props: { children: p.children ?? [] } }, w, actions);
    case 'Grid': {
      // Rows of `cols` cells, each drawn like a Row.
      const kids = (p.children ?? []).filter(Boolean), n = Math.max(1, Number(p.cols) || 2), out = [];
      for (let i = 0; i < kids.length; i += n) { if (out.length) out.push(''); out.push(...draw({ type: 'Row', props: { children: kids.slice(i, i + n) } }, w, actions)); }
      return out;
    }
    case 'Row': {
      const kids = (p.children ?? []).filter(Boolean);
      if (!kids.length) return [];
      const colW = Math.floor((w - 2 * (kids.length - 1)) / kids.length);
      if (colW < 14) return draw({ type: 'Stack', props: { children: kids, gap: 'tight' } }, w, actions);
      const cols = kids.map((k) => draw(k, colW, actions));
      const h = Math.max(...cols.map((c) => c.length));
      const out = [];
      for (let i = 0; i < h; i++) out.push(cols.map((c) => fit(c[i] ?? '', colW)).join('  ').trimEnd());
      return out;
    }
    case 'Card': {
      const tone = p.tone && p.tone !== 'plain' ? p.tone : null;
      const edge = tone ? paint[tone] : paint.dim;
      const inner = w - 4;
      const body = draw({ type: 'Stack', props: { children: p.children ?? [] } }, inner, actions);
      const title = ` ${paint.bold(p.title ?? '')} `;
      const top = edge('╭─') + title + edge('─'.repeat(Math.max(0, w - 3 - visibleWidth(title))) + '╮');
      return [top, ...body.map((l) => `${edge('│')} ${fit(l, inner)} ${edge('│')}`), edge(`╰${'─'.repeat(w - 2)}╯`)];
    }
    case 'Header':
      return [paint.bold(paint.gold(fit(p.title ?? '', w).trimEnd())), ...(p.subtitle ? [paint.dim(p.subtitle)] : [])];
    case 'Text': {
      const style = p.style ?? 'body';
      const f = style === 'muted' ? paint.dim : style === 'strong' || style === 'large' ? paint.bold : paint.plain;
      return wrapText(String(p.text ?? ''), w).map(f);
    }
    case 'Stat': {
      const d = Number(p.delta);
      const delta = Number.isFinite(d) && p.delta != null ? ` ${(d >= 0 ? paint.success : paint.error)(`${d >= 0 ? '▲' : '▼'} ${Math.abs(d)}`)}` : '';
      return [paint.dim(p.label ?? ''), `${paint.bold(fmtValue(p.value, typeof p.value === 'number' ? 'number' : 'text'))}${p.unit ? ` ${paint.dim(p.unit)}` : ''}${delta}`];
    }
    case 'Fields': {
      const entries = Object.entries(p.pairs ?? {});
      const kw = Math.min(Math.max(0, ...entries.map(([k]) => k.length)), Math.floor(w / 2));
      return entries.map(([k, v]) => `${paint.dim(fit(k, kw))}  ${fit(fmtValue(v), w - kw - 2).trimEnd()}`);
    }
    case 'Table': return drawTable((p.columns ?? []).filter((c) => c.type === 'Col'), w);
    case 'BarChart': {
      const labels = (p.labels ?? []).map(String);
      const vals = (p.values ?? []).map(Number);
      const max = Math.max(0, ...vals.filter(Number.isFinite)) || 1;
      const lw = Math.min(Math.max(0, ...labels.map((l) => l.length)), Math.floor(w / 3));
      const nums = vals.map((v) => fmtValue(v, 'number'));
      const nw = Math.max(0, ...nums.map(visibleWidth));
      const bw = Math.max(4, w - lw - nw - 4);
      return [
        ...(p.title ? [paint.bold(p.title)] : []),
        ...labels.map((l, i) => `${fit(l, lw)}  ${paint.gold(fit(bar((vals[i] || 0) / max, bw), bw))} ${nums[i] ?? ''}`.trimEnd()),
      ];
    }
    case 'Sparkline': {
      const vals = (p.values ?? []).map(Number).filter(Number.isFinite);
      if (!vals.length) return [];
      const lo = Math.min(...vals);
      const hi = Math.max(...vals);
      const ticks = '▁▂▃▄▅▆▇█';
      const s = vals.slice(-Math.max(4, w - 16)).map((v) => ticks[hi === lo ? 3 : Math.round(((v - lo) / (hi - lo)) * 7)]).join('');
      return [`${p.label ? `${paint.dim(p.label)} ` : ''}${paint.gold(s)} ${paint.dim(fmtValue(vals[vals.length - 1], 'number'))}`];
    }
    case 'Progress': {
      const max = Number(p.max ?? 100) || 100;
      const frac = Math.max(0, Math.min(1, Number(p.value) / max));
      const label = String(p.label ?? '');
      const pct = `${Math.round(frac * 100)}%`;
      const bw = Math.max(6, w - visibleWidth(label) - pct.length - 4);
      return [`${label} ${paint.gold(bar(frac, bw))}${paint.dim('░'.repeat(Math.max(0, bw - Math.ceil(frac * bw))))} ${pct}`];
    }
    case 'List':
      return (p.items ?? []).flatMap((it, i) => {
        const mark = p.ordered ? `${i + 1}.` : '•';
        return wrapText(fmtValue(it), w - mark.length - 1).map((l, j) => `${j ? ' '.repeat(mark.length) : paint.dim(mark)} ${l}`);
      });
    case 'Callout': {
      const tone = p.tone ?? 'info';
      const f = paint[tone] ?? paint.plain;
      const body = p.text ? wrapText(p.text, w - 4) : [];
      return [`${f('▌')} ${f(TONE_ICON[tone] ?? '•')} ${paint.bold(p.title ?? '')}`, ...body.map((l) => `${f('▌')}   ${l}`)];
    }
    case 'Badge': return [(paint[p.tone ?? 'plain'] ?? paint.plain)(`[${p.text}]`)];
    case 'Code':
      return [paint.dim(`┌ ${p.lang ?? 'code'}`), ...String(p.code ?? '').split('\n').map((l) => `${paint.dim('│')} ${fit(l, w - 2).trimEnd()}`), paint.dim('└')];
    case 'Diff':
      return String(p.diff ?? '').split('\n').map((l) => {
        const f = l.startsWith('+') && !l.startsWith('+++') ? paint.success : l.startsWith('-') && !l.startsWith('---') ? paint.error : l.startsWith('@@') ? paint.info : paint.dim;
        return f(fit(l, w).trimEnd());
      });
    case 'Divider': return [paint.dim('─'.repeat(w))];
    case 'Button': return [button(p, actions)];
    case 'Buttons': {
      const out = [''];
      for (const b of p.buttons ?? []) {
        const s = b.type === 'Button' ? button(b.props, actions) : '';
        if (!s) continue;
        const cur = out[out.length - 1];
        if (cur && visibleWidth(cur) + 2 + visibleWidth(s) > w) out.push(s);
        else out[out.length - 1] = cur ? `${cur}  ${s}` : s;
      }
      return out.filter(Boolean);
    }
    case 'Select': {
      const opts = (p.options ?? []).filter((o) => o.type === 'Option');
      const parts = opts.map((o) => {
        const val = o.props.value;
        const label = o.props.label ?? String(val);
        const n = actions.push({ label, steps: [{ step: 'set', name: p.bind, value: val }] });
        const on = String(val) === String(p.value);
        return on ? paint.gold(`[${n}] ● ${label}`) : `${paint.dim(`[${n}]`)} ○ ${label}`;
      });
      return [`${paint.dim(`${p.name}:`)} ${parts.join('  ')}`];
    }
    case 'Input':
      return [`${paint.dim(`${p.label}:`)} ${p.value ?? ''}`];
    case 'Title': return [paint.bold ? paint.bold(String(p.text ?? '')) : String(p.text ?? '')];
    case 'Caption': return [paint.dim(String(p.text ?? ''))];
    case 'Spacer': return [];
    case 'Checkbox': return [`${p.value ? '☑' : '☐'} ${p.label}`];
    case 'Segmented': return [(p.options ?? []).map((o) => (String(o) === String(p.value) ? `[${o}]` : ` ${o} `)).join(' ')];
    case 'Svg': return [paint.dim('[drawing: open it in the app]')];
    case 'SearchImage': return [paint.dim(`[photo: ${p.query}]`)];
    case 'Chart': {
      const vals = (p.values ?? []).map(Number), max = Math.max(1e-9, ...vals.map(Math.abs));
      return [...(p.title ? [String(p.title)] : []), ...vals.map((v, k) => `${String(p.labels?.[k] ?? '').padEnd(12).slice(0, 12)} ${'█'.repeat(Math.max(1, Math.round((Math.abs(v) / max) * 24)))} ${v}`)];
    }
    case 'Slider': {
      const lo = Number(p.min), hi = Number(p.max), v = Number(p.value);
      const w = 16, f = hi > lo ? Math.max(0, Math.min(w, Math.round(((v - lo) / (hi - lo)) * w))) : 0;
      return [`${paint.dim(`${p.label}:`)} ${'━'.repeat(f)}●${'─'.repeat(w - f)} ${v}`];
    }
    case 'Option':
    case 'Col':
      return [];
    default:
      return [];
  }
}

function button(p, actions) {
  const steps = p.action?.steps?.length ? p.action.steps : [{ step: 'ask', message: p.label }];
  const n = actions.push({ label: p.label, steps });
  const f = p.tone === 'danger' ? paint.error : p.tone === 'primary' ? paint.gold : paint.bold;
  return `${paint.dim(`[${n}]`)} ${f(p.label)}`;
}

function drawTable(cols, w) {
  if (!cols.length) return [];
  const rows = Math.max(0, ...cols.map((c) => (Array.isArray(c.props.values) ? c.props.values.length : 0)));
  const cells = cols.map((c) => [paint.bold(c.props.label ?? ''), ...Array.from({ length: rows }, (_, r) => fmtValue(c.props.values?.[r], c.props.type))]);
  let widths = cells.map((col) => Math.max(...col.map(visibleWidth)));
  const avail = w - 2 * (cols.length - 1);
  while (widths.reduce((a, b) => a + b, 0) > avail) {
    const i = widths.indexOf(Math.max(...widths));
    if (widths[i] <= 6) break;
    widths[i]--;
  }
  const right = cols.map((c) => ['number', 'currency', 'percent'].includes(c.props.type));
  const line = (r) => cells.map((col, i) => {
    const s = col[r] ?? '';
    if (!right[i]) return fit(s, widths[i]);
    const pad = widths[i] - visibleWidth(s);
    return pad >= 0 ? ' '.repeat(pad) + s : fit(s, widths[i]);
  }).join('  ').trimEnd();
  return [line(0), paint.dim(widths.map((x) => '─'.repeat(x)).join('  ')), ...Array.from({ length: rows }, (_, r) => line(r + 1))];
}

function wrapText(text, w) {
  const out = [];
  for (const para of String(text).split('\n')) {
    let cur = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (!cur) cur = word;
      else if (visibleWidth(cur) + 1 + visibleWidth(word) <= w) cur += ` ${word}`;
      else { out.push(cur); cur = word; }
      while (visibleWidth(cur) > w) { out.push(cur.slice(0, w)); cur = cur.slice(w); }
    }
    out.push(cur);
  }
  return out;
}

// ---------------------------------------------------------------- canvas runtime

/** Wrap a tool's text result as Query data: parsed JSON when it is JSON, else {text, lines}. */
export function toQueryData(content) {
  const text = String(content ?? '');
  try {
    const j = JSON.parse(text);
    if (j && typeof j === 'object') return j;
  } catch {}
  // ox's tools answer "No matches …" / "No files …" in prose: that is zero rows.
  if (/^No (matches|files|entries|results)\b/i.test(text.trim())) return { text, lines: [], count: 0 };
  const lines = text.split('\n').filter((l) => l.length);
  return { text, lines, count: lines.length };
}

/**
 * A live canvas: the program source, its $state, query results and the last
 * render. One per session; a patch merges into it.
 */
export class Canvas {
  constructor() {
    this.source = '';
    this.state = {};
    this.data = {};
    this.mutations = {};
    this.last = null;
  }

  /** Replace or patch the program. Returns the evaluation (errors included). */
  load(src, { patch = false } = {}) {
    this.source = patch && this.source ? mergePrograms(this.source, src) : String(src ?? '');
    const prog = parseProgram(this.source);
    // New $vars take their declared default; existing ones keep the user's choice.
    for (const [k, v] of Object.entries(prog.state)) if (!(k in this.state)) this.state[k] = v;
    return this.evaluate(prog);
  }

  evaluate(prog = parseProgram(this.source)) {
    const ev = evaluate(prog, { state: this.state, data: this.data, mutations: this.mutations });
    ev.parseErrors = prog.errors;
    this.last = ev;
    return ev;
  }

  /** Run every Query (or only `ids`) through `runTool(name, args)`; errors land in the data. */
  async refresh(runTool, ids = null) {
    const ev = this.last ?? this.evaluate();
    for (const q of ev.queries) {
      if (ids && !ids.includes(q.id)) continue;
      try {
        const r = await runTool(q.tool, q.args);
        this.data[q.id] = r?.isError ? { ...(q.defaults ?? {}), error: String(r.content ?? '').slice(0, 200) } : toQueryData(r?.content);
      } catch (e) {
        this.data[q.id] = { ...(q.defaults ?? {}), error: String(e?.message ?? e) };
      }
    }
    return this.evaluate();
  }

  render(opts) {
    const ev = this.last ?? this.evaluate();
    return renderTerminal(ev.root, opts);
  }

  /**
   * Apply a numbered action locally. Returns { rerender, ask?, mutation?, open? }:
   * state changes and query re-runs never need the model; @ToAssistant and
   * Mutations go back to the agent, which keeps ox's approval rules in charge.
   */
  async act(action, runTool) {
    const out = { rerender: false };
    const prog = parseProgram(this.source);
    for (const s of action?.steps ?? []) {
      if (s.step === 'set' && s.name) { this.state[s.name] = s.value; out.rerender = true; }
      else if (s.step === 'reset') { for (const n of s.names) this.state[n] = prog.state[n] ?? null; out.rerender = true; }
      else if (s.step === 'ask') out.ask = s.message;
      else if (s.step === 'open') out.open = s.url;
      else if (s.step === 'run' && s.ref) {
        const ev = this.last ?? this.evaluate();
        if (ev.queries.some((q) => q.id === s.ref)) {
          if (runTool) await this.refresh(runTool, [s.ref]);
          out.rerender = true;
        } else {
          const m = ev.mutations.find((x) => x.id === s.ref);
          if (m) { out.mutation = m; break; } // the agent runs it, under approval
        }
      }
    }
    if (out.rerender) this.evaluate(prog);
    return out;
  }
}

/** One-line digest of a render tree for the model: component counts, no content. */
export function digest(root) {
  const counts = {};
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (typeof n.type === 'string') counts[n.type] = (counts[n.type] ?? 0) + 1;
    for (const v of Object.values(n.props ?? {})) if (typeof v === 'object') walk(v);
  };
  walk(root);
  return Object.entries(counts).map(([k, v]) => (v > 1 ? `${k}×${v}` : k)).join(', ');
}
