// contract/browser-server.ts — Server-only browser backends (Step A).
//
// Split out of ./browser because TurboPack traces dynamic imports into the
// CLIENT bundle: background-worker → native-tools imports the contract, and
// a runtime import of agent-browser-session (Playwright, child_process, fs)
// breaks `next build` with 100+ module-not-found errors. This file is
// imported ONLY from server code (server executor, API routes) — never from
// anything the browser bundle touches.

import type {
  BrowserBackend,
  BrowserOpArgs,
  BrowserOpName,
} from "./browser";
import type { BrowserOpResult } from "../../agent-browser-session";

/** Playwright backend: wraps the headless session runner (server + API route). */
export function playwrightBackend(userId: string, sessionId?: string): BrowserBackend {
  return {
    kind: "playwright",
    async run(op: BrowserOpName, args: BrowserOpArgs): Promise<BrowserOpResult> {
      const { runBrowserOp } = await import("../../agent-browser-session");
      return runBrowserOp(userId, op, sessionId ? { ...args, sessionId } : args);
    },
  };
}
