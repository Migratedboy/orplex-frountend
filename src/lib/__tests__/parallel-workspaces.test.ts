// Regression tests for the parallel-workspaces Windows fix: the worktree
// parent directory must be created with the fs API (mkdir recursive), never
// through a Unix-only `mkdir -p` shell command.
// The worktree path uses execFileSync (argv array, no shell) so a path with
// spaces or shell metacharacters can never be reinterpreted by cmd.exe/sh.
jest.mock("child_process", () => ({ execFileSync: jest.fn(), spawn: jest.fn() }));
jest.mock("fs/promises", () => ({
  mkdir: jest.fn(),
  cp: jest.fn(),
  rm: jest.fn(),
  writeFile: jest.fn(),
  readFile: jest.fn(),
  readdir: jest.fn(),
  stat: jest.fn(),
}));
// Mock these two so the runtime-state singleton stays pristine per test.
jest.mock("@/lib/runtime-log", () => ({ recordRuntimeLog: jest.fn() }));
jest.mock("@/lib/runtime-state", () => ({
  runtimeState: { workspaces: { fallbackCount: 0, lastFallbackAt: null, lastFallbackReason: null } },
}));

import { execFileSync } from "child_process";
import { mkdir, readdir } from "fs/promises";
import { join } from "path";
import { recordRuntimeLog } from "@/lib/runtime-log";
import { runtimeState } from "@/lib/runtime-state";
import { createWorkspace } from "../parallel-workspaces";

const execFileSyncMock = execFileSync as unknown as jest.Mock;
/** Flatten execFileSync("git", ["worktree","add",...]) into one searchable string. */
const gitCalls = () => execFileSyncMock.mock.calls.map((c) => [String(c[0]), ...(c[1] ?? []).map(String)].join(" "));
const mkdirMock = mkdir as unknown as jest.Mock;
const readdirMock = readdir as unknown as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  // Default: git repo present, every git command succeeds.
  execFileSyncMock.mockReturnValue(Buffer.from(""));
  mkdirMock.mockResolvedValue(undefined);
  // Empty project listing keeps the directory-copy fallback trivial.
  readdirMock.mockResolvedValue([]);
});

describe("createWorkspace cross-platform directory creation", () => {
  it("creates the worktree parent with the fs API — no `mkdir -p` shell command", async () => {
    const ws = await createWorkspace("D:\\proj", "run-1");

    expect(mkdirMock).toHaveBeenCalledWith(join("D:\\proj", ".orplex-workspaces"), { recursive: true });
    // The actual regression: no shell command may contain mkdir anymore.
    const shellCommands = gitCalls();
    expect(shellCommands.some((cmd) => cmd.includes("mkdir"))).toBe(false);
    expect(ws.branchName).toMatch(/^agent\/ws-/);
  });

  it("still creates the git worktree inside the parent directory", async () => {
    const ws = await createWorkspace("D:\\proj");

    const worktreeCmd = gitCalls().find((cmd) => cmd.includes("worktree add"));
    expect(worktreeCmd).toContain(ws.workspaceDir);
    expect(ws.workspaceDir).toBe(join("D:\\proj", ".orplex-workspaces", ws.id));
  });

  it("falls back to directory copy when git is unavailable (also fs-based)", async () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error("git not found");
    });

    const ws = await createWorkspace("D:\\proj");

    expect(ws.branchName).toBeUndefined();
    expect(mkdirMock).toHaveBeenCalledWith(join("D:\\proj", ".orplex-workspaces", ws.id), { recursive: true });
  });

  it("marks non-git roots as a legitimate copy with the reason (never a fallback)", async () => directModeCheck("copy", "not a git repository"));

  it("marks worktree failures as copy-fallback, increments the metric, and logs loudly", async () => {
    execFileSyncMock.mockImplementation((_file: string, args?: readonly string[]) => {
      if (args?.includes("rev-parse")) return Buffer.from(""); // git repo
      if (args?.includes("worktree")) throw new Error("fatal: worktree add failed");
      return Buffer.from("");
    });

    const ws = await createWorkspace("D:\\proj", "run-9");

    expect(ws.mode).toBe("copy-fallback");
    expect(ws.fallbackReason).toContain("worktree add failed");
    expect(ws.branchName).toBeUndefined();
    expect(runtimeState.workspaces.fallbackCount).toBe(1);
    expect(runtimeState.workspaces.lastFallbackReason).toContain("worktree add failed");
    expect(recordRuntimeLog).toHaveBeenCalledWith("workspace", "warn", expect.stringContaining("degraded to directory copy"));
  });

  it("marks successful worktrees with mode=worktree", async () => {
    const ws = await createWorkspace("D:\\proj");
    expect(ws.mode).toBe("worktree");
  });
});

/** Fresh-module variant of the legitimate-copy check (isolated metric state). */
async function directModeCheck(expectedMode: "copy", expectedReason: string): Promise<void> {
  execFileSyncMock.mockImplementation(() => {
    throw new Error("not a repo");
  });
  const ws = await createWorkspace("D:\\proj");
  expect(ws.mode).toBe(expectedMode);
  expect(ws.fallbackReason).toBe(expectedReason);
  expect(runtimeState.workspaces.fallbackCount).toBe(0);
}
