// electron/auth-desktop.ts — desktop sign-in via custom protocol (orplex://).
//
// Browser OAuth cannot hand a session back to the desktop app: the provider
// callback lands on the cloud domain, so the session cookie never reaches the
// app's own origin. The deep-link handoff fixes that:
//
//   1. The renderer asks the main process to open the SYSTEM browser at
//      `<backend>/api/auth/desktop/start?provider=google|github`.
//   2. The backend completes the OAuth flow on its own domain (Google/GitHub
//      redirect URIs stay exactly as configured — nothing to re-register),
//      mints a single-use code, and navigates the browser to
//      `orplex://auth?code=<one-time-code>` (or `?error=<reason>`).
//   3. The OS launches/focuses this app with that URL (protocol handler),
//      or hands it to the running instance via `second-instance` argv.
//   4. Main parses the URL and forwards { code, error } to the renderer,
//      which POSTs the code to `/api/auth/desktop/exchange` (same-origin →
//      proxied to the backend). The backend validates the one-time code and
//      sets the next-auth session cookie on the app's own origin.
//
// Cold-launch race: a callback that arrives before the renderer is listening
// is stashed as `pending` and delivered when the sign-in page calls
// `consumePending()`.

import { app, ipcMain, shell, type BrowserWindow } from "electron";
import path from "node:path";

const PROTOCOL = "orplex";
const DEFAULT_BACKEND = "https://orplextech.freebuff.app";

export interface DesktopAuthPayload {
  code?: string;
  error?: string;
}

function backendOrigin(): string {
  const raw = (process.env.ORPLEX_API_URL || process.env.NEXT_PUBLIC_API_BASE_URL || "")
    .trim()
    .replace(/\/+$/, "");
  return raw || DEFAULT_BACKEND;
}

/** Parse `orplex://auth?code=…` / `orplex://auth?error=…`. Null when unrelated. */
export function parseDesktopAuthUrl(raw: string | undefined | null): DesktopAuthPayload | null {
  if (!raw || !raw.toLowerCase().startsWith(`${PROTOCOL}://`)) return null;
  try {
    const u = new URL(raw);
    // orplex://auth?… → hostname "auth"; tolerate orplex:///auth?… too.
    const route = (u.hostname || u.pathname.replace(/^\/+/, "").split("/")[0] || "").toLowerCase();
    if (route !== "auth") return null;
    const code = u.searchParams.get("code") || undefined;
    const error = u.searchParams.get("error") || undefined;
    if (!code && !error) return null;
    return { code, error };
  } catch {
    return null;
  }
}

let getWindow: (() => BrowserWindow | null) | null = null;
let pending: DesktopAuthPayload | null = null;

function deliver(payload: DesktopAuthPayload): void {
  const win = getWindow?.();
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    win.webContents.send("orplex:auth-callback", payload);
  } else {
    // Renderer not ready yet (cold protocol launch) — the sign-in page asks
    // for it via orplex:auth-consume-pending once mounted.
    pending = payload;
  }
}

/** Handle a fresh `second-instance` argv (Windows/Linux protocol launch). */
export function handleDesktopAuthArgv(argv: string[]): void {
  for (const arg of argv) {
    const payload = parseDesktopAuthUrl(arg);
    if (payload) {
      deliver(payload);
      return;
    }
  }
}

export function registerDesktopAuth(windowGetter: () => BrowserWindow | null): void {
  getWindow = windowGetter;

  // Register the orplex:// handler. In dev (`electron .`) Windows needs the
  // script path too, otherwise the OS launches a bare electron.exe.
  try {
    if (process.defaultApp && process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
    } else {
      app.setAsDefaultProtocolClient(PROTOCOL);
    }
  } catch {
    // Best-effort: a failed registration only means the deep link can't wake
    // the app; the sign-in page surfaces that as a timeout/error.
  }

  // macOS delivers the URL via open-url instead of argv.
  app.on("open-url", (event, url) => {
    const payload = parseDesktopAuthUrl(url);
    if (payload) {
      event.preventDefault();
      deliver(payload);
    }
  });

  // Cold start on Windows/Linux: the protocol URL is in our own argv.
  for (const arg of process.argv) {
    const payload = parseDesktopAuthUrl(arg);
    if (payload) {
      pending = payload;
      break;
    }
  }

  // Renderer → main: open the backend's desktop sign-in start page in the
  // user's real browser (system browser = the user's existing OAuth session
  // and password manager, per RFC 8252).
  ipcMain.handle("orplex:auth-start", async (_e, provider: string) => {
    const p = provider === "github" ? "github" : "google";
    const url = `${backendOrigin()}/api/auth/desktop/start?provider=${p}`;
    try {
      await shell.openExternal(url);
      return { ok: true, url };
    } catch (err) {
      return { ok: false, error: (err as Error)?.message ?? "Could not open the browser" };
    }
  });

  // Renderer asks once on mount — covers callbacks that landed before the
  // sign-in page was listening (cold protocol launch, early second-instance).
  ipcMain.handle("orplex:auth-consume-pending", () => {
    const p = pending;
    pending = null;
    return p;
  });
}
