// The worker side of off-thread.js: run one exported function and send back its answer.
import { parentPort, workerData as w } from 'node:worker_threads';

try {
  const value = await (await import(w.url))[w.fn](...w.args);
  parentPort.postMessage({ value: value === undefined ? null : JSON.parse(JSON.stringify(value)) });
} catch (e) {
  parentPort.postMessage({ error: String(e?.message ?? e) });
}
process.exit(0);
