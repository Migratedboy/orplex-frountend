/**
 * preview-logic.ts — pure helpers of the native preview / agent browser.
 *
 * Extracted verbatim from electron/main.ts (the REAL-BROWSER PREVIEW block):
 * these are the decision functions behind the preview:* and agent-browser:*
 * IPC lanes, split out so they are unit-testable without an Electron runtime.
 * State (view maps, console/network rings, agent tab bookkeeping) and all
 * WebContentsView wiring live in preview-views.ts; main.ts keeps window
 * ownership and the IPC origin guard.
 */

/** Cap on agent-owned tabs (agent-browser:tabs "new" refuses beyond this). */
export const MAX_AGENT_TABS = 4;

/** Named viewports for agent-browser:screenshot-advanced (typo-compatible:
 * the IPC arg is "viewpoint" — kept verbatim). */
export const AGENT_VIEWPORTS: Record<string, { width: number; height: number }> = {
  desktop: { width: 1280, height: 720 },
  tablet: { width: 768, height: 1024 },
  mobile: { width: 390, height: 844 },
};

/** The clamp math of applyBounds: no negative origins, never a 0-sized view. */
export function computeBounds(rect: { x: number; y: number; width: number; height: number }): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  return {
    x: Math.max(0, Math.round(rect.x)),
    y: Math.max(0, Math.round(rect.y)),
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height)),
  };
}

/** One console-message entry for the agent's observation ring buffer.
 * Electron ≥32 passes a single MessageDetails object. */
export function formatConsoleLine(details: any): { level: string; text: string } {
  const level = String(details?.level ?? "log");
  const line = details?.lineNumber != null ? `:${details.lineNumber}` : "";
  const src = details?.sourceId ? ` (${String(details.sourceId).split("/").pop()}${line})` : "";
  return { level, text: `${details?.message ?? ""}${src}` };
}

/**
 * normalizePreviewUrl — what the address bar input means.
 * Full URLs pass through; bare hosts get https (http for localhost);
 * anything URL-ish-but-not-a-URL becomes a real Google search (the agent
 * browser is a genuine Chromium client, so Google serves the genuine UI).
 * Returns null when nothing sensible can be done.
 */
export function normalizePreviewUrl(raw: string): string | null {
  const trimmed = (raw || "").trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  // Localhost must branch BEFORE the dotted-host pattern: "localhost:3000"
  // has no dot, so the dotted check would miss it and it would fall through
  // to the search catch-all (which rejects ":"). v2's omnibox sends raw
  // input here (DECISIONS D3), so this must be real (ARCHITECTURE §2).
  if (/^localhost(:\d+)?(\/|$)/i.test(trimmed)) {
    return `http://${trimmed}`;
  }
  // Bare host/localhost/URL-ish input gets https:// (http for localhost)
  if (/^[\w-]+(\.[\w-]+)+(\/|$|:\d)/.test(trimmed)) {
    return /^localhost(:|\/|$)/i.test(trimmed) ? `http://${trimmed}` : `https://${trimmed}`;
  }
  // Not URL-shaped → treat as a web search.
  if (/^[\w\s+.-]{2,120}$/.test(trimmed)) {
    return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
  }
  return null;
}

/** Resolve a browser_find ref ("e3") against a find snapshot. Returns the
 * stored selector, or an error the agent can act on (stale/unknown ref). */
export function resolveRefFromSnapshot(
  snapshot: Array<{ selector: string; description: string }> | null,
  ref: string
): { selector?: string; error?: string } {
  if (!snapshot) return { error: `ref ${ref} is stale — run browser_find again (no find snapshot)` };
  const idx = parseInt(ref.replace(/^e/i, ""), 10) - 1;
  if (!Number.isInteger(idx) || idx < 0 || idx >= snapshot.length) {
    return { error: `unknown ref ${ref} — run browser_find again` };
  }
  return { selector: snapshot[idx].selector };
}

/** The agent-browser:find filter pipeline: role filter, text/selector needle,
 * hard cap of 40 matches (the ref space the agent sees). */
export function filterFindMatches(
  raw: Array<{ role: string; name: string; selector: string; enabled: boolean }>,
  filter: { text?: string; role?: string } = {}
): Array<{ role: string; name: string; selector: string; enabled: boolean }> {
  const needle = (filter.text || "").toLowerCase();
  return raw
    .filter((c) => (filter.role ? c.role === filter.role : true))
    .filter((c) =>
      needle
        ? (c.name || "").toLowerCase().includes(needle) || c.selector.toLowerCase().includes(needle)
        : true
    )
    .slice(0, 40);
}

/** wait-for's fixed-delay clamp (no "time" arg → 1s; bounded 100ms..10s). */
export function clampFixedDelayMs(time: unknown): number {
  return Math.min(Math.max(Number(time) || 1000, 100), 10000);
}

/** wait-for's timeout clamp (default 10s; bounded 500ms..15s). */
export function clampWaitTimeoutMs(timeoutMs: unknown): number {
  return Math.min(Math.max(Number(timeoutMs) || 10000, 500), 15000);
}

/**
 * Navigation state for the `navigated` emit (Right Panel v2 D15): the
 * renderer's Back/Forward disabled state and omnibox text come from real
 * `did-navigate` events, never local state. Pure reader — preview-views
 * passes it a webContents-like {navigationHistory} pair.
 */
export function navStateOf(navigationHistory: {
  canGoBack(): boolean;
  canGoForward(): boolean;
} | null | undefined): { canGoBack: boolean; canGoForward: boolean } {
  try {
    return {
      canGoBack: !!navigationHistory?.canGoBack?.(),
      canGoForward: !!navigationHistory?.canGoForward?.(),
    };
  } catch {
    return { canGoBack: false, canGoForward: false };
  }
}
