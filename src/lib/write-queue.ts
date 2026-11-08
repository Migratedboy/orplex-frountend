/**
 * write-queue.ts — per-file write serialization.
 *
 * Every mutating tool call funnels through the audited write path; concurrent
 * writers to the SAME file (two agents, an agent + a background lane) must
 * run one at a time in order. Different files never wait on each other.
 *
 * Keys are normalized workspace paths ("\" → "/"), so src/a.ts arriving as
 * both separators resolves to one queue.
 */

const queues = new Map<string, Promise<unknown>>();

/** Normalized queue key: workspace-relative, forward slashes, no trailing dupes. */
export function normalizeWritePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
}

/**
 * Run `fn` exclusively against the given paths: it waits until every prior
 * queued run for those paths has settled, then runs. Other files' queues are
 * untouched, so different files still run in parallel.
 */
export function serializeWrites<T>(
  paths: readonly string[],
  fn: () => Promise<T>
): Promise<T> {
  const keys = [...new Set(paths.map((path) => normalizeWritePath(path)))].sort();
  if (keys.length === 0) return fn();
  const prior = keys
    .map((key) => queues.get(key))
    .filter((waiting): waiting is Promise<unknown> => waiting !== undefined)
    .map((waiting) => waiting.catch(() => undefined));
  const run = Promise.all(prior).then(fn);
  for (const key of keys) queues.set(key, run.catch(() => undefined));
  return run;
}

/** Test hook: drain state between tests. Never returns pending work. */
export function clearWriteQueueForTests(): void {
  queues.clear();
}
