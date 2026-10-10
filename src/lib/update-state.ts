// update-state.ts — Pure state machine for the in-app updater UI.
// UI-agnostic (no React, no Electron) so it stays unit-testable under node.
// The hook (useAppUpdater) feeds it bridge + force-update events; UpdateToast
// renders whatever state comes out.

export type UpdaterPhase =
  | "hidden" // no update activity (steady state)
  | "available" // a newer version is ready to download
  | "downloading" // bytes flowing, cancellable
  | "downloaded" // ready — restart to apply
  | "force" // backend answered 426: update required to continue
  | "notice"; // transient error line (dismisses itself)

export interface UpdaterState {
  phase: UpdaterPhase;
  version: string | null;
  notes: string | null;
  percent: number | null;
  error: string | null;
  minVersion: string | null;
  dismissedVersion: string | null;
}

export const FORCE_UPDATE_EVENT = "orplex:force-update";

/**
 * Central 426 handler: call from apiJson so ANY stale-client API call flips
 * the update card into its mandatory state. Safe to call with any status.
 * Lives here (not the hook) so low-level non-React modules can import it.
 */
export function handleVersionedResponse(status: number, data: unknown): void {
  if (status !== 426 || typeof window === "undefined") return;
  const minVersion = (data as { minVersion?: unknown } | null)?.minVersion;
  if (typeof minVersion === "string" && minVersion) {
    // Cap length: value comes from the server, never render unbounded text.
    window.dispatchEvent(new CustomEvent(FORCE_UPDATE_EVENT, { detail: { minVersion: minVersion.slice(0, 32) } }));
  }
}

export const initialUpdaterState: UpdaterState = {
  phase: "hidden",
  version: null,
  notes: null,
  percent: null,
  error: null,
  minVersion: null,
  dismissedVersion: null,
};

export type UpdaterEvent =
  | { type: "bridge"; status: { state: string; version?: string; notes?: string; percent?: number; error?: string } }
  | { type: "force"; minVersion: string }
  | { type: "dismiss" }
  | { type: "notice"; error: string }
  | { type: "reset" };

/** Fresh state for an incoming version, preserving the dismissed marker. */
function forVersion(prev: UpdaterState, version: string): UpdaterState {
  return {
    ...initialUpdaterState,
    dismissedVersion: prev.dismissedVersion,
    version,
  };
}

export function applyUpdateEvent(prev: UpdaterState, event: UpdaterEvent): UpdaterState {
  switch (event.type) {
    case "reset":
      return initialUpdaterState;
    case "dismiss": {
      // "Later" — hide. A dismissed AVAILABLE version doesn't re-toast, but a
      // dismissed DOWNLOADED update keeps no suppression: the install is
      // already on disk and the next check must offer Restart again.
      if (prev.phase === "downloaded") {
        return { ...prev, phase: "hidden" };
      }
      return {
        ...prev,
        phase: "hidden",
        dismissedVersion: prev.version ?? prev.dismissedVersion,
      };
    }
    case "notice":
      return { ...prev, phase: "notice", error: event.error.slice(0, 200) };
    case "force":
      // 426 from the backend beats everything except an in-flight download.
      if (prev.phase === "downloading") return prev;
      return { ...forVersion(prev, prev.version ?? ""), phase: "force", minVersion: event.minVersion };
    case "bridge": {
      const s = event.status;
      switch (s.state) {
        case "checking":
          // Keep current card (if any) — checking is silent.
          return prev;
        case "available": {
          if (!s.version) return prev;
          // Don't re-toast a version the user already dismissed.
          if (s.version === prev.dismissedVersion) return { ...prev, phase: "hidden" };
          return { ...forVersion(prev, s.version), phase: "available", notes: s.notes ?? null };
        }
        case "downloading":
          // Late progress events after Cancel (optimistic dismiss) must not
          // re-open the card — main follows with idle/downloaded shortly.
          if (prev.phase === "hidden") return prev;
          return {
            ...prev,
            phase: "downloading",
            percent: typeof s.percent === "number" ? s.percent : prev.percent,
          };
        case "downloaded":
          return { ...prev, phase: "downloaded", percent: 100 };
        case "error":
          return { ...prev, phase: "notice", error: (s.error || "update failed").slice(0, 200) };
        case "idle":
        default:
          // A fresh idle after activity clears transient cards; never clears
          // force (only a successful download/install clears that).
          if (prev.phase === "force") return prev;
          if (prev.phase === "hidden" || prev.phase === "notice") return { ...prev, phase: "hidden", error: null };
          return prev;
      }
    }
  }
}
