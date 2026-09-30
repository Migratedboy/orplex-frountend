-- Pinned visual annotations: where on the artifact a comment points (0–1
-- fractions of width/height). Additive nullable columns — no backfill needed.
ALTER TABLE "comments" ADD COLUMN "anchorX" DOUBLE PRECISION;
ALTER TABLE "comments" ADD COLUMN "anchorY" DOUBLE PRECISION;
