// Keyed async locks for workspace mutations.
//
// Subagents intentionally share the parent workspace today. A lock per
// resolved path prevents two edit/write calls from reading the same old
// contents and then silently overwriting one another, while preserving
// concurrency for independent files. This is coordination, not isolation:
// callers still need an explicit worktree/merge strategy for conflicting
// multi-file tasks.
const queues = new Map();

export async function withWriteLock(key, fn) {
  const lockKey = String(key ?? '');
  const previous = queues.get(lockKey) ?? Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  queues.set(lockKey, current);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (queues.get(lockKey) === current) queues.delete(lockKey);
  }
}

export function pendingWriteLocks() {
  return queues.size;
}

