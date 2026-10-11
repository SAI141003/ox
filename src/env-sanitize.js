// Wave5a B: environment sanitizer for child processes (bash tool + MCP stdio
// servers). Zero deps. Modes:
//   'core' — PATH/HOME/SHELL/LANG/LC_*/TERM/TMPDIR/USER/LOGNAME (+ Windows
//            basics) plus proxy vars with userinfo credentials STRIPPED.
//   'all'  — full passthrough minus *KEY*/*SECRET*/*TOKEN*/AWS_SESSION keys
//            unless rescued by the include list.
//   'none' — minimal: PATH, HOME, TMPDIR.
// OX_ENV_ALL=1 forces 'all' regardless of the requested mode.

const PROXY_KEYS = new Set([
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
]);

const CORE_KEYS = new Set([
  'PATH',
  'HOME',
  'SHELL',
  'LANG',
  'TERM',
  'TMPDIR',
  'TEMP',
  'TMP',
  'USER',
  'LOGNAME',
  'SYSTEMROOT',
  'COMSPEC',
  'PATHEXT',
  'PROGRAMFILES',
]);

function stripProxyUserinfo(value) {
  let s = String(value ?? '');
  // scheme://user:pass@host → scheme://host
  s = s.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, '$1');
  // bare user:pass@host form (no scheme)
  s = s.replace(/^[^/@\s:]+:[^/@\s]*@/, '');
  return s;
}

function isSecretKey(key, include) {
  const k = String(key ?? '');
  if (Array.isArray(include) && include.includes(k)) return false;
  const up = k.toUpperCase();
  return /(KEY|SECRET|TOKEN)/.test(up) || up.startsWith('AWS_SESSION');
}

export function sanitizeEnv(base = process.env, opts = {}) {
  let mode = opts.mode;
  if (process.env.OX_ENV_ALL === '1' || process.env.OX_ENV_ALL === 'true') mode = 'all';
  if (!['core', 'all', 'none'].includes(mode)) mode = 'core';
  const exclude = Array.isArray(opts.exclude) ? new Set(opts.exclude.map(String)) : new Set();
  const include = Array.isArray(opts.include) ? opts.include.map(String) : [];
  const out = {};
  for (const [k, v] of Object.entries(base && typeof base === 'object' ? base : {})) {
    if (exclude.has(k)) continue;
    if (v === undefined) continue;
    if (mode === 'none') {
      if (k === 'PATH' || k === 'HOME' || k === 'TMPDIR') out[k] = v;
      continue;
    }
    if (mode === 'core') {
      const isProxy = PROXY_KEYS.has(k);
      if (CORE_KEYS.has(k) || k.startsWith('LC_') || isProxy) {
        out[k] = isProxy ? stripProxyUserinfo(v) : v;
      }
      continue;
    }
    // all: passthrough minus secret-shaped keys unless include-listed
    if (isSecretKey(k, include)) continue;
    out[k] = v;
  }
  return out;
}
