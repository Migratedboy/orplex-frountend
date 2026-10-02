// walkthroughNarration — deterministic plain-language session summary.

import { buildWalkthrough, walkthroughNarration, type Walkthrough } from "../walkthrough";

function base(overrides: Partial<Parameters<typeof buildWalkthrough>[0]> = {}) {
  return {
    success: true,
    url: "http://localhost:3000/dashboard",
    pageTitle: "Dashboard",
    durationMs: 4200,
    consoleErrors: [],
    consoleWarnings: [],
    ...overrides,
  };
}

describe("walkthroughNarration", () => {
  test("narrates a clean session: load → interactions → pass", () => {
    const wt = buildWalkthrough(
      base({
        timeline: [
          { action: "navigate", detail: "http://localhost:3000/dashboard", consoleErrorsAtStep: 0, atMs: 0 },
          { action: "click", detail: "button.save", consoleErrorsAtStep: 0, atMs: 1200 },
          { action: "type", detail: "input#name", consoleErrorsAtStep: 0, atMs: 2200 },
          { action: "screenshot", consoleErrorsAtStep: 0, atMs: 4000 },
        ],
      })
    );
    const text = walkthroughNarration(wt);
    expect(text).toContain("localhost:3000/dashboard");
    expect(text).toContain('"Dashboard"');
    expect(text).toContain("click");
    expect(text).toContain("type");
    expect(text).toContain("passed with a clean console");
    expect(text).not.toContain("error");
  });

  test("reports when and where console errors first appeared", () => {
    const wt = buildWalkthrough(
      base({
        success: false,
        durationMs: 5000,
        consoleErrors: ["TypeError: x is not a function"],
        timeline: [
          { action: "navigate", detail: "http://localhost:3000/", consoleErrorsAtStep: 0, atMs: 0 },
          { action: "click", detail: "#submit", consoleErrorsAtStep: 2, atMs: 1800 },
          { action: "screenshot", consoleErrorsAtStep: 3, atMs: 4800 },
        ],
      })
    );
    const text = walkthroughNarration(wt);
    expect(text).toContain("3 console errors");
    expect(text).toContain("1.8s");
    expect(text).toContain("failed");
  });

  test("narrates non-200 HTTP status", () => {
    const wt = buildWalkthrough(base({ httpStatus: 500, timeline: [] }));
    expect(walkthroughNarration(wt)).toContain("HTTP 500");
  });

  test("single interaction reads naturally (was performed)", () => {
    const wt = buildWalkthrough(
      base({
        timeline: [
          { action: "navigate", detail: "http://x.test/", consoleErrorsAtStep: 0, atMs: 0 },
          { action: "click", detail: "#go", consoleErrorsAtStep: 0, atMs: 900 },
        ],
      })
    );
    expect(walkthroughNarration(wt)).toContain("was performed");
  });

  test("narration survives a malformed walkthrough without throwing", () => {
    const broken = { frames: undefined } as unknown as Walkthrough;
    expect(() => walkthroughNarration(broken)).not.toThrow();
  });
});
