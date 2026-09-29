// project-menu.ts — Pure logic for the per-project context menu. Extracted
// so the node Jest suite pins the rules: viewport-safe positioning, item
// enablement per project state, and the two-step destructive-confirm state
// machine (first click arms, second executes, anything else disarms).

export type ProjectMenuItemId = "rename" | "reveal" | "remove" | "remove-and-delete";

export interface ProjectMenuSpec {
  /** Real folder with a local handle (or the active one). */
  canReveal: boolean;
  /** Roster knows it but this device has no handle. */
  isGhost: boolean;
  /** The project currently attached as the active workspace. */
  isActive: boolean;
  /** Whether the app runs inside the Electron desktop shell. */
  hasDesktopBridge: boolean;
}

export interface ProjectMenuItem {
  id: ProjectMenuItemId;
  label: string;
  enabled: boolean;
  /** Why the item is disabled (tooltip when not enabled). */
  reason?: string;
}

/**
 * Menu item list + enablement for a project's state. Pure.
 * Rules:
 *  - Rename is always available (alias works for ghosts too).
 *  - Reveal needs an Electron bridge AND a captured absolute path; ghosts
 *    without a path show it inert with the reason.
 *  - Remove-from-list is always available.
 *  - Remove & delete threads is available for everything with (or potentially
 *    having) tagged threads — including active projects.
 */
export function buildProjectMenu(spec: ProjectMenuSpec): ProjectMenuItem[] {
  const items: ProjectMenuItem[] = [
    { id: "rename", label: "Rename alias", enabled: true },
  ];
  if (spec.canReveal && spec.hasDesktopBridge) {
    items.push({ id: "reveal", label: "Reveal in Explorer", enabled: true });
  } else if (spec.hasDesktopBridge) {
    items.push({
      id: "reveal",
      label: "Reveal in Explorer",
      enabled: false,
      reason: spec.isGhost ? "Folder not opened on this device yet" : "Folder path unknown",
    });
  }
  // No desktop bridge → Reveal is omitted entirely (graceful degradation).
  items.push({ id: "remove", label: "Remove from list", enabled: true });
  items.push({
    id: "remove-and-delete",
    label: spec.isActive ? "Remove & delete threads (active project)" : "Remove & delete threads",
    enabled: true,
  });
  return items;
}

export interface MenuPosition {
  x: number;
  y: number;
}

export interface ViewportSize {
  width: number;
  height: number;
}

/** Menu dimensions used for clamping (matches the CSS: 200w, ~144h). */
export const MENU_SIZE = { width: 200, height: 144, margin: 8 };

/**
 * Clamp a menu origin so the whole menu stays inside the viewport (with a
 * margin). Pure — the component passes window.innerWidth/innerHeight.
 */
export function clampMenuPosition(anchor: MenuPosition, viewport: ViewportSize): MenuPosition {
  const maxX = Math.max(MENU_SIZE.margin, viewport.width - MENU_SIZE.width - MENU_SIZE.margin);
  const maxY = Math.max(MENU_SIZE.margin, viewport.height - MENU_SIZE.height - MENU_SIZE.margin);
  return {
    x: Math.min(Math.max(anchor.x, MENU_SIZE.margin), maxX),
    y: Math.min(Math.max(anchor.y, MENU_SIZE.margin), maxY),
  };
}

/** The two-step confirm lifecycle for the destructive item. */
export type ConfirmState = "idle" | "armed" | "executed";

/**
 * Advance the confirm state machine.
 *  - idle + trigger on the destructive item → armed (first click)
 *  - armed + trigger on the SAME destructive item → executed (second click)
 *  - armed + trigger on ANYTHING ELSE (other item, click-away, Esc,
 *    re-right-click) → idle (cancels)
 */
export function nextConfirmState(current: ConfirmState, trigger: "remove-and-delete" | "other" | "dismiss"): ConfirmState {
  if (trigger === "other" || trigger === "dismiss") return "idle";
  return current === "armed" ? "executed" : "armed";
}
