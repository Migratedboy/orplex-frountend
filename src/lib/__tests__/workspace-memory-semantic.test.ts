// workspace-memory-semantic.test.ts — Hybrid retrieval (C5): the MiniLM
// cosine term must (a) boost semantically-related memories, (b) vanish
// gracefully when embeddings are unavailable (lexical-only fallback), and
// (c) backfill + persist vectors for rows missing one. The embeddings module
// is mocked — no model download, no onnxruntime in tests.

import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const storeDir = mkdtempSync(join(tmpdir(), "orplex-wsm-"));
const storeFile = join(storeDir, "workspace-memory.json");

const unitVec = (i: number): Float32Array => {
  const v = new Float32Array(384);
  v[i] = 1;
  return v;
};
/** What the fake model returns for the task text. */
let mockTaskVec: Float32Array | null = unitVec(0);
/** What the fake model returns for memory contents (per-text override). */
const mockContentVecs = new Map<string, Float32Array>();
let mockBackfillVec: Float32Array | null = unitVec(0);

jest.mock("../embeddings", () => ({
  EMBED_DIM: 384,
  embedText: async (t: string) => {
    if (mockContentVecs.has(t)) return mockContentVecs.get(t)!;
    return mockBackfillVec;
  },
  // Production always calls cosineSimilarity(taskVec, storedVec) — the mock
  // mirrors that contract: arg A is the task vector, arg B the candidate's.
  cosineSimilarity: (a: ArrayLike<number> | null, b: ArrayLike<number> | null): number => {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    return na > 0 && nb > 0 ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
  },
}));

import {
  retrieveWorkspaceMemories,
  resetWorkspaceMemoryCacheForTests,
} from "../workspace-memory";

interface Row {
  id: string;
  content: string;
  embedding: number[] | null;
}

function seedRows(rows: Row[]) {
  const now = new Date().toISOString();
  const body = {
    version: 1,
    workspaces: {
      ws: rows.map((r) => ({
        id: r.id,
        workspaceKey: "ws",
        kind: "pattern" as const,
        content: r.content,
        contentHash: r.content,
        files: [],
        evidence: {},
        embedding: r.embedding,
        count: 1,
        firstSeenAt: now,
        lastSeenAt: now,
      })),
    },
  };
  writeFileSync(storeFile, JSON.stringify(body), "utf8");
  resetWorkspaceMemoryCacheForTests();
}

function readStoredEmbeddings(): Record<string, number[] | null | undefined> {
  const parsed = JSON.parse(readFileSync(storeFile, "utf8")) as {
    workspaces: Record<string, Array<{ id: string; embedding?: number[] | null }>>;
  };
  return Object.fromEntries((parsed.workspaces.ws ?? []).map((r) => [r.id, r.embedding]));
}

beforeEach(() => {
  if (existsSync(storeFile)) rmSync(storeFile);
  process.env.ORPLEX_WORKSPACE_MEMORY_FILE = storeFile;
  resetWorkspaceMemoryCacheForTests();
  mockContentVecs.clear();
  mockTaskVec = unitVec(0);
  mockBackfillVec = unitVec(0);
});

afterAll(() => {
  delete process.env.ORPLEX_WORKSPACE_MEMORY_FILE;
  rmSync(storeDir, { recursive: true, force: true });
});

describe("hybrid workspace-memory retrieval (semantic + lexical)", () => {
  it("boosts the semantically-related row above an equally-lexical row", async () => {
    const shared = "database connection pooling guidance for services";
    seedRows([
      { id: "row-high", content: shared, embedding: Array.from(unitVec(0)) },
      { id: "row-low", content: shared, embedding: Array.from(unitVec(1)) },
    ]);
    const out = await retrieveWorkspaceMemories("ws", "database pooling", 5);
    expect(out.length).toBe(2);
    expect(out[0].semantic).toBe(true);
    expect(out[1].semantic).toBeFalsy();
  });

  it("falls back to lexical-only scoring when embeddings are unavailable", async () => {
    mockTaskVec = null;
    mockBackfillVec = null;
    seedRows([{ id: "lexical", content: "fix the login redirect flow in the auth module", embedding: null }]);
    const out = await retrieveWorkspaceMemories("ws", "login redirect", 5);
    expect(out.length).toBe(1);
    expect(out[0].semantic).toBeFalsy();
    // No vectors persisted without a model.
    expect(readStoredEmbeddings().lexical).toBeNull();
  });

  it("backfills and persists a vector for rows missing one", async () => {
    seedRows([{ id: "nofix", content: "payment webhook retry semantics", embedding: null }]);
    const out = await retrieveWorkspaceMemories("ws", "webhook retries", 5);
    expect(out[0].semantic).toBe(true);
    // Fire-and-forget persist — settle the write chain.
    await new Promise((r) => setTimeout(r, 50));
    expect(readStoredEmbeddings().nofix).toHaveLength(384);
  });

  it("ignores stored vectors of the wrong dimension", async () => {
    seedRows([{ id: "wrongdim", content: "retry queue overflow policy", embedding: [0.1, 0.2] }]);
    mockBackfillVec = null; // no backfill: only the stored path is under test
    const out = await retrieveWorkspaceMemories("ws", "retry queue", 5);
    expect(out[0].semantic).toBeFalsy();
  });
});