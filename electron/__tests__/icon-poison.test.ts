// icon-poison.test.ts — regression pins for the Windows taskbar icon poison.
//
// The bug: Electron's Windows toast path self-installs a Start Menu
// "Electron.lnk" carrying the CURRENT app's AUMID. In dev that AUMID is
// tech.orplex.app.dev — the same one our window declares — and the shortcut
// points at the STOCK electron.exe, so the shell resolves the taskbar button
// through it and shows the generic Electron logo / the name "Electron".
// The sweep that deletes it was packaged-only, so the dev taskbar stayed
// poisoned. These tests pin the DETECTION (which targets are poison and,
// just as important, which are NOT) and the SWEEP behaviour (it must delete
// only the poison, must survive a failing read, and must keep going).

import {
  POISON_SHORTCUT_NAME,
  isIconPoisonTarget,
  poisonShortcutPath,
  sweepIconPoison,
} from "../icon-poison";

describe("isIconPoisonTarget — the Start Menu shortcut that poisons the taskbar", () => {
  it("flags the stock dev electron.exe (the real poison we hit)", () => {
    expect(isIconPoisonTarget("D:\\orplex\\node_modules\\electron\\dist\\electron.exe")).toBe(true);
  });

  it("flags it with forward slashes too (path normalization)", () => {
    expect(isIconPoisonTarget("D:/orplex/node_modules/electron/dist/electron.exe")).toBe(true);
  });

  it("flags a stock electron.exe from any node_modules/electron tree", () => {
    expect(isIconPoisonTarget("C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\electron\\dist\\electron.exe")).toBe(true);
  });

  it("does NOT flag the branded dev binary (we run that one)", () => {
    expect(isIconPoisonTarget("D:\\orplex\\node_modules\\electron\\dist\\orplex-dev.exe")).toBe(false);
  });

  it("does NOT flag the installed product", () => {
    expect(isIconPoisonTarget("C:\\Users\\me\\AppData\\Local\\Programs\\orplex-code\\Orplex Code.exe")).toBe(false);
  });

  it("does NOT flag unrelated apps that happen to be called electron-ish", () => {
    expect(isIconPoisonTarget("C:\\Program Files\\Some App\\electron-helper.exe")).toBe(false);
    expect(isIconPoisonTarget("C:\\Program Files\\Some App\\Electron")).toBe(false);
  });

  it("treats an empty/missing target as not poison", () => {
    expect(isIconPoisonTarget(undefined)).toBe(false);
    expect(isIconPoisonTarget(null)).toBe(false);
    expect(isIconPoisonTarget("")).toBe(false);
  });
});

describe("poisonShortcutPath", () => {
  it("points at the Start Menu Programs folder in %APPDATA%", () => {
    const p = poisonShortcutPath("C:\\Users\\me\\AppData\\Roaming", "\\");
    expect(p).toContain("Microsoft");
    expect(p).toContain("Windows");
    expect(p).toContain("Start Menu");
    expect(p).toContain("Programs");
    expect(p.endsWith(POISON_SHORTCUT_NAME)).toBe(true);
  });

  it("uses the given separator", () => {
    const p = poisonShortcutPath("/appdata", "/");
    expect(p.startsWith("/appdata/")).toBe(true);
    expect(p).not.toContain("\\");
  });
});

describe("sweepIconPoison", () => {
  const POISON = "C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Electron.lnk";
  const INSTALLED = "C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Orplex Code.lnk";

  function deps(over: Partial<Parameters<typeof sweepIconPoison>[0]> = {}) {
    const removed: string[] = [];
    const base = {
      candidates: [POISON],
      exists: () => true,
      readTarget: () => "D:\\orplex\\node_modules\\electron\\dist\\electron.exe",
      remove: (p: string) => {
        removed.push(p);
      },
      ...over,
    };
    return { base, removed };
  }

  it("deletes the shortcut when it points at the stock electron.exe", () => {
    const { base, removed } = deps();
    const result = sweepIconPoison(base);
    expect(result.removed).toEqual([POISON]);
    expect(removed).toEqual([POISON]);
  });

  it("keeps a shortcut that points at the installed product", () => {
    const { base, removed } = deps({
      candidates: [INSTALLED],
      readTarget: () => "C:\\Users\\me\\AppData\\Local\\Programs\\orplex-code\\Orplex Code.exe",
    });
    const result = sweepIconPoison(base);
    expect(result.removed).toEqual([]);
    expect(result.kept).toBe(1);
    expect(removed).toHaveLength(0);
  });

  it("removes a poison that is named after the app instead of Electron", () => {
    const renamed = "C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Orplex Code.lnk";
    const { base, removed } = deps({
      candidates: [renamed],
      readTarget: () => "D:\\orplex\\node_modules\\electron\\dist\\electron.exe",
    });
    const result = sweepIconPoison(base);
    expect(result.removed).toEqual([renamed]);
    expect(removed).toEqual([renamed]);
  });

  it("skips candidates that do not exist", () => {
    const { base, removed } = deps({ exists: () => false });
    const result = sweepIconPoison(base);
    expect(result.removed).toEqual([]);
    expect(removed).toHaveLength(0);
  });

  it("survives a failing shortcut read (never throws at the call site)", () => {
    const { base, removed } = deps({
      readTarget: () => {
        throw new Error("shell unavailable");
      },
    });
    const result = sweepIconPoison(base);
    expect(result.removed).toEqual([]);
    expect(result.errors.length).toBe(1);
    expect(removed).toHaveLength(0);
  });

  it("keeps sweeping the remaining candidates after one fails", () => {
    const other = "C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Other.lnk";
    const { base, removed } = deps({
      candidates: [POISON, other],
      readTarget: (p: string) => {
        if (p === POISON) throw new Error("shell unavailable");
        return "D:\\orplex\\node_modules\\electron\\dist\\electron.exe";
      },
    });
    const result = sweepIconPoison(base);
    expect(result.errors.length).toBe(1);
    expect(result.removed).toEqual([other]);
  });
});
