import { useSyncExternalStore } from "react";
import { smoothSpeed } from "./formatters";

export type UpdatePhase = "idle" | "available" | "downloading" | "ready" | "installing" | "done" | "error";

export interface UpdateStatusPayload {
  state: string;
  version?: string;
  notes?: string;
  percent?: number;
  bytesPerSecond?: number;
  transferred?: number;
  total?: number;
  error?: string;
}

export interface UpdateStoreState {
  phase: UpdatePhase;
  version: string | null; // target new version
  currentVersion: string | null;
  notes: string | null;
  percent: number;
  speedBps: number; // smoothed bytes/sec
  transferred: number;
  total: number;
  error: string | null;
  dismissedVersion: string | null;
}

const PENDING_KEY = "orplex.pendingUpdateTarget";

const initialState: UpdateStoreState = {
  phase: "idle",
  version: null,
  currentVersion: null,
  notes: null,
  percent: 0,
  speedBps: 0,
  transferred: 0,
  total: 0,
  error: null,
  dismissedVersion: null,
};

let state: UpdateStoreState = { ...initialState };
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

function setState(patch: Partial<UpdateStoreState>) {
  state = { ...state, ...patch };
  emit();
}

export function getUpdateState(): UpdateStoreState {
  return state;
}

export function subscribeUpdateStore(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useUpdateStore(): UpdateStoreState {
  return useSyncExternalStore(subscribeUpdateStore, getUpdateState, getUpdateState);
}

// ---- actions ----

interface DesktopUpdatesBridge {
  check?: () => Promise<UpdateStatusPayload>;
  download?: () => Promise<UpdateStatusPayload>;
  cancel?: () => Promise<{ ok: boolean }>;
  install?: () => Promise<{ ok: boolean }>;
  defer?: () => Promise<{ ok: boolean }>;
  arm?: () => Promise<{ ok: boolean }>;
  onStatus?: (listener: (status: UpdateStatusPayload) => void) => () => void;
}

export interface DesktopBridge {
  getAppVersion?: () => Promise<string>;
  updates?: DesktopUpdatesBridge;
}

function bridge(): DesktopBridge | null {
  if (typeof window === "undefined") return null;
  return (window as DesktopBridge & { orplexDesktop?: DesktopBridge }).orplexDesktop ?? null;
}

export function setCurrentVersion(v: string | null) {
  setState({ currentVersion: v });
}

export function applyStatus(payload: UpdateStatusPayload) {
  const s = payload;
  switch (s.state) {
    case "checking":
      // silent
      return;
    case "available": {
      if (!s.version) return;
      if (s.version === state.dismissedVersion) {
        setState({ phase: "idle" });
        return;
      }
      setState({
        phase: "available",
        version: s.version,
        notes: s.notes ?? state.notes,
        percent: 0,
        speedBps: 0,
        transferred: 0,
        total: 0,
        error: null,
      });
      return;
    }
    case "downloading": {
      if (state.phase === "done" || state.phase === "installing") return;
      if (state.phase === "idle" && state.dismissedVersion && state.dismissedVersion === state.version) return;
      const nextSpeed = smoothSpeed(state.speedBps, s.bytesPerSecond ?? state.speedBps);
      setState({
        phase: "downloading",
        version: s.version ?? state.version,
        percent: typeof s.percent === "number" ? s.percent : state.percent,
        speedBps: nextSpeed,
        transferred: typeof s.transferred === "number" ? s.transferred : state.transferred,
        total: typeof s.total === "number" ? s.total : state.total,
        error: null,
      });
      return;
    }
    case "downloaded": {
      setState({
        phase: "ready",
        version: s.version ?? state.version,
        percent: 100,
        error: null,
      });
      return;
    }
    case "error": {
      setState({ phase: "error", error: (s.error || "update failed").slice(0, 200) });
      return;
    }
    case "idle":
    default: {
      if (state.phase === "idle" || state.phase === "error") {
        setState({ phase: "idle", error: null });
      }
      // available/downloading/ready/done/installing stay: an up-to-date
      // check must not hide a pending update card.
      return;
    }
  }
}

export async function checkForUpdates(manual = false): Promise<UpdateStatusPayload | null> {
  const b = bridge();
  if (!b?.updates?.check) return null;
  if (manual) setState({ dismissedVersion: null });
  try {
    const res = await b.updates.check();
    if (res && res.state) applyStatus(res);
    return res ?? null;
  } catch {
    setState({ phase: "error", error: "update check failed" });
    return { state: "error", error: "update check failed" };
  }
}

export async function downloadUpdate(): Promise<void> {
  const b = bridge();
  // optimistic
  setState({ phase: "downloading", percent: 0, speedBps: 0, transferred: 0 });
  try {
    if (b?.updates?.download) await b.updates.download();
  } catch {
    setState({ phase: "error", error: "download failed to start" });
  }
}

export async function cancelDownload(): Promise<void> {
  const b = bridge();
  try {
    if (b?.updates?.cancel) await b.updates.cancel();
  } catch {
    /* best-effort */
  }
  setState({ phase: "available", percent: 0, speedBps: 0, transferred: 0, total: state.total });
}

export function dismiss(): void {
  if (state.phase === "ready" || state.phase === "done") {
    setState({ phase: "idle" });
    return;
  }
  setState({ phase: "idle", dismissedVersion: state.version ?? state.dismissedVersion });
}

export async function defer(): Promise<void> {
  const b = bridge();
  try {
    if (b?.updates?.defer) await b.updates.defer();
  } catch {
    /* best-effort */
  }
}

export async function arm(): Promise<void> {
  const b = bridge();
  try {
    if (b?.updates?.arm) await b.updates.arm();
  } catch {
    /* best-effort */
  }
}

export async function installUpdate(): Promise<void> {
  const b = bridge();
  const v = state.version;
  if (v) {
    try {
      localStorage.setItem(PENDING_KEY, v);
    } catch {
      /* ignore */
    }
  }
  setState({ phase: "installing" });
  try {
    if (b?.updates?.install) await b.updates.install();
  } catch {
    setState({ phase: "error", error: "restart failed" });
  }
}

export function markDoneIfNeeded(currentVersion: string | null) {
  let target: string | null = null;
  try {
    target = localStorage.getItem(PENDING_KEY);
  } catch {
    target = null;
  }
  if (target && currentVersion && target === currentVersion) {
    setState({ phase: "done", version: target });
    try {
      localStorage.removeItem(PENDING_KEY);
    } catch {
      /* ignore */
    }
  }
}

export function setPhase(phase: UpdatePhase) {
  setState({ phase });
}

export function clearDone() {
  setState({ phase: "idle" });
}

// dev simulator entry: push a fake status
export function pushDevStatus(payload: UpdateStatusPayload) {
  applyStatus(payload);
}