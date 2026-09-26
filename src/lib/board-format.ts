// board-format.ts — Pure presentation helpers for the runs board and the run
// timeline. Everything here is deterministic data-in, string-out so it is
// unit-testable without React or the DB. The payloads mirror what the
// executor emits (see server-executor/executor.ts emit() calls).

/** 1234 → "1.2k", 1234567 → "1.2M"; 0/undefined → "0". */
export function formatTokens(n: number | null | undefined): string {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return String(v);
}

/**
 * Label for a scheduled (morning-queue) run: "in 7h 12m", "in 45s", or the
 * empty string when the run is not scheduled for the future.
 */
export function scheduledLabel(notBefore: string | null | undefined, now = Date.now()): string {
  if (!notBefore) return "";
  const at = new Date(notBefore).getTime();
  if (!Number.isFinite(at)) return "";
  const diff = at - now;
  if (diff <= 0) return "";
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return `in ${Math.round(diff / 1000)}s`;
  if (mins < 60) return `in ${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `in ${h}h ${m}m` : `in ${h}h`;
}

export interface UsagePayload {
  promptTokens?: number;
  completionTokens?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
}

/** Minimal run shape the optimistic approval update needs. */
export interface RunWithApprovals {
  id: string;
  pendingApprovalCount: number;
  pendingApprovals?: { id: string }[] | null;
}

/**
 * Optimistic board update after an approve/deny click: drop the request's
 * card and decrement the lane's counter. Pure — the board restores the
 * previous array when the POST fails.
 */
export function removeApprovalFromRuns<T extends RunWithApprovals>(runs: T[], runId: string, requestId: string): T[] {
  return runs.map((r) =>
    r.id === runId
      ? {
          ...r,
          pendingApprovals: (r.pendingApprovals || []).filter((a) => a.id !== requestId),
          pendingApprovalCount: Math.max(0, r.pendingApprovalCount - 1),
        }
      : r,
  );
}

/** Prompt+completion from either snake_case (wire) or camelCase payload. */
export function usageTotals(p: UsagePayload | null | undefined): { prompt: number; completion: number } | null {
  if (!p || typeof p !== "object") return null;
  const prompt = Number(p.promptTokens ?? p.prompt_tokens) || 0;
  const completion = Number(p.completionTokens ?? p.completion_tokens) || 0;
  if (prompt === 0 && completion === 0) return null;
  return { prompt, completion };
}

/**
 * Human-readable {label, detail} for a raw run event. Returns null for
 * event types with nothing useful to add beyond the type name (the timeline
 * then shows just the icon + type, exactly as today).
 */
export function describeEvent(type: string, payload: unknown): { label: string; detail?: string } | null {
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  switch (type) {
    case "spawned": {
      const via = typeof p.via === "string" ? p.via : "";
      return via ? { label: `spawned via ${via}` } : null;
    }
    case "claimed":
      return { label: `claimed by ${typeof p.by === "string" ? p.by : "executor"}` };
    case "worktree-created":
      return typeof p.branch === "string" ? { label: p.branch } : null;
    case "compacted":
      return { label: `context compacted at ${formatTokens(Number(p.tokensBefore))} tokens` };
    case "mcp-tools-loaded":
      return { label: `${String(p.count ?? 0)} MCP tool(s) from ${Array.isArray(p.servers) ? p.servers.join(", ") : "server"}` };
    case "mcp-server-error":
      return { label: `MCP server "${String(p.server ?? "?")}" failed`, detail: String(p.error ?? "").slice(0, 200) };
    case "tool-denied":
      return { label: `${String(p.tool ?? "tool")} denied`, detail: String(p.reason ?? "") };
    case "tool-notify":
      return { label: `notify: ${String(p.tool ?? "tool")}` };
    case "usage": {
      const u = usageTotals(p);
      return u ? { label: `${formatTokens(u.prompt + u.completion)} tok (prompt ${formatTokens(u.prompt)} + completion ${formatTokens(u.completion)})` } : null;
    }
    case "usage-total": {
      const u = usageTotals(p);
      return u ? { label: `total ${formatTokens(u.prompt + u.completion)} tok` } : null;
    }
    case "provider-failover":
      return { label: `${String(p.from ?? "?")} → ${String(p.to ?? "?")}`, detail: String(p.reason ?? "").slice(0, 160) };
    case "native-tools-unsupported":
      return { label: "native tool-calling unavailable — text protocol", detail: String(p.error ?? "").slice(0, 160) };
    case "requeued-after-restart":
      return { label: `requeued after restart (attempt ${String(p.requeue ?? "?")})` };
    case "branch-pushed":
      return typeof p.ref === "string" ? { label: p.ref.replace(/^origin\//, "") } : typeof p.error === "string" ? { label: "push failed", detail: p.error.slice(0, 160) } : null;
    case "pr-opened":
      return typeof p.url === "string" ? { label: `review link (${String(p.via ?? "compare")})`, detail: p.url } : null;
    case "run-finished":
      return { label: `${String(p.changedFiles ?? 0)} file(s) changed${typeof p.provider === "string" ? ` · ${p.provider}` : ""}` };
    case "run-failed":
      return { label: "run failed", detail: String(p.error ?? "").slice(0, 200) };
    case "verify-repaired":
      return { label: `verification repaired (${String(p.fixes ?? 0)} fix(es))` };
    case "approval-requested":
      return { label: String(p.action ?? "approval needed") };
    default:
      return null;
  }
}
