"use client";

/**
 * Integrations (MCP connectors) — PLACEHOLDER for the shell refactor's
 * phase 7: the full page (connected servers via /api/mcp/*, popular grid,
 * custom server form) lands there. The rail's extensions button already
 * routes here so the shell composition is testable end-to-end.
 */
export default function IntegrationsPage() {
  return (
    <div className="ox-int-in" style={{ width: "100%", height: "100%" }}>
      <div className="ox-int-wrap">
        <div className="ox-int-head">
          <h1>Integrations</h1>
        </div>
        <p style={{ color: "var(--muted)" }}>
          MCP connectors land here in an upcoming update.
        </p>
      </div>
    </div>
  );
}
