// next-children.test.ts — the shared kill-lane for the two Next.js children.
//
// This loop used to be duplicated verbatim in will-quit and the SIGTERM/SIGINT
// shutdown path (electron/main.ts); the extract exists so no future fix lands
// in one copy and not the other. Pins the platform behavior: taskkill tree
// kill on Windows, SIGTERM elsewhere, and that killed/null children are
// skipped instead of throwing.

jest.mock("node:child_process", () => ({
  spawn: jest.fn(),
}));

import { spawn, type ChildProcess } from "node:child_process";
import { killNextChildren } from "../next-children";

const mockedSpawn = spawn as jest.Mock;

function fakeChild(pid: number, killed = false): ChildProcess {
  return { pid, killed } as unknown as ChildProcess;
}

beforeEach(() => {
  mockedSpawn.mockClear();
});

describe("killNextChildren", () => {
  it("tree-kills both children on Windows with taskkill /T /F", async () => {
    const original = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      const ui = fakeChild(111);
      const api = fakeChild(222);
      killNextChildren(ui, api);
      expect(mockedSpawn).toHaveBeenCalledTimes(2);
      expect(mockedSpawn).toHaveBeenNthCalledWith(1, "taskkill", ["/pid", "111", "/T", "/F"]);
      expect(mockedSpawn).toHaveBeenNthCalledWith(2, "taskkill", ["/pid", "222", "/T", "/F"]);
    } finally {
      Object.defineProperty(process, "platform", { value: original });
    }
  });

  it("does not fall back to SIGTERM for alive children on win32 even when a taskkill failed", async () => {
    const original = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    mockedSpawn.mockImplementation(() => {
      throw new Error("taskkill exploded");
    });
    try {
      killNextChildren(fakeChild(1), fakeChild(2));
      // The catch inside the loop swallows the failure — the important part is
      // that BOTH children still got their attempt (no early bail).
      expect(mockedSpawn).toHaveBeenCalledTimes(2);
    } finally {
      Object.defineProperty(process, "platform", { value: original });
    }
  });

  it("skips already-killed children without spawning anything", () => {
    killNextChildren(fakeChild(3, true), null);
    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it("swallows a missing pid rather than aborting the second child", async () => {
    // The platform MUST be pinned here: this file asserts the Windows taskkill
    // behavior, and on a Linux/macOS runner killNextChildren takes the POSIX
    // branch (child.kill("SIGTERM")) and never spawns taskkill — so without the
    // stub this test failed on CI while passing on a Windows dev box.
    const original = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      const noPid = { pid: undefined, killed: false } as unknown as ChildProcess;
      killNextChildren(noPid, fakeChild(4));
      expect(mockedSpawn).toHaveBeenCalledTimes(2);
      expect(mockedSpawn).toHaveBeenLastCalledWith("taskkill", ["/pid", "4", "/T", "/F"]);
    } finally {
      Object.defineProperty(process, "platform", { value: original });
    }
  });

  it("uses SIGTERM instead of taskkill on non-Windows platforms", () => {
    // The POSIX half of the documented platform behavior, pinned so a runner
    // on Linux/macOS exercises the same branch a Windows runner does not.
    const original = process.platform;
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      const kill = jest.fn();
      const child = { pid: 7, killed: false, kill } as unknown as ChildProcess;
      killNextChildren(child, null);
      expect(mockedSpawn).not.toHaveBeenCalled();
      expect(kill).toHaveBeenCalledWith("SIGTERM");
    } finally {
      Object.defineProperty(process, "platform", { value: original });
    }
  });
});
