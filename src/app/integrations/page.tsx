"use client";

/**
 * /integrations — MCP connectors. The page body (connected servers, the
 * catalog grid, search and the connect/remove/toggle actions) lives in
 * src/components/integrations/IntegrationsPage.tsx; this route mounts it in
 * the shell's main pane.
 */
import IntegrationsPage from "@/components/integrations/IntegrationsPage";

export default function IntegrationsRoute() {
  return <IntegrationsPage />;
}
