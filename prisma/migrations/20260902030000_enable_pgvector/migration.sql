-- Enable the pgvector extension (Supabase has it pre-installed)
CREATE EXTENSION IF NOT EXISTS vector;

-- Convert the embedding column from JSONB to vector(128).
-- The ::vector cast handles JSONB arrays like '[0.1, 0.2, ...]' → vector.
ALTER TABLE "vector_memory_entries"
  ALTER COLUMN "embedding" DROP DEFAULT,
  ALTER COLUMN "embedding" TYPE vector(128) USING ('[' || replace(replace("embedding"::text, ' ', ','), '"', '') || ']')::vector;

-- IVFFlat index for fast approximate nearest neighbor search.
-- Lists = sqrt(row_count) is a good starting point; re-index after bulk loads.
-- The index supports the cosine distance operator <=>
CREATE INDEX "vector_memory_entries_embedding_idx"
  ON "vector_memory_entries"
  USING ivfflat ("embedding" vector_cosine_ops)
  WITH (lists = 50);
