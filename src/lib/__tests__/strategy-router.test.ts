/**
 * strategy-router.test.ts — The deterministic router: strategy selection from
 * task shape (pure, no model), and the strategy functions' contract against a
 * mocked adapter (JSON parsing, tool-call extraction, review consensus).
 */
import { pickStrategy, runStrategy, strategyPlan, strategyReview } from "../strategy-router";
import { InMemoryAdapter, type AIProviderAdapter } from "../ai-providers";
import * as providers from "../ai-providers";

/** Swap the provider factory so strategies talk to a canned adapter. */
function mockAdapter(adapter: AIProviderAdapter): void {
  (providers as { createProviderAdapter: () => AIProviderAdapter }).createProviderAdapter = () => adapter;
}

const REAL_FACTORY = providers.createProviderAdapter;
afterEach(() => {
  (providers as { createProviderAdapter: unknown }).createProviderAdapter = REAL_FACTORY;
});

describe("pickStrategy — deterministic selection from task shape", () => {
  it("routes greenfield multi-file builds to scaffold", () => {
    expect(pickStrategy({ task: "build a complete dashboard application with charts and auth", existingFileCount: 0 })).toBe("scaffold");
    expect(pickStrategy({ task: "create an e-commerce website with cart and checkout", existingFileCount: 3 })).toBe("scaffold");
  });

  it("routes UI-shaped tasks in an existing workspace to branch-compare", () => {
    expect(pickStrategy({ task: "build a pricing card component for the settings page", existingFileCount: 20 })).toBe("branch-compare");
    expect(pickStrategy({ task: "create a modal widget with a form", existingFileCount: 8 })).toBe("branch-compare");
  });

  it("routes everything else to implement", () => {
    expect(pickStrategy({ task: "fix the login redirect bug", existingFileCount: 40 })).toBe("implement");
    expect(pickStrategy({ task: "add a retry with backoff to the deploy poller", existingFileCount: 12 })).toBe("implement");
  });

  it("is deterministic: same inputs → same strategy", () => {
    const task = "build a landing page with hero and pricing sections";
    const first = pickStrategy({ task, existingFileCount: 2 });
    for (let i = 0; i < 5; i++) {
      expect(pickStrategy({ task, existingFileCount: 2 })).toBe(first);
    }
  });
});

describe("strategyPlan — JSON contract", () => {
  it("parses the JSON plan into write_file calls", async () => {
    mockAdapter(
      new InMemoryAdapter([
        'Here is the plan:\n```json\n{"goal":"tag module","requirements":["export a tag"],"files":[{"path":"out/a.ts","purpose":"a","content":"export const a = 1;\\n"},{"path":"out/b.ts","purpose":"b","content":"export const b = 2;\\n"}],"order":["out/a.ts","out/b.ts"]}\n```',
      ]),
    );
    const r = await strategyPlan({ task: "make a tag module" });
    expect(r.ok).toBe(true);
    expect(r.files).toEqual(["out/a.ts", "out/b.ts"]);
    expect(r.toolCalls[0]).toMatchObject({ name: "write_file", path: "out/a.ts" });
    expect(r.summary).toContain("2 file(s) planned");
  });

  it("fails cleanly when no files come back", async () => {
    mockAdapter(new InMemoryAdapter(["I thought about it and have no files."]));
    const r = await strategyPlan({ task: "anything" });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("plan-empty");
    expect(r.toolCalls).toHaveLength(0);
  });
});

describe("runStrategy — forced kinds", () => {
  it("implement extracts tool_call-wrapped writes", async () => {
    mockAdapter(
      new InMemoryAdapter([
        'Working on it.\n<tool_call>{"name":"write_file","path":"x.ts","content":"export const x = 1;\\n"}</tool_call>\nDone.',
      ]),
    );
    const r = await runStrategy({ task: "fix the bug in the poller" }, "implement");
    expect(r.ok).toBe(true);
    expect(r.strategy).toBe("implement");
    expect(r.files).toEqual(["x.ts"]);
  });

  it("review arm without files refuses with a readable error", async () => {
    const r = await runStrategy({ task: "review" }, "review");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("strategyReview");
  });
});

describe("strategyReview — severity contract", () => {
  it("consensus false only for critical/major findings", async () => {
    mockAdapter(
      new InMemoryAdapter([
        '{"findings":[{"severity":"critical","description":"SQL injection in query()"},{"severity":"minor","description":"naming"}]}',
      ]),
    );
    const r = await strategyReview([{ path: "db.ts", content: "export const q = () => {};" }], "make a db helper");
    expect(r.consensus).toBe(false);
    expect(r.findings).toHaveLength(2);
    expect(r.summary).toContain("1 blocking");
  });

  it("consensus true when only minor notes", async () => {
    mockAdapter(
      new InMemoryAdapter(['{"findings":[{"severity":"minor","description":"rename i to idx"}]}']),
    );
    const r = await strategyReview([{ path: "a.ts", content: "x" }], "task");
    expect(r.consensus).toBe(true);
  });

  it("provider failure degrades to consensus true (never blocks the run)", async () => {
    // The adapter surfaces provider errors as text (its retry already ran);
    // no JSON → no findings → consensus true, so a down provider never
    // fabricates blocking review findings.
    mockAdapter(new InMemoryAdapter(["LLM API error: 503"]));
    const r = await strategyReview([{ path: "a.ts", content: "x" }], "task");
    expect(r.consensus).toBe(true);
    expect(r.findings).toHaveLength(0);
  });
});
