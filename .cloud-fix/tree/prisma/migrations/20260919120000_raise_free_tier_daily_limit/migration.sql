-- Raise the free-tier daily request limit from 50 to 1000.
ALTER TABLE "user_quotas" ALTER COLUMN "dailyLimit" SET DEFAULT 1000;

-- Backfill existing free-tier users so the new limit applies to them too.
UPDATE "user_quotas" SET "dailyLimit" = 1000 WHERE "tier" = 'free' AND "dailyLimit" = 50;
