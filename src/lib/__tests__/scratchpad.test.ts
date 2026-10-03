// scratchpad.test.ts — state ops, budget caps, truncation order, rendering.
import {
  createScratchpad,
  seedScratchpad,
  isScratchpadEmpty,
  updateScratchpadSection,
  renderScratchpadBlock,
  SCRATCHPAD_MAX_CHARS,
} from "../scratchpad";

describe("scratchpad state", () => {
  it("starts empty and renders nothing (zero tokens until used)", () => {
    const s = createScratchpad();
    expect(isScratchpadEmpty(s)).toBe(true);
    expect(renderScratchpadBlock(s)).toBe("");
  });

  it("seed scaffolds plan + next move", () => {
    const s = seedScratchpad("rebuild the auth flow");
    expect(isScratchpadEmpty(s)).toBe(false);
    expect(s.plan).toContain("rebuild the auth flow");
    expect(s.next.length).toBeGreaterThan(0);
    expect(renderScratchpadBlock(s)).toContain("<scratchpad>");
  });

  it("updates one section and stamps the turn", () => {
    let s = createScratchpad();
    s = updateScratchpadSection(s, "findings", "login route 500s on null user", 3);
    expect(s.findings).toContain("500s");
    expect(s.updatedAtTurn).toBe(3);
    expect(s.plan).toBe("");
  });

  it("caps a single oversized write", () => {
    let s = createScratchpad();
    s = updateScratchpadSection(s, "plan", "x".repeat(SCRATCHPAD_MAX_CHARS + 500), 1);
    const total = s.plan.length + s.hypotheses.length + s.findings.length + s.next.length;
    expect(total).toBeLessThanOrEqual(SCRATCHPAD_MAX_CHARS);
  });

  it("drops oldest findings lines first under pressure", () => {
    let s = createScratchpad();
    const old = Array.from({ length: 30 }, (_, i) => `old-finding-${i}`).join("\n");
    s = updateScratchpadSection(s, "findings", old, 1);
    s = updateScratchpadSection(s, "plan", "y".repeat(1200), 2);
    expect(s.findings).not.toContain("old-finding-0");
    const total = s.plan.length + s.hypotheses.length + s.findings.length + s.next.length;
    expect(total).toBeLessThanOrEqual(SCRATCHPAD_MAX_CHARS);
  });

  it("renders only non-empty sections", () => {
    let s = createScratchpad();
    s = updateScratchpadSection(s, "next", "run typecheck", 1);
    const block = renderScratchpadBlock(s);
    expect(block).toContain("next: run typecheck");
    expect(block).not.toContain("plan:");
    expect(block).not.toContain("hypotheses:");
  });
});
