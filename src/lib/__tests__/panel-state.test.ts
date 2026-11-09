/**
 * panel-state.test.ts — pure helpers for the Right Panel v2 tab model:
 * storage parsing, legacy migration (preview → browser), add/close, popover set.
 */
import {
  ALL_TABS,
  addTab,
  closeTab,
  closedTabs,
  defaultTabToOpenTabs,
  legacyTabToOpenTabs,
  normalizeTabId,
  parseOpenTabs,
  serializeOpenTabs,
  toLegacyTabId,
} from "../panel-state";

describe("normalizeTabId", () => {
  it("maps legacy preview → browser", () => {
    expect(normalizeTabId("preview")).toBe("browser");
  });
  it("passes valid ids through", () => {
    expect(normalizeTabId("files")).toBe("files");
    expect(normalizeTabId("scratch")).toBe("scratch");
  });
  it("rejects unknown/garbage values", () => {
    expect(normalizeTabId("nope")).toBeNull();
    expect(normalizeTabId(42)).toBeNull();
    expect(normalizeTabId(null)).toBeNull();
    expect(normalizeTabId(undefined)).toBeNull();
  });
});

describe("parseOpenTabs", () => {
  it("returns null for absent values (fresh install → launcher)", () => {
    expect(parseOpenTabs(null)).toBeNull();
    expect(parseOpenTabs(undefined)).toBeNull();
    expect(parseOpenTabs("")).toBeNull();
  });
  it("returns null for invalid JSON / non-arrays", () => {
    expect(parseOpenTabs("{nope")).toBeNull();
    expect(parseOpenTabs('"files"')).toBeNull();
  });
  it("parses, migrates and de-duplicates", () => {
    expect(parseOpenTabs('["files","preview","preview","files","bogus"]')).toEqual(["files", "browser"]);
  });
  it("round-trips through serializeOpenTabs", () => {
    const list = ["queue", "browser", "terminal"] as const;
    expect(parseOpenTabs(serializeOpenTabs(list as never))).toEqual([...list]);
  });
});

describe("legacy / default-tab migration", () => {
  it("legacy stored tab becomes a 1-element open list", () => {
    expect(legacyTabToOpenTabs("preview")).toEqual(["browser"]);
    expect(legacyTabToOpenTabs("files")).toEqual(["files"]);
    expect(legacyTabToOpenTabs("wat")).toEqual([]);
    expect(legacyTabToOpenTabs(null)).toEqual([]);
  });
  it("default-tab requests map the same way", () => {
    expect(defaultTabToOpenTabs("terminal")).toEqual(["terminal"]);
    expect(defaultTabToOpenTabs("preview")).toEqual(["browser"]);
    expect(defaultTabToOpenTabs(undefined)).toEqual([]);
    expect(defaultTabToOpenTabs("bogus")).toEqual([]);
  });
  it("legacy write-back round-trips banner ids", () => {
    expect(toLegacyTabId("browser")).toBe("preview");
    expect(toLegacyTabId("queue")).toBe("queue");
  });
});

describe("addTab / closeTab", () => {
  it("adds and activates without duplication", () => {
    const r1 = addTab([], "browser");
    expect(r1).toEqual({ openTabs: ["browser"], activeTab: "browser" });
    const r2 = addTab(r1.openTabs, "browser");
    expect(r2.openTabs).toEqual(["browser"]);
    const r3 = addTab(r2.openTabs, "files");
    expect(r3).toEqual({ openTabs: ["browser", "files"], activeTab: "files" });
  });
  it("closing the active tab activates the previous neighbour", () => {
    const r = closeTab(["queue", "browser", "files"], "browser", "browser");
    expect(r).toEqual({ openTabs: ["queue", "files"], activeTab: "queue" });
  });
  it("closing the FIRST tab activates the next one", () => {
    const r = closeTab(["queue", "browser"], "queue", "queue");
    expect(r).toEqual({ openTabs: ["browser"], activeTab: "browser" });
  });
  it("closing a non-active tab keeps the active one", () => {
    const r = closeTab(["queue", "browser"], "queue", "browser");
    expect(r).toEqual({ openTabs: ["queue"], activeTab: "queue" });
  });
  it("closing the last tab leaves no active tab (launcher)", () => {
    const r = closeTab(["queue"], "queue", "queue");
    expect(r).toEqual({ openTabs: [], activeTab: null });
  });
});

describe("closedTabs", () => {
  it("lists what the + popover offers, canonical order", () => {
    expect(closedTabs([])).toEqual(ALL_TABS);
    expect(closedTabs(["queue", "scratch"])).toEqual(["changes", "browser", "terminal", "files"]);
    expect(closedTabs(ALL_TABS)).toEqual([]);
  });
});
