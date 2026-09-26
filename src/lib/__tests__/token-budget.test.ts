import { estimateTokens, fitMessagesToBudget } from "../background-worker";

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
});
