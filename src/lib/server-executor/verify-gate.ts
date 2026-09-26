// verify-gate.ts — Global serialization for the server executor's verify lane.
//
// Whatever the run concurrency, at most ONE verify dev server may exist at a
// time: on the 8 GB target machine each boot is +0.5–1 GB RSS and two boots
// on the same port collide. The gate is a promise-chain mutex — trivially
// correct, no deps, and the port offset adds defense-in-depth for any
// diagnostic path that ever runs two slots side by side.

import { BROWSER_VERIFY_PORT } from "../ui-paths";

let chain: Promise<void> = Promise.resolve();
let active = 0; // jobs currently holding the slot

/** Run `fn` while holding the global verify slot (FIFO). */
export function withVerifySlot<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    active++;
    try {
      return await fn();
    } finally {
      active--;
    }
  });
  // Keep the chain alive even when fn rejects — one failed verify must not
  // poison every later one.
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Deterministic per-run port near the base (stable across restarts). */
export function verifyPortForRun(runId: string, base: number = BROWSER_VERIFY_PORT): number {
  let h = 0;
  for (let i = 0; i < runId.length; i++) h = (h * 31 + runId.charCodeAt(i)) >>> 0;
  return base + (h % 50);
}

/** Test/diagnostic hook: is the slot free? */
export function isVerifySlotFree(): boolean {
  return active === 0;
}
