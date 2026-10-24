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
      /** Absolute path of a workspace folder by name (main-process fallback). */
      getPathForDirectory?: (name: string) => Promise<string>;
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
      /** True when the previous app session did not exit cleanly (crash recovery). */
      lastSessionCrashed?: () => Promise<boolean>;
      /** Packaged app version from package.json (update detection). */
      getAppVersion?: () => Promise<string>;
      /** In-app updates: user-consented check/download/install + status events. */
      updates?: {
        check: () => Promise<{ state: string; version?: string }>;
        download: () => Promise<{ state: string; version?: string }>;
        cancel: () => Promise<{ ok: boolean }>;
        install: () => Promise<{ ok: boolean }>;
        onStatus: (
          listener: (status: {
            state: string;
            version?: string;
            notes?: string;
            percent?: number;
            bytesPerSecond?: number;
            transferred?: number;
            total?: number;
            error?: string;
          }) => void
        ) => () => void;
      };
      /** Desktop sign-in: browser OAuth + orplex:// deep-link handoff. */
      auth?: {
        start: (provider: "google" | "github") => Promise<{
          ok: boolean;
          url?: string;
          error?: string;
        }>;
        onCallback: (
          listener: (payload: { code?: string; error?: string }) => void
        ) => () => void;
        consumePending: () => Promise<{ code?: string; error?: string } | null>;
      };
      /** On-device terminal (Electron only): real shell in the workspace folder. */
      terminal?: {
        exec: (args: { command: string; cwd?: string; timeoutMs?: number; streamId?: string }) => Promise<{
          ok: boolean;
          stdout?: string;
          stderr?: string;
          exitCode?: number;
          cwd?: string;
          timedOut?: boolean;
          error?: string;
        }>;
        onStream: (
          listener: (event: { streamId: string; type: string; text: string }) => void
        ) => () => void;
        serveStart: (args: { command: string; cwd?: string }) => Promise<{
          ok: boolean;
          id?: number;
          port?: number;
          url?: string;
          tail?: string;
          error?: string;
        }>;
        serveStop: (id: number) => Promise<{ ok: boolean; error?: string }>;
        serveList: () => Promise<{
          ok: boolean;
          servers?: Array<{ id: number; command: string; cwd: string; port: number; url: string | null; startedAt: number }>;
        }>;
      };
      /** Local-first conversation store (desktop only): on-device JSON file
       * in userData replaces the cloud for chat history CRUD. */
      conversations?: {
        list: () => Promise<
          Array<{
            id: string;
            title: string;
            workspaceName: string | null;
            createdAt: string;
            updatedAt: string;
            messages: { content: string }[];
          }>
        >;
        get: (id: string) => Promise<{
          id: string;
          title: string;
          workspaceName: string | null;
          createdAt: string;
          updatedAt: string;
          messages: { role: string; content: string; createdAt: string }[];
        } | null>;
        save: (
          input: {
            conversationId?: string | null;
            workspaceName?: string | null;
            messages: Array<{ role: string; content: string }>;
          }
        ) => Promise<{ conversationId: string } | { error: string }>;
        rename: (id: string, title: string) => Promise<boolean>;
        remove: (id: string) => Promise<boolean>;
        fork: (id: string) => Promise<{
          id: string;
          messages: { role: string; content: string; createdAt: string }[];
        } | null>;
        import: (
          list: unknown[]
        ) => Promise<{ imported: number; skipped: number }>;
        flush: () => Promise<boolean>;
      };
      /** MCP remote servers: OAuth 2.1 in main + Node-side JSON-RPC passthrough. */
      mcp?: {
        request: (params: {
          url: string;
          method?: string;
          headers?: Record<string, string>;
          body?: string;
        }) => Promise<{
          ok: boolean;
          status?: number;
          headers?: Record<string, string>;
          text?: string;
          error?: string;
        }>;
        oauthAuthorize: (params: {
          serverUrl: string;
          label?: string;
        }) => Promise<{
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
        }>;
        oauthRefresh: (params: {
          serverUrl: string;
          refreshToken: string;
          clientId: string;
          clientSecret?: string;
          tokenEndpoint?: string;
        }) => Promise<{
          ok: boolean;
          error?: string;
          accessToken?: string;
          refreshToken?: string;
          expiresIn?: number;
          tokenType?: string;
        }>;
        /** SDK flow: bind the 127.0.0.1 loopback BEFORE connect (exact redirect_uri). */
        oauthPrepare: () => Promise<{
          ok: boolean;
          redirectUri?: string;
          error?: string;
        }>;
        /** Open the auth URL in the system browser (never a webview). */
        oauthOpen: (authUrl: string) => Promise<{
          ok: boolean;
          error?: string;
        }>;
        /** Loopback caught ?code&state&iss — relay to POST /api/mcp/oauth/complete. */
        onOAuthCallback: (
          listener: (payload: {
            code?: string;
            state?: string;
            iss?: string;
            error?: string;
            error_description?: string;
          }) => void
        ) => () => void;
      };
    };
  }
}

export {};
