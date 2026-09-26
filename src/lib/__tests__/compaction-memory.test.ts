// compaction-memory.test.ts — Deterministic fact extraction from compaction
// summaries (the auto-capture path; DB capture itself is best-effort).
import { extractEvictionFacts } from "@/lib/compaction-memory";

describe("extractEvictionFacts", () => {
  it("pulls decision- and pitfall-shaped lines", () => {
    const summary = [
      "Context so far:",
      "- Decision: use pnpm workspaces for the monorepo",
      "* avoid jest fake timers for the pacer tests",
      "The user asked for a login page and the agent built it.",
    ].join("\n");

    const facts = extractEvictionFacts(summary);

    expect(facts).toHaveLength(2);
    expect(facts[0]).toContain("pnpm workspaces");
    expect(facts[1]).toContain("fake timers");
  });

  it("caps at 3 facts and skips short/long lines", () => {
    const summary = [
      "- use a",
      `- choose ${"y".repeat(500)}`,
      "- prefer vitest for new tests",
      "- never commit .env files",
      "- avoid raw SQL string concatenation",
      "- use parameterized queries everywhere",
    ].join("\n");

    const facts = extractEvictionFacts(summary);
    expect(facts).toHaveLength(3);
    expect(facts.every((f) => f.length >= 25 && f.length <= 400)).toBe(true);
  });

  it("returns empty for summaries without durable facts", () => {
    expect(extractEvictionFacts("The agent read three files and wrote one.")).toEqual([]);
    expect(extractEvictionFacts("")).toEqual([]);
  });
});
