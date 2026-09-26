import type { BrowserWindow } from 'electron';

export interface InputGuardOptions {
  /** Also swallow Alt+F4 (used on lock overlays so they cannot be dismissed). */
  blockAltF4?: boolean;
}

/**
 * Blocks DevTools / reload shortcuts at the webContents level. Used on every
 * window so the lock surface cannot be bypassed or tampered with.
 */
export function attachInputGuard(win: BrowserWindow, options: InputGuardOptions = {}): void {
  const blockAltF4 = options.blockAltF4 === true;
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = input.key.toLowerCase();
    const ctrlOrCmd = input.control || input.meta;

    const isReload = (ctrlOrCmd && key === 'r') || key === 'f5';
    const isDevTools = key === 'f12' || (ctrlOrCmd && input.shift && key === 'i');
    if (isReload || isDevTools) {
      event.preventDefault();
      return;
    }
    if (blockAltF4 && input.alt && key === 'f4') {
      event.preventDefault();
    }
  });
}
