/**
 * vector-memory.ts — Vectorized Memory Layer with DB persistence.
 *
 * Hybrid architecture: in-memory cache for fast reads, Prisma for persistence.
 * On startup, hydrates from DB. Writes go to both memory and DB (fire-and-forget).
 */

import crypto from "crypto";
import { prisma } from "./prisma";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MemoryEntry {
  id: string;
  type: "code_change" | "conversation" | "pattern" | "error" | "convention";
  content: string;
  embedding: number[];
  metadata: {
    filePath?: string;
    tool?: string;
    success?: boolean;
    timestamp: number;
    tags: string[];
  };
}

export interface MemorySearchResult {
  entry: MemoryEntry;
  similarity: number;
  relevance: "high" | "medium" | "low";
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const EMBEDDING_DIMS = 128;
const MAX_ENTRIES = 5000;
const SIMILARITY_THRESHOLD = 0.3;

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

let memoryStore: MemoryEntry[] = [];
let hydrated = false;

// ---------------------------------------------------------------------------
// Embedding (hash-based, no external API)
// ---------------------------------------------------------------------------

function embedText(text: string): number[] {
  const lower = text.toLowerCase();
  const words = lower.split(/\s+/).filter((w) => w.length > 2);
  const vec = new Array(EMBEDDING_DIMS).fill(0);
  for (const word of words) {
    const hash = simpleHash(word);
    vec[hash % EMBEDDING_DIMS] += 1;
    for (let i = 0; i < word.length - 2; i++) {
      const trigram = word.slice(i, i + 3);
      vec[simpleHash(trigram) % EMBEDDING_DIMS] += 0.5;
    }
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  if (norm > 0) for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  return vec;
}

function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++)
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  return Math.abs(hash);
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0,
    normA = 0,
    normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function extractTags(text: string): string[] {
  const tags: string[] = [];
  const lower = text.toLowerCase();
  if (/auth|login|session/.test(lower)) tags.push("auth");
  if (/api|route/.test(lower)) tags.push("api");
  if (/component|ui|page/.test(lower)) tags.push("ui");
  if (/database|prisma/.test(lower)) tags.push("database");
  if (/error|bug|fix/.test(lower)) tags.push("bugfix");
  return tags;
}

// ---------------------------------------------------------------------------
// Hydration from DB
// ---------------------------------------------------------------------------

async function hydrateIfNeeded(): Promise<void> {
  if (hydrated) return;
  try {
    const rows = await prisma.vectorMemoryEntry.findMany({
      orderBy: { createdAt: "desc" },
      take: MAX_ENTRIES,
    });
    memoryStore = rows.map((row) => ({
      id: row.id,
      type: row.type as MemoryEntry["type"],
      content: row.content,
      embedding: row.embedding as unknown as number[],
      metadata: {
        filePath: row.filePath || undefined,
        tool: row.tool || undefined,
        success: row.success ?? undefined,
        timestamp: row.createdAt.getTime(),
        tags: row.tags,
      },
    }));
    hydrated = true;
  } catch {
    // DB unavailable — continue with empty memory
    hydrated = true;
  }
}

// ---------------------------------------------------------------------------
// Persist to DB (fire-and-forget)
// ---------------------------------------------------------------------------

function persistEntry(entry: MemoryEntry): void {
  prisma.vectorMemoryEntry
    .create({
      data: {
        id: entry.id,
        type: entry.type,
        content: entry.content,
        embedding: entry.embedding as any,
        filePath: entry.metadata.filePath || null,
        tool: entry.metadata.tool || null,
        success: entry.metadata.success ?? null,
        tags: entry.metadata.tags,
      },
    })
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function rememberCodeChange(
  filePath: string,
  oldContent: string | null,
  newContent: string,
  success: boolean,
): void {
  const content =
    filePath + ": " + (oldContent ? "edit" : "create") + " " + newContent.slice(0, 200);
  const entry: MemoryEntry = {
    id: crypto.randomUUID(),
    type: "code_change",
    content,
    embedding: embedText(content),
    metadata: {
      filePath,
      tool: oldContent ? "edit_file" : "write_file",
      success,
      timestamp: Date.now(),
      tags: extractTags(content),
    },
  };
  memoryStore.push(entry);
  persistEntry(entry);
  evictIfNeeded();
}

export function rememberConversation(
  userMessage: string,
  aiResponse: string,
  _toolsUsed: string[],
): void {
  const content = "User: " + userMessage + " AI: " + aiResponse.slice(0, 200);
  const entry: MemoryEntry = {
    id: crypto.randomUUID(),
    type: "conversation",
    content,
    embedding: embedText(userMessage),
    metadata: { timestamp: Date.now(), tags: extractTags(userMessage) },
  };
  memoryStore.push(entry);
  persistEntry(entry);
  evictIfNeeded();
}

export function rememberPattern(pattern: string, tags: string[] = []): void {
  const entry: MemoryEntry = {
    id: crypto.randomUUID(),
    type: "pattern",
    content: pattern,
    embedding: embedText(pattern),
    metadata: { timestamp: Date.now(), tags },
  };
  memoryStore.push(entry);
  persistEntry(entry);
  evictIfNeeded();
}

export function rememberError(
  error: string,
  fix: string,
  filePath?: string,
): void {
  const content = "Error: " + error + " Fix: " + fix;
  const entry: MemoryEntry = {
    id: crypto.randomUUID(),
    type: "error",
    content,
    embedding: embedText(error),
    metadata: {
      filePath,
      success: true,
      timestamp: Date.now(),
      tags: ["error", "fix"],
    },
  };
  memoryStore.push(entry);
  persistEntry(entry);
  evictIfNeeded();
}

export function rememberConvention(
  convention: string,
  tags: string[] = [],
): void {
  const entry: MemoryEntry = {
    id: crypto.randomUUID(),
    type: "convention",
    content: convention,
    embedding: embedText(convention),
    metadata: { timestamp: Date.now(), tags: ["convention", ...tags] },
  };
  memoryStore.push(entry);
  persistEntry(entry);
  evictIfNeeded();
}

export async function searchMemory(
  query: string,
  options: {
    maxResults?: number;
    type?: MemoryEntry["type"];
    minSimilarity?: number;
  } = {},
): Promise<MemorySearchResult[]> {
  await hydrateIfNeeded();

  const {
    maxResults = 5,
    type,
    minSimilarity = SIMILARITY_THRESHOLD,
  } = options;
  const queryEmbedding = embedText(query);
  const queryTerms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 2);

  // Try pgvector database-level search first
  try {
    const { isPgvectorAvailable, vectorSearch } = await import("./pgvector-search");
    if (await isPgvectorAvailable()) {
      const dbResults = await vectorSearch(queryEmbedding, {
        maxResults,
        type,
        minSimilarity,
      });
      if (dbResults.length > 0) {
        return dbResults.map((r) => ({
          entry: {
            id: r.id,
            type: r.type as MemoryEntry["type"],
            content: r.content,
            embedding: queryEmbedding, // not needed for display
            metadata: {
              filePath: r.filePath || undefined,
              tool: r.tool || undefined,
              success: r.success ?? undefined,
              timestamp: r.createdAt.getTime(),
              tags: r.tags,
            },
          },
          similarity: r.similarity,
          relevance:
            r.similarity > 0.8 ? "high" : r.similarity > 0.7 ? "medium" : "low",
        }));
      }
    }
  } catch {
    // pgvector unavailable — fall through to in-memory search
  }

  // Fallback: in-memory hybrid search (vector + BM25)
  const scored: MemorySearchResult[] = [];
  for (const entry of memoryStore) {
    if (type && entry.type !== type) continue;
    const vectorSim = cosineSimilarity(queryEmbedding, entry.embedding);
    const docTerms = entry.content.toLowerCase().split(/\s+/);
    let bm25 = 0;
    for (const term of queryTerms)
      bm25 += docTerms.filter((t) => t === term).length;
    const bm25Norm = Math.min(bm25 / 5, 1);
    const hybridScore = vectorSim * 0.6 + bm25Norm * 0.4;
    if (hybridScore >= minSimilarity) {
      scored.push({
        entry,
        similarity: hybridScore,
        relevance:
          hybridScore > 0.8 ? "high" : hybridScore > 0.7 ? "medium" : "low",
      });
    }
  }
  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, maxResults);
}

export async function getMemoryContext(task: string): Promise<string> {
  const results = await searchMemory(task, { maxResults: 3 });
  if (results.length === 0) return "";
  return (
    "\n\nRelevant past experience:\n" +
    results
      .map(
        (r) =>
          "[" + r.entry.type.toUpperCase() + "] " + r.entry.content.slice(0, 150),
      )
      .join("\n")
  );
}

export async function getMemoryStats(): Promise<{
  totalEntries: number;
  byType: Record<string, number>;
  avgAge: number;
  recentPatterns: string[];
}> {
  await hydrateIfNeeded();
  const now = Date.now();
  const byType: Record<string, number> = {};
  let totalAge = 0;
  for (const entry of memoryStore) {
    byType[entry.type] = (byType[entry.type] || 0) + 1;
    totalAge += now - entry.metadata.timestamp;
  }
  const patterns = memoryStore
    .filter((e) => e.type === "pattern" || e.type === "convention")
    .sort((a, b) => b.metadata.timestamp - a.metadata.timestamp)
    .slice(0, 5)
    .map((e) => e.content.slice(0, 80));
  return {
    totalEntries: memoryStore.length,
    byType,
    avgAge:
      memoryStore.length > 0 ? totalAge / memoryStore.length / 3600000 : 0,
    recentPatterns: patterns,
  };
}

function evictIfNeeded(): void {
  if (memoryStore.length > MAX_ENTRIES) {
    memoryStore.sort(
      (a, b) => b.metadata.timestamp - a.metadata.timestamp,
    );
    memoryStore = memoryStore.slice(0, MAX_ENTRIES);
  }
}
