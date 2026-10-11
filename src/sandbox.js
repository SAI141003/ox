// Wave5a A: OS sandbox profiles (grok-build pattern, clean-room).
//
// resolveSandbox({flag, config}) picks the effective profile:
//   --sandbox off|workspace|read-only|strict  >  config sandbox.profile  >  'off'
// A non-preset name loads a CUSTOM profile from <cwd>/.ox-sandbox.json or
// ~/.ox/sandbox.json ({extends, read_only, read_write, deny, restrict_network,
// network_allow}). Globs are a gitignore subset (* ? [...] ** [!a]); unsupported
// metachars make startup REFUSE (fail-closed) naming the file and line.
//
// Enforcement compiles once per session: macOS sandbox-exec SBPL via a cached
// tmpfile under os.tmpdir(), Linux bwrap argv. Without either backend the run
// degrades LOUDLY to userspace confinement and is marked degraded.
//
// ---- profile fields ---------------------------------------------------------
//   kind/name/extends  identity. A custom profile RENAMES itself to the name
//                      the user typed, so every policy branch keys off
//                      profileBaseName() = `extends ?? name` — never `name`.
//   read_only           paths OR globs; SBPL emits a (deny file-write*)
//                      per entry (literal -> (subpath …), glob -> anchored
//                      regex) AFTER the write roots, so it holds inside cwd.
//   read_write          globs; both backends widen the writable set.
//   deny                globs; explicit read+write denies, compiled last.
//   restrict_network    true => network egress is off by default.
//   network_allow       host patterns (globs / IPs / CIDRs) permitted while
//                      restrict_network is true. EMPTY => blanket deny. A
//                      non-array value is ignored (treated as empty) and
//                      recorded in profile.warnings — never a silent surprise.
//   warnings            non-fatal, human-readable notes from profile loading.
//
// ---- what "network_allow" ACTUALLY enforces, per layer (MEASURED, not assumed)
// macOS, spawned commands:
//   (deny network*) compiles and IS kernel-enforced — verified live on
//   macOS 15.7 by curling https://example.com under a compiled profile: it
//   fails at name resolution, and the same curl unsandboxed returns HTTP 200.
//   A per-host ALLOW rule needs (allow network-outbound (remote ip "H:P")) and
//   macOS 15.7's sandbox-exec REJECTS every host other than '*' or 'localhost'
//   at compile time ("host must be * or localhost in network address"), so on
//   this platform the allow-list is NOT kernel-exforceable. We probe the LOCAL
//   sandbox-exec once (seatbeltAllowsRemoteIp) and emit allow rules only on a
//   host that accepts them; otherwise the blanket deny stands and a ';'
//   comment in the compiled profile says so out loud.
// macOS, in-process web tools (networkEgressVerdict / blocksTool):
//   YES — this is the layer where a host allow-list is actually applied.
// Linux:
//   NOT enforceable. bwrap has no host or port allow-list (--unshare-net is
//   all-or-nothing), so the deny is compiled and the allow-list is reported as
//   an UNAPPLIED gap on the prepared result, loudly.
// MCP servers:
//   spawned through the same prefix (src/mcp.js), so they inherit the same
//   deny. A host allow-list for an MCP server's own traffic is not expressible
//   on any backend.
// None of the above is a DNS-level control: a name allowed here can resolve to
// a different address later, and in-process tools are node code running inside
// the agent process, not sandboxed children.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { CONFIG_DIR } from './config.js';
import { appendJsonlCapped } from './audit.js';

export const SANDBOX_PRESETS = ['off', 'workspace', 'read-only', 'strict'];

export class SandboxConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SandboxConfigError';
    this.exitCode = 4;
  }
}

// ---- glob validation / translation (gitignore subset) ----------------------

// Returns an error message string when the pattern uses unsupported syntax,
// null when acceptable.
export function validateGlobPattern(pattern) {
  const s = String(pattern ?? '');
  if (!s.trim()) return 'empty pattern';
  if (/[\r\n\0]/.test(s)) return 'control characters';
  if (s.includes('{') || s.includes('}')) return "unsupported '{…}' alternation";
  if (s.includes('\\')) return 'unsupported backslash escape';
  let i = 0;
  while ((i = s.indexOf('[', i)) !== -1) {
    const close = s.indexOf(']', i + 1);
    if (close === -1) return "unclosed '[' character class";
    if (close === i + 1) return "empty '[]' character class";
    i = close + 1;
  }
  return null;
}

function escapeRegexLiteral(c) {
  return /[.*+?^${}()|[\]\\]/.test(c) ? `\\${c}` : c;
}

// gitignore-subset glob → regex SOURCE (no anchors; caller anchors).
export function globToRegexSource(glob) {
  const s = String(glob ?? '');
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '*') {
      if (s[i + 1] === '*') {
        out += '.*';
        i += 2;
      } else {
        out += '[^/]*';
        i++;
      }
    } else if (c === '?') {
      out += '[^/]';
      i++;
    } else if (c === '[') {
      const close = s.indexOf(']', i + 1);
      if (close === -1) {
        out += '\\[';
        i++;
      } else {
        let cls = s.slice(i + 1, close);
        let neg = '';
        if (cls.startsWith('!')) {
          neg = '^';
          cls = cls.slice(1);
        }
        cls = cls.replace(/\\/g, '\\\\').replace(/\]/g, '\\]');
        out += `[${neg}${cls}]`;
        i = close + 1;
      }
    } else {
      out += escapeRegexLiteral(c);
      i++;
    }
  }
  return out;
}

function isLiteralPath(p) {
  return !/[*?[]/.test(String(p ?? ''));
}

function lineOfEntry(rawText, entry) {
  const needle = `"${String(entry).replace(/"/g, '\\"')}"`;
  const lines = String(rawText ?? '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(needle)) return i + 1;
  }
  return 1;
}

// ---- profile resolution -----------------------------------------------------

// A custom profile keeps the BASE preset in `extends` and overwrites `name`
// with the name the user typed on the CLI, so `name` alone cannot select a
// policy: every backend branch keys off this. (Dispatching on `name` sent every
// custom profile down the strict branch — a `(deny network*)` it never asked
// for and no workspace write roots — while bwrap, which already checked
// `kind === 'custom'`, disagreed with the SBPL it was paired with.)
export function profileBaseName(profile) {
  const base = profile?.extends ?? profile?.name;
  return base == null ? '' : String(base);
}

function presetProfile(name, { cwd, home }) {
  const common = {
    kind: 'preset',
    name,
    cwd,
    oxDir: path.join(home, '.ox'),
    tmpDir: os.tmpdir(),
    read_only: [],
    read_write: [],
    deny: [],
    restrict_network: false,
    network_allow: [],
    degraded: false,
    warnings: [],
  };
  if (name === 'workspace') return { ...common };
  if (name === 'read-only') return { ...common };
  if (name === 'strict') return { ...common, restrict_network: true };
  return {
    kind: 'off',
    name: 'off',
    cwd,
    oxDir: path.join(home, '.ox'),
    tmpDir: os.tmpdir(),
    read_only: [],
    read_write: [],
    deny: [],
    restrict_network: false,
    network_allow: [],
    degraded: false,
    warnings: [],
  };
}

function loadCustomProfile(file, name, ctx) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new SandboxConfigError(`ox: cannot read custom sandbox profile ${file}: ${err?.message ?? err}`);
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    throw new SandboxConfigError(`ox: malformed JSON in custom sandbox profile ${file}: ${err?.message ?? err}`);
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new SandboxConfigError(`ox: custom sandbox profile ${file} must be a JSON object`);
  }
  const baseName = doc.extends == null ? 'workspace' : String(doc.extends);
  if (!SANDBOX_PRESETS.includes(baseName) || baseName === 'off') {
    throw new SandboxConfigError(
      `ox: custom sandbox profile ${file}: 'extends' must be one of ${SANDBOX_PRESETS.filter((p) => p !== 'off').join(', ')}`
    );
  }
  const profile = presetProfile(baseName, ctx);
  profile.kind = 'custom';
  profile.name = name;
  profile.extends = baseName;
  profile.source = file;
  for (const field of ['read_only', 'read_write', 'deny']) {
    const list = doc[field];
    if (list == null) continue;
    if (!Array.isArray(list)) {
      throw new SandboxConfigError(`ox: custom sandbox profile ${file}: '${field}' must be an array of paths/globs`);
    }
    profile[field] = list.map((entry) => String(entry));
    for (const entry of profile[field]) {
      const why = validateGlobPattern(entry);
      if (why) {
        throw new SandboxConfigError(
          `ox: refusing to start — invalid glob '${entry}' (${why}) in ${file}:${lineOfEntry(raw, entry)}`
        );
      }
    }
  }
  if (doc.restrict_network != null) profile.restrict_network = doc.restrict_network === true;
  // network_allow: an array of host patterns. Unlike read_only/read_write/deny
  // a wrong type does NOT refuse startup — an allow-list is a narrowing, and
  // refusing to boot because of it would be a worse failure than running
  // stricter than asked. It degrades to [] (blanket deny) and says so.
  profile.network_allow = [];
  if (doc.network_allow != null) {
    if (Array.isArray(doc.network_allow)) {
      const entries = [];
      for (const rawEntry of doc.network_allow) {
        // Stored in canonical form, keeping the port (a port is only ever used
        // by the kernel rule) and IPv6 in brackets so `:port` cannot be
        // confused with the address itself.
        const { host, port } = hostAndPort(rawEntry);
        if (!host) {
          profile.warnings.push(
            `ox: custom sandbox profile ${file}: network_allow entry ${JSON.stringify(String(rawEntry))} is not a host ox can judge — ignored.`
          );
          continue;
        }
        const isIp = isIpLiteral(host) || CIDR4_RE.test(host);
        if (!isIp) {
          const why = validateGlobPattern(host);
          if (why) {
            throw new SandboxConfigError(
              `ox: refusing to start — invalid network_allow glob '${host}' (${why}) in ${file}:${lineOfEntry(raw, host)}`
            );
          }
        }
        // A port is only kept for an IP literal: that is the only entry class
        // the kernel rule can use, and host matching is by host alone. A
        // hostname written as `example.com:8443` is stored as `example.com`.
        const spelled = host.includes(':') ? `[${host}]` : host;
        entries.push(isIp && port ? `${spelled}:${port}` : isIp ? spelled : host);
      }
      profile.network_allow = entries;
    } else if (doc.network_allow !== false) {
      profile.warnings.push(
        `ox: custom sandbox profile ${file}: 'network_allow' must be an array of host patterns — ignored. ` +
          "With restrict_network:true that means a BLANKET network deny."
      );
    }
  }
  return profile;
}

export function resolveSandbox({ flag, config, cwd, home } = {}) {
  home = home ?? os.homedir();
  cwd = cwd ?? process.cwd();
  const cfgSandbox =
    config?.sandbox && typeof config.sandbox === 'object' && !Array.isArray(config.sandbox)
      ? config.sandbox
      : config?.raw?.sandbox && typeof config.raw.sandbox === 'object'
        ? config.raw.sandbox
        : {};
  const cfgProfile = cfgSandbox.profile != null && cfgSandbox.profile !== '' ? String(cfgSandbox.profile) : null;
  let name;
  let source;
  if (flag != null && flag !== '') {
    name = String(flag).toLowerCase();
    source = 'flag';
  } else if (cfgProfile) {
    name = cfgProfile.toLowerCase();
    source = 'config';
  } else {
    name = 'off';
    source = 'default';
  }

  const envBits = {
    env_mode: ['core', 'all', 'none'].includes(cfgSandbox.env_mode) ? cfgSandbox.env_mode : 'core',
    env_exclude: Array.isArray(cfgSandbox.env_exclude) ? cfgSandbox.env_exclude.map(String) : [],
    env_include: Array.isArray(cfgSandbox.env_include) ? cfgSandbox.env_include.map(String) : [],
  };

  const finish = (profile) => {
    const resolved = { ...profile, source, ...envBits };
    // src/guards.js and src/verify-loop.js already call ctx.sandbox.blocksTool
    // and treat a deny as monotonic (it beats yolo). Until this existed the
    // method was simply missing, so every production call site no-opped and
    // only the test stubs did anything. It is a closure over `profile` so the
    // decision always reads the resolved policy, never a stale copy.
    resolved.blocksTool = (toolName, args) => networkPolicyFor(profile, toolName, args).blocked === true;
    return resolved;
  };

  if (name === 'off') return finish(presetProfile('off', { cwd, home }));
  if (SANDBOX_PRESETS.includes(name)) return finish(presetProfile(name, { cwd, home }));

  const candidates = [
    ['project', path.join(cwd, '.ox-sandbox.json')],
    ['home', path.join(home, '.ox', 'sandbox.json')],
  ];
  for (const [, file] of candidates) {
    if (!fs.existsSync(file)) continue;
    const profile = loadCustomProfile(file, name, { cwd, home });
    profile.source = source;
    return finish(profile);
  }
  throw new SandboxConfigError(
    `ox: sandbox profile '${name}' not found — presets: ${SANDBOX_PRESETS.join(', ')}; custom profiles load from <cwd>/.ox-sandbox.json or ~/.ox/sandbox.json`
  );
}

// ---- network policy (the single decision point) ------------------------------
//
// One function owns "may this tool reach the network under this profile", and
// everything else asks it: resolveSandbox attaches it as profile.blocksTool
// (src/guards.js and src/verify-loop.js already call that), and
// src/tools/web.js calls it directly for its refusal prose. Two copies of a
// security decision is one copy too many.

// Tools that need egress. web_get is the network-egress-controlled fetch used by
// the ACP approval bridge; open_url hands the URL to the OS browser, which no
// sandbox prefix can reach.
export const NETWORK_TOOL_NAMES = new Set(['web_fetch', 'web_search', 'open_url', 'web_get']);

export function isNetworkTool(name) {
  return NETWORK_TOOL_NAMES.has(String(name ?? ''));
}

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const CIDR4_RE = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\/(\d{1,3})$/;

function isIpv4(s) {
  const m = IPV4_RE.exec(s);
  return !!m && m.slice(1).every((part) => Number(part) <= 255);
}

// The one host normaliser. Accepts a URL object, a URL string, `host`,
// `host:port`, `[v6]`, `[v6]:port` or a CIDR, and returns {host, port} with the
// port as '' when the input carried none. Lowercases, drops scheme/userinfo/
// path, unwraps IPv6 brackets, drops the DNS root dot.
//
// An input it cannot make sense of returns host:'' on purpose: a garbage host
// must never reach hostInAllowList, where a catch-all entry like '*' would
// otherwise match it. Empty means "no destination we can judge", which
// networkPolicyFor treats as a refusal.
export function hostAndPort(raw) {
  let s = typeof raw === 'string' ? raw : raw == null ? '' : String(raw);
  s = s.trim().toLowerCase();
  if (!s) return { host: '', port: '' };
  if (s.includes('://')) {
    let u;
    try {
      u = new URL(s);
    } catch {
      return { host: '', port: '' };
    }
    // WHATWG keeps the DNS root dot ('api.example.com.'), so strip it here too.
    return { host: String(u.hostname ?? '').replace(/^\[|\]$/g, '').replace(/\.$/, ''), port: String(u.port ?? '') };
  }
  if (s.startsWith('[')) {
    const end = s.indexOf(']');
    if (end === -1) return { host: '', port: '' };
    return { host: s.slice(1, end), port: s.slice(end + 2) };
  }
  // A CIDR keeps its prefix length — `/8` is not a path.
  if (CIDR4_RE.test(s)) return { host: s, port: '' };
  s = s.split('/')[0];
  if (s.includes('@')) s = s.slice(s.lastIndexOf('@') + 1);
  const colons = (s.match(/:/g) ?? []).length;
  if (colons > 1) return { host: s, port: '' }; // bare IPv6 literal, no port
  if (colons === 1) {
    const i = s.indexOf(':');
    // `api.example.com.:443` — the root dot belongs to the host, not the port.
    return { host: s.slice(0, i).replace(/\.$/, ''), port: s.slice(i + 1).replace(/\.$/, '') };
  }
  return { host: s.replace(/\.$/, ''), port: '' };
}

export function normalizeHost(raw) {
  return hostAndPort(raw).host;
}

// Destinations that stay refused no matter what a profile allow-lists: the
// loopback interface (a fetch to it is a fetch to a local admin port), every
// link-local range (that includes the cloud metadata endpoint), and unique-local
// IPv6. Allow-listing one of these is the exact mistake this guards.
const HARD_REFUSED_HOSTS = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
]);

export function isHardRefusedHost(rawHost) {
  const host = normalizeHost(rawHost);
  if (!host) return false;
  if (HARD_REFUSED_HOSTS.has(host)) return true;
  if (isIpv4(host)) {
    const [a, b] = host.split('.').map(Number);
    if (a === 127) return true; // loopback /8
    if (a === 169 && b === 254) return true; // link-local, incl. 169.254.169.254
    if (a === 0) return true; // 0.0.0.0 / this-network
    return false;
  }
  if (host === '::1' || host === '::' || host === '::ffff:127.0.0.1') return true;
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true; // fc00::/7 unique-local
  if (/^fe[89ab]/.test(host)) return true; // fe80::/10 link-local
  if (host.startsWith('::ffff:')) return isHardRefusedHost(host.slice(7));
  return false;
}

function hostInCidr4(host, cidr) {
  const m = CIDR4_RE.exec(cidr);
  if (!m || !isIpv4(host)) return false;
  const bits = Number(m[2]);
  if (bits < 0 || bits > 32) return false;
  const toInt = (s) => s.split('.').reduce((acc, part) => (acc << 8) | Number(part), 0) >>> 0;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (toInt(host) & mask) === (toInt(m[1]) & mask);
}

// Match a normalised host against the profile's network_allow. Same glob
// dialect as the file policies (globToRegexSource), fully anchored, so
// `*.example.com` matches `api.example.com` but not `example.com.evil.test`.
// Exact IPs and IPv4 CIDRs are matched numerically as well, because a CIDR is
// not expressible as a glob.
export function hostInAllowList(host, allowList) {
  const h = normalizeHost(host);
  if (!h) return false;
  for (const raw of Array.isArray(allowList) ? allowList : []) {
    const entry = normalizeHost(raw);
    if (!entry) continue;
    if (entry === '*' || entry === '**') return true;
    if (entry === h) return true;
    if (CIDR4_RE.test(entry) && hostInCidr4(h, entry)) return true;
    try {
      if (new RegExp(`^${globToRegexSource(entry)}$`).test(h)) return true;
    } catch {
      /* a pattern that will not compile simply does not match */
    }
  }
  return false;
}

function profileLabel(profile) {
  return profile?.name || profile?.kind || 'custom';
}

// The one decision. Returns {blocked, reason, host, label}. `reason` is for
// prose; callers decide the wording (src/tools/web.js owns the user-facing
// message so the honesty text lives next to the tool).
//
//   network-unrestricted  restrict_network is not true — nothing is blocked.
//   not-network-tool      not a tool that needs egress.
//   hard-refused          loopback / link-local / metadata: refused even when
//                         allow-listed.
//   no-destination        the tool's destination host is not knowable before
//                         the call (web_search picks a backend at request
//                         time) — fail closed rather than guess.
//   blanket-deny          restrict_network with an empty network_allow.
//   allowed / not-allowed host allow-list hit / near-miss.
export function networkPolicyFor(profile, name, args = {}) {
  const tool = String(name ?? '');
  if (!isNetworkTool(tool)) return { blocked: false, reason: 'not-network-tool', host: null };
  if (!profile || profile.restrict_network !== true) {
    return { blocked: false, reason: 'network-unrestricted', host: null };
  }
  const label = profileLabel(profile);
  const allow = Array.isArray(profile.network_allow) ? profile.network_allow : [];
  const host = normalizeHost(args?.url ?? args?.host ?? args?.href ?? args?.remote ?? args?.base_url ?? null);
  if (isHardRefusedHost(host)) {
    return { blocked: true, reason: 'hard-refused', host, label };
  }
  if (!host) return { blocked: true, reason: 'no-destination', host: null, label };
  if (allow.length === 0) return { blocked: true, reason: 'blanket-deny', host, label };
  if (hostInAllowList(host, allow)) return { blocked: false, reason: 'allowed', host, label };
  return { blocked: true, reason: 'not-allowed', host, label };
}

// ---- SBPL compilation (macOS) ----------------------------------------------

function sbplTmpRegex(profile) {
  const esc = String(profile.tmpDir).replace(/[\\^$."]/g, (c) => `\\${c}`);
  return `(regex "^${esc}/.*")`;
}

// A path interpolated into an SBPL `(subpath "...")`. Only a double quote and
// a backslash can terminate or escape the string literal; validateGlobPattern
// already rejects backslashes but not a double quote, so a literal read_only
// containing one would otherwise compile to an unparseable profile. This is
// byte-identical for every ordinary path.
function sbplStr(p) {
  return String(p).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// ---- macOS capability probe -------------------------------------------------
//
// A per-host Seatbelt allow rule is (allow network-outbound (remote ip "H:P")).
// It is documented, but the sandbox-exec on macOS 15.7 refuses to COMPILE any
// host other than '*' or 'localhost':
//     sandbox-exec: host must be * or localhost in network address
// Emitting it anyway would make every sandboxed command fail to launch, so the
// capability is probed once against the local binary and allow rules are
// emitted only where they actually load. No network call is made.
let remoteIpCapability = null;

export function seatbeltAllowsRemoteIp() {
  if (remoteIpCapability !== null) return remoteIpCapability;
  remoteIpCapability = false;
  if (process.platform !== 'darwin' || !fs.existsSync('/usr/bin/sandbox-exec')) return remoteIpCapability;
  const file = path.join(os.tmpdir(), 'ox-sbpl-remoteip-probe.sb');
  try {
    fs.writeFileSync(file, '(version 1)\n(allow default)\n(allow network-outbound (remote ip "203.0.113.7:443"))\n', {
      mode: 0o600,
    });
    const res = spawnSync('/usr/bin/sandbox-exec', ['-f', file, '/usr/bin/true'], { timeout: 15_000, stdio: 'ignore' });
    remoteIpCapability = res?.status === 0;
  } catch {
    remoteIpCapability = false;
  }
  return remoteIpCapability;
}

export function setSeatbeltRemoteIpCapabilityForTest(value) {
  remoteIpCapability = value == null ? null : !!value;
}

function isIpLiteral(host) {
  if (isIpv4(host)) return true;
  return host.includes(':') && /^[0-9a-f:]+$/.test(host) && !/:::$/.test(host);
}

// Which allow-list entries a seatbelt rule can express, and which cannot.
// CANNOT: hostnames (a policy is compiled before any DNS answer exists) and
// IPv4 CIDRs (no CIDR form in the remote filter) — those two classes are
// enforced in-process only, and the compiled profile says so in a comment.
export function splitNetworkAllow(allowList) {
  const kernel = [];
  const userspaceOnly = [];
  for (const raw of Array.isArray(allowList) ? allowList : []) {
    const { host, port: given } = hostAndPort(raw);
    if (!host) continue;
    const port = given || '*'; // '*' = any port
    if (CIDR4_RE.test(host)) {
      userspaceOnly.push(`${host} (CIDR — no seatbelt form)`);
    } else if (isIpLiteral(host)) {
      kernel.push({ host, port });
    } else {
      userspaceOnly.push(`${host} (hostname — a policy cannot resolve a name at compile time)`);
    }
  }
  return { kernel, userspaceOnly };
}

function sbplAddr(host, port) {
  return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
}

export function compileSbpl(profile) {
  if (!profile || profile.kind === 'off' || profile.name === 'off') return null;
  // Branch on the BASE preset. A custom profile's `name` is whatever the user
  // typed; `extends` is the preset it inherits.
  const base = profileBaseName(profile);
  const tmpAllow = sbplTmpRegex(profile);
  const lines = ['(version 1)', '(allow default)'];
  if (base === 'workspace') {
    lines.push('(deny file-write*)');
    lines.push(`(allow file-write* (subpath "${profile.cwd}") (subpath "${profile.oxDir}") ${tmpAllow})`);
  } else if (base === 'read-only') {
    lines.push('(deny file-write*)');
    lines.push(`(allow file-write* (subpath "${profile.oxDir}") ${tmpAllow})`);
  } else {
    // strict (and any custom profile extending it): writable = tmp only.
    lines.push('(deny file-write*)');
    lines.push(`(allow file-write* ${tmpAllow})`);
  }
  // One deny for the whole profile — the old code emitted a second one from a
  // separate `restrict_network` branch, which is why the strict profile used
  // to compile two identical (deny network*) lines.
  if (profile.restrict_network) {
    lines.push('(deny network*)');
    const { kernel, userspaceOnly } = splitNetworkAllow(profile.network_allow ?? []);
    const canRemoteIp = kernel.length > 0 ? seatbeltAllowsRemoteIp() : false;
    if (kernel.length && canRemoteIp) {
      for (const { host, port } of kernel) {
        lines.push(`(allow network-outbound (remote ip "${sbplAddr(host, port)}"))`);
      }
    }
    if (kernel.length && !canRemoteIp) {
      lines.push(
        '; ox: this sandbox-exec REJECTS a per-host (remote ip …) rule ("host must be * or localhost"),' +
          ' so the allow-list below is NOT kernel-enforced here — it is enforced in-process' +
          ' (src/sandbox.js networkPolicyFor / src/tools/web.js). The deny above stands.'
      );
    }
    // Per-entry documentation, emitted whether or not the kernel path exists, so
    // the compiled profile always names exactly what it did not enforce.
    for (const entry of userspaceOnly) {
      const why = entry.includes('CIDR')
        ? 'seatbelt has no CIDR form for the remote filter'
        : 'a hostname cannot be resolved when a policy is compiled, and re-checking DNS at connect time' +
          ' is still not a kernel boundary';
      lines.push(
        `; ox: network_allow entry ${entry} is enforced IN-PROCESS ONLY (src/sandbox.js networkPolicyFor).` +
          ` It is deliberately NOT translated into a kernel rule: ${why}.`
      );
    }
  }

  // Custom widening roots.
  for (const p of profile.read_write ?? []) {
    if (isLiteralPath(p)) lines.push(`(allow file-write* (subpath "${sbplStr(p)}"))`);
    else lines.push(`(allow file-write* (regex "^${globToRegexSource(p)}$"))`);
  }

  // read_only: a write deny per entry, LITERAL AND GLOB ALIKE.
  //
  // This loop used to skip literal paths on the theory that the blanket
  // `(deny file-write*)` already covered them. That is only true OUTSIDE every
  // writable root. Seatbelt takes the LAST matching rule, and the
  // `(allow file-write* (subpath "<cwd>"))` emitted above comes after the
  // blanket deny — so inside cwd that allow wins, and a skipped literal
  // read_only was left WRITABLE. A profile could name /ws/inside read_only,
  // compile to a policy that never mentioned it, report gaps.unapplied == []
  // and profile.warnings == [], and take the write: silent, and failing OPEN.
  //
  // The skip was an output-size optimisation and nothing depended on it, so it
  // is gone. A redundant rule is never worth a policy hole. This deny is also
  // emitted after the read_write allows, so read_only beats an overlapping
  // read_write — the more restrictive of two user statements wins, which is the
  // fail-closed reading.
  for (const p of profile.read_only ?? []) {
    if (isLiteralPath(p)) lines.push(`(deny file-write* (subpath "${sbplStr(p)}"))`);
    else lines.push(`(deny file-write* (regex "^${globToRegexSource(p)}$"))`);
  }

  // Explicit user denies LAST so they win over the blanket exceptions above.
  // Literal and glob entries get the same mapping read_only now uses (subpath
  // vs anchored regex), so the two lists cannot drift apart the way read_only
  // and deny just did.
  for (const d of profile.deny ?? []) {
    if (isLiteralPath(d)) {
      lines.push(`(deny file-read* (subpath "${sbplStr(d)}"))`);
      lines.push(`(deny file-write* (subpath "${sbplStr(d)}"))`);
    } else {
      lines.push(`(deny file-read* (regex "^${globToRegexSource(d)}$"))`);
      lines.push(`(deny file-write* (regex "^${globToRegexSource(d)}$"))`);
    }
  }
  return lines.join('\n') + '\n';
}

// ---- Linux bwrap -------------------------------------------------------------

export function buildBwrapArgv(profile, command, shell = '/bin/sh') {
  const prefix = bwrapPrefix(profile);
  if (!prefix) return null;
  return [...prefix, shell, '-lc', command];
}

function bwrapPrefix(profile) {
  if (!profile || profile.kind === 'off' || profile.name === 'off') return null;
  const argv = [
    'bwrap',
    '--ro-bind',
    '/',
    '/',
    '--bind',
    profile.cwd,
    profile.cwd,
    '--tmpfs',
    '/tmp',
    '--dev',
    '/dev',
    '--proc',
    '/proc',
  ];
  // Same base-name rule as compileSbpl, so the two backends never disagree
  // about a custom profile: strict keeps the writable set to cwd and tmp.
  const base = profileBaseName(profile);
  if (base !== 'strict') argv.push('--bind', profile.oxDir, profile.oxDir);
  // A glob has no bwrap form (--bind takes one concrete path), so only literals
  // are widened; the rest are named in bwrapGaps rather than dropped quietly.
  for (const p of profile.read_write ?? []) {
    if (isLiteralPath(p)) argv.push('--bind', p, p);
  }
  // read_only is NOT looped over here, and that is a fail-OPEN gap, not an
  // optimisation: nothing in this argv subtracts a path from the writable set.
  // It is reported through bwrapGaps()/unapplied (and shown by /sandbox) so a
  // policy the backend cannot honour is never silently unenforced.
  if (profile.restrict_network) argv.push('--unshare-net');
  return argv;
}

// What bwrap structurally cannot express, and what ox does not bother to
// express. bwrap is a mount builder, not a policy language: there is no
// "deny writes here" and no host or port allow-list (--unshare-net is
// all-or-nothing). Returning these as data lets prepareSandbox warn once at
// startup and lets /sandbox print them, instead of shipping a profile that
// quietly under- or over-restricts.
//
// Every field either backend reads is listed here if bwrap does not fully
// express it. Silence about a field that is unenforced IS the defect — a
// profile field that does nothing must say so, loudly, in both directions:
// `read_only`/`deny` are fail-OPEN if dropped (something the user forbade
// becomes writable), `read_write` globs are fail-CLOSED (something the user
// widened stays read-only).
export function bwrapGaps(profile) {
  const unapplied = [];
  const notes = [];
  if (!profile || profile.kind === 'off') return { unapplied, notes };
  const allow = Array.isArray(profile.network_allow) ? profile.network_allow : [];
  if (profile.restrict_network && allow.length > 0) {
    unapplied.push('network_allow');
    notes.push(
      `network_allow (${allow.length} entr${allow.length === 1 ? 'y' : 'ies'}) is NOT applied on Linux: bwrap has no ` +
        'host or port allow-list, so --unshare-net denies ALL egress from spawned commands. Fail-closed ' +
        '(over-restrictive for the allowed hosts, never a silent under-restriction). The allow-list is ' +
        'enforced in-process by src/sandbox.js networkPolicyFor, which covers ox\'s own web tools only.'
    );
  }
  const readOnly = (profile.read_only ?? []).map(String).filter(Boolean);
  if (readOnly.length > 0) {
    unapplied.push('read_only');
    notes.push(
      `read_only (${readOnly.length} entr${readOnly.length === 1 ? 'y' : 'ies'}) is NOT applied on Linux: the bwrap ` +
        'argv ox builds cannot remove a path from the writable set. bwrap is a mount builder, not a policy ' +
        'language, and ox deliberately does not emit a shadowing --ro-bind for these because that ordering ' +
        'behaviour is unverified — so a read_write --bind covering one of these stays WRITABLE (fail-open, ' +
        'reported here rather than left silent). macOS SBPL enforces the same entries, literal via ' +
        '(deny file-write* (subpath …)) and glob via (deny file-write* (regex …)), both emitted AFTER the ' +
        'write roots so they win inside cwd.'
    );
  }
  const denies = (profile.deny ?? []).map(String).filter(Boolean);
  if (denies.length > 0) {
    unapplied.push('deny');
    notes.push(
      `deny (${denies.length} entr${denies.length === 1 ? 'y' : 'ies'}) is NOT applied on Linux: bwrapPrefix() has ` +
        'no rule kind for an explicit read/write deny, so these paths are neither read-blocked nor ' +
        'write-blocked. This is the fail-OPEN direction and is reported loudly rather than dropped quietly. ' +
        'macOS SBPL emits (deny file-read* …) and (deny file-write* …) for the same entries, last.'
    );
  }
  const rwGlobs = (profile.read_write ?? []).map(String).filter((p) => p && !isLiteralPath(p));
  if (rwGlobs.length > 0) {
    unapplied.push('read_write(glob)');
    notes.push(
      `read_write glob entr${rwGlobs.length === 1 ? 'y' : 'ies'} (${rwGlobs.join(', ')}) are NOT applied on ` +
        'Linux: --bind needs one concrete path, so a glob cannot be widened. Fail-closed (the matching ' +
        'subtrees simply stay read-only), but the profile is not doing what it says.'
    );
  }
  return { unapplied, notes };
}

export function findBin(name) {
  const dirs = [...(process.env.PATH ?? '').split(':').filter(Boolean), '/usr/bin', '/usr/local/bin', '/opt/homebrew/bin'];
  for (const dir of dirs) {
    try {
      const full = path.join(dir, name);
      fs.accessSync(full, fs.constants.X_OK);
      return full;
    } catch {}
  }
  return null;
}

// ---- per-session compile cache ------------------------------------------------

const compileCache = new Map();

// Every field either backend reads has to be in here: the compiled SBPL is
// written to a tmpfile NAMED by this hash, so a field left out means two
// different policies silently share one compiled file. (read_only and
// network_allow were both missing: two profiles differing only in either
// returned the first one's SBPL.)
function cacheKey(profile) {
  return JSON.stringify([
    profile.kind,
    profile.name,
    profile.extends ?? null,
    profile.cwd,
    profile.oxDir,
    profile.tmpDir,
    profile.restrict_network,
    profile.network_allow ?? [],
    profile.deny ?? [],
    profile.read_write ?? [],
    profile.read_only ?? [],
  ]);
}

const warnedGaps = new Set();

// One warning per (backend, gap-set) so a long session does not repeat itself
// while a real gap is never silent.
function warnGaps(backend, gaps) {
  if (!gaps?.notes?.length) return;
  const key = `${backend}:${gaps.unapplied.join(',')}`;
  if (warnedGaps.has(key)) return;
  warnedGaps.add(key);
  for (const note of gaps.notes) console.warn(`ox: sandbox ${backend} — ${note}`);
}

// Compiles once per session; returns {backend, degraded, argvPrefix, gaps}.
// `gaps.unapplied` names the profile fields this backend could NOT express, so
// callers (and /sandbox) can report an over- or under-restriction instead of
// implying the profile is fully enforced.
export function prepareSandbox(profile) {
  if (!profile || profile.kind === 'off' || profile.name === 'off') {
    return { backend: 'none', degraded: true, argvPrefix: null, gaps: { unapplied: [], notes: [] } };
  }
  const key = cacheKey(profile);
  if (compileCache.has(key)) return compileCache.get(key);

  let result;
  if (process.platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec')) {
    const text = compileSbpl(profile);
    const hash = crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
    const file = path.join(os.tmpdir(), `ox-sbpl-${hash}.sb`);
    fs.writeFileSync(file, text, { mode: 0o600 });
    // What macOS could not express: every network_allow entry that is not a
    // plain IP literal (and, on a sandbox-exec without per-host `remote ip`
    // support, the whole allow-list).
    const { userspaceOnly } = splitNetworkAllow(profile.network_allow ?? []);
    const allowCount = (profile.network_allow ?? []).length;
    const gaps = { unapplied: [], notes: [] };
    // An EMPTY allow-list is a blanket deny, which IS fully kernel-enforced —
    // there is no gap to report.
    if (profile.restrict_network && allowCount > 0) {
      const kernelCount = allowCount - userspaceOnly.length;
      if (!seatbeltAllowsRemoteIp()) {
        gaps.unapplied.push('network_allow');
        gaps.notes.push(
          `network_allow (${allowCount} entr${allowCount === 1 ? 'y' : 'ies'}) is NOT kernel-enforced on this macOS: ` +
            'sandbox-exec refuses a per-host (remote ip …) rule, and a hostname cannot be resolved when a ' +
            'policy is compiled. The (deny network*) rule below IS enforced for spawned commands; the ' +
            "allow-list is enforced in-process by ox's own web tools (src/tools/web.js)."
        );
      } else if (userspaceOnly.length > 0) {
        gaps.unapplied.push('network_allow(partial)');
        gaps.notes.push(
          `${userspaceOnly.length} network_allow entr${userspaceOnly.length === 1 ? 'y' : 'ies'} ` +
            `(${userspaceOnly.join(', ')}) are enforced in-process only; the ${kernelCount} IP entr${kernelCount === 1 ? 'y' : 'ies'} ` +
            'are kernel-enforced by (allow network-outbound (remote ip …)).'
        );
      }
    }
    result = { backend: 'sandbox-exec', degraded: false, argvPrefix: ['/usr/bin/sandbox-exec', '-f', file], gaps };
    warnGaps('sandbox-exec', gaps);
  } else if (process.platform === 'linux') {
    const bw = findBin('bwrap');
    if (bw) {
      const gaps = bwrapGaps(profile);
      result = { backend: 'bwrap', degraded: false, argvPrefix: bwrapPrefix(profile), gaps };
      warnGaps('bwrap', gaps);
    } else {
      result = { backend: 'none', degraded: true, argvPrefix: null, gaps: { unapplied: [], notes: [] } };
    }
  } else {
    result = { backend: 'none', degraded: true, argvPrefix: null, gaps: { unapplied: [], notes: [] } };
  }
  compileCache.set(key, result);
  return result;
}

export function resetSandboxCompileCacheForTest() {
  compileCache.clear();
  warnedGaps.clear();
}

// Current backend capability for display purposes.
export function sandboxBackendFor(profile) {
  if (!profile || profile.kind === 'off' || profile.name === 'off') return 'none';
  if (process.platform === 'darwin') return fs.existsSync('/usr/bin/sandbox-exec') ? 'sandbox-exec' : 'none';
  if (process.platform === 'linux') return findBin('bwrap') ? 'bwrap' : 'none';
  return 'none';
}

// ---- denied-vs-failed classifier (DeepSeek dsh denialSignatures) -------
//
// Distinguishes "the kernel blocked this" (EROFS/EACCES/EPERM on Linux,
// errSec* on macOS) from "the command ran and failed". Lets the agent report
// sandbox refusals accurately instead of misreading them as bugs.

const DENIAL_PATTERNS = [
  { re: /\bEROFS\b|read-only file system/i, sig: 'EROFS' },
  { re: /\bEACCES\b|permission denied/i, sig: 'EACCES' },
  { re: /\bEPERM\b|operation not permitted/i, sig: 'EPERM' },
  { re: /errSecAuthFailed|errSecPermissionDenied|denied by security policy/i, sig: 'MACOS_AUTH' },
  { re: /sandbox.*violation|violated sandbox|sandbox_check/i, sig: 'SBPL' },
];

export function classifySandboxExit({ code, signal, stderr, backend }) {
  const text = String(stderr ?? '');
  for (const p of DENIAL_PATTERNS) {
    if (p.re.test(text)) {
      return { kind: 'sandbox-denied', signature: p.sig, backend: backend || 'unknown' };
    }
  }
  return { kind: 'command-failed', signature: null, backend: backend || 'unknown' };
}

// ---- violation events ledger ---------------------------------------------------

export function appendSandboxEvent(row) {
  appendJsonlCapped(path.join(CONFIG_DIR, 'sandbox-events.jsonl'), { ts: new Date().toISOString(), ...row }, 5 * 1024 * 1024);
}

// ---- session pinning ------------------------------------------------------------

export function pinnedSandboxFromEvents(events) {
  for (let i = (events ?? []).length - 1; i >= 0; i--) {
    if (events[i]?.t === 'sandbox') return events[i];
  }
  return null;
}

// grok-build semantics: resume/--continue with a DIFFERENT requested profile
// refuses with exit 4 naming the mismatch.
export function assertSandboxPinCompatible(events, requestedName) {
  const pinned = pinnedSandboxFromEvents(events);
  if (!pinned) return null;
  const pinnedName = String(pinned.profile ?? 'off');
  if (pinnedName !== String(requestedName)) {
    throw new SandboxConfigError(
      `ox: sandbox profile mismatch — session is pinned to '${pinnedName}' but '${requestedName}' was requested. Resume keeps the pinned profile; start a fresh session (or drop --sandbox) to change it.`
    );
  }
  return pinned;
}
