/**
 * Typed API surface exposed to renderers through the preload bridge.
 * Renderers are sandboxed: everything goes through these whitelisted calls.
 */

import type {
  AppState,
  StartTimerRequest,
  StartTimerResult,
  WindowListEntry,
} from '../shared/focuslock.ts';

export interface FocuslockBridge {
  /** Current app state (used by the panel on open). */
  getState(): Promise<AppState | null>;
  /** Ask main to start a lock session. Returns validation result. */
  startTimer(req: StartTimerRequest): Promise<StartTimerResult>;
  /** Class mode: list of open windows the user can pin. */
  getWindows(): Promise<WindowListEntry[]>;
  /** End the current class-mode session early. */
  endClassSession(): void;
  /** Widget requests the settings panel. */
  openPanel(): void;
  /** Pointer-drag support: move the widget window to an absolute screen pos. */
  moveWindowTo(x: number, y: number): void;
  /** Panel closes itself. */
  closePanel(): void;
  /** Strict-mode emergency abort (Ctrl+Shift+Q), dev builds only. */
  requestAbort(): void;
  /** Logo as a data URL (PNG override or built-in SVG). */
  getLogoDataUrl(): Promise<string | null>;
  /** Subscribe to state broadcasts from main. */
  onStateChanged(cb: (state: AppState) => void): void;
  /** Fires when the native hook swallows a blocked key combo. */
  onBlockedKey(cb: () => void): void;
}

declare global {
  interface Window {
    focuslock: FocuslockBridge;
  }
}

export {};
