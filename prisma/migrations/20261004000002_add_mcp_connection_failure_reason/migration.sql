-- P7: the store's token-save / needs_reauth paths write "failureReason" on
-- mcp_connections (store.ts), but the Phase 2 migration only created the
-- column on mcp_oauth_pendings - Prisma rejects the unknown argument at
-- runtime. Add it so status = needs_reauth can surface its reason in the
-- Connectors panel. See docs/MCP-OAUTH.md.

-- AlterTable
ALTER TABLE "mcp_connections" ADD COLUMN "failureReason" TEXT;
