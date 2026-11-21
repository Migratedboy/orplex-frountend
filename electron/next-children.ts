/**
 * electron/next-children.ts — kill-lane for the two Next.js child processes
 * the main process owns.
 *
 * The will-quit teardown (main.ts) and the SIGTERM/SIGINT shutdown path used
 * to duplicate this loop verbatim — two copies of platform kill logic that
 * could drift. There is exactly one implementation now. Ownership of the
 * child references (nextProcess/apiProcess) stays in main.ts: it spawns the
 * children and passes them in here.
 *
 * WHY SYNCHRONOUS: this runs on the way out, immediately before an installer
 * may start replacing files. A fire-and-forget `spawn("taskkill")` returns
 * before the tree is dead, so on Windows the updater could overwrite
 * `app.asar.unpacked/.next/standalone` while the old server still had those
 * files mapped: the executable is replaced, the app server is not, and the new
 * version boots the old UI. Blocking here means "the children are gone" is true
 * by the time quit continues.
 */
import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

/** Kill both Next.js children so no orphaned node process holds the ports. */
export function killNextChildren(
  nextProcess: ChildProcess | null,
  apiProcess: ChildProcess | null
): void {
  for (const child of [nextProcess, apiProcess]) {
    if (child && !child.killed && typeof child.pid === "number") {
      try {
        if (process.platform === "win32") {
          // /T walks the tree (cmd shim → node), /F refuses to be ignored.
          execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
            stdio: "ignore",
            timeout: 10_000,
          });
        } else {
          child.kill("SIGTERM");
        }
      } catch {
        // Fall back to the handle: a backgrounded/unresponsive child still
        // needs a signal even if the tree-walk tool refused.
        try {
          child.kill("SIGKILL");
        } catch {}
      }
    }
  }
}

/**
 * Non-blocking variant, for callers that must not stall the event loop (the
 * tray quit path, the SIGTERM handler). Same semantics, no waiting.
 */
export function killNextChildrenDetached(
  nextProcess: ChildProcess | null,
  apiProcess: ChildProcess | null
): void {
  for (const child of [nextProcess, apiProcess]) {
    if (child && !child.killed && typeof child.pid === "number") {
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
