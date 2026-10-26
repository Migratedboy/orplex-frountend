// useAppUpdater.ts — Renderer side of in-app updates.
// Subscribes to the Electron bridge (updates.onStatus) + the force-update
// window event (dispatched centrally when any apiJson call gets a 426).
// Outside Electron every action is a safe no-op and state stays hidden.

"use client";

import { useCallback, useEffect, useReducer } from "react";
import {
  applyUpdateEvent,
  initialUpdaterState,
  FORCE_UPDATE_EVENT,
  type UpdaterState,
} from "@/lib/update-state";

function isElectron(): boolean {
  return typeof window !== "undefined" && !!(window as unknown as { orplexDesktop?: unknown }).orplexDesktop;
}

export function useAppUpdater() {
  const [state, dispatch] = useReducer(applyUpdateEvent, initialUpdaterState);

  useEffect(() => {
    if (!isElectron()) return;
    const bridge = (window as unknown as {
      orplexDesktop?: {
        updates?: { onStatus?: (l: (s: { state: string; version?: string; notes?: string; percent?: number; error?: string }) => void) => () => void };
      };
    }).orplexDesktop;
    const off = bridge?.updates?.onStatus?.((status) => dispatch({ type: "bridge", status }));
    const onForce = (e: Event) => {
      const minVersion = (e as CustomEvent<{ minVersion?: string }>).detail?.minVersion;
      if (minVersion) dispatch({ type: "force", minVersion });
    };
    window.addEventListener(FORCE_UPDATE_EVENT, onForce);
    return () => {
      off?.();
      window.removeEventListener(FORCE_UPDATE_EVENT, onForce);
    };
  }, []);

  const check = useCallback(async () => {
    try {
      await (window as unknown as {
        orplexDesktop?: { updates?: { check?: () => Promise<unknown> } };
      }).orplexDesktop?.updates?.check?.();
    } catch {
      dispatch({ type: "notice", error: "update check failed" });
    }
  }, []);

  const download = useCallback(async () => {
    try {
      await (window as unknown as {
        orplexDesktop?: { updates?: { download?: () => Promise<unknown> } };
      }).orplexDesktop?.updates?.download?.();
    } catch {
      dispatch({ type: "notice", error: "download failed to start" });
    }
  }, []);

  const cancel = useCallback(async () => {
    try {
      await (window as unknown as {
        orplexDesktop?: { updates?: { cancel?: () => Promise<unknown> } };
      }).orplexDesktop?.updates?.cancel?.();
    } catch {
      /* cancel is best-effort */
    }
    dispatch({ type: "dismiss" });
  }, []);

  const install = useCallback(async () => {
    try {
      await (window as unknown as {
        orplexDesktop?: { updates?: { install?: () => Promise<unknown> } };
      }).orplexDesktop?.updates?.install?.();
    } catch {
      dispatch({ type: "notice", error: "restart failed" });
    }
  }, []);

  /**
   * Postpone the automatic restart. The downloaded build stays on disk and
   * is applied on the next quit or the next boot — nothing is lost.
   */
  const defer = useCallback(async () => {
    try {
      await (window as unknown as {
        orplexDesktop?: { updates?: { defer?: () => Promise<unknown> } };
      }).orplexDesktop?.updates?.defer?.();
    } catch {
      /* deferring is best-effort */
    }
  }, []);

  /** Re-arm the automatic restart (the runs that blocked it are done). */
  const arm = useCallback(async () => {
    try {
      await (window as unknown as {
        orplexDesktop?: { updates?: { arm?: () => Promise<unknown> } };
      }).orplexDesktop?.updates?.arm?.();
    } catch {
      /* re-arming is best-effort */
    }
  }, []);

  const dismiss = useCallback(() => dispatch({ type: "dismiss" }), []);

  return { state, check, download, cancel, install, defer, arm, dismiss, isElectron: isElectron() };
}
