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
  /** App version from package.json (shown in Settings/About). */
  versions: {
    electron: process.versions.electron || "",
    chrome: process.versions.chrome || "",
    node: process.versions.node || "",
  },
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
    getId: () => ipcRenderer.invoke("agent-browser:get-id") as Promise<number>,
    navigate: (url: string) =>
      ipcRenderer.invoke("agent-browser:navigate", url) as Promise<{ ok: boolean; url?: string; title?: string; error?: string }>,
    read: () =>
      ipcRenderer.invoke("agent-browser:read") as Promise<Record<string, unknown>>,
    elements: () =>
      ipcRenderer.invoke("agent-browser:elements") as Promise<Record<string, unknown>>,
    interact: (action: { kind: string; selector?: string; text?: string; key?: string; amount?: number }) =>
      ipcRenderer.invoke("agent-browser:interact", action) as Promise<Record<string, unknown>>,
    console: () =>
      ipcRenderer.invoke("agent-browser:console") as Promise<{ ok: boolean; messages: Array<{ level: string; text: string; at: number }> }>,
    screenshot: () => ipcRenderer.invoke("agent-browser:screenshot") as Promise<string>,
    evaluate: (code: string) =>
      ipcRenderer.invoke("agent-browser:evaluate", code) as Promise<{ ok: boolean; result?: unknown; error?: string }>,
  },
});
