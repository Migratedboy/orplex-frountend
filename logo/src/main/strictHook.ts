/**
 * Strict mode: truly blocks Alt+Tab, the Win key, and other system combos
 * while a session is live, via a Windows low-level keyboard hook
 * (WH_KEYBOARD_LL). Two interchangeable backends, both optional:
 *
 * 1. Native N-API addon (native/keyboard_hook.cc, `npm run build:native`)
 *    - preferred when a C++ toolchain exists (needs VS Build Tools)
 * 2. C# helper (native/KeyboardHook.cs) compiled by the .NET Framework
 *    compiler that ships with every Windows install - no dependencies.
 *
 * Without either backend, strict mode degrades gracefully to standard
 * enforcement and says so. Strict is never faked: strictMode is only honored
 * when the backend confirms the hook is actually installed.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface StrictHook {
  /** Installs the hook; resolves to true only when truly active. */
  install(): Promise<boolean>;
  uninstall(): Promise<void>;
  isInstalled(): boolean;
}

const HOOK_EXE = 'FocusLockKeyboardHook.exe';
const PIPE_NAME = 'FocusLockKeyboardHook';
const CONNECT_TIMEOUT_MS = 3000;
const STATE_TIMEOUT_MS = 1500;

let cachedNative: RawAddon | null | undefined;
let helper: HelperHandle | null = null;

interface RawAddon {
  installHook(onBlocked: () => void): boolean;
  removeHook(): void;
  isHookInstalled(): boolean;
}

interface HelperHandle {
  child: ChildProcess;
  exePath: string;
}

function isWindows(): boolean {
  return process.platform === 'win32';
}

function tryRequireAddon(p: string): RawAddon | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require(p);
  } catch {
    return null;
  }
}

function getNativeAddon(): RawAddon | null {
  if (cachedNative !== undefined) return cachedNative;
  cachedNative = null;
  if (isWindows()) {
    const candidates = [
      path.join(__dirname, '..', '..', 'prebuilds', 'keyboard_hook.node'),
      path.join(process.cwd(), 'prebuilds', 'keyboard_hook.node'),
      path.join(process.resourcesPath ?? '', 'keyboard_hook.node'),
    ];
    for (const candidate of candidates) {
      const addon = tryRequireAddon(candidate);
      if (addon !== null) {
        cachedNative = addon;
        break;
      }
    }
  }
  return cachedNative;
}

/** True when the native N-API addon is loadable (preferred backend). */
export function nativeAddonAvailable(): boolean {
  return getNativeAddon() !== null;
}

function helperExePath(): string | null {
  // __dirname is dist/main -> project root is ../..
  const root = path.join(__dirname, '..', '..');
  const candidates = [
    path.join(root, 'prebuilds', HOOK_EXE),
    path.join(process.cwd(), 'prebuilds', HOOK_EXE),
    path.join(process.resourcesPath ?? '', HOOK_EXE),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore
    }
  }
  return null;
}

function connectAndSend(command: 'state' | 'quit', expectReply: boolean): Promise<string | null> {
  const net = require('node:net') as typeof import('node:net');
  return new Promise((resolve) => {
    const socket = net.createConnection(`\\\\.\\pipe\\${PIPE_NAME}`);
    let settled = false;
    const done = (value: string | null) => {
      if (!settled) {
        settled = true;
        socket.destroy();
        resolve(value);
      }
    };
    socket.setTimeout(CONNECT_TIMEOUT_MS);
    socket.on('connect', () => {
      socket.setTimeout(STATE_TIMEOUT_MS);
      socket.write(`${command}\n`, 'utf8', () => {
        if (!expectReply) {
          done(null);
          return;
        }
      });
    });
    let data = '';
    socket.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf8');
      if (data.includes('\n')) done(data.trim());
    });
    socket.on('timeout', () => done(expectReply ? null : 'ok'));
    socket.on('error', () => done(null));
  });
}

function spawnHelper(exePath: string): HelperHandle | null {
  try {
    // stdio: stdin is kept open so the helper's stdin watcher doesn't quit;
    // stdout/stderr discarded so nothing spams the terminal.
    const child = spawn(exePath, ['--owner', String(process.pid)], {
      stdio: ['pipe', 'ignore', 'ignore'],
      windowsHide: true,
    });
    if (child.pid === undefined) return null;
    child.once('exit', () => {
      if (helper !== null && helper.child === child) helper = null;
    });
    return { child, exePath };
  } catch {
    return null;
  }
}

class NativeBackend implements StrictHook {
  private addon: RawAddon;

  constructor(addon: RawAddon) {
    this.addon = addon;
  }

  async install(): Promise<boolean> {
    // installHook blocks in C++ until the hook thread confirms (or ~2s).
    const ok = this.addon.installHook(() => {
      // Blocked-combo notifications are not forwarded anywhere right now;
      // the overlays show enforcement through their own strict banner.
    });
    return ok && this.addon.isHookInstalled();
  }

  async uninstall(): Promise<void> {
    this.addon.removeHook();
  }

  isInstalled(): boolean {
    return this.addon.isHookInstalled();
  }
}

class HelperBackend implements StrictHook {
  async install(): Promise<boolean> {
    if (helper !== null) {
      const state = await this.queryState();
      return state !== null && state.installed === 1;
    }
    const exePath = helperExePath();
    if (exePath === null) return false;
    const handle = spawnHelper(exePath);
    if (handle === null) return false;
    helper = handle;

    // The hook installs synchronously before the message loop, but give the
    // process a moment to come up before trusting its state.
    const deadline = Date.now() + CONNECT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const state = await this.queryState();
      if (state !== null) break;
      await new Promise((r) => setTimeout(r, 100));
      if (helper === null) return false;
    }
    const finalState = await this.queryState();
    if (finalState === null || finalState.installed !== 1) {
      this.killHelper();
      return false;
    }
    return true;
  }

  async uninstall(): Promise<void> {
    if (helper === null) return;
    await connectAndSend('quit', false);
    this.killHelper();
  }

  isInstalled(): boolean {
    // Best-effort synchronous check without blocking on the pipe.
    return helper !== null && helper.child.exitCode === null;
  }

  private async queryState(): Promise<{ installed: number; blocked: number } | null> {
    const reply = await connectAndSend('state', true);
    if (reply === null) return null;
    const installedMatch = /installed=(\d+)/.exec(reply);
    const blockedMatch = /blocked=(\d+)/.exec(reply);
    if (installedMatch === null) return null;
    return {
      installed: Number(installedMatch[1]),
      blocked: blockedMatch !== null ? Number(blockedMatch[1]) : 0,
    };
  }

  private killHelper(): void {
    if (helper === null) return;
    try {
      helper.child.kill();
    } catch {
      // ignore
    }
    helper = null;
  }
}

function pickBackend(): StrictHook | null {
  const native = getNativeAddon();
  if (native !== null) return new NativeBackend(native);
  if (isWindows() && helperExePath() !== null) return new HelperBackend();
  return null;
}

/** Lazily get the best available strict-mode backend, or null. */
export function getStrictHook(): StrictHook | null {
  return pickBackend();
}

/** True when ANY strict backend is available on this machine. */
export function strictAvailable(): boolean {
  return getNativeAddon() !== null || (isWindows() && helperExePath() !== null);
}

/** One-shot CLI probe (also usable by tests): installs, checks, removes. */
export async function verifyStrictHookInstalls(): Promise<boolean> {
  const backend = pickBackend();
  if (backend === null) return false;
  const ok = await backend.install();
  if (!ok) return false;
  await backend.uninstall();
  return ok;
}
