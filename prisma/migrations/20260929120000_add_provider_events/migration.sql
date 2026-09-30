-- Provider uptime telemetry: one row per provider attempt (success or error)
-- so the Settings → Provider & Cost tab can show a 7-day reliability view.
CREATE TABLE "provider_events" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "lane" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "errorKind" TEXT,
    "httpStatus" INTEGER,
    "latencyMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "provider_events_userId_createdAt_idx" ON "provider_events"("userId", "createdAt");
CREATE INDEX "provider_events_provider_createdAt_idx" ON "provider_events"("provider", "createdAt");
