/**
 * thinking-normalize.test.ts — The final persisted message must render raw
 * reasoning inside the collapsible ThinkingCard, never as plain answer text.
 * normalizeThinkingBlocks repairs the failure modes that made reasoning leak:
 * markers glued mid-line, unclosed blocks (Stop mid-think), unwrapped
 * deliberation paragraphs, and thinking-only output with no answer.
 */
import { normalizeThinkingBlocks } from "../stream-reader";

describe("normalizeThinkingBlocks — well-formed input passes through", () => {
  it("keeps a closed thinking block followed by the answer", () => {
    const input = "[THINKING]\nLet me plan the layout.\n[/THINKING]\n\nHere is your dashboard.";
    expect(normalizeThinkingBlocks(input)).toBe(input.trim());
  });

  it("leaves output with no thinking at all untouched", () => {
    const input = "Just a plain answer with **bold** text.";
    expect(normalizeThinkingBlocks(input)).toBe(input);
  });
});

describe("normalizeThinkingBlocks — glued markers (the leak)", () => {
  it("repairs a marker glued into the previous line so reasoning renders in the card", () => {
    // This exact shape leaked raw reasoning as answer text before: the UI
    // parser only matches [THINKING] at line starts.
    const input = "Good description into the output code, but we can output the answer after retrieving it. [THINKING]\nWe need to navigate to wikipedia.org\n[/THINKING]\nHere is the result.";
    const out = normalizeThinkingBlocks(input);
    // Every marker now stands on its own line (parser-matchable)
    expect(out).toMatch(/\n\[THINKING\]\n/);
    expect(out).toMatch(/\n\[\/THINKING\]\n/);
    // Reasoning is preserved, not deleted
    expect(out).toContain("We need to navigate to wikipedia.org");
    // And the answer text survives outside the thinking block
    expect(out).toContain("Here is the result.");
  });

  it("repairs a closer glued to the answer text", () => {
    const input = "[THINKING]\nreasoning here[/THINKING]The answer.";
    const out = normalizeThinkingBlocks(input);
    expect(out).toMatch(/\n\[\/THINKING\]\n/);
    expect(out).toContain("The answer.");
  });
});

describe("normalizeThinkingBlocks — unclosed block (Stop mid-think)", () => {
  it("closes a block that runs to the end and notes there was no answer", () => {
    const input = "[THINKING]\nI was still working out the approach when the user stopped me";
    const out = normalizeThinkingBlocks(input);
    expect(out).toContain("[/THINKING]");
    expect(out).toContain("I was still working out the approach");
    expect(out).toContain("stopped before producing an answer");
  });
});

describe("normalizeThinkingBlocks — unwrapped deliberation leak", () => {
  it("wraps a leading deliberation paragraph into a thinking block instead of deleting it", () => {
    const input = "We need to navigate to wikipedia.org first, then search.\n\nHere is your answer: 42.";
    const out = normalizeThinkingBlocks(input);
    expect(out).toMatch(/\[THINKING\]\nWe need to navigate[\s\S]*\[\/THINKING\]/);
    expect(out).toContain("Here is your answer: 42.");
  });

  it("does NOT wrap answer paragraphs that merely start with 'I'", () => {
    const input = "I built the dashboard. It has three charts.";
    expect(normalizeThinkingBlocks(input)).toBe(input);
  });
});

describe("normalizeThinkingBlocks — multiple blocks", () => {
  it("handles several closed blocks across tool turns", () => {
    const input = "[THINKING]\nfirst idea\n[/THINKING]\nWrote the file. [THINKING]\nsecond idea\n[/THINKING]\nDone.";
    const out = normalizeThinkingBlocks(input);
    expect((out.match(/\[THINKING\]/g) || []).length).toBe(2);
    expect((out.match(/\[\/THINKING\]/g) || []).length).toBe(2);
    expect(out).toContain("Wrote the file.");
    expect(out).toContain("Done.");
  });
});
