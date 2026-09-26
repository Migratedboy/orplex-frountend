/**
 * Class mode: pin the user's chosen window (their online class) so switching
 * to other apps is neutralized for the session.
 *
 * Electron cannot manipulate foreign windows, so this module drives a small
 * PowerShell helper (native/classPin.ps1) that:
 *  - puts the class window BORDERLESS FULLSCREEN on its monitor,
 *  - keeps it TOPMOST and focused (300 ms watchdog),
 *  - keeps the countdown widget's HWND just above the class window,
 *  - restores it if minimized,
 *  - saves the window's original style/rect to a state file so the original
 *    windowed geometry survives even if the app or helper crashes,
 *  - restores it (or exits) when the session ends, the window closes, or the
 *    app dies.
 *
 * Killing this helper (or the app) ends the pin — Task Manager always wins,
 * same honest limitation as lockdown mode.
 */

import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

const PS_SCRIPT = path.join(__dirname, '..', '..', 'native', 'classPin.ps1');
const STATE_FILE = path.join(process.cwd(), 'classPin-state.json');

/**
 * PowerShell is an external process and cannot read inside an asar archive,
 * so packaged builds get a temp copy of the script.
 */
function resolveScript(): string {
  if (!PS_SCRIPT.includes('app.asar')) return PS_SCRIPT;
  const tmp = path.join(app.getPath('temp'), 'focuslock-classPin.ps1');
  try {
    fs.copyFileSync(PS_SCRIPT, tmp);
    return tmp;
  } catch {
    return PS_SCRIPT;
  }
}

let current: ChildProcess | null = null;
let currentHwnd = '0';

function psArgs(action: 'pin' | 'restore', hwnd: string, widgetHwnd: string): string[] {
  return [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-WindowStyle',
    'Hidden',
    '-File',
    resolveScript(),
    '-Action',
    action,
    '-Hwnd',
    hwnd,
    '-ParentPid',
    String(process.pid),
    '-StateFile',
    STATE_FILE,
    '-WidgetHwnd',
    widgetHwnd,
  ];
}

/** Best-effort restore via a short-lived helper process. */
function spawnRestore(hwnd: string, onDone?: () => void): void {
  if (process.platform !== 'win32' || hwnd === '0') {
    onDone?.();
    return;
  }
  try {
    execFile(
      'powershell.exe',
      psArgs('restore', hwnd, '0'),
      { timeout: 10000, windowsHide: true },
      () => onDone?.()
    );
  } catch {
    onDone?.();
  }
}

/**
 * Start pinning (borderless fullscreen) the window identified by `hwnd`.
 * `widgetHwnd` (optional, decimal string) is the countdown widget's native
 * window: the helper re-raises it above the pinned class window every tick so
 * the timer floats over the fullscreen class instead of hiding behind it.
 */
export function startClassPin(hwnd: string, widgetHwnd?: string | null): boolean {
  stopClassPin();
  if (process.platform !== 'win32') return false;
  const id = Number.parseInt(hwnd, 10);
  if (!Number.isFinite(id) || id <= 0) return false;
  const script = resolveScript();
  if (!fs.existsSync(script)) {
    console.warn('[classPin] script missing:', script);
    return false;
  }

  const child = spawn('powershell.exe', psArgs('pin', hwnd, widgetHwnd ?? '0'), {
    stdio: ['pipe', 'ignore', 'pipe'],
    windowsHide: true,
  });
  child.on('exit', () => {
    if (current === child) {
      current = null;
      currentHwnd = '0';
    }
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    // Helper trace output (diagnostics only; harmless if unread).
    console.log('[classPin:helper]', chunk.toString().trim());
  });
  current = child;
  currentHwnd = hwnd;
  return true;
}

/** Restore the pinned window to its original windowed state. */
export function stopClassPin(): void {
  const pin = current;
  const hwnd = currentHwnd;
  current = null;
  currentHwnd = '0';
  if (pin !== null && !pin.killed && pin.exitCode === null) {
    pin.kill();
  }
  // The pin helper also restores on its own exit path, but drive restore
  // explicitly so it happens even if the helper was killed first.
  spawnRestore(hwnd);
}

/** Recover a leftover fullscreen pin from a crashed previous run. */
export function recoverOrphanedPin(): void {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const saved = fs.readFileSync(STATE_FILE, 'utf8').trim();
    if (saved === '') return;
    // Field 0 is the hwnd (see classPin.ps1 SaveState).
    const hwnd = saved.split('|')[0]?.trim() ?? '0';
    if (hwnd === '' || hwnd === '0') return;
    console.log('[classPin] recovering orphaned pin for hwnd', hwnd);
    spawnRestore(hwnd);
  } catch {
    // ignore
  }
}

export function isPinning(): boolean {
  return current !== null;
}
