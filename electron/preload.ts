/**
 * electron/preload.ts — secure bridge between the app and Electron.
 *
 * With contextIsolation on, the renderer has no Node access. This exposes a
 * minimal, explicitly-enumerated API only.
 */
import { contextBridge, ipcRenderer, webUtils } from "electron";

contextBridge.exposeInMainWorld("orplexDesktop", {
  /** True when running inside the Electron shell (vs a plain browser). */
  isElectron: true,
  platform: process.platform,
  /** Ask the main process to open an external http(s) link in the OS browser. */
  openExternal: (url: string) => ipcRenderer.invoke("orplex:open-external", url),
  /** Resolve the absolute filesystem path of a File (File System Access API). */
  getPathForFile: (file: File) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },
  /**
   * Fallback for the workspace path: webUtils.getPathForFile needs a File the
   * renderer obtained from a real handle, which can come back empty for a
   * probe file. The main process then asks natively with a folder NAME
   * (unique per device in practice) so folder-open can still register an
   * absolute cwd. Empty string when unresolvable — never a guess.
   */
  getPathForDirectory: (name: string) =>
    ipcRenderer.invoke("orplex:path-for-directory", name) as Promise<string>,
  /** App version from package.json (shown in Settings/About). */
  versions: {
    electron: process.versions.electron || "",
    chrome: process.versions.chrome || "",
    node: process.versions.node || "",
  },
  /**
   * Crash recovery: true when the previous session did not exit cleanly
   * (crash / force-kill / power loss). The renderer offers to recover.
   */
  lastSessionCrashed: () =>
    ipcRenderer.invoke("orplex:last-session-crashed") as Promise<boolean>,
  /** Packaged app version (package.json "version") for update detection. */
  getAppVersion: () =>
    ipcRenderer.invoke("orplex:app-version") as Promise<string>,
  /**
   * IN-APP UPDATES: user-consented download flow (available → downloading w/
   * progress + cancel → downloaded → restart). All UI lives in the renderer
   * (UpdateToast); main only checks/downloads/installs on explicit calls.
   */
  updates: {
    check: () => ipcRenderer.invoke("orplex:update-check") as Promise<{ state: string; version?: string }>,
    download: () => ipcRenderer.invoke("orplex:update-download") as Promise<{ state: string; version?: string }>,
    cancel: () => ipcRenderer.invoke("orplex:update-cancel") as Promise<{ ok: boolean }>,
    install: () => ipcRenderer.invoke("orplex:update-install") as Promise<{ ok: boolean }>,
    /** update-status events from main (checking/available/downloading/downloaded/error). */
    onStatus: (listener: (status: {
      state: string;
      version?: string;
      notes?: string;
      percent?: number;
      bytesPerSecond?: number;
      transferred?: number;
      total?: number;
      error?: string;
    }) => void) => {
      const wrapped = (_e: unknown, payload: {
        state: string;
        version?: string;
        notes?: string;
        percent?: number;
        bytesPerSecond?: number;
        transferred?: number;
        total?: number;
        error?: string;
      }) => listener(payload);
      ipcRenderer.on("orplex:update-status", wrapped);
      return () => ipcRenderer.removeListener("orplex:update-status", wrapped);
    },
  },
  /** Reveal a workspace folder in the OS file manager (Projects menu). */
  revealPath: (path: string) =>
    ipcRenderer.invoke("orplex:reveal-path", path) as Promise<boolean>,
  /**
   * REAL-BROWSER PREVIEW: the main process renders preview tabs as genuine
   * Chromium WebContentsViews layered above this window (isolated
   * persist:orplex-preview profile). The renderer positions them over the
   * RightPanel viewport and drives them through this bridge.
   */
  preview: {
    createTab: () => ipcRenderer.invoke("preview:create-tab") as Promise<number>,
    navigate: (tabId: number, url: string) =>
      ipcRenderer.invoke("preview:navigate", tabId, url) as Promise<boolean>,
    setBounds: (
      tabId: number,
      rect: { x: number; y: number; width: number; height: number }
    ) => ipcRenderer.invoke("preview:set-bounds", tabId, rect) as Promise<boolean>,
    showTab: (tabId: number | null) =>
      ipcRenderer.invoke("preview:show-tab", tabId) as Promise<boolean>,
    closeTab: (tabId: number) =>
      ipcRenderer.invoke("preview:close-tab", tabId) as Promise<boolean>,
    goBack: (tabId: number) => ipcRenderer.invoke("preview:go-back", tabId) as Promise<boolean>,
    goForward: (tabId: number) =>
      ipcRenderer.invoke("preview:go-forward", tabId) as Promise<boolean>,
    reload: (tabId: number) => ipcRenderer.invoke("preview:reload", tabId) as Promise<boolean>,
    stop: (tabId: number) => ipcRenderer.invoke("preview:stop", tabId) as Promise<boolean>,
    screenshot: (tabId: number) =>
      ipcRenderer.invoke("preview:screenshot", tabId) as Promise<string | null>,
    diag: () => ipcRenderer.invoke("preview:diag") as Promise<unknown>,
    /** Navigation / loading / title events from main. */
    onEvent: (listener: (event: { type: string; [k: string]: unknown }) => void) => {
      const wrapped = (_e: unknown, payload: { type: string; [k: string]: unknown }) =>
        listener(payload);
      ipcRenderer.on("preview:event", wrapped);
      return () => ipcRenderer.removeListener("preview:event", wrapped);
    },
  },
  /**
   * AGENT BROWSER: the AI's own real browser session. Exposed to the app
   * renderer so agent tools (via /api/agent/browser-command) can drive a
   * genuine Chromium — navigate, read page state, click, type, screenshot,
   * and capture console output.
   */
  agentBrowser: {
    show: () => ipcRenderer.invoke("agent-browser:show") as Promise<number>,
    showId: (viewId: number) => ipcRenderer.invoke("agent-browser:show-id", viewId) as Promise<boolean>,
    getId: () => ipcRenderer.invoke("agent-browser:get-id") as Promise<number>,
    navigate: (url: string) =>
      ipcRenderer.invoke("agent-browser:navigate", url) as Promise<{ ok: boolean; url?: string; title?: string; error?: string }>,
    read: () =>
      ipcRenderer.invoke("agent-browser:read") as Promise<Record<string, unknown>>,
    elements: () =>
      ipcRenderer.invoke("agent-browser:elements") as Promise<Record<string, unknown>>,
    interact: (action: { kind: string; selector?: string; ref?: string; text?: string; key?: string; amount?: number }) =>
      ipcRenderer.invoke("agent-browser:interact", action) as Promise<Record<string, unknown>>,
    console: () =>
      ipcRenderer.invoke("agent-browser:console") as Promise<{ ok: boolean; messages: Array<{ level: string; text: string; at: number }> }>,
    screenshot: (opts?: { fullPage?: boolean; viewpoint?: string }) =>
      ipcRenderer.invoke("agent-browser:screenshot-advanced", opts ?? {}) as Promise<Record<string, unknown>>,
    evaluate: (code: string) =>
      ipcRenderer.invoke("agent-browser:evaluate", code) as Promise<{ ok: boolean; result?: unknown; error?: string }>,
    find: (filter?: { text?: string; role?: string }) =>
      ipcRenderer.invoke("agent-browser:find", filter ?? {}) as Promise<Record<string, unknown>>,
    waitFor: (args: { text?: string; selector?: string; time?: number; timeoutMs?: number }) =>
      ipcRenderer.invoke("agent-browser:wait-for", args) as Promise<Record<string, unknown>>,
    hover: (args: { selector?: string; ref?: string }) =>
      ipcRenderer.invoke("agent-browser:hover", args) as Promise<Record<string, unknown>>,
    select: (args: { selector?: string; ref?: string; value: string }) =>
      ipcRenderer.invoke("agent-browser:select", args) as Promise<Record<string, unknown>>,
    tabs: (args: { action?: string; url?: string; index?: number }) =>
      ipcRenderer.invoke("agent-browser:tabs", args) as Promise<Record<string, unknown>>,
    network: () => ipcRenderer.invoke("agent-browser:network") as Promise<Record<string, unknown>>,
  },
  /**
   * ON-DEVICE TERMINAL: the main process runs commands in the user's real
   * workspace folder (cloud lanes would run on Vercel instead). One-shot
   * exec streams live chunks; the serve lane tracks detached dev servers.
   */
  terminal: {
    exec: (args: { command: string; cwd?: string; timeoutMs?: number; streamId?: string }) =>
      ipcRenderer.invoke("terminal:exec", args) as Promise<{
        ok: boolean;
        stdout?: string;
        stderr?: string;
        exitCode?: number;
        cwd?: string;
        timedOut?: boolean;
        error?: string;
      }>,
    /** Live output chunks for a streamId passed to exec. */
    onStream: (
      listener: (event: { streamId: string; type: string; text: string }) => void
    ) => {
      const wrapped = (
        _e: unknown,
        payload: { streamId: string; type: string; text: string }
      ) => listener(payload);
      ipcRenderer.on("terminal:stream", wrapped);
      return () => ipcRenderer.removeListener("terminal:stream", wrapped);
    },
    serveStart: (args: { command: string; cwd?: string }) =>
      ipcRenderer.invoke("terminal:serve-start", args) as Promise<{
        ok: boolean;
        id?: number;
        port?: number;
        url?: string;
        tail?: string;
        error?: string;
      }>,
    serveStop: (id: number) =>
      ipcRenderer.invoke("terminal:serve-stop", { id }) as Promise<{ ok: boolean; error?: string }>,
    serveList: () =>
      ipcRenderer.invoke("terminal:serve-list") as Promise<{
        ok: boolean;
        servers?: Array<{ id: number; command: string; cwd: string; port: number; url: string | null; startedAt: number }>;
      }>,
  },
  /**
   * MCP REMOTE SERVERS: OAuth 2.1 flows run in the main process (discovery,
   * dynamic client registration, browser sign-in with a 127.0.0.1 loopback
   * callback, token exchange/refresh) and MCP JSON-RPC goes through a
   * Node-side passthrough so remote servers' CORS can never block the app.
   */
  /**
   * DESKTOP SIGN-IN: the renderer opens the backend's OAuth start page in
   * the user's real browser; the backend deep-links back to orplex://auth
   * with a one-time code, which the main process relays here. The renderer
   * exchanges the code for a same-origin session cookie.
   */
  auth: {
    start: (provider: "google" | "github") =>
      ipcRenderer.invoke("orplex:auth-start", provider) as Promise<{
        ok: boolean;
        url?: string;
        error?: string;
      }>,
    /** Fires when the OS hands the app an orplex://auth callback. */
    onCallback: (listener: (payload: { code?: string; error?: string }) => void) => {
      const wrapped = (_e: unknown, payload: { code?: string; error?: string }) =>
        listener(payload);
      ipcRenderer.on("orplex:auth-callback", wrapped);
      return () => ipcRenderer.removeListener("orplex:auth-callback", wrapped);
    },
    /** Drain a callback that arrived before the sign-in page mounted. */
    consumePending: () =>
      ipcRenderer.invoke("orplex:auth-consume-pending") as Promise<{
        code?: string;
        error?: string;
      } | null>,
  },
  mcp: {
    request: (params: { url: string; method?: string; headers?: Record<string, string>; body?: string }) =>
      ipcRenderer.invoke("orplex:mcp-request", params) as Promise<{
        ok: boolean;
        status?: number;
        headers?: Record<string, string>;
        text?: string;
        error?: string;
      }>,
    oauthAuthorize: (params: { serverUrl: string; label?: string }) =>
      ipcRenderer.invoke("orplex:mcp-oauth-authorize", params) as Promise<{
        ok: boolean;
        error?: string;
        accessToken?: string;
        refreshToken?: string;
        expiresIn?: number;
        tokenType?: string;
        scope?: string;
        clientId?: string;
        clientSecret?: string;
        tokenEndpoint?: string;
        serverUrl?: string;
      }>,
    oauthRefresh: (params: {
      serverUrl: string;
      refreshToken: string;
      clientId: string;
      clientSecret?: string;
      tokenEndpoint?: string;
    }) =>
      ipcRenderer.invoke("orplex:mcp-oauth-refresh", params) as Promise<{
        ok: boolean;
        error?: string;
        accessToken?: string;
        refreshToken?: string;
        expiresIn?: number;
        tokenType?: string;
      }>,
    /** SDK flow: bind the 127.0.0.1 loopback BEFORE connect (exact redirect_uri). */
    oauthPrepare: () =>
      ipcRenderer.invoke("orplex:mcp-oauth-prepare") as Promise<{
        ok: boolean;
        redirectUri?: string;
        error?: string;
      }>,
    /** Open the auth URL in the system browser (never a webview). */
    oauthOpen: (authUrl: string) =>
      ipcRenderer.invoke("orplex:mcp-oauth-open", { authUrl }) as Promise<{
        ok: boolean;
        error?: string;
      }>,
    /** Loopback caught ?code&state&iss — relay to POST /api/mcp/oauth/complete. */
    onOAuthCallback: (
      listener: (payload: { code?: string; state?: string; iss?: string; error?: string; error_description?: string }) => void
    ) => {
      const wrapped = (_e: unknown, payload: { code?: string; state?: string; iss?: string; error?: string; error_description?: string }) =>
        listener(payload);
      ipcRenderer.on("orplex:mcp-oauth-callback", wrapped);
      return () => ipcRenderer.removeListener("orplex:mcp-oauth-callback", wrapped);
    },
  },
});
