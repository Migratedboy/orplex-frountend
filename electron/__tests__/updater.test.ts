// updater.test.ts — the app updates itself (electron/).
//
// The behaviour this guards: a newer version is downloaded in the background
// and the app restarts into it, so the new build replaces the old one
// without the user touching anything. "Later" (or agent runs in flight)
// postpones the restart but never loses the update.

import { EventEmitter } from "events";

type Handler = (...args: unknown[]) => void;

class FakeUpdater extends EventEmitter {
  autoDownload = false;
  autoInstallOnAppQuit = false;
  allowDowngrade = true;
  logger: unknown = null;
  downloadUpdate = jest.fn(async () => {});
  quitAndInstall = jest.fn();
  checkForUpdates = jest.fn(
    async (): Promise<{ updateInfo: { version: string; releaseNotes?: string } }> => ({
      updateInfo: { version: "9.9.9", releaseNotes: "notes" },
    })
  );
}

const fake = new FakeUpdater();

jest.mock("electron", () => ({
  app: { getVersion: () => "1.0.13" },
  BrowserWindow: class {},
  powerMonitor: { on: () => {} },
}));

jest.mock("electron-updater", () => ({ autoUpdater: fake }));

jest.mock("../dev-mode", () => ({ isPackagedRuntime: () => true }));

const sendStatus = jest.fn();

async function loadUpdater() {
  jest.resetModules();
  return await import("../updater");
}

beforeEach(() => {
  fake.removeAllListeners();
  fake.autoDownload = false;
  fake.autoInstallOnAppQuit = false;
  fake.allowDowngrade = true;
  fake.downloadUpdate.mockClear();
  fake.quitAndInstall.mockClear();
  fake.checkForUpdates = jest.fn(async (): Promise<{ updateInfo: { version: string; releaseNotes?: string } }> => ({
    updateInfo: { version: "9.9.9", releaseNotes: "notes" },
  }));
  sendStatus.mockClear();
});

describe("auto update", () => {
  it("downloads in the background and installs on quit", async () => {
    const upd = await loadUpdater();
    const status = await upd.checkForUpdates(() => ({ webContents: { send: sendStatus } }) as never);

    expect(status.state).toBe("available");
    expect(fake.autoDownload).toBe(true);
    expect(fake.autoInstallOnAppQuit).toBe(true);
  });

  it("installs and relaunches once the download finished", async () => {
    jest.useFakeTimers();
    try {
      const upd = await loadUpdater();
      await upd.checkForUpdates(() => ({ webContents: { send: sendStatus } }) as never);

      fake.emit("update-downloaded", { version: "9.9.9" });
      expect(sendStatus).toHaveBeenCalledWith(
        "orplex:update-status",
        expect.objectContaining({ state: "downloaded", version: "9.9.9" })
      );

      await jest.advanceTimersByTimeAsync(15_000);
      expect(fake.quitAndInstall).toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it("postpones the restart on request but keeps the update on disk", async () => {
    jest.useFakeTimers();
    try {
      const upd = await loadUpdater();
      await upd.checkForUpdates(() => ({ webContents: { send: sendStatus } }) as never);
      fake.emit("update-downloaded", { version: "9.9.9" });

      upd.deferAutoInstall("9.9.9");
      await jest.advanceTimersByTimeAsync(60_000);
      expect(fake.quitAndInstall).not.toHaveBeenCalled();
      // autoInstallOnAppQuit stays on: the build is applied when the user quits.
      expect(fake.autoInstallOnAppQuit).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it("re-arms the restart when the blocker is gone", async () => {
    jest.useFakeTimers();
    try {
      const upd = await loadUpdater();
      await upd.checkForUpdates(() => ({ webContents: { send: sendStatus } }) as never);
      fake.emit("update-downloaded", { version: "9.9.9" });
      upd.deferAutoInstall("9.9.9");
      await jest.advanceTimersByTimeAsync(60_000);
      expect(fake.quitAndInstall).not.toHaveBeenCalled();

      upd.armAutoInstall(() => ({ webContents: { send: sendStatus } }) as never);
      await jest.advanceTimersByTimeAsync(15_000);
      expect(fake.quitAndInstall).toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it("ignores a feed that is not newer than the running build", async () => {
    const upd = await loadUpdater();
    fake.checkForUpdates = jest.fn(async () => ({ updateInfo: { version: "1.0.1" } }));
    const status = await upd.checkForUpdates(() => ({ webContents: { send: sendStatus } }) as never);
    expect(status.state).toBe("idle");
  });
});

export type { Handler };
