// Type declarations for the Electron desktop bridge (window.orplexDesktop,
// exposed by electron/preload.ts).

declare global {
  interface Window {
    orplexDesktop?: {
      isElectron: true;
      platform: string;
      openExternal: (url: string) => Promise<void>;
      /** Resolve the absolute filesystem path of a File (Electron only). */
      getPathForFile?: (file: File) => string;
      versions: { electron: string; chrome: string; node: string };
      /** Real-browser preview (Electron only): native WebContentsView tabs. */
      preview?: {
        createTab: () => Promise<number>;
        navigate: (tabId: number, url: string) => Promise<boolean>;
        setBounds: (
          tabId: number,
          rect: { x: number; y: number; width: number; height: number }
        ) => Promise<boolean>;
        showTab: (tabId: number | null) => Promise<boolean>;
        closeTab: (tabId: number) => Promise<boolean>;
        goBack: (tabId: number) => Promise<boolean>;
        goForward: (tabId: number) => Promise<boolean>;
        reload: (tabId: number) => Promise<boolean>;
        stop: (tabId: number) => Promise<boolean>;
        screenshot: (tabId: number) => Promise<string | null>;
        diag: () => Promise<unknown>;
        onEvent: (
          listener: (event: { type: string; [key: string]: unknown }) => void
        ) => () => void;
      };
      /** The AI's own real browser session (agent tools drive this). */
      agentBrowser?: {
        show: () => Promise<number>;
        getId: () => Promise<number>;
        navigate: (
          url: string
        ) => Promise<{ ok: boolean; url?: string; title?: string; error?: string }>;
        read: () => Promise<Record<string, unknown>>;
        elements: () => Promise<Record<string, unknown>>;
        interact: (action: {
          kind: string;
          selector?: string;
          text?: string;
          key?: string;
          amount?: number;
        }) => Promise<Record<string, unknown>>;
        console: () => Promise<{
          ok: boolean;
          messages: Array<{ level: string; text: string; at: number }>;
        }>;
        screenshot: () => Promise<string>;
        evaluate: (code: string) => Promise<{ ok: boolean; result?: unknown; error?: string }>;
      };
    };
  }
}

export {};
