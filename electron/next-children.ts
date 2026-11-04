/**
 * electron/next-children.ts — kill-lane for the two Next.js child processes
 * the main process owns.
 *
 * The will-quit teardown (main.ts) and the SIGTERM/SIGINT shutdown path used
 * to duplicate this loop verbatim — two copies of platform kill logic that
 * could drift. There is exactly one implementation now. Ownership of the
 * child references (nextProcess/apiProcess) stays in main.ts: it spawns the
 * children and passes them in here.
 */
import { spawn, type ChildProcess } from "node:child_process";

/** Kill both Next.js children so no orphaned node process holds the ports. */
export function killNextChildren(
  nextProcess: ChildProcess | null,
  apiProcess: ChildProcess | null
): void {
  for (const child of [nextProcess, apiProcess]) {
    if (child && !child.killed) {
      try {
        if (process.platform === "win32") {
          spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
        } else {
          child.kill("SIGTERM");
        }
      } catch {}
    }
  }
}
