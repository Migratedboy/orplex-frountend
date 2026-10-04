-- MCP OAuth persistence (spec Phase 2): remote-connection rows + one-time
-- OAuth pending states. See docs/MCP-OAUTH.md §data-model.

-- CreateTable
CREATE TABLE "mcp_connections" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "transport" TEXT NOT NULL DEFAULT 'streamable-http',
    "url" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'connected',
    "issuer" TEXT,
    "clientId" TEXT,
    "clientSecret" TEXT,
    "tokensCiphertext" TEXT,
    "tokenType" TEXT,
    "scope" TEXT,
    "expiresAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "lastTestAt" TIMESTAMP(3),
    "lastTestOk" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mcp_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mcp_oauth_pendings" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "codeVerifier" TEXT,
    "redirectUrl" TEXT NOT NULL,
    "authorizationUrl" TEXT,
    "issuer" TEXT,
    "discoveryState" JSONB,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "consumedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mcp_oauth_pendings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "mcp_connections_userId_status_idx" ON "mcp_connections"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "mcp_connections_userId_serverId_key" ON "mcp_connections"("userId", "serverId");

-- CreateIndex
CREATE UNIQUE INDEX "mcp_oauth_pendings_state_key" ON "mcp_oauth_pendings"("state");

-- CreateIndex
CREATE INDEX "mcp_oauth_pendings_userId_serverId_status_idx" ON "mcp_oauth_pendings"("userId", "serverId", "status");

-- CreateIndex
CREATE INDEX "mcp_oauth_pendings_expiresAt_idx" ON "mcp_oauth_pendings"("expiresAt");

-- AddForeignKey
ALTER TABLE "mcp_connections" ADD CONSTRAINT "mcp_connections_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_oauth_pendings" ADD CONSTRAINT "mcp_oauth_pendings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
