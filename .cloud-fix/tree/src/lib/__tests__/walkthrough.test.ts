// walkthrough.test.ts — The walkthrough is the replay contract between the
// verify session, the executor's evidence preservation, and the drawer's
// player. These tests lock the data shape.

import {
  buildWalkthrough,
  rewriteFramePaths,
  walkthroughToText,
  type Walkthrough,
} from "../walkthrough";

const base = {
  success: false,
  url: "http://localhost:5000/",
  pageTitle: "App",
  httpStatus: 200,
  durationMs: 4200,
  consoleErrors: ["TypeError: x is not a function"],
  consoleWarnings: [],
};

describe("buildWalkthrough", () => {
  it("computes per-step error deltas", () => {
    const wt = buildWalkthrough({
      ...base,
      timeline: [
        { action: "navigate", detail: "http://localhost:5000/", consoleErrorsAtStep: 2, atMs: 300 },
        { action: "click", detail: "#save", consoleErrorsAtStep: 5, atMs: 1200 },
        { action: "screenshot", consoleErrorsAtStep: 5, atMs: 1500 },
      ],
    });
    expect(wt.frames.map((f) => f.newErrors)).toEqual([2, 3, 0]);
    expect(wt.frames.map((f) => f.errorsAtStep)).toEqual([2, 5, 5]);
    expect(wt.frames[0].i).toBe(0);
    expect(wt.frames[2].i).toBe(2);
  });

  it("caps frames at 40 and error lines at 30", () => {
    const many = Array.from({ length: 100 }, (_, i) => ({
      action: "click",
      consoleErrorsAtStep: i,
      atMs: i * 100,
    }));
    const errs = Array.from({ length: 50 }, (_, i) => `e${i}`);
    const wt = buildWalkthrough({ ...base, timeline: many, consoleErrors: errs });
    expect(wt.frames.length).toBe(40);
    expect(wt.consoleErrors.length).toBe(30);
  });

  it("keeps steps without frames (framePath null) and survives a missing timeline", () => {
    const wt = buildWalkthrough({ ...base, timeline: null });
    expect(wt.frames).toEqual([]);
    expect(wt.success).toBe(false);
    const wt2 = buildWalkthrough({
      ...base,
      timeline: [{ action: "wait", consoleErrorsAtStep: 0, atMs: 0 }],
    });
    expect(wt2.frames[0].framePath).toBeNull();
  });

  it("truncates over-long details", () => {
    const wt = buildWalkthrough({
      ...base,
      timeline: [{ action: "type", detail: "x".repeat(1000), consoleErrorsAtStep: 0, atMs: 0 }],
    });
    expect((wt.frames[0].detail || "").length).toBe(300);
  });
});

describe("rewriteFramePaths", () => {
  it("rewrites preserved frames and sets framesPreserved", () => {
    const wt = buildWalkthrough({
      ...base,
      timeline: [
        { action: "navigate", screenshotPath: "/tmp/wt/step-1.png", consoleErrorsAtStep: 0, atMs: 0 },
        { action: "click", screenshotPath: "/tmp/wt/step-2.png", consoleErrorsAtStep: 1, atMs: 100 },
      ],
    });
    const out = rewriteFramePaths(wt, (p) => p.replace("/tmp/wt", "/ws/.orplex/verify-evidence"));
    expect(out.framesPreserved).toBe(true);
    expect(out.frames[0].framePath).toBe("/ws/.orplex/verify-evidence/step-1.png");
  });

  it("keeps the original when the mapper returns null (copy failed)", () => {
    const wt = buildWalkthrough({
      ...base,
      timeline: [{ action: "navigate", screenshotPath: "/tmp/wt/step-1.png", consoleErrorsAtStep: 0, atMs: 0 }],
    });
    const out = rewriteFramePaths(wt, () => null);
    expect(out.framesPreserved).toBe(false);
    expect(out.frames[0].framePath).toBe("/tmp/wt/step-1.png");
  });
});

describe("walkthroughToText", () => {
  it("renders a readable transcript with error markers", () => {
    const wt: Walkthrough = buildWalkthrough({
      ...base,
      timeline: [
        { action: "navigate", detail: "http://x/", consoleErrorsAtStep: 0, atMs: 200 },
        { action: "click", detail: "#go", consoleErrorsAtStep: 1, atMs: 1400 },
      ],
    });
    const text = walkthroughToText(wt);
    expect(text).toContain("FAIL");
    expect(text).toContain("0.2s  navigate http://x/");
    expect(text).toContain("1.4s  click #go");
    expect(text).toContain("(+1 console error)");
    expect(text).toContain("TypeError: x is not a function");
  });
});
