// Type declarations for the Electron desktop bridge (window.orplexDesktop,
// exposed by electron/preload.ts).

declare global {
  interface Window {
    orplexDesktop?: {
      isElectron: true;
      platform: string;
      openExternal: (url: string) => Promise<void>;
      /** Reveal a workspace folder in the OS file manager (Projects menu). */
      revealPath?: (path: string) => Promise<boolean>;
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
        /** Show a specific agent tab's view (multi-tab support). */
        showId: (viewId: number) => Promise<boolean>;
        getId: () => Promise<number>;
        navigate: (
          url: string
        ) => Promise<{ ok: boolean; url?: string; title?: string; error?: string }>;
        read: () => Promise<Record<string, unknown>>;
        elements: () => Promise<Record<string, unknown>>;
        /** click/type/press/scroll; click+type accept a browser_find ref instead of selector. */
        interact: (action: {
          kind: string;
          selector?: string;
          ref?: string;
          text?: string;
          key?: string;
          amount?: number;
        }) => Promise<Record<string, unknown>>;
        console: () => Promise<{
          ok: boolean;
          messages: Array<{ level: string; text: string; at: number }>;
        }>;
        /** Capture; opts add fullPage and named viewport (desktop/tablet/mobile). */
        screenshot: (opts?: {
          fullPage?: boolean;
          viewpoint?: string;
        }) => Promise<Record<string, unknown>>;
        evaluate: (code: string) => Promise<{ ok: boolean; result?: unknown; error?: string }>;
        /** Actionable elements with refs (e1..eN) for click/type/hover/select. */
        find: (filter?: { text?: string; role?: string }) => Promise<Record<string, unknown>>;
        waitFor: (args: {
          text?: string;
          selector?: string;
          time?: number;
          timeoutMs?: number;
        }) => Promise<Record<string, unknown>>;
        hover: (args: { selector?: string; ref?: string }) => Promise<Record<string, unknown>>;
        select: (args: { selector?: string; ref?: string; value: string }) => Promise<Record<string, unknown>>;
        /** list | new (url?) | switch (index) | close (index). */
        tabs: (args: { action?: string; url?: string; index?: number }) => Promise<Record<string, unknown>>;
        /** Failed requests (4xx/5xx + aborted) since session start. */
        network: () => Promise<Record<string, unknown>>;
      };
    };
  }
}

export {};
