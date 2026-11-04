// Slow read-only work (gh, git, Mail, version checks) runs commands synchronously.
// On the server's own thread that stops it answering anything: the app looked dead,
// was restarted, and whatever else was running (Studio, a chat) was cut off. This
// runs one exported function of an ox module on a worker thread instead. Arguments
// and the answer are copied, so the module's in-memory state is the worker's own:
// only for functions that read and return. Under tests it runs here, where mocks are.
import { Worker } from 'node:worker_threads';

export async function offThread(file, fn, args = [], { timeoutMs = 60_000 } = {}) {
  const url = new URL(file, import.meta.url).href;
  if (process.env.NODE_TEST_CONTEXT) return (await import(url))[fn](...args);
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./off-thread-worker.js', import.meta.url), { workerData: { url, fn, args }, stdout: true, stderr: true, execArgv: [] });
    worker.unref();
    const timer = setTimeout(() => { worker.terminate(); reject(new Error(`${fn} took too long`)); }, timeoutMs);
    timer.unref?.();
    const done = (settle, v) => { clearTimeout(timer); settle(v); };
    worker.once('message', (m) => (m.error ? done(reject, new Error(m.error)) : done(resolve, m.value)));
    worker.once('error', (e) => done(reject, e));
    worker.once('exit', () => done(reject, new Error(`${fn} stopped without an answer`)));
  });
}
