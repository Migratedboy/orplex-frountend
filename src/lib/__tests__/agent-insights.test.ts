// agent-insights.test.ts — The insight store: pattern mining, semantic
// degradation, and the "never throw on a telemetry path" contract.

const mockPrisma = {
  task: { create: jest.fn(), update: jest.fn(), count: jest.fn(), groupBy: jest.fn(), findMany: jest.fn() },
  toolCall: { create: jest.fn() },
  pipelineStep: { create: jest.fn() },
  agentTaskDependency: { createMany: jest.fn() },
  agentTask: { findMany: jest.fn() },
  sonaTrajectory: { create: jest.fn(), findMany: jest.fn() },
  sonaPattern: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), count: jest.fn(), findMany: jest.fn() },
  vectorMemoryEntry: { create: jest.fn(), count: jest.fn(), findMany: jest.fn(), deleteMany: jest.fn() },
};
jest.mock("../prisma", () => ({ prisma: mockPrisma }));

const mockEmbed = jest.fn();
const mockCosine = jest.fn();
jest.mock("../embeddings", () => ({
  embedText: (...a: unknown[]) => mockEmbed(...a),
  cosineSimilarity: (...a: unknown[]) => mockCosine(...a),
  EMBED_DIM: 384,
}));

import {
  learnPatternsFromTrajectories,
  rememberSemantic,
  recallSimilar,
  recordTaskDependency,
  readyAgentTasks,
  topPatterns,
  PATTERN_MIN_SAMPLES,
} from "../agent-insights";

beforeEach(() => {
  jest.clearAllMocks();
  mockEmbed.mockResolvedValue(new Float32Array(384).fill(0.1));
  mockCosine.mockReturnValue(0.9);
  mockPrisma.task.create.mockResolvedValue({ id: "task-1" });
  mockPrisma.sonaPattern.findFirst.mockResolvedValue(null);
  mockPrisma.sonaPattern.create.mockResolvedValue({});
  mockPrisma.vectorMemoryEntry.count.mockResolvedValue(0);
});

const traj = (tools: string[], outcome = "success", totalDuration = 1000) => ({
  toolsUsed: tools,
  outcome,
  totalDuration,
});

describe("learnPatternsFromTrajectories", () => {
  it("promotes a repeated, successful tool sequence", async () => {
    mockPrisma.sonaTrajectory.findMany.mockResolvedValue([
      traj(["read_file", "grep", "edit_file"]),
      traj(["read_file", "grep", "edit_file"]),
      traj(["read_file", "grep", "edit_file"]),
    ]);
    const learned = await learnPatternsFromTrajectories();
    expect(learned).toHaveLength(1);
    expect(learned[0].steps).toEqual(["read_file", "grep", "edit_file"]);
    expect(learned[0].successRate).toBe(1);
    expect(learned[0].useCount).toBe(3);
  });

  it("does NOT promote a sequence below the minimum sample count", async () => {
    mockPrisma.sonaTrajectory.findMany.mockResolvedValue([
      traj(["read_file", "edit_file"]),
      traj(["read_file", "edit_file"]),
    ]);
    expect(await learnPatternsFromTrajectories()).toEqual([]);
  });

  it("does NOT promote a sequence that mostly failed", async () => {
    mockPrisma.sonaTrajectory.findMany.mockResolvedValue([
      traj(["run_command"], "success"),
      traj(["run_command"], "failure"),
      traj(["run_command"], "failure"),
    ]);
    expect(await learnPatternsFromTrajectories()).toEqual([]);
  });

  it("counts partial as non-success when measuring the rate", async () => {
    // 3/4 = 0.75 clears the 0.6 bar, so this IS promoted — and the rate proves
    // partial outcomes are not silently counted as wins.
    mockPrisma.sonaTrajectory.findMany.mockResolvedValue([
      traj(["a", "b", "c"], "success"),
      traj(["a", "b", "c"], "success"),
      traj(["a", "b", "c"], "success"),
      traj(["a", "b", "c"], "partial"),
    ]);
    const learned = await learnPatternsFromTrajectories();
    expect(learned).toHaveLength(1);
    expect(learned[0].successRate).toBe(0.75);
  });

  it("rejects a majority-partial sequence, which would teach a bad habit", async () => {
    // 2/4 = 0.5 is below the bar: promoting it would hand the agent a sequence
    // that mostly does not work.
    mockPrisma.sonaTrajectory.findMany.mockResolvedValue([
      traj(["a", "b", "c"], "success"),
      traj(["a", "b", "c"], "success"),
      traj(["a", "b", "c"], "partial"),
      traj(["a", "b", "c"], "failure"),
    ]);
    expect(await learnPatternsFromTrajectories()).toEqual([]);
  });

  it("truncates the sequence so a long run can still repeat", async () => {
    const long = ["a", "b", "c", "d", "e", "f", "g", "h"];
    mockPrisma.sonaTrajectory.findMany.mockResolvedValue([traj(long), traj(long), traj(long)]);
    const learned = await learnPatternsFromTrajectories();
    expect(learned[0].steps).toHaveLength(5);
  });

  it("updates an existing pattern instead of duplicating it", async () => {
    mockPrisma.sonaPattern.findFirst.mockResolvedValue({ id: "pat-1" });
    mockPrisma.sonaTrajectory.findMany.mockResolvedValue([
      traj(["x", "y"]),
      traj(["x", "y"]),
      traj(["x", "y"]),
    ]);
    await learnPatternsFromTrajectories();
    expect(mockPrisma.sonaPattern.create).not.toHaveBeenCalled();
    expect(mockPrisma.sonaPattern.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "pat-1" } })
    );
  });

  it("returns [] instead of throwing when the read fails", async () => {
    mockPrisma.sonaTrajectory.findMany.mockRejectedValue(new Error("db down"));
    await expect(learnPatternsFromTrajectories()).resolves.toEqual([]);
  });
});

describe("recordTaskDependency", () => {
  it("writes the edge idempotently", async () => {
    mockPrisma.agentTaskDependency.createMany.mockResolvedValue({ count: 1 });
    await expect(recordTaskDependency("t2", "t1")).resolves.toBe("written");
    expect(mockPrisma.agentTaskDependency.createMany).toHaveBeenCalledWith({
      data: [{ taskId: "t2", dependsOnId: "t1" }],
      skipDuplicates: true,
    });
  });

  it("refuses a self-edge, which would make a task permanently unschedulable", async () => {
    await expect(recordTaskDependency("t1", "t1")).resolves.toBe("skipped");
    expect(mockPrisma.agentTaskDependency.createMany).not.toHaveBeenCalled();
  });

  it("returns failed (never throws) on a write error", async () => {
    mockPrisma.agentTaskDependency.createMany.mockRejectedValue(new Error("nope"));
    await expect(recordTaskDependency("t2", "t1")).resolves.toBe("failed");
  });
});

describe("readyAgentTasks", () => {
  it("excludes tasks whose dependencies are unfinished", async () => {
    mockPrisma.agentTask.findMany.mockResolvedValue([]);
    await readyAgentTasks("run-1");
    const where = mockPrisma.agentTask.findMany.mock.calls[0][0].where;
    expect(where.status).toBe("pending");
    expect(where.NOT.dependencies.some.dependsOn.status.notIn).toEqual(["completed", "failed"]);
  });

  it("returns [] rather than throwing when the query fails", async () => {
    mockPrisma.agentTask.findMany.mockRejectedValue(new Error("db down"));
    await expect(readyAgentTasks("run-1")).resolves.toEqual([]);
  });
});

describe("rememberSemantic / recallSimilar", () => {
  it("stores a vector when the embedder is available", async () => {
    mockPrisma.vectorMemoryEntry.create.mockResolvedValue({});
    const r = await rememberSemantic({ type: "pattern", content: "fixed the build" });
    expect(r).toEqual({ written: true, vectorised: true });
    expect(mockPrisma.vectorMemoryEntry.create.mock.calls[0][0].data.embedding).toHaveLength(384);
  });

  it("still stores the memory when the embedder is missing (zero-vector marker)", async () => {
    // Losing a memory because an OPTIONAL inference model is absent is
    // backwards; the text is the valuable part.
    mockEmbed.mockResolvedValue(null);
    mockPrisma.vectorMemoryEntry.create.mockResolvedValue({});
    const r = await rememberSemantic({ type: "error", content: "build broke" });
    expect(r).toEqual({ written: true, vectorised: false });
    expect(mockPrisma.vectorMemoryEntry.create.mock.calls[0][0].data.embedding).toHaveLength(384);
  });

  it("reports written:false (never throws) when the insert fails", async () => {
    mockPrisma.vectorMemoryEntry.create.mockRejectedValue(new Error("db down"));
    await expect(rememberSemantic({ type: "pattern", content: "x" })).resolves.toEqual({
      written: false,
      vectorised: false,
    });
  });

  it("ranks semantic hits above the floor", async () => {
    mockCosine.mockReturnValue(0.8);
    mockPrisma.vectorMemoryEntry.findMany.mockResolvedValue([
      { id: "m1", type: "pattern", content: "similar", filePath: null, embedding: new Array(384).fill(0.1) },
    ]);
    const hits = await recallSimilar("fix the build");
    expect(hits[0].match).toBe("semantic");
    expect(hits[0].score).toBeCloseTo(0.8);
  });

  it("drops sub-floor candidates and degrades to a labelled keyword hit", async () => {
    // Nothing clears SEMANTIC_MIN_SCORE, so the semantic result is empty and
    // the keyword fallback takes over — but every hit is labelled "keyword" so
    // the caller can tell it did NOT get semantic ranking.
    mockCosine.mockReturnValue(0.1);
    mockPrisma.vectorMemoryEntry.findMany.mockResolvedValue([
      { id: "m1", type: "pattern", content: "unrelated", filePath: null, embedding: new Array(384).fill(0.1) },
    ]);
    const hits = await recallSimilar("fix the build");
    expect(hits.every((h) => h.match === "keyword")).toBe(true);
    expect(hits.some((h) => h.match === "semantic")).toBe(false);
  });

  it("labels the fallback KEYWORD, so a caller never mistakes it for semantic", async () => {
    mockEmbed.mockResolvedValue(null);
    mockPrisma.vectorMemoryEntry.findMany.mockResolvedValue([
      { id: "m2", type: "error", content: "fix the build", filePath: "a.ts" },
    ]);
    const hits = await recallSimilar("fix the build");
    expect(hits[0].match).toBe("keyword");
  });

  it("returns [] for an empty query without touching the db", async () => {
    await expect(recallSimilar("   ")).resolves.toEqual([]);
    expect(mockPrisma.vectorMemoryEntry.findMany).not.toHaveBeenCalled();
  });
});

describe("topPatterns", () => {
  it("returns [] rather than throwing when the read fails", async () => {
    mockPrisma.sonaPattern.findMany.mockRejectedValue(new Error("db down"));
    await expect(topPatterns()).resolves.toEqual([]);
  });
});

describe("constants", () => {
  it("requires real evidence before calling something a pattern", () => {
    expect(PATTERN_MIN_SAMPLES).toBeGreaterThanOrEqual(2);
  });
});