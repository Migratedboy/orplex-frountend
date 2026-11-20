// mcp-catalog.ts — the app's synchronous view of the MCP catalogue.
//
// The catalogue itself is signed marketplace data (see marketplace-client.ts);
// the SDK owns the entry schema, validation and search. What the app needs on
// top of that is a *synchronous* lookup, because connection/auth code decides
// whether a server id is "known" in the middle of otherwise-sync paths.
//
// So the verified bundle is mirrored into a module-level array after it loads,
// and this module reads that. Before the first successful load the catalogue is
// empty — a lookup returns null, which every caller already treats as "custom
// server, no catalogue hints".
export type {
  McpAuthType,
  McpCategory,
  McpCatalogEntry,
  McpEnvSpec,
  McpOAuthSpec,
  McpRemoteSpec,
  McpStdioSpec,
  McpCatalogValidation,
} from "@orplex/sdk/lib/mcp-catalog";

export {
  MCP_CATEGORIES,
  applyOAuthEnvOverrides,
  mcpCatalogEntrySchema,
  searchMcpCatalog,
  validateMcpCatalog,
} from "@orplex/sdk/lib/mcp-catalog";

import { getMcpCatalogEntry as lookup, type McpCatalogEntry } from "@orplex/sdk/lib/mcp-catalog";
import { peekMcpCatalog } from "./marketplace-client";

/** Catalogue entry by id, or null when unknown / not loaded yet. */
export function getMcpCatalogEntry(id: string): McpCatalogEntry | null {
  return lookup(id, peekMcpCatalog());
}

/** How many servers the verified catalogue currently holds. */
export function mcpCatalogSize(): number {
  return peekMcpCatalog().length;
}
