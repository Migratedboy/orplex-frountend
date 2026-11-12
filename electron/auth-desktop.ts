// electron/auth-desktop.ts — desktop sign-in via custom protocol (orplex://).
//
// Browser OAuth cannot hand a session back to the desktop app: the provider
// callback lands on the cloud domain, so the session cookie never reaches the
// app's own origin. The deep-link handoff fixes that:
//
//   1. The renderer asks the main process to open the SYSTEM browser at the
//      MEDIATOR SITE's login page (`ORPLEX_AUTH_URL`, default
//      https://orplex-code.vercel.app/login?app=auth).
//   2. The site owns the whole OAuth round-trip (GitHub/Google/email magic
//      link — NEXTAUTH_URL and the provider redirect URIs live there), so
//      the session cookie lands on the site origin. When the page was opened
//      in app mode, its JS mints a short-lived one-time token at
//      /api/auth/desktop/link (proxied to the backend) and navigates to
//      `orplex://auth?code=<token>` (or `?error=<reason>`).
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
/** The mediator site's login page in app mode — where desktop sign-in starts. */
const DEFAULT_AUTH_URL = "https://orplex-code.vercel.app/login?app=auth";

export interface DesktopAuthPayload {
  code?: string;
  error?: string;
}

/**
 * Kept for reference — desktop sign-in no longer starts on the backend (the
 * mediator site does, see authOrigin). The backend origin still drives ALL
 * other app API traffic via the local proxy (ORPLEX_API_URL).
 */

/**
 * Where desktop sign-in STARTS: the mediator site, not the backend. The
 * site's OAuth round-trip (and the provider-registered redirect URIs) live
 * on orplex-code.vercel.app — starting on the backend would put the
 * provider's state cookies on the wrong origin and kill the flow. Override
 * with ORPLEX_AUTH_URL (shipped in electron/app-config.json as authUrl).
 */
function authOrigin(): string {
  const raw = (process.env.ORPLEX_AUTH_URL || "").trim().replace(/\/+$/, "");
  return raw || DEFAULT_AUTH_URL;
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

  // Renderer → main: open the mediator site's sign-in page in the user's
  // real browser (system browser = the user's existing OAuth session and
  // password manager, per RFC 8252). The site handles ALL providers
  // (GitHub / Google / email) in one UI, so `provider` is ignored here.
  ipcMain.handle("orplex:auth-start", async (_e, provider: string) => {
    void provider; // site page offers every provider; kept for IPC compatibility
    const url = authOrigin();
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
