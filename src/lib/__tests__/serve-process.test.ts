// serve-process.test.ts — the pure process helpers extracted from
// /api/agent/serve. Pins: declare-port detection, the real-TCP readiness
// probe (binds an actual server), and the platform split of treeKill
// (win32 → taskkill tree-kill; POSIX → process-group kill with fallback).

import { execFile } from "node:child_process";
import net from "node:net";
import { detectPort, treeKill, waitUntilListening } from "../serve-process";

jest.mock("node:child_process", () => ({
  execFile: jest.fn((_cmd: string, _args: string[], cb: (err: Error | null) => void) => {
    process.nextTick(() => cb(null));
    return undefined;
  }),
}));

const mockedExecFile = execFile as unknown as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
});

describe("detectPort", () => {
  it("detects the declared listener in its real phrasings", () => {
    expect(detectPort("npx serve -l 3001")).toBe(3001);
    expect(detectPort("python -m http.server 8000")).toBe(8000);
    expect(detectPort("vite --port 5173")).toBe(5173);
    expect(detectPort("python3 -m http.server 8080")).toBe(8080);
  });

  it("rejects impossible ports instead of returning them", () => {
    // out of range → pattern bounds say {2,5} digits; 99999 has 5 digits but
    // must still be eliminated by the 1..65535 guard
    expect(detectPort("serve -p 99999")).toBeNull();
    expect(detectPort("serve -p 0")).toBeNull();
  });

  it("returns null when nothing looks like a port", () => {
    expect(detectPort("npm run build")).toBeNull();
    expect(detectPort("")).toBeNull();
    expect(detectPort("serve port")).toBeNull();
  });
});

describe("waitUntilListening", () => {
  it("reports true against a real listening server", async () => {
    const server = net.createServer(() => {});
    const address = await new Promise<{ port: number }>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve(server.address() as { port: number }));
    });
    try {
      expect(await waitUntilListening(address.port, 5_000)).toBe(true);
    } finally {
      server.close();
    }
  }, 15_000);

  it("reports false against a definitely-closed port", async () => {
    // Port 1 (tcpmux) is never opened on the test machine.
    expect(await waitUntilListening(1, 400)).toBe(false);
  }, 15_000);
});

describe("treeKill — platform split", () => {
  const originalPlatform = process.platform;
  const setPlatform = (p: string) =>
    Object.defineProperty(process, "platform", { value: p });

  afterEach(() => setPlatform(originalPlatform));

  it("uses taskkill /PID <pid> /T /F on Windows", async () => {
    setPlatform("win32");
    await treeKill(4242);
    expect(mockedExecFile).toHaveBeenCalledTimes(1);
    expect(mockedExecFile.mock.calls[0][0]).toBe("taskkill");
    expect(mockedExecFile.mock.calls[0][1]).toEqual(["/PID", "4242", "/T", "/F"]);
    // Callback-style: the promise resolves even when taskkill fails.
    const cb = mockedExecFile.mock.calls[0][2] as (err: Error | null) => void;
    await expect(treeKill(7)).resolves.toBeUndefined();
    cb(new Error("nope"));
  });

  it("kills the process GROUP on POSIX, falling back to the pid directly", async () => {
    setPlatform("linux");
    const killMock = jest
      .spyOn(process, "kill")
      .mockImplementation(() => true)
      .mockImplementationOnce(() => {
        throw new Error("group gone");
      });
    try {
      await treeKill(5150);
      expect(killMock.mock.calls[0]).toEqual([-5150, "SIGKILL"]);
      expect(killMock.mock.calls[1]).toEqual([5150, "SIGKILL"]);
    } finally {
      killMock.mockRestore();
    }
  });

  it("survives both POSIX kills failing (already-dead pid)", async () => {
    setPlatform("linux");
    const killMock = jest
      .spyOn(process, "kill")
      .mockImplementation(() => {
        throw new Error("ESRCH");
      });
    try {
      await expect(treeKill(1)).resolves.toBeUndefined();
      expect(killMock).toHaveBeenCalledTimes(2);
    } finally {
      killMock.mockRestore();
    }
  });
});
