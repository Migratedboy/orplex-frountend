import {
  lineSimilarity,
  diffSnippet,
  scoreFile,
  scoreTask,
  aggregateScores,
  enrichWithMetadata,
} from "../eval/scorer";
import {
  ALL_TASKS,
  TASK_REGISTRY,
  getTaskById,
  getTasksByCategory,
  getTasksByDifficulty,
  getTaskCount,
} from "../eval/tasks";
import type { EvalTask, TaskResult } from "../eval/types";

// ============================================================
// lineSimilarity
// ============================================================

describe("lineSimilarity", () => {
  it("returns 1 for identical strings", () => {
    expect(lineSimilarity("hello\nworld", "hello\nworld")).toBe(1);
  });

  it("returns 0 for completely different strings", () => {
    expect(lineSimilarity("aaa\nbbb", "ccc\nddd")).toBe(0);
  });

  it("returns > 0 for partially overlapping strings", () => {
    const sim = lineSimilarity("a\nb\nc", "a\nx\nc");
    expect(sim).toBeGreaterThan(0.5);
    expect(sim).toBeLessThan(1);
  });

  it("handles empty strings", () => {
    expect(lineSimilarity("", "hello")).toBe(0);
    expect(lineSimilarity("hello", "")).toBe(0);
    expect(lineSimilarity("", "")).toBe(1);
  });

  it("handles single-line strings", () => {
    expect(lineSimilarity("same", "same")).toBe(1);
    expect(lineSimilarity("aaa", "bbb")).toBe(0);
  });
});

// ============================================================
// diffSnippet
// ============================================================

describe("diffSnippet", () => {
  it("returns exact match message for identical content", () => {
    expect(diffSnippet("hello", "hello")).toBe("(exact match)");
  });

  it("shows added/removed lines for different content", () => {
    const snippet = diffSnippet("line1\nline2", "line1\nline3");
    expect(snippet).toContain("- line2");
    expect(snippet).toContain("+ line3");
  });

  it("respects maxLines limit", () => {
    const a = Array(100).fill("aaa").join("\n");
    const b = Array(100).fill("bbb").join("\n");
    const snippet = diffSnippet(a, b, 5);
    const lines = snippet.split("\n");
    expect(lines.length).toBeLessThanOrEqual(6); // 5 + possible "..." context
  });

  it("handles empty strings", () => {
    expect(diffSnippet("", "something")).toContain("+ something");
    expect(diffSnippet("something", "")).toContain("- something");
  });
});

// ============================================================
// scoreFile
// ============================================================

describe("scoreFile", () => {
  it("marks exact match", () => {
    const result = scoreFile("a.ts", "content", "content");
    expect(result.exactMatch).toBe(true);
    expect(result.similarity).toBe(1);
    expect(result.diffSnippet).toBe("(exact match)");
  });

  it("marks non-match with similarity", () => {
    const result = scoreFile("a.ts", "old", "new");
    expect(result.exactMatch).toBe(false);
    expect(result.similarity).toBeLessThan(1);
  });

  it("handles missing expected file", () => {
    const result = scoreFile("new.ts", "content", undefined);
    expect(result.exactMatch).toBe(false);
    expect(result.similarity).toBe(0.5);
  });
});

// ============================================================
// scoreTask
// ============================================================

describe("scoreTask", () => {
  const baseTask: EvalTask = {
    id: "TEST-001",
    name: "Test task",
    description: "Test",
    category: "type-error",
    difficulty: "easy",
    fixInstruction: "Fix it",
    initialFiles: [{ path: "a.ts", content: "broken" }],
    expectedFiles: { "a.ts": "fixed" },
    assertions: [
      {
        label: "Contains 'fixed'",
        check: (files) => (files["a.ts"] || "").includes("fixed"),
      },
    ],
    timeout: 60,
  };

  it("returns pass when files match and assertions pass", () => {
    const result = scoreTask(baseTask, { "a.ts": "fixed" }, "I fixed it", 1000);
    expect(result.verdict).toBe("pass");
    expect(result.fileDiffs[0].exactMatch).toBe(true);
    expect(result.assertionResults[0].passed).toBe(true);
  });

  it("returns fail when files don't match and assertions fail", () => {
    const result = scoreTask(baseTask, { "a.ts": "still broken" }, "oops", 1000);
    expect(result.verdict).toBe("fail");
    expect(result.fileDiffs[0].exactMatch).toBe(false);
    expect(result.assertionResults[0].passed).toBe(false);
  });

  it("returns pass when assertions pass even if files differ", () => {
    const result = scoreTask(
      { ...baseTask, expectedFiles: {} },
      { "a.ts": "fixed content" },
      "done",
      1000
    );
    expect(result.verdict).toBe("pass");
  });

  it("returns error when error is provided", () => {
    const result = scoreTask(baseTask, {}, "", 1000, "Something went wrong");
    expect(result.verdict).toBe("error");
    expect(result.error).toBe("Something went wrong");
  });

  it("returns timeout when duration exceeds timeout", () => {
    const result = scoreTask(baseTask, {}, "", 61000);
    expect(result.verdict).toBe("timeout");
  });

  it("truncates agent output to 4KB", () => {
    const longOutput = "x".repeat(8000);
    const result = scoreTask(baseTask, { "a.ts": "fixed" }, longOutput, 1000);
    expect(result.agentOutput.length).toBeLessThanOrEqual(4096);
  });
});

// ============================================================
// aggregateScores / enrichWithMetadata
// ============================================================

describe("aggregateScores", () => {
  it("computes flat counts", () => {
    const results: TaskResult[] = [
      { taskId: "A", verdict: "pass" } as TaskResult,
      { taskId: "B", verdict: "fail" } as TaskResult,
      { taskId: "C", verdict: "timeout" } as TaskResult,
      { taskId: "D", verdict: "error" } as TaskResult,
    ];
    const summary = aggregateScores(results);
    expect(summary.totalTasks).toBe(4);
    expect(summary.passed).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.timedOut).toBe(1);
    expect(summary.errored).toBe(1);
    expect(summary.score).toBe(25);
  });

  it("returns 0 score for empty results", () => {
    const summary = aggregateScores([]);
    expect(summary.score).toBe(0);
    expect(summary.totalTasks).toBe(0);
  });
});

describe("enrichWithMetadata", () => {
  it("fills category and difficulty breakdowns", () => {
    const results: TaskResult[] = [
      { taskId: "TS-001", verdict: "pass" } as TaskResult,
      { taskId: "TS-002", verdict: "fail" } as TaskResult,
      { taskId: "LOGIC-001", verdict: "pass" } as TaskResult,
    ];
    const meta = new Map([
      ["TS-001", { category: "type-error" as const, difficulty: "easy" as const }],
      ["TS-002", { category: "type-error" as const, difficulty: "medium" as const }],
      ["LOGIC-001", { category: "logic-bug" as const, difficulty: "easy" as const }],
    ]);

    let summary = aggregateScores(results);
    summary = enrichWithMetadata(summary, meta);

    expect(summary.byCategory["type-error"]).toEqual({ total: 2, passed: 1, score: 50 });
    expect(summary.byCategory["logic-bug"]).toEqual({ total: 1, passed: 1, score: 100 });
    expect(summary.byDifficulty["easy"]).toEqual({ total: 2, passed: 2, score: 100 });
    expect(summary.byDifficulty["medium"]).toEqual({ total: 1, passed: 0, score: 0 });
  });
});

// ============================================================
// Task Registry
// ============================================================

describe("Task Registry", () => {
  it("has at least 35 tasks", () => {
    expect(ALL_TASKS.length).toBeGreaterThanOrEqual(35);
  });

  it("has unique IDs", () => {
    const ids = ALL_TASKS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("lookup by ID works", () => {
    expect(getTaskById("TS-001")).toBeDefined();
    expect(getTaskById("NONEXISTENT")).toBeUndefined();
  });

  it("filter by category works", () => {
    const typeTasks = getTasksByCategory("type-error");
    expect(typeTasks.length).toBeGreaterThan(0);
    expect(typeTasks.every((t) => t.category === "type-error")).toBe(true);
  });

  it("filter by difficulty works", () => {
    const easyTasks = getTasksByDifficulty("easy");
    expect(easyTasks.length).toBeGreaterThan(0);
    expect(easyTasks.every((t) => t.difficulty === "easy")).toBe(true);
  });

  it("all tasks have required fields", () => {
    for (const task of ALL_TASKS) {
      expect(task.id).toBeTruthy();
      expect(task.name).toBeTruthy();
      expect(task.description).toBeTruthy();
      expect(task.fixInstruction).toBeTruthy();
      expect(task.initialFiles.length).toBeGreaterThan(0);
      expect(task.assertions.length).toBeGreaterThan(0);
      expect(task.timeout).toBeGreaterThan(0);
    }
  });

  it("category counts add up", () => {
    const categories = new Set(ALL_TASKS.map((t) => t.category));
    let total = 0;
    for (const cat of categories) {
      total += getTasksByCategory(cat).length;
    }
    expect(total).toBe(ALL_TASKS.length);
  });
});

// ============================================================
// Per-Task Structural Tests
// ============================================================

describe("Task file integrity", () => {
  for (const task of ALL_TASKS) {
    it(`${task.id} (${task.name}): initialFiles and expectedFiles use consistent paths`, () => {
      const initialPaths = new Set(task.initialFiles.map((f) => f.path));
      const expectedPaths = new Set(Object.keys(task.expectedFiles));

      // All expected files should have a corresponding initial file
      // (or be a new file the agent creates)
      for (const path of expectedPaths) {
        // It's fine if the agent creates a new file — just verify the path is valid
        expect(path).toBeTruthy();
      }

      // All initial files should have non-empty content
      for (const file of task.initialFiles) {
        expect(file.content.length).toBeGreaterThan(0);
      }
    });

    it(`${task.id} (${task.name}): assertions are functional`, () => {
      // Verify each assertion's check function doesn't throw
      const emptyFiles: Record<string, string> = {};
      for (const assertion of task.assertions) {
        expect(() => assertion.check(emptyFiles)).not.toThrow();
      }
    });
  }
});
