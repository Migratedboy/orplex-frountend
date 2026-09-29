/**
 * project-menu.test.ts — the context menu's pure rules: item list/enablement
 * per project state (desktop vs browser, ghost vs real), viewport clamping,
 * and the two-step destructive confirm state machine.
 */
import { buildProjectMenu, clampMenuPosition, nextConfirmState, MENU_SIZE } from "../project-menu";

describe("buildProjectMenu", () => {
  it("omits Reveal entirely without the desktop bridge (browser build)", () => {
    const items = buildProjectMenu({ canReveal: true, isGhost: false, isActive: false, hasDesktopBridge: false });
    expect(items.map((i) => i.id)).toEqual(["rename", "remove", "remove-and-delete"]);
  });

  it("enables Reveal for a real project inside Electron", () => {
    const items = buildProjectMenu({ canReveal: true, isGhost: false, isActive: false, hasDesktopBridge: true });
    const reveal = items.find((i) => i.id === "reveal")!;
    expect(reveal.enabled).toBe(true);
  });

  it("keeps Reveal visible but inert with a reason for ghosts/unknown paths", () => {
    const ghost = buildProjectMenu({ canReveal: false, isGhost: true, isActive: false, hasDesktopBridge: true });
    const reveal = ghost.find((i) => i.id === "reveal")!;
    expect(reveal.enabled).toBe(false);
    expect(reveal.reason).toContain("not opened on this device");

    const unknown = buildProjectMenu({ canReveal: false, isGhost: false, isActive: false, hasDesktopBridge: true });
    expect(unknown.find((i) => i.id === "reveal")!.reason).toContain("path unknown");
  });

  it("always offers Rename, Remove, and Remove & delete", () => {
    const items = buildProjectMenu({ canReveal: false, isGhost: true, isActive: false, hasDesktopBridge: false });
    for (const id of ["rename", "remove", "remove-and-delete"] as const) {
      expect(items.find((i) => i.id === id)?.enabled).toBe(true);
    }
  });

  it("labels the destructive item for the active project", () => {
    const items = buildProjectMenu({ canReveal: false, isGhost: false, isActive: true, hasDesktopBridge: false });
    expect(items.find((i) => i.id === "remove-and-delete")!.label).toContain("active project");
  });
});

describe("clampMenuPosition", () => {
  it("keeps a comfortable mid-screen anchor as-is", () => {
    expect(clampMenuPosition({ x: 300, y: 300 }, { width: 1000, height: 800 })).toEqual({ x: 300, y: 300 });
  });

  it("pulls the menu inside the right/bottom edges", () => {
    const pos = clampMenuPosition({ x: 990, y: 790 }, { width: 1000, height: 800 });
    expect(pos.x).toBe(1000 - MENU_SIZE.width - MENU_SIZE.margin);
    expect(pos.y).toBe(800 - MENU_SIZE.height - MENU_SIZE.margin);
  });

  it("never goes negative on tiny viewports (clamps to the margin)", () => {
    const pos = clampMenuPosition({ x: 2, y: 1 }, { width: 150, height: 100 });
    expect(pos.x).toBe(MENU_SIZE.margin);
    expect(pos.y).toBe(MENU_SIZE.margin);
  });
});

describe("nextConfirmState (two-step destructive confirm)", () => {
  it("arms on the first destructive click", () => {
    expect(nextConfirmState("idle", "remove-and-delete")).toBe("armed");
  });

  it("executes on the second consecutive destructive click", () => {
    expect(nextConfirmState("armed", "remove-and-delete")).toBe("executed");
  });

  it("disarms on other items, click-away, Esc, and re-right-click", () => {
    expect(nextConfirmState("armed", "other")).toBe("idle");
    expect(nextConfirmState("armed", "dismiss")).toBe("idle");
    expect(nextConfirmState("idle", "other")).toBe("idle");
    expect(nextConfirmState("idle", "dismiss")).toBe("idle");
  });
});
