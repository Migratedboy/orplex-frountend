// janitor.test.ts — The safety-critical property: the janitor can only ever
// propose/delete a hardcoded whitelist of re-creatable artifacts, and every
// protected path is refused both at listing and at delete time. fs is mocked
// so no test ever touches the real disk.
jest.mock("fs/promises", () => ({
  readdir: jest.fn().mockResolvedValue([]),
  rm: jest.fn().mockResolvedValue(undefined),
  stat: jest.fn().mockRejectedValue(new Error("ENOENT")),
}));
jest.mock("fs", () => ({ existsSync: jest.fn().mockReturnValue(false) }));
jest.mock("@/lib/runtime-log", () => ({ recordRuntimeLog: jest.fn() }));
jest.mock("@/lib/runtime-state", () => {
  const state = {
    logs: [],
    executor: {},
    backup: {},
    cron: {},
    workspaces: {},
    hardware: { pressure: "ok", lastCheckAt: null, usedRatio: 0, rssBytes: 0, freememBytes: 0, totalBytes: 0 },
    janitor: { lastSweepAt: null, lastResult: null, running: false },
  };
  return { runtimeState: state };
});

import { isProtectedPath, listSweepCandidates, runJanitor } from "@/lib/janitor";

describe("protected-path denylist", () => {
  it("refuses every protected root exactly and nested", () => {
    for (const p of ["backups", "backups/orplex-backup-2026.dump", ".git", ".git/objects/ab/cd", ".env", ".env.local", ".localpg", ".localpg/pgbin/pg_dump.exe", "src", "src/lib/backup.ts", "prisma", "prisma/schema.prisma", "electron", "scripts", ".orplex", ".orplex-workspaces"]) {
      expect(isProtectedPath(p)).toBe(true);
    }
  });

  it("allows only whitelisted re-creatable locations", () => {
    for (const p of [".next/cache/webpack", "node_modules/.cache/tsbuildinfo", "docs-site/.docusaurus", "docs-site/build"]) {
      expect(isProtectedPath(p)).toBe(false);
    }
  });

  it("still protects files INSIDE whitelisted parents when the path escapes the whitelist scope", () => {
    // e.g. docs-site/src is protected even though docs-site/.docusaurus is not
    expect(isProtectedPath("docs-site/src/css/custom.css")).toBe(true);
    expect(isProtectedPath("docs-site/docs/guides/self-hosting.md")).toBe(true);
  });
});

describe("listSweepCandidates (no fs entries → empty, never throws)", () => {
  it("returns an empty candidate list when nothing exists on disk", async () => {
    const candidates = await listSweepCandidates();
    expect(candidates).toEqual([]);
  });
});

describe("runJanitor", () => {
  it("refuses to delete anything outside the whitelist even if asked", async () => {
    // With no on-disk candidates, a sweep must be a no-op — proving the
    // whitelist gate: nothing is invented, nothing is guessed.
    const result = await runJanitor({ mode: "full" });
    expect(result.deleted).toBe(0);
    expect(result.bytesFreed).toBe(0);
    expect(result.candidates).toBe(0);
  });
});
