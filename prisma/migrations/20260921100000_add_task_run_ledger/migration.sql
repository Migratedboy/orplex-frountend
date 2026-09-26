-- Persistent run ledger: the agent's cross-restart memory of every task's
-- verification verdicts, token economics, and duration.
CREATE TABLE "task_runs" (
    "id" TEXT NOT NULL,
    "workspaceKey" TEXT NOT NULL,
    "task" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "finalStatus" TEXT NOT NULL,
    "typecheckLane" TEXT NOT NULL DEFAULT 'skipped',
    "browserLane" TEXT NOT NULL DEFAULT 'skipped',
    "swarmLane" TEXT NOT NULL DEFAULT 'skipped',
    "modelCalls" INTEGER NOT NULL DEFAULT 0,
    "fullCalls" INTEGER NOT NULL DEFAULT 0,
    "compactCalls" INTEGER NOT NULL DEFAULT 0,
    "systemTokensSpent" INTEGER NOT NULL DEFAULT 0,
    "systemTokensFull" INTEGER NOT NULL DEFAULT 0,
    "tokensSaved" INTEGER NOT NULL DEFAULT 0,
    "savedPct" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "task_runs_workspaceKey_createdAt_idx" ON "task_runs"("workspaceKey", "createdAt");
CREATE INDEX "task_runs_workspaceKey_finalStatus_idx" ON "task_runs"("workspaceKey", "finalStatus");

-- Distinct failure signatures per workspace/lane. Recurrence raises `count`
-- (anti-loop signal); a passing lane resolves the signature.
CREATE TABLE "task_failures" (
    "id" TEXT NOT NULL,
    "workspaceKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "detailHash" TEXT NOT NULL,
    "files" JSONB,
    "count" INTEGER NOT NULL DEFAULT 1,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "task_failures_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "task_failures_workspaceKey_kind_detailHash_key" ON "task_failures"("workspaceKey", "kind", "detailHash");
CREATE INDEX "task_failures_workspaceKey_lastSeenAt_idx" ON "task_failures"("workspaceKey", "lastSeenAt");
