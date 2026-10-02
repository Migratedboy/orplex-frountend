import {
  deriveMemories,
  formatMemoriesForPrompt,
  type CaptureInput,
} from "../workspace-memory";

const base: CaptureInput = {
  workspaceKey: "test-ws",
  task: "Build a Next.js settings page",
  writtenFiles: {
    "app/settings/page.tsx": 'import { useState } from "react";\nimport Link from "next/link";',
    "app/settings/layout.tsx": 'import { metadata } from "../shared";',
    "components/Toggle.tsx": 'import { useState } from "react";',
  },
  lanes: { typecheck: "pass", browser: "pass" },
  finalStatus: "done",
};

describe("deriveMemories", () => {
  it("extracts stack signals from written files", () => {
    const mems = deriveMemories(base);
    const stack = mems.filter((m) => m.kind === "stack").map((m) => m.content);
    expect(stack.some((s) => s.includes("Next.js"))).toBe(true);
    expect(stack.some((s) => s.includes("React"))).toBe(true);
  });

  it("derives pattern memories only from verified runs", () => {
    const unverified = deriveMemories({ ...base, lanes: { typecheck: "skipped", browser: "skipped" } });
    expect(unverified.some((m) => m.kind === "pattern")).toBe(false);
    expect(deriveMemories(base).some((m) => m.kind === "pattern")).toBe(true);
  });

  it("records user rejections as pitfalls", () => {
    const mems = deriveMemories({
      ...base,
      rejectedSuggestions: ["use Redux for this"],
    });
    const pitfall = mems.find((m) => m.kind === "pitfall");
    expect(pitfall?.content).toContain("User rejected");
    expect(pitfall?.content).toContain("use Redux for this");
  });

  it("returns nothing without written files", () => {
    expect(deriveMemories({ ...base, writtenFiles: {} })).toHaveLength(0);
  });

  it("strips control characters from task text", () => {
    const mems = deriveMemories({ ...base, task: "fix\u0000the\u0007bug" });
    for (const m of mems) {
      expect(m.content).not.toMatch(/[\u0000-\u0008]/);
    }
  });
});

describe("formatMemoriesForPrompt", () => {
  it("returns null for empty memory lists", () => {
    expect(formatMemoriesForPrompt([])).toBeNull();
  });

  it("tags pitfalls as AVOID and decisions as USER PREFERENCE", () => {
    const block = formatMemoriesForPrompt([
      { kind: "pitfall", content: "User rejected Redux", score: 2 },
      { kind: "decision", content: "User approved Tailwind", score: 1.5 },
      { kind: "stack", content: "Uses Next.js", score: 1 },
    ]);
    expect(block).toContain("[AVOID] User rejected Redux");
    expect(block).toContain("[USER PREFERENCE] User approved Tailwind");
    expect(block).toContain("[STACK] Uses Next.js");
    expect(block).toContain("evidence-backed observations");
  });
});
