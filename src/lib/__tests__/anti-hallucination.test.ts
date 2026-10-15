/**
 * Anti-hallucination regressions.
 *
 * Each of these reproduces a specific way the agent lied to the user:
 *  - the whole reasoning buffer was re-emitted as the visible answer
 *  - an empty workspace reported "[SUCCESS] Listed 1 file(s)"
 *  - the turn wrapper asserted "you have all the information you need"
 *    even when the tool found nothing
 */

import { listFilesUnderPath } from "@/lib/tool-text";

describe("the empty-listing trap that caused the false SUCCESS", () => {
  it("an empty tree yields a one-line sentinel, so a naive count reports 1", () => {
    // This is the trap itself. The production fix compares against this exact
    // sentinel BEFORE counting — a naive split("\n").length reports 1 file
    // for a completely empty workspace.
    const listing = listFilesUnderPath("", []);
    expect(listing.trim()).toBe("No files found at that path.");
    expect(listing.split("\n")).toHaveLength(1);
    expect(listing.split("\n").filter(Boolean)).toHaveLength(1);
  });

  it("the sentinel is the only listing that is not a path", () => {
    const listing = listFilesUnderPath("", []).trim();
    const isSentinel = listing === "No files found at that path.";
    expect(isSentinel).toBe(true);
    // Which is why the status must be [EMPTY], never [SUCCESS] Listed N.
    expect(isSentinel).not.toBe(false);
  });
});

describe("system prompt grounds the model in what it actually received", () => {
  const prompt = require("@/lib/master-prompt") as {
    buildSystemPrompt: (opts: Record<string, unknown>) => Promise<string>;
  };

  it("tells the model that absence is not evidence", async () => {
    const p = await prompt.buildSystemPrompt({ mode: "build" } as never);
    expect(p).toMatch(/ABSENCE IS NOT EVIDENCE/i);
  });

  it("forbids guessing an attachment's contents", async () => {
    const p = await prompt.buildSystemPrompt({ mode: "build" } as never);
    expect(p).toMatch(/NEVER speculate about its contents/i);
    expect(p).toMatch(/I can'?t see the contents of that file/i);
  });

  it("documents the archive block contract", async () => {
    const p = await prompt.buildSystemPrompt({ mode: "build" } as never);
    expect(p).toMatch(/\[ARCHIVE:/);
    expect(p).toMatch(/COULD NOT BE UNPACKED/);
  });

  it("instructs against retrying after empty output", async () => {
    const p = await prompt.buildSystemPrompt({ mode: "build" } as never);
    expect(p).toMatch(/Empty tool output is a fact/i);
  });
});
