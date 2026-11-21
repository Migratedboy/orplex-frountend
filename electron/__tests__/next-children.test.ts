// next-children.test.ts — the shared kill-lane for the two Next.js children.
//
// This loop used to be duplicated verbatim in will-quit and the SIGTERM/SIGINT
// shutdown path (electron/main.ts); the extract exists so no future fix lands
// in one copy and not the other.
//
// The Windows branch is SYNCHRONOUS on purpose: it runs on the way out, right
// before an installer starts replacing files. A fire-and-forget taskkill
// returns while the tree is still alive, so nsinstall could overwrite the exe
// while the old Next server still had .next/standalone mapped — new version
// label, old UI. These tests pin "the call returns only after the tree is
// gone", which is exactly what execFileSync gives us.

jest.mock("node:child_process", () => ({
  spawn: jest.fn(),
  execFileSync: jest.fn(),
}));

import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { killNextChildren, killNextChildrenDetached } from "../next-children";

const mockedSpawn = spawn as jest.Mock;
const mockedExec = execFileSync as jest.Mock;

function fakeChild(pid: number | undefined, killed = false): ChildProcess {
  return { pid, killed, kill: jest.fn() } as unknown as ChildProcess;
}

const onWindows = (fn: () => void | Promise<void>) => async () => {
  const original = process.platform;
  Object.defineProperty(process, "platform", { value: "win32" });
  try {
    await fn();
  } finally {
    Object.defineProperty(process, "platform", { value: original });
  }
};

const onPosix = (fn: () => void | Promise<void>) => async () => {
  const original = process.platform;
  Object.defineProperty(process, "platform", { value: "linux" });
  try {
    await fn();
  } finally {
    Object.defineProperty(process, "platform", { value: original });
  }
};

beforeEach(() => {
  mockedSpawn.mockClear();
  mockedExec.mockClear();
});

describe("killNextChildren (blocking)", () => {
  it(
    "tree-kills both children on Windows with taskkill /T /F, synchronously",
    onWindows(() => {
      killNextChildren(fakeChild(111), fakeChild(222));
      expect(mockedExec).toHaveBeenCalledTimes(2);
      expect(mockedExec).toHaveBeenNthCalledWith(1, "taskkill", ["/pid", "111", "/T", "/F"], expect.objectContaining({ stdio: "ignore" }));
      expect(mockedExec).toHaveBeenNthCalledWith(2, "taskkill", ["/pid", "222", "/T", "/F"], expect.objectContaining({ stdio: "ignore" }));
      // The detached (non-waiting) variant is the one that spawns.
      expect(mockedSpawn).not.toHaveBeenCalled();
    }),
  );

  it(
    "a failed taskkill still signals the child handle and does not abort the loop",
    onWindows(() => {
      mockedExec.mockImplementation(() => {
        throw new Error("taskkill exploded");
      });
      const ui = fakeChild(1);
      const api = fakeChild(2);
      killNextChildren(ui, api);
      expect(mockedExec).toHaveBeenCalledTimes(2);
      expect((ui.kill as jest.Mock)).toHaveBeenCalledWith("SIGKILL");
      expect((api.kill as jest.Mock)).toHaveBeenCalledWith("SIGKILL");
    }),
  );

  it("skips already-killed and pid-less children", onWindows(() => {
    const noPid = fakeChild(undefined);
    killNextChildren(fakeChild(3, true), noPid);
    expect(mockedExec).not.toHaveBeenCalled();
    expect(noPid.kill).not.toHaveBeenCalled();
  }));

  it(
    "uses SIGTERM instead of taskkill on non-Windows platforms",
    onPosix(() => {
      const child = fakeChild(7);
      killNextChildren(child, null);
      expect(mockedExec).not.toHaveBeenCalled();
      expect((child.kill as jest.Mock)).toHaveBeenCalledWith("SIGTERM");
    }),
  );
});

describe("killNextChildrenDetached (non-blocking)", () => {
  it(
    "spawns taskkill on Windows and returns immediately",
    onWindows(() => {
      killNextChildrenDetached(fakeChild(111), fakeChild(222));
      expect(mockedSpawn).toHaveBeenCalledTimes(2);
      expect(mockedSpawn).toHaveBeenNthCalledWith(1, "taskkill", ["/pid", "111", "/T", "/F"]);
      expect(mockedExec).not.toHaveBeenCalled();
    }),
  );

  it(
    "signals with SIGTERM on POSIX",
    onPosix(() => {
      const child = fakeChild(9);
      killNextChildrenDetached(child, null);
      expect(mockedSpawn).not.toHaveBeenCalled();
      expect((child.kill as jest.Mock)).toHaveBeenCalledWith("SIGTERM");
    }),
  );
});
