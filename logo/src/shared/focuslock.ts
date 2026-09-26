/**
 * Shared constants, types, and pure helpers used by both the Electron main
 * process and the renderer processes. Keep this file dependency-free.
 */

/** Strict-mode abort hotkey, shown on the lock screen (Ctrl+Shift+Q). */
export const STRICT_ABORT_HOTKEY_LABEL = 'Ctrl+Shift+Q';
export const STRICT_ABORT_HOTKEY_ACCELERATOR = 'Control+Shift+Q';

/** All IPC channel names in one place so main/preload/renderer never drift. */
export const IPC = {
  // Widget -> main
  widgetOpenPanel: 'widget:openPanel',
  /** Widget pointer-drag: position the window at an absolute screen point. */
  widgetMoveTo: 'widget:moveTo',
  // Panel -> main
  panelStartTimer: 'panel:startTimer',
  panelGetState: 'panel:getState',
  panelClose: 'panel:close',
  /** Panel asks for the list of open windows (class-mode pinning). */
  classGetWindows: 'class:getWindows',
  // Lock renderer -> main
  lockRequestAbort: 'lock:requestAbort',
  /** Widget: end the current CLASS-mode session early (confirmed in UI). */
  classEndSession: 'class:endSession',
  // Main -> all renderers (state broadcasts)
  stateChanged: 'state:changed',
  // Main -> renderer
  logoDataUrl: 'logo:dataUrl',
  lockHotkeyChanged: 'lock:hotkeyChanged',
  /** Fired when the native hook swallows a blocked combo (strict mode). */
  lockBlocked: 'lock:blocked',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

/** App-level phase: idle shows the circle widget, locked shows the cylinder. */
export type AppPhase = 'idle' | 'locked';

/**
 * Enforcement mode for a session:
 *  - 'lockdown': fullscreen overlays on every display + focus watchdog.
 *  - 'class': timer only; nothing is blocked (watch a class / keep working).
 */
export type SessionMode = 'lockdown' | 'class';
export const SESSION_MODES: readonly SessionMode[] = ['lockdown', 'class'];

export function isSessionMode(value: unknown): value is SessionMode {
  return typeof value === 'string' && (SESSION_MODES as readonly string[]).includes(value);
}

/** Serializable snapshot of the timer state broadcast to all renderers. */
export interface AppState {
  phase: AppPhase;
  /** Epoch ms when the lock ends. Present only while locked. */
  endAt: number | null;
  /** Epoch ms when the lock started. Present only while locked. */
  startedAt: number | null;
  strictMode: boolean;
  mode: SessionMode;
  /** Class mode: pinned hwnd (decimal string), persisted for restart restore. */
  pinHwnd: string | null;
}

/** One pinnable window for class mode. */
export interface WindowListEntry {
  /** desktopCapturer source id. */
  id: string;
  /** Window title. */
  name: string;
  /** Raw HWND as a decimal string (class pinning target). */
  hwnd: string;
}

/** Payload the panel sends when the user presses "Lock". */
export interface StartTimerRequest {
  /** Requested duration in milliseconds (already combined from steppers). */
  durationMs: number;
  /** Whether to use the strict keyboard-hook mode (lockdown only). */
  strictMode: boolean;
  /** Which enforcement mode to run. */
  mode: SessionMode;
  /** Class mode: hwnd (decimal string) to pin, or null for timer-only. */
  pinHwnd: string | null;
}

/** Result returned to the panel after a start attempt. */
export type StartTimerResult =
  | { ok: true }
  | { ok: false; error: string };

export const MIN_DURATION_MS = 5_000;
export const MAX_DURATION_MS = 24 * 60 * 60 * 1000; // 24h

/** Clamp a requested duration to the supported range. */
export function clampDuration(ms: number): number {
  if (!Number.isFinite(ms)) return MIN_DURATION_MS;
  return Math.min(MAX_DURATION_MS, Math.max(MIN_DURATION_MS, Math.round(ms)));
}

/**
 * True when the interval [prev, now] crossed an integer-second boundary of the
 * countdown. Used by renderers to avoid re-rendering every 250 ms tick.
 */
export function crossedSecondBoundary(
  endAt: number,
  prevNow: number,
  now: number
): boolean {
  const prevRemaining = Math.max(0, endAt - prevNow);
  const nowRemaining = Math.max(0, endAt - now);
  return Math.ceil(prevRemaining / 1000) !== Math.ceil(nowRemaining / 1000);
}

/** Format remaining milliseconds as HH:MM:SS (24h style, zero-padded). */
export function formatRemaining(msRemaining: number): string {
  const totalSeconds = Math.max(0, Math.ceil(msRemaining / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

/**
 * The widget geometry plan. Pure function so the renderer can compute target
 * sizes without knowing about the main process.
 */
export interface WidgetGeometry {
  width: number;
  height: number;
  /** CSS border-radius (px) for the current shape. */
  borderRadius: number;
}

export const WIDGET_IDLE_SIZE = 64;
/** Locked shape: horizontal pill, three HH/MM/SS segments + separators. */
export const WIDGET_LOCKED_WIDTH = 172;
export const WIDGET_LOCKED_HEIGHT = 64;

/** Transparent gutter around the widget so the specular glow can bleed. */
export const WIDGET_PAD = 20;

/** Circle when idle, horizontal capsule ("cylinder") while locked. */
export function widgetGeometry(phase: AppPhase): WidgetGeometry {
  if (phase === 'locked') {
    return {
      width: WIDGET_LOCKED_WIDTH,
      height: WIDGET_LOCKED_HEIGHT,
      borderRadius: WIDGET_LOCKED_HEIGHT / 2,
    };
  }
  return {
    width: WIDGET_IDLE_SIZE,
    height: WIDGET_IDLE_SIZE,
    borderRadius: WIDGET_IDLE_SIZE / 2,
  };
}

/** The OS window is larger than the shape: glow needs bleed room. */
export function widgetWindowGeometry(phase: AppPhase): { width: number; height: number } {
  const shape = widgetGeometry(phase);
  return {
    width: shape.width + WIDGET_PAD * 2,
    height: shape.height + WIDGET_PAD * 2,
  };
}

/** Defensive parser for IPC payloads coming from renderers. */
export function parseStartTimerRequest(input: unknown): StartTimerRequest | null {
  if (typeof input !== 'object' || input === null) return null;
  const rec = input as Record<string, unknown>;
  const durationMs = rec['durationMs'];
  const strictMode = rec['strictMode'];
  const mode = rec['mode'];
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs)) return null;
  if (typeof strictMode !== 'boolean') return null;
  if (!isSessionMode(mode)) return null;
  const pinHwnd = rec['pinHwnd'];
  if (pinHwnd !== null && typeof pinHwnd !== 'string') return null;
  return { durationMs, strictMode, mode, pinHwnd };
}

/** Defensive parser for broadcast state. */
export function parseAppState(input: unknown): AppState | null {
  if (typeof input !== 'object' || input === null) return null;
  const rec = input as Record<string, unknown>;
  if (rec['phase'] !== 'idle' && rec['phase'] !== 'locked') return null;
  if (typeof rec['strictMode'] !== 'boolean') return null;
  if (!isSessionMode(rec['mode'])) return null;
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
