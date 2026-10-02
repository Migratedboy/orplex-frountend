-- CreateIndex
CREATE INDEX "vector_memory_entries_type_createdAt_idx" ON "vector_memory_entries"("type", "createdAt");

-- DropIndex (remove the old single-column indexes)
DROP INDEX IF EXISTS "vector_memory_entries_type_idx";
DROP INDEX IF EXISTS "vector_memory_entries_createdAt_idx";
