/**
 * useOverlayFreeze.test.ts — the freeze decision seam (spec §2.2): the DOM
 * overlay shows a capturePage snapshot instead of letting the native view
 * paint through, and only once the snapshot exists (never a flash).
 */
import { freezeVisible } from "../hooks/useOverlayFreeze";

describe("freezeVisible", () => {
  it("freezes only when an overlay is open AND a snapshot exists", () => {
    expect(freezeVisible(true, "data:image/png;base64,x")).toBe(true);
    expect(freezeVisible(true, null)).toBe(false);
    expect(freezeVisible(false, "data:image/png;base64,x")).toBe(false);
    expect(freezeVisible(false, null)).toBe(false);
  });
});
