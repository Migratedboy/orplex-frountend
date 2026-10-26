// WhatIsNew.test.tsx — the release notes must belong to the running build.
//
// The bug this guards: the modal looked the notes up by the PREVIOUS
// version and fell back to a fixed entry, so every update showed the same
// unrelated list ("Starter tasks: open a folder…") no matter what shipped.
//
// The expectations are derived from the notes map itself, so adding a new
// release entry never breaks this test.

import { compareVersions, entryFor, WHATS_NEW } from "../WhatIsNew";

const versions = Object.keys(WHATS_NEW).sort(compareVersions);
const newest = versions[versions.length - 1];
const oldest = versions[0];

function patchBump(version: string): string {
  const parts = version.split(".");
  const patch = parseInt(parts[2] ?? "0", 10) + 1;
  return `${parts[0]}.${parts[1]}.${patch}`;
}

describe("release notes selection", () => {
  it("returns the notes of the running version", () => {
    expect(entryFor(newest)).toEqual(WHATS_NEW[newest]);
    for (const v of versions) {
      expect(entryFor(v)).toEqual(WHATS_NEW[v]);
    }
  });

  it("falls back to the newest release that is not newer than the build", () => {
    // A build without notes of its own gets the newest ones it DOES have.
    expect(entryFor(patchBump(newest))).toEqual(WHATS_NEW[newest]);
  });

  it("never shows notes from a newer release line", () => {
    // A build below every known entry falls back to the oldest known notes.
    expect(entryFor("0.9.0")).toEqual(WHATS_NEW[oldest]);
  });

  it("has notes for the releases that shipped the desktop sign-in fix", () => {
    expect(WHATS_NEW["1.0.11"].title).toMatch(/sign-in/i);
    expect(WHATS_NEW["1.0.12"].title).toMatch(/notes|sign-in/i);
    expect(WHATS_NEW["1.0.14"].title).toMatch(/update/i);
  });
});
