// Tool calls from any model, repaired before they run. Most failures with
// open-weight and local models are not the model's reasoning but the wire:
// arguments that are almost JSON, a tool call written into the reply text
// instead of the tool channel, a tool name with a prefix or the wrong case,
// a number sent as a string. Research on cross-model harnesses ("Finding the
// Right Fit", arXiv 2610.00917; the open-weight tool-calling notes in
// HonestHarness) finds the harness that returns these failures in a usable
// form, or repairs them, is the one that lets every model finish.
//
// Order: repair the JSON, resolve the name, coerce the types to the schema;
// what still does not fit goes back to the model as a precise error, and the
// call is not run on guessed arguments.

/** Almost-JSON → an object, or null. Code fences, trailing commas, single
 *  quotes, Python literals, unquoted keys and a missing closing brace. */
export function repairJson(raw) {
  if (raw && typeof raw === 'object') return raw;
  let s = String(raw ?? '').trim();
  if (!s) return {};
  const tryParse = (t) => { try { const v = JSON.parse(t); return v; } catch { return undefined; } };
  let v = tryParse(s);
  if (v !== undefined) return typeof v === 'string' ? repairJson(v) : v;
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const first = s.indexOf('{');
  if (first > 0) s = s.slice(first);
  s = s
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false').replace(/\bNone\b/g, 'null')
    .replace(/([{,]\s*)([A-Za-z_][\w-]*)\s*:/g, '$1"$2":');
  v = tryParse(s);
  if (v !== undefined) return v;
  // Single-quoted strings (only when there are no double quotes to confuse).
  if (!s.includes('"') || /'[^']*'\s*:/.test(s)) {
    v = tryParse(s.replace(/'((?:[^'\\]|\\.)*)'/g, (_, b) => JSON.stringify(b.replace(/\\'/g, "'"))));
    if (v !== undefined) return v;
  }
  // Cut off: close what is open.
  const open = [];
  let inStr = false, esc = false;
  for (const ch of s) {
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') open.push(ch === '{' ? '}' : ']');
    else if (ch === '}' || ch === ']') open.pop();
  }
  if (open.length || inStr) {
    v = tryParse(`${s}${inStr ? '"' : ''}${open.reverse().join('')}`);
    if (v !== undefined) return v;
  }
  return null;
}

/** A tool name as the model wrote it → the offered name, or null.
 *  "functions.read_file", "Read_File", "read_file_0", "fs::read_file", "mcp.github.search". */
export function resolveToolName(name, names) {
  const list = [...(names ?? [])];
  const n = String(name ?? '').trim();
  if (!n) return null;
  if (list.includes(n)) return n;
  const norm = (x) => x.toLowerCase().replace(/^(?:functions?|tools?)[.:]/, '').replace(/(?:::|\.)/g, '__').replace(/[-\s]/g, '_').replace(/_\d+$/, '').replace(/:\d+$/, '');
  const want = norm(n);
  return list.find((x) => norm(x) === want) ?? list.find((x) => norm(x).endsWith(`__${want}`)) ?? null;
}

/** Arguments → the types the schema asks for: "3" → 3, "true" → true,
 *  '["a"]' → ["a"]; a string stays a string where the schema says string. */
export function coerceArgs(args, schema) {
  const props = schema?.properties;
  if (!args || typeof args !== 'object' || Array.isArray(args) || !props) return args;
  const out = { ...args };
  for (const [k, v] of Object.entries(out)) {
    const p = props[k];
    if (!p) continue;
    const types = [].concat(p.type ?? (p.anyOf ?? []).map((x) => x.type)).filter(Boolean);
    if (typeof v === 'string') {
      if (types.includes('string')) continue;
      if ((types.includes('integer') || types.includes('number')) && /^-?\d+(?:\.\d+)?$/.test(v.trim())) out[k] = Number(v);
      else if (types.includes('boolean') && /^(true|false)$/i.test(v.trim())) out[k] = v.trim().toLowerCase() === 'true';
      else if ((types.includes('array') || types.includes('object')) && /^[[{]/.test(v.trim())) { const j = repairJson(v); if (j && typeof j === 'object') out[k] = j; }
    } else if (types.includes('array') && !types.includes(typeof v) && v != null && !Array.isArray(v)) {
      out[k] = [v];
    } else if (types.includes('string') && !types.includes(typeof v) && (typeof v === 'number' || typeof v === 'boolean')) {
      out[k] = String(v);
    }
  }
  return out;
}

// Names models use for the same field: old_str for old_string, file_path for
// path, contents for content, cmd for command.
const SYNONYMS = { path: ['file_path', 'filepath', 'file', 'filename', 'target_file'], content: ['contents', 'text', 'body', 'file_text', 'data'], command: ['cmd', 'script', 'shell'], old_string: ['old_str', 'old', 'search', 'old_text', 'find'], new_string: ['new_str', 'new', 'replace', 'new_text', 'replacement'], query: ['q', 'search_query', 'term'], url: ['link', 'href', 'uri'] };
const squash = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, '');

/** Arguments under another name than the schema's (old_str, file_path…) → the schema's names. */
export function renameToSchema(args, schema) {
  const props = schema?.properties;
  if (!args || typeof args !== 'object' || Array.isArray(args) || !props) return args;
  const out = { ...args };
  for (const want of Object.keys(props)) {
    if (out[want] !== undefined) continue;
    const alts = [...(SYNONYMS[want] ?? [])];
    const hit = Object.keys(out).find((k) => !props[k] && (alts.map(squash).includes(squash(k)) || squash(k) === squash(want)));
    if (hit) { out[want] = out[hit]; delete out[hit]; }
  }
  return out;
}

/** Required fields the arguments are missing. */
export function missingRequired(args, schema) {
  const req = Array.isArray(schema?.required) ? schema.required : [];
  return req.filter((k) => args?.[k] === undefined || args?.[k] === null || args?.[k] === '');
}

// A tool call written into the reply instead of the tool channel: Hermes and
// Qwen <tool_call>{…}</tool_call>, Mistral [TOOL_CALLS][…], Llama 3.1
// <function=name>{…}</function>, a fenced or bare {"name": …, "arguments": …}.
const PATTERNS = [
  /<tool_call>\s*([\s\S]*?)\s*(?:<\/tool_call>|$)/g,
  /<\|tool_call\|>\s*([\s\S]*?)\s*(?:<\|\/tool_call\|>|$)/g,
  /\[TOOL_CALLS\]\s*(\[[\s\S]*?\])(?=\s*$|\s*\n\n)/g,
  /```(?:json|tool_call)?\s*(\{[\s\S]*?"(?:name|tool|function)"[\s\S]*?\})\s*```/g,
];

/**
 * Reply text → { calls, text }: the calls found (only tools that are offered)
 * and the text with their markup taken out. No calls → the text unchanged.
 */
export function extractTextToolCalls(text, names) {
  const src = String(text ?? '');
  const calls = [];
  const spans = [];
  const take = (obj) => {
    for (const o of [].concat(obj)) {
      if (!o || typeof o !== 'object') continue;
      const fn = o.function && typeof o.function === 'object' ? o.function : o;
      const name = resolveToolName(fn.name ?? o.tool ?? o.tool_name, names);
      if (!name) continue;
      let args = fn.arguments ?? fn.parameters ?? fn.args ?? fn.input ?? {};
      if (typeof args === 'string') args = repairJson(args) ?? {};
      calls.push({ id: `call_text_${calls.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
    }
  };
  for (const re of PATTERNS) {
    for (const m of src.matchAll(re)) { const before = calls.length; take(repairJson(m[1])); if (calls.length > before) spans.push([m.index, m.index + m[0].length]); }
  }
  // Anthropic-style XML, with or without a namespace prefix:
  // <invoke name="read_file"><parameter name="path">a.js</parameter></invoke>
  for (const m of src.matchAll(/<(?:[\w-]+:)?invoke\s+name="([^"]+)"\s*>([\s\S]*?)(?:<\/(?:[\w-]+:)?invoke>|$)/g)) {
    const args = {};
    for (const p of m[2].matchAll(/<(?:[\w-]+:)?parameter\s+name="([^"]+)"\s*>([\s\S]*?)<\/(?:[\w-]+:)?parameter>/g)) {
      const v = p[2].trim();
      args[p[1]] = /^[[{]/.test(v) ? (repairJson(v) ?? v) : v;
    }
    const before = calls.length;
    take({ name: m[1], arguments: args });
    if (calls.length > before) spans.push([m.index, m.index + m[0].length]);
  }
  for (const m of src.matchAll(/<function=([\w.:-]+)>\s*([\s\S]*?)\s*(?:<\/function>|$)/g)) {
    const before = calls.length;
    take({ name: m[1], arguments: repairJson(m[2]) ?? {} });
    if (calls.length > before) spans.push([m.index, m.index + m[0].length]);
  }
  // The whole reply is one JSON call (small models answer with just the object).
  if (!calls.length && /^\s*\{[\s\S]*"(?:name|tool|function)"[\s\S]*\}\s*$/.test(src)) {
    take(repairJson(src));
    if (calls.length) spans.push([0, src.length]);
  }
  if (!calls.length) return { calls, text: src };
  let rest = '';
  let at = 0;
  for (const [a, b] of spans.sort((x, y) => x[0] - y[0])) { if (a >= at) { rest += src.slice(at, a); at = b; } }
  rest += src.slice(at);
  return { calls, text: rest.trim() };
}

/** Raw argument text for one call → { args } or { error } (what to tell the model). */
export function parseToolArgs(raw, schema, name) {
  const fixed = repairJson(raw);
  if (fixed === null || typeof fixed !== 'object' || Array.isArray(fixed)) {
    const want = Array.isArray(schema?.required) && schema.required.length ? ` with ${schema.required.map((k) => `"${k}"`).join(', ')}` : '';
    return { error: `The arguments for ${name} were not a JSON object, so it was not run: ${String(raw ?? '').slice(0, 160)}. Call ${name} again with one JSON object${want}.` };
  }
  const args = coerceArgs(renameToSchema(fixed, schema), schema);
  const missing = missingRequired(args, schema);
  if (missing.length) {
    const desc = missing.map((k) => `"${k}"${schema.properties?.[k]?.description ? ` (${String(schema.properties[k].description).slice(0, 80)})` : ''}`).join(', ');
    return { error: `${name} was not run: it needs ${desc}. Call it again with ${missing.length > 1 ? 'them' : 'it'}.` };
  }
  return { args };
}

/** The reply is tool-call markup that could not be read (a cut or garbled call):
 *  it should be asked for again, not shown as the answer. */
export function looksLikeBrokenToolCall(text) {
  const t = String(text ?? '').trim();
  if (!t || t.length > 4000) return false;
  const marks = (t.match(/<\/?(?:[\w-]+:)?(?:invoke|function_calls|parameter|tool_call|function)\b[^>]*>/g) ?? []).length;
  const words = t.replace(/<[^>]*>/g, ' ').replace(/[^A-Za-z]+/g, ' ').trim().split(' ').filter((w) => w.length > 2).length;
  return marks >= 2 && words < 25;
}
