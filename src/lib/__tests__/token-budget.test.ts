import { estimateTokens, fitMessagesToBudget } from "../background-worker";
import { appendTaskAnchor } from "../stream-reader";

describe("token budget", () => {
  it("estimates tokens at 4 chars/token", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("")).toBe(0);
  });

  it("caps older messages but never the last one", () => {
    const older = "x".repeat(8000); // ~2000 tokens
    const msgs = [
      { role: "user", content: older },
      { role: "assistant", content: older },
      { role: "user", content: "final question" },
    ];
    const out = fitMessagesToBudget(msgs);
    expect(out[0].content.length).toBeLessThan(older.length);
    expect(out[1].content.length).toBeLessThan(older.length);
    expect(out[2].content).toBe("final question"); // last message untouched
    // LIVE-VALIDATED (run 5): an unexplained mid-tag cut made the model think
    // the FILE was truncated — markers must say the cut is the CONTEXT, not
    // the file.
    expect(out[0].content).toContain("OLDER MESSAGE SHORTENED");
    expect(out[0].content).toContain("the FILE ITSELF is complete");
  });

  it("cuts older messages at a line boundary, never mid-tag", () => {
    const html = Array.from({ length: 400 }, (_, i) => `<li><a href="#s${i}">Section ${i}</a></li>`).join("\n");
    const msgs = [{ role: "user", content: html }, { role: "user", content: "final" }];
    const out = fitMessagesToBudget(msgs);
    // The cut must not land inside a tag: the char right before the marker is
    // a newline.
    const capped = out[0].content;
    const markerIdx = capped.indexOf("\n…[OLDER MESSAGE SHORTENED");
    expect(markerIdx).toBeGreaterThan(0);
  });

  it("drops oldest messages when still over budget", () => {
    const big = "y".repeat(2000); // ~500 tokens each
    const msgs = Array.from({ length: 10 }, (_, i) => ({ role: "user", content: `${i}:${big}` }));
    const out = fitMessagesToBudget(msgs, 1200);
    expect(out.length).toBeLessThan(msgs.length);
    expect(out.length).toBeGreaterThanOrEqual(2);
  });

  it("caps the last message when it alone exceeds the budget", () => {
    const huge = "z".repeat(40_000); // ~10000 tokens
    const msgs = [{ role: "user", content: huge }];
    const out = fitMessagesToBudget(msgs, 1000);
    expect(estimateTokens(out[0].content)).toBeLessThanOrEqual(1100);
    expect(out[0].content).toContain("TOOL OUTPUT SHORTENED");
    expect(out[0].content).toContain("the FILE ITSELF is complete");
  });

  it("does not mutate the input array", () => {
    const msgs = [{ role: "user", content: "a".repeat(10_000) }, { role: "user", content: "b" }];
    const snapshot = JSON.stringify(msgs);
    fitMessagesToBudget(msgs, 500);
    expect(JSON.stringify(msgs)).toBe(snapshot);
  });

  // The task anchor is appended to the TAIL of the last message, and the cap
  // keeps the HEAD slice — on a tight budget the anchor used to be sliced
  // away, so the repaired context lost the original task entirely. The cap
  // must split base vs anchor and always keep the anchor tail verbatim.
  it("never caps away the task anchor on the last message", () => {
    const anchored = appendTaskAnchor([{ role: "user", content: "q".repeat(2000) }], "the original task text that must never vanish");
    const out = fitMessagesToBudget(anchored, 300);
    expect(out[0].content).toContain("[ORIGINAL TASK");
    expect(out[0].content).toContain("the original task text that must never vanish");
    // The base was still capped (the marker proves the cut happened).
    expect(out[0].content).toContain("TOOL OUTPUT SHORTENED");
  });

  // The ordering bug this pins: callModel used to run
  //   let fitted = fitMessagesToBudget(anchored);            // default ~16k budget
  //   const MSG_BUDGET_TOKENS = msgBudgetFor(realWindow);   // resolved AFTER
  // and only overwrite `fitted` when compaction returned a result. Whenever
  // compaction declined (transcript under 0.8 of the real, much larger budget)
  // the ~16k default survived, so a 1M-window model was truncated to 16k of
  // history by LOSSY truncation rather than summarized.
  it("keeps a large-window transcript whole when the real budget is passed", () => {
    const fallbackBudget = 16_000; // msgBudgetFor(FALLBACK_CONTEXT_TOKENS = 32k)
    const realBudget = 500_000; // a 1M-context model at the 0.5 ratio

    // fitMessagesToBudget always caps each non-final message at OLDER_CAP
    // (800 tokens); the budget argument only decides how many whole messages
    // get DROPPED. So the fixture needs enough messages that the post-cap total
    // still clears the 16k fallback: 40 messages -> 39*800 + 3000 ~= 34k.
    const msgs = Array.from({ length: 40 }, (_, i) => ({
      role: i % 2 ? "assistant" : "user",
      content: `msg-${i} ${"q".repeat(12_000)}`, // 3000 tokens each
    }));

    // Real budget: over the fallback threshold, well under the real one, and no
    // message may be dropped.
    const out = fitMessagesToBudget(msgs, realBudget);
    expect(out.length).toBe(msgs.length);

    // Stale fallback default: whole turns are dropped. That is the regression -
    // losing a turn entirely is not the same as capping it.
    const squeezed = fitMessagesToBudget(msgs, fallbackBudget);
    expect(squeezed.length).toBeLessThan(msgs.length);
  });
});
