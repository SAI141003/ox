// ox secure on the labelled set: how many vulnerable lines it catches with the
// right CWE (recall), and how many safe lookalikes it wrongly flags.
//   node bench/security/run.mjs [--misses]
import { scanText } from '../../src/security-scan.js';
import { HOLDOUT as CASES } from './holdout.mjs';

const showMisses = process.argv.includes('--misses');
let tp = 0, fn = 0, fp = 0, tn = 0, wrongCwe = 0;
const misses = [];
const t0 = process.hrtime.bigint();
for (const c of CASES) {
  const found = scanText(c.f, c.code);
  if (c.cwe) {
    if (found.some((x) => x.cwe === c.cwe || (c.cwe === 'CWE-916' && x.cwe === 'CWE-327'))) tp++;
    else { fn++; if (found.length) wrongCwe++; misses.push(`MISS ${c.cwe} ${c.f}: ${c.code}${found.length ? `  (found ${found.map((x) => x.cwe).join(',')})` : ''}`); }
  } else if (found.length) { fp++; misses.push(`FALSE ALARM ${found.map((x) => x.rule).join(',')} ${c.f}: ${c.code}`); }
  else tn++;
}
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
const vul = tp + fn, safe = fp + tn;
console.log(`ox secure, HELD-OUT set: ${CASES.length} lines (${vul} vulnerable, ${safe} safe lookalikes)`);
console.log(`caught      ${tp}/${vul}  (${((tp / vul) * 100).toFixed(1)}% recall)`);
console.log(`false alarm ${fp}/${safe}  (${((fp / safe) * 100).toFixed(1)}%)`);
console.log(`precision   ${((tp / Math.max(1, tp + fp)) * 100).toFixed(1)}%`);
console.log(`time        ${ms.toFixed(1)} ms for all ${CASES.length} lines`);
if (showMisses && misses.length) console.log(`\n${misses.join('\n')}`);
