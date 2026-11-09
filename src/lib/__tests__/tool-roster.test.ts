/**
 * tool-roster.test.ts — regression guard against registry drift (Operation
 * Zero Failure, REGRESSION-STRATEGY §Tool registry).
 *
 * The system prompt's tool roster is GENERATED from M3_TOOL_DEFINITIONS, so
 * it cannot silently omit a tool — but only while buildToolRoster keeps
 * consuming the registry. These tests pin that contract: every registered
 * tool appears in the roster, the rendered count matches the registry
 * length, and the compact (groq/nvidia) tier is a strict subset of the
 * roster so awareness never exceeds executable schemas.
 */
import { M3_TOOL_DEFINITIONS, LEAN_TOOL_NAMES, usesCompactTools } from "../tool-definitions";
import { buildToolRoster } from "../master-prompt";

const registryNames = M3_TOOL_DEFINITIONS.map((d: { function?: { name?: string } }) => d.function?.name ?? "").filter(Boolean);

describe("tool roster consistency — prompt can never drift from the registry", () => {
  it("renders every registered tool name", () => {
    const roster = buildToolRoster();
    for (const name of registryNames) {
      expect(roster).toContain(name);
    }
  });

  it("renders the registry count as the headline number", () => {
    const roster = buildToolRoster();
    expect(roster.startsWith(`${registryNames.length} tools:`)).toBe(true);
  });

  it("renders a lane-specific set exactly when names are supplied", () => {
    const subset = registryNames.slice(0, 5);
    const roster = buildToolRoster(subset);
    expect(roster.startsWith("5 tools:")).toBe(true);
    for (const name of subset) expect(roster).toContain(name);
  });

  it("compact tier is a strict subset of the registry", () => {
    for (const name of LEAN_TOOL_NAMES) {
      expect(registryNames).toContain(name);
    }
    expect(LEAN_TOOL_NAMES.length).toBeLessThan(registryNames.length);
  });

  it("compact-tier classification matches the provider lists", () => {
    expect(usesCompactTools("nvidia")).toBe(true);
    expect(usesCompactTools("nvidia")).toBe(true);
    expect(usesCompactTools("openai")).toBe(false);
    expect(usesCompactTools("anthropic")).toBe(false);
    expect(usesCompactTools("openrouter")).toBe(false);
  });
});
