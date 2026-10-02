-- CreateTable
CREATE TABLE "learnings" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL DEFAULT 'default',
    "pattern" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "tags" TEXT[] NOT NULL,
    "sourceRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "learnings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comments" (
    "id" TEXT NOT NULL,
    "artifactId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_key_pool" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "apiKey" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "usageToday" INTEGER NOT NULL DEFAULT 0,
    "dailyLimit" INTEGER NOT NULL DEFAULT 1000,
    "lastResetAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_key_pool_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_logs" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "tokensIn" INTEGER NOT NULL DEFAULT 0,
    "tokensOut" INTEGER NOT NULL DEFAULT 0,
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "success" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_quotas" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "requestsToday" INTEGER NOT NULL DEFAULT 0,
    "dailyLimit" INTEGER NOT NULL DEFAULT 50,
    "lastResetAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tier" TEXT NOT NULL DEFAULT 'free',

    CONSTRAINT "user_quotas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_api_keys" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "apiKey" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "usageToday" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_limit_windows" (
    "key" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rate_limit_windows_pkey" PRIMARY KEY ("key","windowStart")
);

-- CreateTable
CREATE TABLE "circuit_breaker_states" (
    "provider" TEXT NOT NULL,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "isOpen" BOOLEAN NOT NULL DEFAULT false,
    "openUntil" TIMESTAMP(3),
    "lastFailure" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "circuit_breaker_states_pkey" PRIMARY KEY ("provider")
);

-- CreateTable
CREATE TABLE "vector_memory_entries" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "embedding" JSONB NOT NULL,
    "filePath" TEXT,
    "tool" TEXT,
    "success" BOOLEAN,
    "tags" TEXT[] NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vector_memory_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sona_patterns" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "embedding" JSONB NOT NULL,
    "steps" TEXT[] NOT NULL,
    "successRate" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "useCount" INTEGER NOT NULL DEFAULT 1,
    "avgDuration" INTEGER NOT NULL DEFAULT 0,
    "tags" TEXT[] NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sona_patterns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sona_trajectories" (
    "id" TEXT NOT NULL,
    "task" TEXT NOT NULL,
    "embedding" JSONB NOT NULL,
    "outcome" TEXT NOT NULL,
    "totalDuration" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "filesChanged" TEXT[] NOT NULL,
    "toolsUsed" TEXT[] NOT NULL,
    "tags" TEXT[] NOT NULL,
    "steps" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sona_trajectories_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "learnings_projectId_tags_idx" ON "learnings"("projectId", "tags");

-- CreateIndex
CREATE INDEX "comments_artifactId_idx" ON "comments"("artifactId");

-- CreateIndex
CREATE INDEX "api_key_pool_provider_isActive_idx" ON "api_key_pool"("provider", "isActive");

-- CreateIndex
CREATE INDEX "usage_logs_userId_createdAt_idx" ON "usage_logs"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "usage_logs_createdAt_idx" ON "usage_logs"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "user_quotas_userId_key" ON "user_quotas"("userId");

-- CreateIndex
CREATE INDEX "user_api_keys_userId_idx" ON "user_api_keys"("userId");

-- CreateIndex
CREATE INDEX "rate_limit_windows_expiresAt_idx" ON "rate_limit_windows"("expiresAt");

-- CreateIndex
CREATE INDEX "vector_memory_entries_type_idx" ON "vector_memory_entries"("type");

-- CreateIndex
CREATE INDEX "vector_memory_entries_createdAt_idx" ON "vector_memory_entries"("createdAt");

-- CreateIndex
CREATE INDEX "sona_patterns_tags_idx" ON "sona_patterns"("tags");

-- CreateIndex
CREATE INDEX "sona_trajectories_outcome_idx" ON "sona_trajectories"("outcome");

-- CreateIndex
CREATE INDEX "sona_trajectories_createdAt_idx" ON "sona_trajectories"("createdAt");

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_artifactId_fkey" FOREIGN KEY ("artifactId") REFERENCES "agent_artifacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
