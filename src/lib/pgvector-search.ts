/**
 * pgvector-search.ts — Database-level vector similarity search using pgvector.
 *
 * Falls back to in-memory search when pgvector is unavailable (e.g. SQLite
 * for local dev). On Supabase / any Postgres with the vector extension,
 * queries run at the database layer with IVFFlat index acceleration.
 *
 * Cosine distance:  0 = identical, 2 = opposite.
 * Similarity = 1 - distance.
 */

import { prisma } from "./prisma";

// --------------------------------------------------------------------------- Types
// ---------------------------------------------------------------------------

export interface PgVectorResult {
  id: string;
  type: string;
  content: string;
  filePath: string | null;
  tool: string | null;
  success: boolean | null;
  tags: string[];
  createdAt: Date;
  /** Cosine similarity (0–1). Higher = more similar. */
  similarity: number;
}

export interface VectorSearchOptions {
  /** Maximum results to return. Default 5. */
  maxResults?: number;
  /** Filter by memory entry type. */
  type?: string;
  /** Minimum similarity threshold (0–1). Default 0.3. */
  minSimilarity?: number;
  /** Restrict to entries whose createdAt >= this date. */
  since?: Date;
}

// --------------------------------------------------------------------------- Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_RESULTS = 5;
const DEFAULT_MIN_SIMILARITY = 0.3;

// --------------------------------------------------------------------------- Helpers
// ---------------------------------------------------------------------------

/**
 * Format a number[] as a pgvector literal string: '[0.1, 0.2, ...]'
 */
export function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}

/**
 * Check if the database supports pgvector by attempting a probe query.
 * Cached after the first call.
 */
let _pgvectorAvailable: boolean | null = null;

export async function isPgvectorAvailable(): Promise<boolean> {
  if (_pgvectorAvailable !== null) return _pgvectorAvailable;

  try {
    // Probe: try to cast a JSON array to vector type
    await prisma.$queryRaw`SELECT '[1,2,3]'::vector(3)`;
    _pgvectorAvailable = true;
  } catch {
    _pgvectorAvailable = false;
  }

  return _pgvectorAvailable;
}

// --------------------------------------------------------------------------- Core search
// ---------------------------------------------------------------------------

/**
 * Search VectorMemoryEntry rows by cosine similarity using pgvector.
 *
 * Uses the <=> (cosine distance) operator with the IVFFlat index.
 * Returns results sorted by similarity descending.
 *
 * SQL produced (parameterized):
 *   SELECT id, type, content, ...,
 *          1 - (embedding <=> $1::vector) AS similarity
 *   FROM vector_memory_entries
 *   WHERE embedding <=> $1::vector < (1 - $2)
 *     [AND type = $3]
 *     [AND createdAt >= $4]
 *   ORDER BY embedding <=> $1::vector
 *   LIMIT $5
 */
export async function vectorSearch(
  queryEmbedding: number[],
  options: VectorSearchOptions = {},
): Promise<PgVectorResult[]> {
  const {
    maxResults = DEFAULT_MAX_RESULTS,
    type,
    minSimilarity = DEFAULT_MIN_SIMILARITY,
    since,
  } = options;

  // pgvector distance threshold: we want similarity >= minSimilarity,
  // which means distance <= (1 - minSimilarity)
  const distanceThreshold = 1 - minSimilarity;
  const vectorLiteral = toVectorLiteral(queryEmbedding);

  // Build the query dynamically based on filters
  const conditions: string[] = [
    `1 - (embedding <=> '${vectorLiteral}'::vector) >= ${minSimilarity}`,
  ];
  const params: unknown[] = [];
  let paramIdx = 1;

  if (type) {
    conditions.push(`type = $${paramIdx++}`);
    params.push(type);
  }

  if (since) {
    conditions.push(`"createdAt" >= $${paramIdx++}`);
    params.push(since);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const sql = `
    SELECT
      id,
      type,
      content,
      "filePath",
      tool,
      success,
      tags,
      "createdAt",
      1 - (embedding <=> '${vectorLiteral}'::vector) AS similarity
    FROM vector_memory_entries
    ${whereClause}
    ORDER BY embedding <=> '${vectorLiteral}'::vector
    LIMIT ${maxResults}
  `;

  try {
    // Raw query — Prisma's $queryRaw doesn't support interpolated vectors well,
    // so we use $queryRawUnsafe for the vector literal while parameterizing filters.
    const rows = await prisma.$queryRawUnsafe(sql, ...params) as Array<{
      id: string;
      type: string;
      content: string;
      filePath: string | null;
      tool: string | null;
      success: boolean | null;
      tags: string[];
      createdAt: Date;
      similarity: number;
    }>;

    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      content: row.content,
      filePath: row.filePath,
      tool: row.tool,
      success: row.success,
      tags: row.tags,
      createdAt: row.createdAt,
      similarity: Number(row.similarity),
    }));
  } catch (err) {
    // If pgvector queries fail (e.g. extension not installed, wrong column type),
    // log and return empty — the caller can fall back to in-memory search.
    console.warn("[pgvector-search] Query failed, falling back:", (err as Error).message);
    return [];
  }
}

// --------------------------------------------------------------------------- Batch insert
// ---------------------------------------------------------------------------

/**
 * Bulk insert memory entries with vector embeddings.
 * Uses a single multi-row INSERT for efficiency.
 */
export async function vectorBulkInsert(
  entries: Array<{
    id: string;
    type: string;
    content: string;
    embedding: number[];
    filePath?: string | null;
    tool?: string | null;
    success?: boolean | null;
    tags: string[];
  }>,
): Promise<number> {
  if (entries.length === 0) return 0;

  const values: string[] = [];
  const params: unknown[] = [];
  let paramIdx = 1;

  for (const entry of entries) {
    const vecLiteral = toVectorLiteral(entry.embedding);
    values.push(
      `($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, '${vecLiteral}'::vector, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, NOW())`
    );
    params.push(
      entry.id,
      entry.type,
      entry.content,
      entry.filePath ?? null,
      entry.tool ?? null,
      entry.success ?? null,
      entry.tags,
    );
  }

  const sql = `
    INSERT INTO vector_memory_entries (id, type, content, embedding, "filePath", tool, success, tags, "createdAt")
    VALUES ${values.join(", ")}
    ON CONFLICT (id) DO NOTHING
  `;

  try {
    const result = await prisma.$queryRawUnsafe(sql, ...params) as { rowCount?: number };
    return entries.length;
  } catch (err) {
    console.warn("[pgvector-search] Bulk insert failed:", (err as Error).message);
    return 0;
  }
}

// --------------------------------------------------------------------------- Cosine similarity (JS fallback)
// ---------------------------------------------------------------------------

/**
 * Compute cosine similarity between two vectors in JavaScript.
 * Used as fallback when pgvector is unavailable.
 */
export function cosineSimilarityJS(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// --------------------------------------------------------------------------- Convenience: hybrid search
// ---------------------------------------------------------------------------

/**
 * Hybrid search: tries pgvector first, falls back to in-memory if unavailable.
 * This is the recommended entry point for callers that want "just work" behavior.
 */
export async function hybridVectorSearch(
  queryEmbedding: number[],
  inMemoryEntries: Array<{ id: string; embedding: number[]; [key: string]: unknown }>,
  options: VectorSearchOptions = {},
): Promise<Array<{ id: string; similarity: number; [key: string]: unknown }>> {
  const pgvectorReady = await isPgvectorAvailable();

  if (pgvectorReady) {
    const dbResults = await vectorSearch(queryEmbedding, options);
    if (dbResults.length > 0) {
      return dbResults.map((r) => ({ ...r }));
    }
  }

  // Fallback: in-memory cosine similarity
  const { maxResults = DEFAULT_MAX_RESULTS, minSimilarity = DEFAULT_MIN_SIMILARITY } = options;

  const scored = inMemoryEntries.map((entry) => ({
    ...entry,
    similarity: cosineSimilarityJS(queryEmbedding, entry.embedding),
  }));

  return scored
    .filter((s) => s.similarity >= minSimilarity)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, maxResults);
}
