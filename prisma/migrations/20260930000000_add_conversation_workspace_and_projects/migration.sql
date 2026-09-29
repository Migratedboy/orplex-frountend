-- Projects sidebar, pass 1 (foundation):
-- 1. conversations.workspaceName — the folder a thread was created in
--    (folder NAME, not path: paths are device-specific, names group fine).
--    Null = Ungrouped. Indexed for per-project thread listing.
-- 2. project_records — per-user roster of opened workspace folders, synced
--    across machines by name (handles/paths stay device-bound).
ALTER TABLE "conversations" ADD COLUMN "workspaceName" TEXT;

CREATE INDEX "conversations_userId_workspaceName_idx" ON "conversations"("userId", "workspaceName");

CREATE TABLE "project_records" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "displayName" TEXT,
    "lastOpenedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_records_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "project_records_userId_name_key" ON "project_records"("userId", "name");
CREATE INDEX "project_records_userId_lastOpenedAt_idx" ON "project_records"("userId", "lastOpenedAt");

ALTER TABLE "project_records" ADD CONSTRAINT "project_records_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
