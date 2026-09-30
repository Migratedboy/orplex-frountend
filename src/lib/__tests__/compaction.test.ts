// compaction.test.ts — The summarizing compactor: eviction math, incremental
// state, cap enforcement, and the failsafe (summarize failure → null → caller
// falls back to truncation).
import {
  compactTranscript,
  createTranscriptCompactor,
  estimateCompactTokens,
  type CompactionState,
} from "../compaction";

const BUDGET = 1000;

function msg(content: string, role = "user") {
  return { role, content };
}

/** Transcript of n messages of `fill` tokens each. */
function fillTranscript(n: number, fillTokens = 300) {
  return Array.from({ length: n }, (_, i) => msg(`message-${i} ${"x".repeat(fillTokens * 4)}`));
}

describe("compactTranscript", () => {
  it("returns null when under the trigger", async () => {
    const small = fillTranscript(2, 100); // ~200 tokens < 80% of 1000
    expect(await compactTranscript(small, BUDGET, async () => "s")).toBeNull();
  });

  it("summarizes evicted messages into a context_so_far block", async () => {
    const big = fillTranscript(6, 300); // ~1800 tokens, well over
    const summarize = jest.fn(async () => "did things to files a and b");
    const result = await compactTranscript(big, BUDGET, summarize);

    expect(result).not.toBeNull();
    const block = result!.messages[0].content;
    expect(block).toContain("<context_so_far>");
    expect(block).toContain("did things to files a and b");
    // kept tail survives verbatim
    const keptLast = result!.messages[result!.messages.length - 1];
    expect(keptLast.content).toBe(big[big.length - 1].content);
    // evicted messages are gone
    expect(result!.messages.find((m) => m.content === big[0].content)).toBeUndefined();
  });

  it("evicts enough to fit summary + remainder under budget", async () => {
    const big = fillTranscript(6, 300); // each 300 tokens
    // keepRecent 2 leaves room to actually reach the budget; with the default
    // keepRecent=4, six messages can't evict enough (by design — recent
    // context is sacred and the caller's truncation caps the tail).
    const result = await compactTranscript(big, BUDGET, async () => "s", { keepRecent: 2 });
    const total = result!.messages.reduce((s, m) => s + estimateCompactTokens(m.content), 0);
    expect(total).toBeLessThanOrEqual(BUDGET + 50); // small tolerance for the block prose
  });

  it("keeps at least keepRecent messages verbatim", async () => {
    const big = fillTranscript(6, 300);
    const result = await compactTranscript(big, BUDGET, async () => "s", { keepRecent: 3 });
    const tail = result!.messages.slice(-3).map((m) => m.content);
    expect(tail).toEqual(big.slice(-3).map((m) => m.content));
  });

  it("returns null (fallback) when the summarizer fails", async () => {
    const big = fillTranscript(6, 300);
    const result = await compactTranscript(big, BUDGET, async () => {
      throw new Error("provider down");
    });
    expect(result).toBeNull();
  });

  it("returns null when the summarizer returns empty", async () => {
    const big = fillTranscript(6, 300);
    expect(await compactTranscript(big, BUDGET, async () => "  ")).toBeNull();
  });

  it("truncates a runaway summary that ignores the cap", async () => {
    const big = fillTranscript(6, 300);
    const runaway = "y".repeat(50_000);
    const result = await compactTranscript(big, BUDGET, async () => runaway);
    expect(result).not.toBeNull();
    expect(result!.newState.summary.length).toBeLessThan(400 * 4 * 1.5 + 40);
  });

  it("reuses prior state incrementally (second eviction summarizes only the new tail)", async () => {
    const big = fillTranscript(6, 300);
    const state: CompactionState = {
      coveredCount: 2,
      summary: "earlier turns did setup",
      fingerprint: big.slice(0, 2).map((m) => m.content.length),
    };
    const summarize = jest.fn(async (_prompt: string, _maxTokens: number) => "merged summary");
    const result = await compactTranscript(big, BUDGET, summarize, {}, state);

    expect(result).not.toBeNull();
    // prompt should mention the previous summary (incremental path taken)
    const sentPrompt = summarize.mock.calls[0][0] as string;
    expect(sentPrompt).toContain("Previous summary of earlier messages");
    expect(sentPrompt).toContain("earlier turns did setup");
    // new state covers everything evicted
    expect(result!.newState.coveredCount).toBe(result!.evictedCount);
  });

  it("falls back to full re-summarize when the fingerprint mismatches", async () => {
    const big = fillTranscript(6, 300);
    const state: CompactionState = {
      coveredCount: 2,
      summary: "stale",
      fingerprint: [1, 2], // wrong lengths → prefix replaced
    };
    const summarize = jest.fn(async (_prompt: string, _maxTokens: number) => "fresh full summary");
    const result = await compactTranscript(big, BUDGET, summarize, {}, state);

    const sentPrompt = summarize.mock.calls[0][0] as string;
    expect(sentPrompt).toContain("Transcript to compress");
    expect(sentPrompt).not.toContain("Previous summary");
    expect(result!.newState.summary).toBe("fresh full summary");
  });
});

describe("createTranscriptCompactor", () => {
  it("caches state across calls and resets cleanly", async () => {
    const summarize = jest.fn(async () => "summary body");
    const compactor = createTranscriptCompactor(summarize);
    const big = fillTranscript(6, 300);

    const first = await compactor.compact(big, BUDGET);
    expect(first).not.toBeNull();
    const callsAfterFirst = summarize.mock.calls.length;

    // Grow the transcript: still over budget → incremental path reuses cache
    const grown = [...big, msg("newest message " + "z".repeat(1200))];
    const second = await compactor.compact(grown, BUDGET);
    expect(second).not.toBeNull();

    compactor.reset();
    const third = await compactor.compact(grown, BUDGET);
    expect(third).not.toBeNull();
    expect(summarize.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  it("never compacts when aborted", async () => {
    const compactor = createTranscriptCompactor(async () => "s");
    const controller = new AbortController();
    controller.abort();
    const big = fillTranscript(6, 300);
    expect(await compactor.compact(big, BUDGET, controller.signal)).toBeNull();
  });
});
