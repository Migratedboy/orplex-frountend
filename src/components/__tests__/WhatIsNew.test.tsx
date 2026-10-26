// WhatIsNew.test.tsx — the release notes must belong to the running build.
//
// The bug this guards: the modal looked the notes up by the PREVIOUS
// version and fell back to a fixed entry, so every update showed the same
// unrelated list ("Starter tasks: open a folder…") no matter what shipped.

import { entryFor, WHATS_NEW } from "../WhatIsNew";

describe("release notes selection", () => {
  it("returns the notes of the running version", () => {
    expect(entryFor("1.0.13")).toEqual(WHATS_NEW["1.0.13"]);
    expect(entryFor("1.0.12")).toEqual(WHATS_NEW["1.0.12"]);
    expect(entryFor("1.0.11")).toEqual(WHATS_NEW["1.0.11"]);
  });

  it("falls back to the newest release that is not newer than the build", () => {
    // 1.0.14 has no notes of its own → the 1.0.13 notes, not the 1.1.0 ones.
    expect(entryFor("1.0.14")).toEqual(WHATS_NEW["1.0.13"]);
    // 1.1.0 is a NEWER line than 1.0.x, so a 1.0.x build must not see it.
    expect(entryFor("1.0.99")).toEqual(WHATS_NEW["1.0.13"]);
    expect(entryFor("1.1.0")).toEqual(WHATS_NEW["1.1.0"]);
  });

  it("never shows notes from a newer release line", () => {
    expect(entryFor("1.0.9")).toEqual(WHATS_NEW["1.0.11"]);
    expect(entryFor("1.0.9").title).not.toEqual(WHATS_NEW["1.1.0"].title);
  });

  it("has notes for the releases that shipped the desktop sign-in fix", () => {
    expect(WHATS_NEW["1.0.11"].title).toMatch(/sign-in/i);
    expect(WHATS_NEW["1.0.12"].title).toMatch(/notes|sign-in/i);
  });
});
