/**
 * orchestration-client.ts — the deep-orchestration client, extracted verbatim
 * from background-worker.ts (Operation Modularity).
 *
 * Runs server-side via /api/agent/orchestrate (the transport needs API keys
 * that must never reach the browser). The route maps legacy op names onto the
 * strategy router; the worker executes returned tool calls through its normal
 * audited write path. ONE planning call per task (was up to 5 through the
 * SPARC→ToT→blueprint waterfall).
 *
 * executeOrchestratedWrites receives the worker's filesystem accessors via
 * ctx.fs (they were module-level lets read at call time — passing them at the
 * call site preserves the exact same semantics).
 */
import { updateTaskStatus } from "./background-chat";
import { emitActivity } from "./agent-events";
import { recordChange } from "./file-history";
import { virtualFS } from "./virtual-fs";
import type { ToolCall } from "./stream-reader";

// === Deep orchestration (deterministic strategy router) ====================
// Runs server-side via /api/agent/orchestrate (the transport needs API keys
// that must never reach the browser). The route maps legacy op names onto the
// strategy router; the worker executes returned tool calls through its normal
// audited write path. ONE planning call per task (was up to 5 through the
// SPARC→ToT→blueprint waterfall).
const ORCHESTRATE_URL = `/api/agent/orchestrate`;

export async function runOrchestration<T = any>(op: string, payload: Record<string, unknown>): Promise<T | null> {
  // 330s > the route's own maxDuration (300s) — the server always gets to
  // answer first. LIVE-VALIDATED: at 280s the client aborted 2s before SPARC
  // finished (5 sequential NVIDIA calls ≈ 282s), wasting the entire run.
  try {
    const res = await fetch(ORCHESTRATE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op, ...payload }),
      signal: AbortSignal.timeout(330_000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.ok ? (data as T) : null;
  } catch {
    return null;
  }
}

/** Execute orchestrator-returned write_file calls through the audited path. */
export async function executeOrchestratedWrites(
  toolCalls: Array<Partial<ToolCall>>,
  ctx: {
    totalWrites: number;
    writtenFiles: Map<string, string>;
    bumpStat: (s: "toolCalls") => void;
    setFilesChanged: (n: number) => void;
    label: string;
    /** Stop must interrupt a batch mid-flight. */
    abortSignal?: AbortSignal | null;
    /** Abandon the batch when a newer run has claimed the task slot. */
    isStale?: () => boolean;
    /** The worker's filesystem accessors (set via setFileSystemAccess). */
    fs: { readFile: ((path: string) => Promise<string>) | null; writeFile: ((path: string, content: string) => Promise<boolean>) | null };
  }
): Promise<number> {
  let count = 0;
  for (const call of toolCalls) {
    if (call.name !== "write_file" || !call.path || call.content === undefined) continue;
    // This loop had no abort check and the call site sat outside the try/catch
    // and every other abort guard, so pressing Stop mid-batch left files 3..N
    // still being written while the "Stopped" note was already on screen.
    if (ctx.abortSignal?.aborted) break;
    if (ctx.isStale?.()) break;
    updateTaskStatus("tool_executing", `${ctx.label}: writing ${call.path}…`);
    emitActivity({ type: "file", message: `${ctx.label}: ${call.path}`, agent: "coder" });
    try {
      let ok = false;
      if (ctx.fs.writeFile) {
        const prevContent = ctx.fs.readFile ? await ctx.fs.readFile(call.path).catch(() => null) : null;
        const hasPrev = prevContent !== null && !prevContent.startsWith("[Error");
        await recordChange(call.path, hasPrev ? prevContent : null, call.content);
        ok = await ctx.fs.writeFile(call.path, call.content);
      } else {
        await recordChange(call.path, virtualFS.readFile(call.path), call.content, false);
        ok = virtualFS.writeFile(call.path, call.content);
      }
      if (ok) {
        count++;
        ctx.bumpStat("toolCalls");
        ctx.totalWrites += 1;
        ctx.setFilesChanged(ctx.totalWrites);
        ctx.writtenFiles.set(call.path, call.content);
      }
    } catch {
      // Orchestrator-planned write failed — keep going; the model's own
      // refinement pass will notice the missing file and rewrite it.
    }
  }
  return count;
}
