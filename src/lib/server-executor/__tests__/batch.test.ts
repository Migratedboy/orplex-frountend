// batch.test.ts — pure batch_execute helpers: planning bounds + consensus.
import { planBatchVariants, chooseConsensus } from "../batch";
import type { BatchWorkerResult } from "../batch";

const worker = (over: Partial<BatchWorkerResult> & { idx: number }): BatchWorkerResult => ({
  label: `variant-${over.idx}`,
  ok: true,
  patch: "diff --git a/x.ts b/x.ts\n+fixed\n",
  files: ["x.ts"],
  turns: 3,
  ...over,
});

describe("planBatchVariants", () => {
  it("accepts 2-3 well-formed variants", () => {
    const v = planBatchVariants([
      { label: "a", prompt: "do A" },
      { label: "b", task: "do B" },
    ]);
    expect(v).toHaveLength(2);
    expect(v![1].prompt).toBe("do B");
  });

  it("refuses fewer than 2 prompts", () => {
    expect(planBatchVariants([{ label: "a", prompt: "solo" }])).toBeNull();
    expect(planBatchVariants("not-an-array")).toBeNull();
  });

  it("caps to the max worker count", () => {
    const v = planBatchVariants([
      { prompt: "1" },
      { prompt: "2" },
      { prompt: "3" },
      { prompt: "4" },
    ]);
    expect(v).toHaveLength(3);
  });
});

describe("chooseConsensus", () => {
  it("picks the agreed majority when an exact patch repeats", () => {
    const patch = "diff --git a/x.ts b/x.ts\n+fixed\n";
    const c = chooseConsensus([
      worker({ idx: 0, patch: patch }),
      worker({ idx: 1, patch: patch }),
      worker({ idx: 2, patch: patch.replace("fixed", "other") }),
    ]);
    expect(c.winner).toBe(0);
    expect(c.verdict).toMatch(/consensus/);
  });

  it("declares no consensus when all variants differ", () => {
    const c = chooseConsensus([
      worker({ idx: 0, patch: "diff a\n+one\n" }),
      worker({ idx: 1, patch: "diff a\n+two\n" }),
      worker({ idx: 2, patch: "diff a\n+three\n" }),
    ]);
    expect(c.winner).toBeNull();
  });

  it("declares no consensus when fewer than 2 variants produced a diff", () => {
    const c = chooseConsensus([
      worker({ idx: 0, ok: false, error: "bombed" }),
      worker({ idx: 1, patch: "diff a\n+one\n" }),
    ]);
    expect(c.winner).toBeNull();
  });

  it("is order-insensitive to hunk line ordering (normalized key)", () => {
    const a = worker({ idx: 0, patch: "+b\n+a\n" });
    const b = worker({ idx: 1, patch: "+a\n+b\n" });
    const c = chooseConsensus([a, b]);
    expect(c.winner).toBe(0);
  });
});
