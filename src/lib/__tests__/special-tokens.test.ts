/**
 * special-tokens.test.ts — model special tokens ("<|minimax|>", "<|tool_call|>",
 * etc.) and truncated fragments never leak into chat text (LIVE-observed:
 * MiniMax M3.1 Flash answers ended with "files.]<|minimax|>[").
 */
import { normalizeThinkingBlocks } from "../stream-reader";

describe("special token stripping", () => {
  it("removes <|minimax|> tail debris from the answer", () => {
    const text = "I'll review the project without making any edits. Let me start by reading the files.]<|minimax|>[";
    const out = normalizeThinkingBlocks(text);
    expect(out).not.toContain("<|");
    expect(out).not.toContain("|>");
    expect(out).toContain("Let me start by reading the files");
  });

  it("removes other provider-style special tokens", () => {
    const text = "answer here <|tool_call|> more text";
    expect(normalizeThinkingBlocks(text)).toBe("answer here  more text");
  });

  it("drops a dangling half-token at the end of a cut-off turn", () => {
    expect(normalizeThinkingBlocks("the answer is incomplete because it cut off <|mi")).toBe(
      "the answer is incomplete because it cut off"
    );
  });

  it("documented tradeoff: a literal <|...|> inside quoted code is stripped", () => {
    // Genuine code containing "<|x|>" (rare inside string literals, e.g.
    // Erlang) is collateral for the model-leak scrub — accepted: model
    // special-token leakage reaches users far more often than code about it.
    expect(normalizeThinkingBlocks("x = '<|x|>'")).toBe("x = ''");
  });

  it("keeps the honest fallback when everything was special tokens", () => {
    const out = normalizeThinkingBlocks("<|minimax|>");
    expect(out).toContain("stopped before producing an answer");
  });
});
