// workspace-memory-semantic.test.ts — Hybrid retrieval (C5): the MiniLM
// cosine term must (a) boost semantically-related memories, (b) vanish
// gracefully when embeddings are unavailable (lexical-only fallback), and
// (c) backfill + persist vectors for rows missing one. The embeddings module
// is mocked — no model download, no onnxruntime in tests.

const mockRows: any[] = [];
const mockUpdates: Array<{ id: string; data: { embedding: number[] } }> = [];

jest.mock("../prisma", () => ({
  prisma: {
    workspaceMemory: {
      findMany: jest.fn(async () => mockRows),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: { embedding: number[] } }) => {
        mockUpdates.push({ id: where.id, data });
        return {};
      }),
    },
  },
}));

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

import { retrieveWorkspaceMemories } from "../workspace-memory";

function mk(id: string, content: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    workspaceKey: "ws",
    kind: "pattern",
    content,
    contentHash: id,
    evidence: {},
    files: [],
    embedding: null,
    count: 1,
    firstSeenAt: new Date(),
    lastSeenAt: new Date(),
    ...extra,
  };
}

beforeEach(() => {
  mockRows.length = 0;
  mockUpdates.length = 0;
  mockContentVecs.clear();
  mockTaskVec = unitVec(0);
  mockBackfillVec = unitVec(0);
});

describe("hybrid workspace-memory retrieval (semantic + lexical)", () => {
  it("boosts the semantically-related row above an equally-lexical row", async () => {
    const shared = "database connection pooling guidance for services";
    mockRows.push(
      mk("row-high", shared, { embedding: Array.from(unitVec(0)) }),
      mk("row-low", shared, { embedding: Array.from(unitVec(1)) })
    );
    const out = await retrieveWorkspaceMemories("ws", "database pooling", 5);
    expect(out.length).toBe(2);
    expect(out[0].content).toBe(shared); // tie broken by (only) semantic score
    expect(out.find((r) => r.score === Math.max(...out.map((o) => o.score)))?.semantic).toBe(true);
    expect(out[0].semantic).toBe(true);
    expect(out[1].semantic).toBeFalsy();
  });

  it("falls back to lexical-only scoring when embeddings are unavailable", async () => {
    mockTaskVec = null;
    mockBackfillVec = null;
    mockRows.push(mk("lexical", "fix the login redirect flow in the auth module"));
    const out = await retrieveWorkspaceMemories("ws", "login redirect", 5);
    expect(out.length).toBe(1);
    expect(out[0].semantic).toBeFalsy();
    expect(mockUpdates).toHaveLength(0); // no vectors persisted without a model
  });

  it("backfills and persists a vector for rows missing one", async () => {
    mockRows.push(mk("nofix", "payment webhook retry semantics"));
    const out = await retrieveWorkspaceMemories("ws", "webhook retries", 5);
    expect(out[0].semantic).toBe(true);
    expect(mockUpdates).toHaveLength(1);
    expect(mockUpdates[0].id).toBe("nofix");
    expect(mockUpdates[0].data.embedding).toHaveLength(384);
  });

  it("ignores stored vectors of the wrong dimension", async () => {
    mockRows.push(mk("wrongdim", "retry queue overflow policy", { embedding: [0.1, 0.2] }));
    mockBackfillVec = null; // no backfill: only the stored path is under test
    const out = await retrieveWorkspaceMemories("ws", "retry queue", 5);
    expect(out[0].semantic).toBeFalsy();
    expect(mockUpdates).toHaveLength(0);
  });
});
