/**
 * Preload: the only bridge between sandboxed renderers and the main process.
 * Exposes a small, typed, whitelisted API — nothing else.
 *
 * IMPORTANT: this file must be SELF-CONTAINED. Sandboxed renderers cannot
 * `require()` relative modules, so all constants/parsers used here are
 * inlined copies of src/shared/focuslock.ts. Keep them in sync (the unit
 * tests pin the shared side; a mismatch shows up as a dead bridge).
 */

import { contextBridge, ipcRenderer } from 'electron';

// --- inlined from src/shared/focuslock.ts ---------------------------------
const IPC = {
  widgetOpenPanel: 'widget:openPanel',
  widgetMoveTo: 'widget:moveTo',
  panelStartTimer: 'panel:startTimer',
  panelGetState: 'panel:getState',
  panelClose: 'panel:close',
  classGetWindows: 'class:getWindows',
  classEndSession: 'class:endSession',
  lockRequestAbort: 'lock:requestAbort',
  stateChanged: 'state:changed',
  logoDataUrl: 'logo:dataUrl',
  lockHotkeyChanged: 'lock:hotkeyChanged',
  lockBlocked: 'lock:blocked',
} as const;

interface WindowListEntry {
  id: string;
  name: string;
  hwnd: string;
}

function parseWindowList(input: unknown): WindowListEntry[] {
  if (!Array.isArray(input)) return [];
  const out: WindowListEntry[] = [];
  for (const raw of input) {
    if (typeof raw !== 'object' || raw === null) continue;
    const rec = raw as Record<string, unknown>;
    const id = rec['id'];
    const name = rec['name'];
    const hwnd = rec['hwnd'];
    if (typeof id !== 'string' || typeof name !== 'string' || typeof hwnd !== 'string') continue;
    out.push({ id, name, hwnd });
  }
  return out;
}

interface StartTimerRequest {
  durationMs: number;
  strictMode: boolean;
  mode: 'lockdown' | 'class';
  pinHwnd: string | null;
}

interface AppState {
  phase: 'idle' | 'locked';
  endAt: number | null;
  startedAt: number | null;
  strictMode: boolean;
  mode: 'lockdown' | 'class';
  pinHwnd: string | null;
}

type StartTimerResult = { ok: true } | { ok: false; error: string };

function parseAppState(input: unknown): AppState | null {
  if (typeof input !== 'object' || input === null) return null;
  const rec = input as Record<string, unknown>;
  if (rec['phase'] !== 'idle' && rec['phase'] !== 'locked') return null;
  if (typeof rec['strictMode'] !== 'boolean') return null;
  if (rec['mode'] !== 'lockdown' && rec['mode'] !== 'class') return null;
  const endAt = rec['endAt'];
  const startedAt = rec['startedAt'];
  const pinHwnd = rec['pinHwnd'];
  if (endAt !== null && typeof endAt !== 'number') return null;
  if (startedAt !== null && typeof startedAt !== 'number') return null;
  if (pinHwnd !== null && typeof pinHwnd !== 'string') return null;
  return {
    phase: rec['phase'],
    endAt: endAt,
    startedAt: startedAt,
    strictMode: rec['strictMode'],
    mode: rec['mode'],
    pinHwnd: pinHwnd ?? null,
  };
}
// --------------------------------------------------------------------------

const api = {
  getState: (): Promise<AppState | null> =>
    (ipcRenderer.invoke(IPC.panelGetState) as Promise<unknown>).then(parseAppState),

  startTimer: (req: StartTimerRequest): Promise<StartTimerResult> =>
    ipcRenderer.invoke(IPC.panelStartTimer, req) as Promise<StartTimerResult>,

  openPanel: (): void => {
    ipcRenderer.send(IPC.widgetOpenPanel);
  },

  /** Pointer-drag support: move the widget window to an absolute screen pos. */
  moveWindowTo: (x: number, y: number): void => {
    ipcRenderer.send(IPC.widgetMoveTo, { x, y });
  },

  closePanel: (): void => {
    ipcRenderer.send(IPC.panelClose);
  },

  requestAbort: (): void => {
    ipcRenderer.send(IPC.lockRequestAbort);
  },

  getLogoDataUrl: (): Promise<string | null> =>
    ipcRenderer.invoke(IPC.logoDataUrl) as Promise<string | null>,

  /** Class mode: list of open windows the user can pin. */
  getWindows: (): Promise<WindowListEntry[]> =>
    (ipcRenderer.invoke(IPC.classGetWindows) as Promise<unknown>).then(parseWindowList),

  /** End the current class-mode session early (lockdown ignores this). */
  endClassSession: (): void => {
    ipcRenderer.send(IPC.classEndSession);
  },

  onStateChanged: (cb: (state: AppState) => void): void => {
    ipcRenderer.on(IPC.stateChanged, (_event, payload: unknown) => {
      const state = parseAppState(payload);
      if (state !== null) cb(state);
    });
  },

  onBlockedKey: (cb: () => void): void => {
    ipcRenderer.on(IPC.lockBlocked, () => cb());
  },
};

export type FocuslockPreloadApi = typeof api;

contextBridge.exposeInMainWorld('focuslock', api);
