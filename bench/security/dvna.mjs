// ox secure on DVNA (github.com/appsecco/dvna): an UNTUNED test. The expected
// list comes from DVNA's own solution docs (docs/solution/*.md) and was fixed
// before the first run; no rule was changed after looking at the result.
//   node bench/security/dvna.mjs <path to a DVNA checkout>
import path from 'node:path';
import { scanPaths } from '../../src/security-scan.js';

const root = process.argv[2];
if (!root) { console.error('usage: node bench/security/dvna.mjs <DVNA checkout>'); process.exit(2); }
const EXPECTED = [
  { what: 'A1 SQL injection (sequelize.query with a built string)', file: 'core/appHandler.js', cwe: 'CWE-89' },
  { what: 'A1 command injection (exec ping + address)', file: 'core/appHandler.js', cwe: 'CWE-78' },
  { what: 'A4 XXE (libxmljs noent: true)', file: 'core/appHandler.js', cwe: 'CWE-611' },
  { what: 'A8 insecure deserialization (node-serialize)', file: 'core/appHandler.js', cwe: 'CWE-502' },
  { what: 'A10:2013 open redirect', file: 'core/appHandler.js', cwe: 'CWE-601' },
  { what: 'A7 XSS (EJS unescaped output)', file: 'views/app/products.ejs', cwe: 'CWE-79' },
  { what: 'A3 password hashes sent by the admin API', file: 'core/appHandler.js', cwe: 'CWE-200' },
];
const t0 = Date.now();
const { findings, files } = scanPaths(['core', 'routes', 'models', 'config', 'server.js', 'views'], { cwd: path.resolve(root) });
let hit = 0;
for (const e of EXPECTED) {
  const ok = findings.some((f) => f.file === e.file && f.cwe === e.cwe);
  if (ok) hit++;
  console.log(`${ok ? 'FOUND ' : 'missed'}  ${e.what}  (${e.file}, ${e.cwe})`);
}
const extra = findings.filter((f) => !EXPECTED.some((e) => e.file === f.file && e.cwe === f.cwe));
console.log(`\nfound ${hit}/${EXPECTED.length} documented vulnerabilities in ${files} files, ${Date.now() - t0} ms`);
console.log(`other findings: ${extra.length}${extra.length ? `\n${extra.map((f) => `  ${f.severity} ${f.file}:${f.line} ${f.cwe} ${f.rule} | ${f.excerpt.slice(0, 90)}`).join('\n')}` : ''}`);
