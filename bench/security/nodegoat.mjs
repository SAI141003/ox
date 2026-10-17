// ox secure on OWASP NodeGoat (github.com/OWASP/NodeGoat), a deliberately
// vulnerable app whose authors document each vulnerability. Not tuned for:
// the expected list below is NodeGoat's own (its tutorial), by file and line.
//   node bench/security/nodegoat.mjs <path to a NodeGoat checkout>
import path from 'node:path';
import { scanPaths } from '../../src/security-scan.js';

const root = process.argv[2];
if (!root) { console.error('usage: node bench/security/nodegoat.mjs <NodeGoat checkout>'); process.exit(2); }
// NodeGoat's documented, code-level vulnerabilities (tutorial A1–A10, and the
// research page's SSRF). Log injection (A1-3) is listed and expected to be missed:
// it depends on what reads the log, which no line rule can know.
const EXPECTED = [
  { what: 'A1-1 server-side JS injection (eval)', file: 'app/routes/contributions.js', cwe: 'CWE-95' },
  { what: 'A1-2 NoSQL injection ($where)', file: 'app/data/allocations-dao.js', cwe: 'CWE-943' },
  { what: 'A1-3 log injection', file: 'app/routes/session.js', cwe: 'CWE-117' },
  { what: 'A3 XSS (template autoescape off)', file: 'server.js', cwe: 'CWE-79' },
  { what: 'A10 unvalidated redirect', file: 'app/routes/index.js', cwe: 'CWE-601' },
  { what: 'SSRF (research page)', file: 'app/routes/research.js', cwe: 'CWE-918' },
  { what: 'ReDoS (profile bank routing)', file: 'app/routes/profile.js', cwe: 'CWE-1333' },
  { what: 'hardcoded cookie secret', file: 'config/env/all.js', cwe: 'CWE-798' },
];
const t0 = Date.now();
const { findings, files } = scanPaths(['app/routes', 'app/data', 'server.js', 'config'], { cwd: path.resolve(root) });
let hit = 0;
for (const e of EXPECTED) {
  const ok = findings.some((f) => f.file === e.file && f.cwe === e.cwe);
  if (ok) hit++;
  console.log(`${ok ? 'FOUND ' : 'missed'}  ${e.what}  (${e.file}, ${e.cwe})`);
}
const extra = findings.filter((f) => !EXPECTED.some((e) => e.file === f.file && e.cwe === f.cwe));
console.log(`\nfound ${hit}/${EXPECTED.length} documented vulnerabilities in ${files} files, ${Date.now() - t0} ms`);
console.log(`other findings: ${extra.length}${extra.length ? `\n${extra.map((f) => `  ${f.severity} ${f.file}:${f.line} ${f.cwe} ${f.rule}`).join('\n')}` : ''}`);
