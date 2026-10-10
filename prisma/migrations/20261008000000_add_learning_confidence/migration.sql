-- Playbook learning loop: the Learning model gains confidence scoring
-- (merge boosts, contradictions decay), verification flags, usage counts,
-- user pins, and a kind discriminator. NOT NULL with DEFAULTs so existing
-- rows backfill in place — no data migration needed.

-- AlterTable
ALTER TABLE "learnings" ADD COLUMN "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
ADD COLUMN "verified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "useCount" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "pinned" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'learning';
