// Settings that the UI claims to have. Each of these keys must be read by real
// code — a switch that only writes localStorage is the bug these tests exist to
// stop from coming back.

import { APP_SETTINGS_DEFAULTS, APP_SETTINGS_KEY, readAppSettings, writeAppSettings, sweepAutoArchive } from "@/lib/app-settings";

describe("app-settings", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("falls back to defaults when nothing is stored", () => {
    expect(readAppSettings()).toEqual(APP_SETTINGS_DEFAULTS);
  });

  it("ignores a corrupt blob instead of throwing", () => {
    window.localStorage.setItem(APP_SETTINGS_KEY, "{not json");
    expect(readAppSettings()).toEqual(APP_SETTINGS_DEFAULTS);
  });

  it("drops unknown autoArchive values so the select cannot show a blank", () => {
    window.localStorage.setItem(APP_SETTINGS_KEY, JSON.stringify({ autoArchive: "14", sounds: false }));
    expect(readAppSettings()).toEqual({ sounds: false, autoArchive: "never" });
  });

  it("round-trips a patch and keeps earlier keys", () => {
    writeAppSettings({ autoArchive: "7" });
    writeAppSettings({ sounds: false });
    expect(readAppSettings()).toEqual({ sounds: false, autoArchive: "7" });
  });

  it("announces changes so open settings consumers re-read", () => {
    const seen: unknown[] = [];
    const handler = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener("orplex:setting", handler);
    writeAppSettings({ autoArchive: "1" });
    window.removeEventListener("orplex:setting", handler);
    expect(seen).toEqual([{ autoArchive: "1" }]);
  });

  it("does not sweep when auto-archive is off", () => {
    writeAppSettings({ autoArchive: "never" });
    const old = new Date(Date.now() - 90 * 86_400_000).toISOString();
    expect(sweepAutoArchive([{ id: "a", updatedAt: old }])).toEqual([]);
  });

  it("sweeps only chats older than the configured window", () => {
    writeAppSettings({ autoArchive: "7" });
    const now = Date.now();
    const rows = [
      { id: "old", updatedAt: new Date(now - 8 * 86_400_000).toISOString() },
      { id: "fresh", updatedAt: new Date(now - 2 * 86_400_000).toISOString() },
      { id: "garbage", updatedAt: "not-a-date" },
    ];
    expect(sweepAutoArchive(rows, now)).toEqual(["old"]);
  });
});
