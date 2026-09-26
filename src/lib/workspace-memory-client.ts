// workspace-memory-client.ts — Browser-side access to workspace memory.
//
// The worker runs in the browser and MUST NOT import Prisma (server-only):
// a direct DB import hangs page loads and tests when no DB is reachable.
// Same discipline as run-ledger.ts — the client goes through the API, the
// server route owns the database.

import type { CaptureInput } from "./workspace-memory";
import { apiFetch } from "@/lib/api-base";

/**
 * Persist evidence-backed learnings from a completed task. Fire-and-forget:
 * memory capture must never block or fail a task completion.
 */
export function captureMemoriesViaApi(input: CaptureInput): void {
  try {
    apiFetch("/api/agent/memory/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(6000),
    }).catch(() => {});
  } catch {}
}

/**
 * Retrieve + format learnings for the prompt. Returns null when the API is
 * unreachable or there's nothing relevant — callers inject only when present.
 */
export async function retrieveMemoryBlockViaApi(
  directoryName: string | null | undefined,
  task: string
): Promise<string | null> {
  try {
    const params = new URLSearchParams({ task: task.slice(0, 500) });
    if (directoryName) params.set("directoryName", directoryName);
    const res = await apiFetch(`/api/agent/memory?${params}`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    return typeof data?.block === "string" && data.block ? data.block : null;
  } catch {
    return null;
  }
}
