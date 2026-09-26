/**
 * live-validate.test.ts — REAL end-to-end validation of the code-mode loop.
 *
 * NOT part of the normal suite: only runs when LIVE_VALIDATE=1, and skips fast
 * otherwise. Drives the REAL background-worker in-process (exactly as the
 * browser does) with:
 *   - REAL disk FS via setFileSystemAccess (writes land in .live-validate/)
 *   - REAL servers: fetch passes through to the dev server (chat model, exec,
 *     orchestrate)
 *   - REAL model: Groq gpt-oss-120b via /api/chat (no mock provider)
 *   - Auto-approver standing in for approval clicks (in-process poller on the
 *     same approval-store the worker awaits)
 *   - Diagnostic override: points /api/agent/verify at .live-validate even if
 *     the server-side workspace registry lost state across restarts.
 *
 * Run: LIVE_VALIDATE=1 npx jest src/lib/__tests__/live-validate.test.ts --runInBand
 */
import * as fs from "fs";
import * as path from "path";

const ENABLED = process.env.LIVE_VALIDATE === "1";
const ORPLEX_ROOT = process.cwd();
const WORKSPACE = path.join(ORPLEX_ROOT, ".live-validate");
const WORKSPACE_FWD = WORKSPACE.replace(/\\/g, "/");
const BASE = "http://localhost:5000";
const ORIGINAL_FETCH = global.fetch;

jest.setTimeout(15 * 60 * 1000);

let sessionToken = "";

/** Pass-through fetch to the real dev server, with the dev session cookie. */
function passthroughFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const raw = String(input);
  const url = raw.startsWith("http") ? raw : BASE + raw;
  const headers = new Headers(init?.headers || {});
  if (!headers.has("Cookie") && sessionToken) {
    headers.set("Cookie", `next-auth.session-token=${sessionToken}`);
  }
  return ORIGINAL_FETCH(url as any, { ...init, headers });
}

/**
 * Diagnostic override so the verification lane typechecks the live-validate
 * workspace even if the server-side registry points elsewhere. Only
 * /api/agent/verify is touched; everything else passes through untouched.
 */
function withVerifyOverride(): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = String(input);
    if (raw.includes("/api/agent/verify")) {
      let body: any = {};
      try {
        body = JSON.parse(String(init?.body || "{}"));
      } catch {}
      return passthroughFetch("/api/agent/verify", {
        ...init,
        body: JSON.stringify({ ...body, workDir: WORKSPACE_FWD }),
      });
    }
    return passthroughFetch(input, init);
  }) as unknown as typeof fetch;
}

/**
 * Auto-approver: approves every pending approval dialog with "Always allow"
 * (in-process — the same approval-store the worker awaits).
 */
function startAutoApprover(): Promise<() => void> {
  return import("../../lib/approval-store").then((store) => {
    const timer = setInterval(() => {
      for (const p of store.getPendingApprovals()) {
        console.log(`[auto-approve] ${p.type} (${p.risk}): ${String(p.summary).slice(0, 70)}`);
        store.approveRequestAlways(p.id);
      }
    }, 1000);
    return () => clearInterval(timer);
  });
}

/** Mint a real next-auth session cookie via the dev bypass. */
async function devLogin(): Promise<string> {
  const res = await ORIGINAL_FETCH(`${BASE}/api/dev/session?action=login`);
  if (!res.ok) throw new Error(`dev login failed: ${res.status}`);
  // Node 18.14+/undici exposes set-cookie list via getSetCookie()
  const anyHeaders = res.headers as any;
  const cookies: string[] =
    typeof anyHeaders.getSetCookie === "function"
      ? anyHeaders.getSetCookie()
      : [res.headers.get("set-cookie") || ""];
  const pair = cookies.find((c) => c.startsWith("next-auth.session-token="));
  if (!pair) throw new Error("dev login returned no session cookie");
  return pair.split(";")[0].split("=").slice(1).join("=");
}

/** Register the live-validate folder as the server-side exec cwd. */
async function registerWorkspace(): Promise<void> {
  const res = await ORIGINAL_FETCH(`${BASE}/api/agent/workspace-cwd`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: `next-auth.session-token=${sessionToken}`,
    },
    body: JSON.stringify({ path: WORKSPACE_FWD }),
  });
  const text = await res.text();
  console.log("[workspace-cwd]", text);
  if (!res.ok || !text.includes('"ok":true')) {
    throw new Error("workspace-cwd registration failed: " + text);
  }
}

describe("live validation (LIVE_VALIDATE=1)", () => {
  const maybe = ENABLED ? it : it.skip;
  maybe(
    "runs the dashboard task in code mode and reaches 'Verification passed'",
    async () => {
      // ── Pre-flight: clean workspace + real session + registered cwd ──
      for (const f of fs.readdirSync(WORKSPACE)) {
        if (f !== "node_modules" && f !== "package.json" && f !== "tsconfig.json") {
          fs.rmSync(path.join(WORKSPACE, f), { recursive: true, force: true });
        }
      }
      sessionToken = await devLogin();
      await registerWorkspace();

      // ── Wire the REAL worker to REAL disk (same call the app makes) ──
      const { runInBackground, setFileSystemAccess } = await import("../background-worker");
      const { getCurrentTask, abortCurrentTask } = await import("../background-chat");

      const readFile = (p: string) => fs.promises.readFile(path.join(WORKSPACE, p), "utf8");
      const writeFile = async (p: string, content: string) => {
        const full = path.join(WORKSPACE, p);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        await fs.promises.writeFile(full, content, "utf8");
        return true;
      };
      const editFile = async (p: string, oldText: string, newText: string) => {
        const full = path.join(WORKSPACE, p);
        const cur = await fs.promises.readFile(full, "utf8");
        if (!cur.includes(oldText)) return false;
        await fs.promises.writeFile(full, cur.replace(oldText, newText), "utf8");
        return true;
      };

      let tree: any[] = [];
      let contents: Record<string, string> = {};
      setFileSystemAccess(
        readFile,
        writeFile,
        editFile,
        tree,
        contents,
        "live-validate" // non-empty → write/edit exposed + verification lane gated ON
      );

      global.fetch = withVerifyOverride() as typeof fetch;
      const stopApprover = await startAutoApprover();
      // Enable rubric recording BEFORE the run: the worker's own hooks then
      // observe tool calls + lanes and auto-record at finalize.
      (await import("../rubric-recorder")).enableRubricRecording();

      try {
        const promise = runInBackground(
          "create an index.html file with a working hero section, a features grid, and a pricing table using inline CSS and a little JavaScript for a mobile nav toggle",
          null, // new conversation
          [], // no prior messages
          "code", // CODE MODE
          [],
          undefined,
          undefined,
          { autoVerify: true } // production default (8th opts arg untouched by UI)
        );

        // Wait for the task to finish (done or error).
        await new Promise<void>((resolve) => {
          const poll = setInterval(() => {
            const task = getCurrentTask();
            if (task && (task.status === "done" || task.status === "error")) {
              clearInterval(poll);
              resolve();
            }
          }, 2000);
        });
        await promise;

        const task = getCurrentTask();
        const display = task?.displayContent || "";
        console.log("=== FINAL STATUS ===", task?.status);
        console.log("=== FINAL TRANSCRIPT ===\n" + display);
        console.log("=== WORKSPACE FILES ===");
        for (const f of listFiles(WORKSPACE)) console.log("  ", f);

        expect(task?.status).toBe("done");
        expect(display).toMatch(/Verification passed/); // typecheck lane
        // The browser lane must actually render the written index.html
        expect(display).toMatch(/Browser verification passed/); // ← THE assertion
        expect(fs.existsSync(path.join(WORKSPACE, "index.html"))).toBe(true);

        // Trend report: the worker auto-recorded this run (recording enabled
        // above) — print the trend so regressions surface run over run.
        const { formatTrendReport, readHistory } = await import("../rubric-recorder");
        console.log("\n=== RUBRIC TREND ===\n" + formatTrendReport(readHistory()) + "\n");
      } finally {
        stopApprover();
        global.fetch = ORIGINAL_FETCH;
        try {
          if (getCurrentTask()) abortCurrentTask();
        } catch {}
      }
    }
  );
});

function listFiles(dir: string, base = ""): string[] {
  let out: string[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (f === "node_modules" || f.startsWith(".")) continue;
    const full = path.join(dir, f);
    const rel = base ? `${base}/${f}` : f;
    if (fs.statSync(full).isDirectory()) out = out.concat(listFiles(full, rel));
    else out.push(rel);
  }
  return out;
}
