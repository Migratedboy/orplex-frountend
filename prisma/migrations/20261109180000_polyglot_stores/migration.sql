-- Polyglot stores (Neon): semantic memory (pgvector + HNSW), recording
-- metadata, transactional outbox, opt-in upload pointers.
-- Applied on Neon (pgvector pre-installed); CREATE EXTENSION is harmless
-- everywhere. HNSW index lives here because Prisma can't express it.

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateTable: memories
CREATE TABLE "memories" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "embedding" VECTOR(1536) NOT NULL,
    "dimVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "memories_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: memories_userId_namespace_idx
CREATE INDEX "memories_userId_namespace_idx" ON "memories"("userId", "namespace");

-- HNSW index for cosine similarity (Prisma can't express this; kept here)
CREATE INDEX "memories_embedding_hnsw" ON "memories" USING hnsw ("embedding" vector_cosine_ops);

-- CreateTable: recordings
CREATE TABLE "recordings" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "machineId" TEXT,
    "name" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "durationSec" INTEGER,
    "deletedAt" TIMESTAMP(3),
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recordings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: recordings_userId_recordedAt_idx
CREATE INDEX "recordings_userId_recordedAt_idx" ON "recordings"("userId", "recordedAt");

-- CreateTable: outbox_events
CREATE TABLE "outbox_events" (
    "id" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "aggregateId" TEXT,
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "nextRetryAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: outbox_events_status_nextRetryAt_idx
CREATE INDEX "outbox_events_status_nextRetryAt_idx" ON "outbox_events"("status", "nextRetryAt");

-- CreateTable: uploaded_files
CREATE TABLE "uploaded_files" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "blobPathname" TEXT NOT NULL,
    "blobUrl" TEXT,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "idempotencyKey" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'opt-in',
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "uploaded_files_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: uploaded_files_idempotencyKey_key (UNIQUE; Postgres treats
-- NULLs as distinct, so rows without a key don't collide)
CREATE UNIQUE INDEX "uploaded_files_idempotencyKey_key" ON "uploaded_files"("idempotencyKey");

-- CreateIndex: uploaded_files_userId_idx
CREATE INDEX "uploaded_files_userId_idx" ON "uploaded_files"("userId");
