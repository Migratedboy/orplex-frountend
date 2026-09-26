import type { BrowserWindow, Rectangle } from 'electron';

import { IPC, widgetWindowGeometry, type AppPhase, type AppState } from '../shared/focuslock';
import { attachConsoleDiagnostics } from './diag';
import { attachInputGuard } from './inputGuard';
import { PRELOAD_PATH, rendererURL } from './paths';

/**
 * Manages the three window kinds (widget, panel, lock) and the enforcement
 * machinery: fullscreen kiosk overlays on every monitor plus a focus watchdog.
 */
export class LockManager {
  private widgetWindow: BrowserWindow | null = null;
  private panelWindow: BrowserWindow | null = null;
  private lockWindows: BrowserWindow[] = [];
  private watchdog: NodeJS.Timeout | null = null;
  private readonly electron: typeof import('electron');

  constructor(
    electron: typeof import('electron'),
    private readonly onWidgetMoved: (x: number, y: number) => void
  ) {
    this.electron = electron;
  }

  createWidget(savedX: number | null, savedY: number | null): void {
    const { BrowserWindow, screen } = this.electron;
    const initial = widgetWindowGeometry('idle');
    const options: Electron.BrowserWindowConstructorOptions = {
      width: initial.width,
      height: initial.height,
      frame: false,
      transparent: true,
      resizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      show: false,
      webPreferences: {
        preload: PRELOAD_PATH,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    };
    if (savedX !== null && savedY !== null) {
      options.x = savedX;
      options.y = savedY;
    }
    const widget = new BrowserWindow(options);
    if (savedX === null || savedY === null) {
      const { workArea } = screen.getPrimaryDisplay();
      widget.setPosition(workArea.x + workArea.width - 120, workArea.y + 16);
    }
    widget.setAlwaysOnTop(true, 'screen-saver');
    widget.loadURL(rendererURL('widget.html'));
    widget.once('ready-to-show', () => widget.showInactive());
    widget.setMovable(true);
    attachInputGuard(widget);
    attachConsoleDiagnostics(widget, 'widget');
    widget.on('moved', () => {
      const pos = widget.getPosition();
      this.onWidgetMoved(pos[0] ?? 0, pos[1] ?? 0);
    });
    widget.on('closed', () => {
      this.widgetWindow = null;
    });
    this.widgetWindow = widget;
  }

  getWidget(): BrowserWindow | null {
    return this.widgetWindow;
  }

  /** Native HWND (decimal string) of the widget window, for the pin helper. */
  getWidgetHwnd(): string | null {
    const widget = this.widgetWindow;
    if (!widget || widget.isDestroyed()) return null;
    try {
      const buf = widget.getNativeWindowHandle();
      let hex = '';
      for (const byte of buf) hex += byte.toString(16).padStart(2, '0');
      const hwnd = Number.parseInt(hex, 16);
      if (!Number.isFinite(hwnd) || hwnd <= 0) return null;
      return String(hwnd);
    } catch {
      return null;
    }
  }

  /**
   * Re-assert the countdown widget on top of the topmost band (above the
   * lockdown overlays). Called every 400 ms while a session is live — the
   * overlays' focus watchdog and the class pin otherwise bury it.
   *
   * Re-asserting alwaysOnTop makes Electron issue SetWindowPos(HWND_TOPMOST)
   * with NOACTIVATE, which re-inserts the widget at the very top of the
   * topmost z-band — above both the overlays and a pinned class window.
   */
  raiseWidgetAboveOverlays(): void {
    const widget = this.widgetWindow;
    if (!widget || widget.isDestroyed()) return;
    widget.setAlwaysOnTop(true, 'screen-saver');
  }

  /**
   * Resize the widget window for a phase change, keeping the shape's on-screen
   * center fixed (the shape is always centered inside the padded window).
   */
  setWidgetPhase(phase: AppPhase): void {
    const widget = this.widgetWindow;
    if (!widget || widget.isDestroyed()) return;
    const next = widgetWindowGeometry(phase);
    const current = widget.getSize();
    const curW = current[0] ?? next.width;
    const curH = current[1] ?? next.height;
    const pos = widget.getPosition();
    const centerX = (pos[0] ?? 0) + curW / 2;
    const centerY = (pos[1] ?? 0) + curH / 2;
    if (curW === next.width && curH === next.height) return;
    widget.setSize(next.width, next.height);
    widget.setPosition(
      Math.round(centerX - next.width / 2),
      Math.round(centerY - next.height / 2)
    );
  }

  /** Move the widget window to an absolute position in DIPs (drag support). */
  moveWidgetTo(x: number, y: number): void {
    const widget = this.widgetWindow;
    if (!widget || widget.isDestroyed()) return;
    widget.setPosition(x, y);
  }

  openPanel(): void {
    const { BrowserWindow } = this.electron;
    if (this.panelWindow && !this.panelWindow.isDestroyed()) {
      this.panelWindow.focus();
      return;
    }
    const panel = new BrowserWindow({
      width: 340,
      height: 420,
      frame: false,
      resizable: false,
      alwaysOnTop: true,
      show: false,
      backgroundColor: '#0f1220',
      webPreferences: {
        preload: PRELOAD_PATH,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    attachInputGuard(panel);
    attachConsoleDiagnostics(panel, 'panel');
    panel.on('closed', () => {
      this.panelWindow = null;
    });
    panel.loadURL(rendererURL('panel.html'));
    panel.once('ready-to-show', () => panel.show());
    this.panelWindow = panel;
  }

  closePanel(): void {
    if (this.panelWindow && !this.panelWindow.isDestroyed()) {
      this.panelWindow.destroy();
    }
    this.panelWindow = null;
  }

  private buildOverlay(bounds: Rectangle): BrowserWindow {
    const { BrowserWindow } = this.electron;
    const win = new BrowserWindow({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      frame: false,
      show: false,
      backgroundColor: '#000000',
      kiosk: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      enableLargerThanScreen: true,
      webPreferences: {
        preload: PRELOAD_PATH,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    attachInputGuard(win, { blockAltF4: true });
    attachConsoleDiagnostics(win, 'lock');
    win.loadURL(rendererURL('lock.html'));
    return win;
  }

  showLockOverlays(): void {
    const { screen } = this.electron;
    this.lockWindows = screen.getAllDisplays().map((d) => this.buildOverlay(d.bounds));
    for (const win of this.lockWindows) {
      win.once('ready-to-show', () => showLockWindow(win));
    }
    this.startWatchdog();
  }

  closeLockOverlays(): void {
    this.stopWatchdog();
    for (const win of this.lockWindows) {
      if (!win.isDestroyed()) win.destroy();
    }
    this.lockWindows = [];
  }

  /** Re-grab focus if any overlay lost it (best-effort Alt+Tab neutralizer). */
  private startWatchdog(): void {
    this.stopWatchdog();
    this.watchdog = setInterval(() => {
      for (const win of this.lockWindows) {
        if (win.isDestroyed()) continue;
        if (!win.isFocused()) {
          win.focus();
          win.moveTop();
        }
      }
      // Keep the countdown widget visible above the overlays (the overlays
      // are created later, so they start above it).
      this.raiseWidgetAboveOverlays();
    }, 400);
    this.watchdog.unref();
  }

  private stopWatchdog(): void {
    if (this.watchdog !== null) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
  }

  /** Rebuild overlays when display metrics change mid-lock. */
  handleDisplayMetricsChanged(): void {
    if (this.lockWindows.length === 0) return;
    this.closeLockOverlays();
    this.showLockOverlays();
  }

  isLocked(): boolean {
    return this.lockWindows.length > 0;
  }

  getLockWindows(): BrowserWindow[] {
    return this.lockWindows.filter((win) => !win.isDestroyed());
  }

  broadcastState(state: AppState): void {
    const targets: (BrowserWindow | null)[] = [
      this.widgetWindow,
      this.panelWindow,
      ...this.lockWindows,
    ];
    for (const win of targets) {
      if (win && !win.isDestroyed()) {
        win.webContents.send(IPC.stateChanged, state);
      }
    }
  }

  /** True when any live window reports the given webContents id. */
  ownsWebContents(id: number): boolean {
    const targets: (BrowserWindow | null)[] = [
      this.widgetWindow,
      this.panelWindow,
      ...this.lockWindows,
    ];
    return targets.some((win) => win && !win.isDestroyed() && win.webContents.id === id);
  }
}

function showLockWindow(win: BrowserWindow): void {
  if (!win.isDestroyed()) {
    win.show();
    win.focus();
    win.moveTop();
  }
}
