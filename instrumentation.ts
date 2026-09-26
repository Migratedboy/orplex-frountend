// instrumentation.ts — Next.js server bootstrap hook.
//
// Next 15+/16 calls `register()` once per server process start. This is what
// makes the run executor PERSISTENT: the loop lives in the Node process that
// serves the app — no open browser tab required. Manager-spawned runs are
// leased, executed in an isolated git worktree, and checkpointed entirely
// server-side.
//
// The executor is opt-in (ORPLEX_SERVER_EXECUTOR=1) because it runs tool
// loops with real filesystem access on the host — a hosted deployment must
// consciously enable it. Local desktop installs enable it by default.
//
// The RAM watchdog starts UNCONDITIONALLY (unlike the executor): the 8GB
// target machine needs memory telemetry + the pressure ladder no matter
// which optional subsystems are enabled. At critical sustained pressure the
// janitor sweeps re-creatable caches (whitelist-only; see janitor.ts).

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return; // skip edge runtime

  // RAM watchdog + critical-pressure janitor (safe on every host).
  try {
    const { startMemoryWatchdog, onCriticalPressure } = await import("@/lib/hardware");
    onCriticalPressure(async () => {
      try {
        const { runJanitor } = await import("@/lib/janitor");
        const result = await runJanitor({ mode: "critical" });
        console.log(`[hardware] critical-pressure janitor freed ${(result.bytesFreed / 1024 / 1024).toFixed(1)} MB`);
      } catch {
        // never let the sweep crash the watchdog
      }
    });
    startMemoryWatchdog();
  } catch (err) {
    console.error("[hardware] watchdog failed to start:", (err as Error).message);
  }

  const enabled = process.env.ORPLEX_SERVER_EXECUTOR === "1" || process.env.ORPLEX_SERVER_EXECUTOR === "true";
  if (!enabled) {
    console.log("[executor] disabled (set ORPLEX_SERVER_EXECUTOR=1 to enable server-side run execution)");
    return;
  }
  try {
    const { startServerExecutor } = await import("@/lib/server-executor/executor");
    startServerExecutor();
    console.log("[executor] server-side run executor started");
  } catch (err) {
    console.error("[executor] failed to start:", (err as Error).message);
    const { recordRuntimeLog } = await import("@/lib/runtime-log");
    recordRuntimeLog("executor", "error", `failed to start: ${(err as Error).message.slice(0, 200)}`);
  }
}
