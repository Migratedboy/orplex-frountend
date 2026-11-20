// preview-extensions.test.ts — the pre-load guard for imported extensions.
//
// Chromium prints an ExtensionLoadWarning for every permission Electron's
// extension loader does not implement, and the extension's background worker
// then dies on its first unimplemented call (chrome.debugger undefined). The
// guard below reads the manifest BEFORE loading so those extensions are
// skipped with a reason instead of spamming stderr every boot.
jest.mock("electron", () => ({
  app: { getPath: jest.fn(() => require("node:os").tmpdir()) },
  dialog: { showOpenDialog: jest.fn(), showMessageBox: jest.fn() },
  BrowserWindow: class {},
  WebContentsView: class {},
  session: { fromPartition: jest.fn(() => ({})) },
  desktopCapturer: { getSources: jest.fn(async () => []) },
}));

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unsupportedPermissions } from "../preview-extras";

describe("unsupportedPermissions", () => {
  let dir = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "orplex-ext-"));
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const manifest = (value: unknown) =>
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(value), "utf8");

  it("reports the declared permissions Electron cannot honour", () => {
    manifest({
      manifest_version: 3,
      permissions: ["storage", "tabs", "debugger", "webNavigation", "contextMenus"],
      optional_permissions: ["tabGroups", "sidePanel"],
    });
    expect(unsupportedPermissions(dir).sort()).toEqual([
      "contextMenus",
      "debugger",
      "sidePanel",
      "tabGroups",
      "webNavigation",
    ]);
  });

  it("returns [] for an extension that only uses supported permissions", () => {
    manifest({ manifest_version: 3, permissions: ["storage", "tabs", "scripting", "activeTab"] });
    expect(unsupportedPermissions(dir)).toEqual([]);
  });

  it("returns [] (no skip) when the manifest is missing or unreadable", () => {
    // Electron's own loadExtension should report the real error in that case.
    expect(unsupportedPermissions(dir)).toEqual([]);
    writeFileSync(join(dir, "manifest.json"), "{ not json", "utf8");
    expect(unsupportedPermissions(dir)).toEqual([]);
  });

  it("ignores non-string permission entries instead of throwing", () => {
    manifest({ manifest_version: 2, permissions: ["windows", 42, null, { x: 1 }] });
    expect(unsupportedPermissions(dir)).toEqual(["windows"]);
  });
});
