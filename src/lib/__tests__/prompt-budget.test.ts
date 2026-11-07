import {
  PLATFORM_PROMPT_BUDGET,
  PLATFORM_TPM_LIMIT,
  messagesTokens,
  promptTokens,
  toolSchemaTokens,
  trimMessagesToTokens,
} from "../prompt-budget";

// Measured live on 2026-11-07 against the platform Groq key (free tier):
//   full payload  → HTTP 413 "Request too large … TPM: Limit 8000, Requested 13636"
//   compact+lean  → HTTP 200
// These numbers are the reason the guard exists.
describe("prompt budget constants", () => {
  it("stays strictly inside the free-tier per-minute ceiling", () => {
    expect(PLATFORM_TPM_LIMIT).toBe(8000);
    expect(PLATFORM_PROMPT_BUDGET).toBe(6400);
    expect(PLATFORM_PROMPT_BUDGET).toBeLessThan(PLATFORM_TPM_LIMIT);
  });
});

describe("promptTokens — what actually goes on the wire", () => {
  it("counts system prompt, history and the tool schema together", () => {
    const system = "x".repeat(400); // 100 tokens
    const tools = [{ type: "function", function: { name: "a".repeat(400) } }]; // ~103
    const messages = [{ role: "user", content: "y".repeat(40) }]; // 10
    const size = promptTokens({ system, messages, tools });
    expect(size).toBe(100 + messagesTokens(messages) + toolSchemaTokens(tools));
    expect(size).toBeGreaterThan(200);
  });

  it("treats a missing/empty roster as free", () => {
    expect(toolSchemaTokens(undefined)).toBe(1); // "[]"
    expect(toolSchemaTokens([])).toBe(1);
  });
});

describe("trimMessagesToTokens — shrink history, never the ask", () => {
  const history = Array.from({ length: 20 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `m${i} ` + "z".repeat(400), // ~100 tokens each
  }));

  it("drops the OLDEST messages until the budget fits", () => {
    const trimmed = trimMessagesToTokens(history, 500);
    expect(trimmed.length).toBeLessThan(history.length);
    expect(messagesTokens(trimmed)).toBeLessThanOrEqual(500);
    expect(trimmed[trimmed.length - 1]).toBe(history[history.length - 1]);
  });

  it("always keeps the newest message, even when the budget is impossible", () => {
    expect(trimMessagesToTokens(history, 1)).toEqual([history[history.length - 1]]);
    expect(trimMessagesToTokens(history, -50)).toEqual([history[history.length - 1]]);
  });

  it("leaves a list that already fits untouched and never mutates the input", () => {
    const small = history.slice(-2);
    const before = JSON.stringify(small);
    expect(trimMessagesToTokens(small, 100_000)).toEqual(small);
    expect(JSON.stringify(small)).toBe(before);
  });
});
