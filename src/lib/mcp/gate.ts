// gate.ts — the ORPLEX_MCP lane gate (spec Phase 8, conflict C8).
//
//   ORPLEX_MCP=legacy → the pre-Phase-8 renderer lane stays runnable:
//                       dispatch + roster read the localStorage registry.
//   anything else      → "sdk" (the DEFAULT): dispatch runs through the
//                       server-side hub over /api/agent/mcp/*; tokens,
//                       roster, and the auto-approve toggle live in Prisma.
//
// Server routes call resolveMcpLane(process.env.ORPLEX_MCP) directly. The
// renderer cannot see server env, so it asks GET /api/agent/mcp once per
// session (env is static until restart) — see native-tools.ts.

export type McpLane = "sdk" | "legacy";

/**
 * Only the exact value "legacy" (case/whitespace-insensitive) selects the
 * legacy lane; unset or any other value falls back to "sdk" so a typo can
 * never silently disable the server-side token store.
 */
export function resolveMcpLane(raw: string | undefined | null): McpLane {
  return typeof raw === "string" && raw.trim().toLowerCase() === "legacy" ? "legacy" : "sdk";
}
