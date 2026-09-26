/**
 * FocusLock main process: app lifecycle, IPC wiring, timer engine,
 * lock enforcement, and the optional native strict-mode hook.
 */

import path from 'node:path';

import {
  app,
  BrowserWindow,
  desktopCapturer,
  ipcMain,
  net,
  Notification,
  protocol,
  screen,
} from 'electron';
import { pathToFileURL } from 'node:url';

import {
  IPC,
  STRICT_ABORT_HOTKEY_ACCELERATOR,
  clampDuration,
  parseStartTimerRequest,
  type AppState,
  type StartTimerResult,
} from '../shared/focuslock';
import { runRenderHealthcheck } from './diag';
import { getStrictHook, strictAvailable } from './strictHook';
import { isPinning, recoverOrphanedPin, startClassPin, stopClassPin } from './classPin';
import { LockManager } from './lockManager';
import { APP_PAGES_ROOT, MAIN_DIR } from './paths';
import { Store } from './store';
import { TimerEngine } from './timer';

/** Dev-only escape hatch (Ctrl+Shift+Q); never available in packaged builds. */
const DEV_ABORT = process.env['FOCUSLOCK_DEV_ABORT'] === '1';

// Must run before app ready: makes app:// a standard, secure scheme so that
// ES modules load with a real origin and CSP 'self' resolves correctly.
// Without this the pages load as opaque origins and every subresource is
// blocked (the "unstyled widget" bug).
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

// Single instance: a second copy must never be able to bypass the lock.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

let store: Store;
let timer: TimerEngine;
let lockManager: LockManager;
let appReady = false;
let widgetTopTimer: NodeJS.Timeout | null = null;

/**
 * While a session is live (class or lockdown), re-assert the countdown
 * widget's topmost z-order every 400 ms. Both the class-pin helper and the
 * lockdown overlay watchdog raise *their* windows into the topmost band on
 * their own schedules, which otherwise buries the widget between ticks.
 */
function keepWidgetAboveAll(active: boolean): void {
  if (active && widgetTopTimer === null) {
    widgetTopTimer = setInterval(() => {
      lockManager.raiseWidgetAboveOverlays();
    }, 400);
    widgetTopTimer.unref();
  } else if (!active && widgetTopTimer !== null) {
    clearInterval(widgetTopTimer);
    widgetTopTimer = null;
  }
}

function currentState(): AppState {
  return timer.getState();
}

function ensureStrictHookInstalled(): void {
  if (!strictAvailable()) return;
  const hook = getStrictHook();
  if (hook === null || hook.isInstalled()) return;
  hook
    .install()
    .then((ok) => {
      if (!ok) {
        console.warn('[main] strict hook install failed; degrading to standard enforcement');
      } else {
        console.log('[main] strict hook installed (Alt+Tab / Win key blocked)');
      }
    })
    .catch((err: unknown) => {
      console.warn('[main] strict hook install error:', err);
    });
}

function uninstallStrictHook(): void {
  const hook = getStrictHook();
  if (hook === null) return;
  hook
    .uninstall()
    .catch(() => undefined);
}

function onStateChanged(state: AppState): void {
  lockManager.setWidgetPhase(state.phase);
  if (state.phase === 'locked' && state.endAt !== null) {
    store.setSession({
      endAt: state.endAt ?? 0,
      startedAt: state.startedAt ?? 0,
      strictMode: state.strictMode,
      mode: state.mode,
      pinHwnd: state.pinHwnd,
    });
    lockManager.closePanel();
    // Class mode: timer + optional window pin. Lockdown: full enforcement.
    if (state.mode === 'class' && state.pinHwnd !== null && !isPinning()) {
      // Covers restart-restore: the pin helper cannot survive the old process.
      startClassPin(state.pinHwnd, lockManager.getWidgetHwnd());
    }
    // Both modes bury the widget (pin watchdog / overlay focus re-grab), so
    // keep the countdown on top for the whole session.
    keepWidgetAboveAll(true);
    if (state.mode === 'lockdown') {
      if (!lockManager.isLocked()) {
        lockManager.showLockOverlays();
      }
    }
    // Strict mode applies to class mode as well as lockdown.
    if (state.strictMode) {
      ensureStrictHookInstalled();
    }
  } else {
    store.clearSession();
    lockManager.closeLockOverlays();
    stopClassPin();
    keepWidgetAboveAll(false);
    uninstallStrictHook();
  }
  lockManager.broadcastState(state);
}

function onExpired(): void {
  if (Notification.isSupported()) {
    const notification = new Notification({
      title: 'FocusLock',
      body: 'Time is up — your focus session has ended.',
      silent: false,
    });
    notification.show();
  }
}

function readLogoDataUrl(): string | null {
  const fs = require('node:fs') as typeof import('node:fs');
  try {
    const pngPath = path.join(MAIN_DIR, 'logo.png');
    const svgPath = path.join(MAIN_DIR, 'logo.svg');
    const file = fs.existsSync(pngPath) ? pngPath : svgPath;
    const mime = file.endsWith('.png') ? 'image/png' : 'image/svg+xml';
    const data = fs.readFileSync(file);
    return `data:${mime};base64,${data.toString('base64')}`;
  } catch (err) {
    console.error('[main] logo load failed:', err);
    return null;
  }
}

function wireIpc(): void {
  ipcMain.handle(IPC.panelStartTimer, (_event, raw: unknown): StartTimerResult => {
    const req = parseStartTimerRequest(raw);
    if (req === null) return { ok: false, error: 'Invalid request.' };
    if (timer.isLocked()) return { ok: false, error: 'A session is already running.' };
    const durationMs = clampDuration(req.durationMs);
    // Strict mode works in BOTH modes (lockdown and class pinning); it is
    // only honored when the native hook is actually available on Windows.
    const strictMode = req.strictMode && strictAvailable();
    // Class mode: optionally pin the chosen class window for the session.
    if (req.mode === 'class' && req.pinHwnd !== null) {
      const pinned = startClassPin(req.pinHwnd, lockManager.getWidgetHwnd());
      if (!pinned) return { ok: false, error: 'Could not pin that window.' };
    } else if (req.mode === 'class') {
      stopClassPin();
    }
    timer.start(durationMs, strictMode, req.mode, req.pinHwnd);
    return { ok: true };
  });

  ipcMain.handle(IPC.panelGetState, () => currentState());

  ipcMain.handle(IPC.classGetWindows, async (event) => {
    if (!lockManager.ownsWebContents(event.sender.id)) return [];
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      fetchWindowIcons: false,
    });
    return sources
      .filter((s) => s.name.trim().length > 0 && s.id.startsWith('window:'))
      .map((s) => {
        // Source id format: "window:<hwnd>:<counter>" on Windows.
        const parts = s.id.split(':');
        return {
          id: s.id,
          name: s.name,
          hwnd: parts.length > 1 && parts[1] !== '' ? parts[1] : '0',
        };
      })
      .filter((entry) => entry.hwnd !== '0');
  });

  ipcMain.on(IPC.widgetOpenPanel, (event) => {
    if (!lockManager.ownsWebContents(event.sender.id)) return;
    if (timer.isLocked()) return;
    lockManager.openPanel();
  });

  ipcMain.on(IPC.widgetMoveTo, (event, raw: unknown) => {
    if (!lockManager.ownsWebContents(event.sender.id)) return;
    if (typeof raw !== 'object' || raw === null) return;
    const rec = raw as Record<string, unknown>;
    const x = rec['x'];
    const y = rec['y'];
    if (typeof x !== 'number' || !Number.isFinite(x)) return;
    if (typeof y !== 'number' || !Number.isFinite(y)) return;
    lockManager.moveWidgetTo(Math.round(x), Math.round(y));
  });

  ipcMain.on(IPC.panelClose, (event) => {
    if (!lockManager.ownsWebContents(event.sender.id)) return;
    lockManager.closePanel();
  });

  ipcMain.on(IPC.lockRequestAbort, (event) => {
    if (!DEV_ABORT) return;
    if (!lockManager.ownsWebContents(event.sender.id)) return;
    timer.clear();
  });

  // Ending a class session early: allowed (the widget confirms first), but
  // lockdown sessions can never be ended this way.
  ipcMain.on(IPC.classEndSession, (event) => {
    if (!lockManager.ownsWebContents(event.sender.id)) return;
    if (!timer.isLocked()) return;
    if (timer.getState().mode !== 'class') return;
    timer.clear();
  });

  // The pin must never outlive the session.
  app.on('before-quit', () => stopClassPin());

  ipcMain.handle(IPC.logoDataUrl, () => readLogoDataUrl());
}

function wireDevAbortHotkey(): void {
  if (!DEV_ABORT) return;
  const { globalShortcut } = require('electron') as typeof import('electron');
  globalShortcut.register(STRICT_ABORT_HOTKEY_ACCELERATOR, () => {
    if (timer.isLocked()) timer.clear();
  });
}

function boot(): void {
  protocol.handle('app', async (request) => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== 'r') return new Response(null, { status: 400 });
      const rel = decodeURIComponent(url.pathname.replace(/^\//, ''));
      const resolved = path.resolve(APP_PAGES_ROOT, rel);
      if (!resolved.startsWith(APP_PAGES_ROOT)) {
        return new Response(null, { status: 403 });
      }
      // no-store: a stale cached module across restarts would be brutal to debug.
      const fileResponse = await net.fetch(pathToFileURL(resolved).toString());
      const headers = new Headers(fileResponse.headers);
      headers.set('cache-control', 'no-store');
      return new Response(fileResponse.body, {
        status: fileResponse.status,
        headers,
      });
    } catch {
      return new Response(null, { status: 500 });
    }
  });

  store = new Store(app.getPath('userData'));
  timer = new TimerEngine({
    onStateChanged,
    onExpired,
  });
  lockManager = new LockManager(
    { BrowserWindow, screen } as unknown as typeof import('electron'),
    (x, y) => store.setWidgetPos(x, y)
  );

  wireIpc();
  wireDevAbortHotkey();

  lockManager.createWidget(store.getWidgetPos().x, store.getWidgetPos().y);

  // A crashed previous run may have left the class window fullscreen.
  recoverOrphanedPin();

  // Prove the widget page actually renders (CSS applied + bridge alive).
  const widgetWin = lockManager.getWidget();
  if (widgetWin !== null) {
    runRenderHealthcheck(widgetWin, 'widget');
  }

  // Re-lock on restart: a persisted session still in the future resumes.
  const session = store.getSession();
  if (session !== null) {
    const restored = timer.restore(
      session.endAt,
      session.startedAt,
      session.strictMode,
      session.mode,
      session.pinHwnd
    );
    if (!restored) {
      store.clearSession();
    }
  }

  screen.on('display-metrics-changed', () => {
    lockManager.handleDisplayMetricsChanged();
  });

  // While locked, closing everything must not end the lock: recreate overlays.
  app.on('window-all-closed', () => {
    if (timer.isLocked()) {
      lockManager.closeLockOverlays();
      lockManager.showLockOverlays();
      return;
    }
    app.quit();
  });
}

app.whenReady().then(() => {
  appReady = true;
  boot();
});

app.on('before-quit', () => {
  uninstallStrictHook();
});

app.on('will-quit', () => {
  try {
    const { globalShortcut } = require('electron') as typeof import('electron');
    globalShortcut.unregisterAll();
  } catch {
    // ignore during shutdown
  }
});

// Crash of a lock overlay mid-lock must immediately rebuild it.
app.on('render-process-gone', (_event, webContents, details) => {
  if (!appReady) return;
  if (details.reason === 'clean-exit') return;
  if (!lockManager.ownsWebContents(webContents.id)) return;
  if (timer.isLocked() && !lockManager.isLocked()) {
    lockManager.showLockOverlays();
  }
});

export {};
