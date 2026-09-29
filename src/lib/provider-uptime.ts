// provider-uptime.ts — Provider uptime telemetry writer.
//
// One row per provider attempt (success or error) lands in the
// provider_events table (see prisma/schema.prisma); /api/agent/uptime feeds
// the 7-day reliability view in Settings → Provider & Cost from it.
//
// Discipline (same rules as notify.ts): telemetry is cosmetic for the
// operation at hand — recordProviderEvent is fire-and-forget, never throws,
// and a failing DB write is swallowed. Callers must not await it on any
// latency-sensitive path.

import { prisma } from "./prisma";

/** Coarse failure buckets the reliability card groups on. */
export type UptimeErrorKind = "rate_limit" | "auth" | "server" | "network" | "bad_request" | "error";

export interface UptimeOutcome {
  userId: string;
  /** "chat" = /api/chat provider ladder, "server_run" = server executor. */
  lane: "chat" | "server_run";
  /** Provider name as the ladder knows it (config name or registry id). */
  provider: string;
  /** Model id the attempt targeted. */
  model: string;
  ok: boolean;
  /** HTTP status the provider returned (when the failure surfaced one). */
  httpStatus?: number | null;
  /** Error text, used to classify when no HTTP status is available. */
  errorMessage?: string | null;
  /** Round-trip ms of the attempt (set on successes and timed failures). */
  latencyMs?: number | null;
}

/**
 * Map a failure to its coarse bucket. HTTP status wins when present;
 * message text fills in the transport-shaped failures (timeouts, DNS) that
 * never produce a status of their own. Everything else is "error" — an
 * honest unknown beats a wrong bucket.
 */
export function classifyUptimeError(httpStatus?: number | null, message?: string | null): UptimeErrorKind {
  const s = typeof httpStatus === "number" ? httpStatus : null;
  if (s === 401 || s === 403) return "auth";
  if (s === 402 || s === 400 || s === 404 || s === 413 || s === 422) return "bad_request";
  if (s === 429) return "rate_limit";
  if (s !== null && s >= 500) return "server";
  const msg = (message ?? "").toLowerCase();
  if (/rate.?limit|quota|too many requests|\b429\b/.test(msg)) return "rate_limit";
  if (/unauthorized|forbidden|invalid api key|invalid_api_key|no credits/.test(msg)) return "auth";
  if (/timeout|timed out|abort|econn|enotfound|etimedout|fetch failed|network|socket/.test(msg)) return "network";
  if (/unexpected token|invalid.*json|unprocessable|\b(400|404|413|422)\b/.test(msg)) return "bad_request";
  return "error";
}

/** Record one provider attempt. Fire-and-forget: never throws, never blocks. */
export function recordProviderEvent(o: UptimeOutcome): void {
  try {
    if (!o?.userId || !o.provider || !o.model) return;
    const ok = o.ok === true;
    const httpStatus = typeof o.httpStatus === "number" ? o.httpStatus : null;
    void prisma.providerEvent
      .create({
        data: {
          userId: o.userId,
          lane: o.lane === "server_run" ? "server_run" : "chat",
          provider: o.provider.slice(0, 120),
          model: o.model.slice(0, 240),
          outcome: ok ? "ok" : "error",
          errorKind: ok ? null : classifyUptimeError(httpStatus, o.errorMessage),
          httpStatus: ok ? null : httpStatus,
          latencyMs: Number.isFinite(o.latencyMs as number) ? Math.round(o.latencyMs as number) : null,
        },
      })
      .catch(() => {});
  } catch {
    // Telemetry must never break the request that produced it.
  }
}
