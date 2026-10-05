-- MCP tool discovery snapshots (spec Phase 5): one row per tools/list entry,
-- diffed on refresh; mcp_connections gains connected_no_tools status values
-- and the SDK-lane auto-approve-read-only toggle (C6). See docs/MCP-OAUTH.md.

-- AlterTable
ALTER TABLE "mcp_connections" ADD COLUMN "autoApproveReadOnly" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "mcp_tools" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "inputSchema" JSONB,
    "annotations" JSONB,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mcp_tools_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mcp_tools_userId_serverId_name_key" ON "mcp_tools"("userId", "serverId", "name");

-- CreateIndex
CREATE INDEX "mcp_tools_userId_serverId_idx" ON "mcp_tools"("userId", "serverId");

-- AddForeignKey
ALTER TABLE "mcp_tools" ADD CONSTRAINT "mcp_tools_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
