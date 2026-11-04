"use client";

/* eslint-disable @next/next/no-img-element -- Browser-tab favicons are resolved from arbitrary tool URLs; next/image needs a remotePatterns allowlist. */

/**
 * preview-tab.tsx — the embedded-browser Preview tab, extracted verbatim from
 * RightPanel.tsx (Operation Modularity). Owns the Chrome-style tab strip, the
 * omnibox, the native WebContentsView bridge (preview:* IPC) and the agent
 * browser tab mirroring. Pure URL helpers live here too; the Electron side of
 * the same contract is electron/preview-views.ts + preview-logic.ts.
 */
import { useState, useEffect, useCallback, useRef } from "react";
import { apiFetch } from "@/lib/api-base";

// === Preview Tab — embedded browser (Chrome-style) ===
// NATIVE ONLY: every page renders in a real Chromium WebContentsView owned by
// the Electron main process (isolated persist:orplex-preview profile), driven
// over IPC. Real Chromium = real Google (with the real Google UI), real
// sites with zero X-Frame-Options problems, working HMR websockets for
// localhost dev servers, service workers, downloads — everything a real
// browser does. There is deliberately NO iframe/proxy fallback: inside the
// desktop shell it was the source of broken pages (rewriting bugs, bot-wall
// interstitials, dead HMR) and outside it nothing works at all.

interface BrowserTab {
  id: number;
  history: string[];
  index: number; // position in history
  title: string;
}

/** Reserved id for the agent's own browser tab (never from nextTabId). */
const AGENT_TAB_ID = 999999;

const HOME_SUGGESTIONS = [
  { label: "3000", url: "http://localhost:3000" },
  { label: "5173", url: "http://localhost:5173" },
  { label: "8080", url: "http://localhost:8080" },
  { label: "4200", url: "http://localhost:4200" },
];

function faviconFor(u: string): string {
  try {
    const host = new URL(u).hostname;
    if (!host || host === window.location.hostname) return "";
    return `https://www.google.com/s2/favicons?domain=${host}&sz=32`;
  } catch {
    return "";
  }
}

function displayUrl(u: string): string {
  try {
    const parsed = new URL(u);
    const path = parsed.pathname === "/" ? "" : parsed.pathname;
    return `${parsed.hostname}${path}${parsed.search}`;
  } catch {
    return u;
  }
}

/**
 * Omnipresent URL normalization, exactly like Chrome's omnibox: search terms
 * → a real Google search, bare hosts → https, localhost/IP → http. The
 * native Chromium view has real browser fingerprints, so Google serves the
 * genuine search UI — no bot walls, no server-rendered stand-ins.
 */
function toNavigateUrl(input: string): string {
  const u = input.trim();
  if (!u) return "";
  if (/^https?:\/\//i.test(u)) return u;
  if (/^localhost(:\d+)?(\/|$)/i.test(u) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(u)) {
    return `http://${u}`;
  }
  // Looks like a domain (has a dot + valid chars) → https, else web search.
  if (/^[\w-]+(\.[\w-]+)+(\/|$)/.test(u)) return `https://${u}`;
  return `https://www.google.com/search?q=${encodeURIComponent(u)}`;
}

const BrowserPreviewInner = ({ panelActive }: { panelActive: boolean }) => {
  const [tabs, setTabs] = useState<BrowserTab[]>([{ id: 1, history: [], index: -1, title: "New Tab" }]);
  const [activeId, setActiveId] = useState(1);
  const [omnibox, setOmnibox] = useState("");
  const [omniboxFocused, setOmniboxFocused] = useState(false);
  const [loading, setLoading] = useState(false);
  const [agentDriven, setAgentDriven] = useState(false);
  // Take over / Watch only: when the agent drives the tab, the user can
  // pause the mirroring (Take over) so their navigation isn't yanked back
  // by the next preview event, or hand control back (Watch only).
  const [watchMode, setWatchMode] = useState<"watch" | "takeover">("watch");
  const watchModeRef = useRef(watchMode);
  watchModeRef.current = watchMode;
  const [nextTabId, setNextTabId] = useState(2);
  // Native load failure — surfaced by the main process's did-fail-load event
  // (real Chromium error codes, no probing required).
  const [loadError, setLoadError] = useState<{ title: string; hint: string } | null>(null);
  // Live local dev servers (probed server-side via TCP): the new-tab page
  // marks ports with a real listener so the user opens the REAL localhost
  // preview of the server running on their machine, not a guess.
  const [homePorts, setHomePorts] = useState(
    HOME_SUGGESTIONS.map(s => ({ ...s, live: false }))
  );
  useEffect(() => {
    let alive = true;
    const probe = () => {
      apiFetch("/api/localhost-probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ports: HOME_SUGGESTIONS.map(s => parseInt(s.label, 10)) }),
      })
        .then(r => r.json())
        .then(d => {
          if (!alive || !Array.isArray(d?.live)) return;
          const liveSet = new Set<number>(d.live);
          setHomePorts(HOME_SUGGESTIONS.map(s => ({
            ...s,
            live: liveSet.has(parseInt(s.label, 10)),
          })));
        })
        .catch(() => {});
    };
    probe();
    const iv = setInterval(probe, 10_000);
    return () => { alive = false; clearInterval(iv); };
  }, []);

  // === NATIVE PREVIEW (Electron) ===
  // The "viewport" is a placeholder div: the real pixels come from a
  // Chromium WebContentsView owned by the main process, positioned over the
  // placeholder via IPC. Real browser = real devtools semantics, HMR
  // websockets, service workers, no X-Frame-Options games.
  const native = typeof window !== "undefined" ? window.orplexDesktop?.preview ?? null : null;
  const nativeMapRef = useRef<Map<number, number>>(new Map()); // renderer tabId -> main view id
  const viewportRef = useRef<HTMLDivElement>(null);
  // The agent's dedicated browser view. Its id arrives via the
  // orplex:agent-browser-tab window event (fired by the worker's browser
  // tools); events from that view update the AGENT tab, not the user's.
  const [agentViewId, setAgentViewId] = useState<number | null>(null);
  const agentViewIdRef = useRef<number | null>(null);
  agentViewIdRef.current = agentViewId;
  const agentTabIdRef = useRef<number | null>(null);

  // Latest navigateTo for event subscriptions that must always act on the
  // currently-active tab (agent preview events arrive async).
  const navigateRef = useRef<(raw: string, opts?: { replace?: boolean }) => void>(() => {});
  const activeIdRef = useRef(1);
  activeIdRef.current = activeId;

  /** Get (lazily create) the main-process view backing a renderer tab. */
  const ensureNativeTab = useCallback(
    async (tabId: number): Promise<number | null> => {
      if (!native) return null;
      const existing = nativeMapRef.current.get(tabId);
      if (existing !== undefined) return existing;
      const mainId = await native.createTab();
      nativeMapRef.current.set(tabId, mainId);
      return mainId;
    },
    [native]
  );

  const activeTab = tabs.find(t => t.id === activeId) ?? tabs[0];
  const currentUrl = activeTab?.history[activeTab.index] || "";

  // Omnibox mirrors the current page URL unless the user is editing it.
  useEffect(() => {
    if (!omniboxFocused) setOmnibox(displayUrl(currentUrl));
  }, [currentUrl, omniboxFocused]);

  // Live agent preview: when the agent calls preview_browser or
  // take_screenshot, navigate the ACTIVE tab to the target URL.
  useEffect(() => {
    let unsubscribe: (() => void) | null = null;
    let alive = true;
    import("@/lib/background-worker").then(({ onPreviewEvent }) => {
      if (!alive) return;
      unsubscribe = onPreviewEvent((event) => {
        setAgentDriven(true);
        // Watch only = mirror the agent's navigation. Take over = leave the
        // page where the user put it, but keep the badge visible so they
        // know the agent is still browsing.
        if (watchModeRef.current === "watch") {
          navigateRef.current(event.url, { replace: true });
        }
      });
    }).catch(() => {});
    return () => {
      alive = false;
      unsubscribe?.();
    };
  }, []);

  // === Native preview plumbing (Electron only) ===
  // The worker's browser tools announce the agent view id + ask the panel to
  // show the agent tab. Creating the renderer tab here keeps state in sync.
  useEffect(() => {
    if (!native) return;
    const handler = async () => {
      try {
        const viewId = await (window.orplexDesktop!.agentBrowser!.getId());
        setAgentViewId(viewId);
        setTabs(prev => {
          const existing = prev.find(t => t.id === AGENT_TAB_ID);
          if (existing) return prev;
          return [...prev, { id: AGENT_TAB_ID, history: [], index: -1, title: "Agent Browser" }];
        });
        setActiveId(AGENT_TAB_ID);
        // Map renderer tab → view so visibility/bounds effects target it.
        agentViewIdRef.current = viewId;
        const map = nativeMapRef.current;
        if (!map.has(AGENT_TAB_ID)) map.set(AGENT_TAB_ID, viewId);
        agentTabIdRef.current = AGENT_TAB_ID;
      } catch {}
    };
    window.addEventListener("orplex:agent-browser-tab", handler);
    return () => window.removeEventListener("orplex:agent-browser-tab", handler);
  }, [native]);

  // Mirror main-process navigation/loading/title events into tab state.
  useEffect(() => {
    if (!native) return;
    const off = native.onEvent((event) => {
      // Attribute the event to the right renderer tab by view id: the agent
      // view's events go to the AGENT tab; everything else to the active tab.
      const isAgent = agentViewIdRef.current !== null && event.viewId === agentViewIdRef.current;
      const tabId = isAgent ? AGENT_TAB_ID : activeIdRef.current;
      switch (event.type) {
        case "navigated": {
          const url = String(event.url || "");
          if (!url || url === "about:blank") return;
          setTabs(prev => prev.map(t => {
            if (t.id !== tabId) return t;
            const cur = t.history[t.index] || "";
            // In-page anchors: replace, don't grow history.
            if (event.inPage) {
              const history = [...t.history.slice(0, t.index), url];
              return { ...t, history, index: history.length - 1 };
            }
            if (cur === url) return t;
            // The renderer already pushed this URL for explicit navigations.
            const history = cur ? [...t.history.slice(0, t.index + 1), url] : [url];
            return { ...t, history, index: history.length - 1, title: displayUrl(url) };
          }));
          break;
        }
        case "loading":
          setLoading(Boolean(event.loading));
          if (event.loading) setLoadError(null);
          break;
        case "did-fail-load": {
          // Real Chromium failure (DNS, refused connection, SSL). Map the
          // common error codes to honest, actionable copy.
          const code = Number(event.errorCode);
          if (code === -3) break; // ERR_ABORTED — navigation superseded, not a failure
          setLoadError(nativeLoadFailure(code, String(event.url || "")));
          break;
        }
        case "title-updated": {
          const title = String(event.title || "").slice(0, 40);
          if (title) setTabs(prev => prev.map(t => (t.id === tabId ? { ...t, title } : t)));
          break;
        }
        case "window-open": {
          // target=_blank inside a preview page → open as a new preview tab
          const url = String(event.url || "");
          if (url) navigateRef.current(url);
          break;
        }
      }
    });
    return off;
  }, [native]);

  // Keep the native view positioned over the viewport placeholder.
  useEffect(() => {
    if (!native) return;
    // Coalesce to one sync per frame. The listener was a raw capture-phase
    // window handler, so scrolling the message list fired it at the display
    // refresh rate — and each call did a forced getBoundingClientRect() plus
    // an IPC round-trip to the Electron main process. That is up to ~120
    // setBounds messages per second.
    let raf = 0;
    const sync = () => {
      if (raf) return; // already scheduled this frame
      raf = requestAnimationFrame(() => {
        raf = 0;
        const el = viewportRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const mainId = nativeMapRef.current.get(activeIdRef.current);
        if (mainId === undefined) return;
        void native.setBounds(mainId, {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        });
      });
    };
    sync();
    const ro = new ResizeObserver(sync);
    if (viewportRef.current) ro.observe(viewportRef.current);
    window.addEventListener("scroll", sync, true);
    window.addEventListener("resize", sync);
    const iv = setInterval(sync, 500); // layout shifts without resize events
    return () => {
      ro.disconnect();
      window.removeEventListener("scroll", sync, true);
      window.removeEventListener("resize", sync);
      clearInterval(iv);
      // Cancel a frame that was scheduled but never ran, so it can't fire
      // setBounds against an unmounted native view.
      if (raf) cancelAnimationFrame(raf);
    };
  }, [native]);

  // Show/hide native views: visible only while the browser tab is active
  // AND the whole panel is open (panelActive encodes both).
  useEffect(() => {
    if (!native) return;
    const mainId = nativeMapRef.current.get(activeId);
    void native.showTab(panelActive ? mainId ?? null : null);
  }, [native, activeId, panelActive, tabs]);

  // Destroy all native views when the component unmounts (panel teardown).
  useEffect(() => {
    if (!native) return;
    const map = nativeMapRef.current;
    return () => {
      for (const mainId of map.values()) void native.closeTab(mainId);
      map.clear();
    };
  }, [native]);

  /** Core navigation: pushes onto the active tab's history (or replaces the current entry). */
  const navigateTo = useCallback((raw: string, opts: { replace?: boolean } = {}) => {
    const target = toNavigateUrl(raw);
    if (!target) return;
    setTabs(prev => prev.map(t => {
      if (t.id !== activeId) return t;
      if (opts.replace) {
        const history = [...t.history.slice(0, t.index), target];
        return { ...t, history, index: history.length - 1 };
      }
      const history = [...t.history.slice(0, t.index + 1), target];
      return { ...t, history, index: history.length - 1, title: displayUrl(target) };
    }));
    setLoading(true);
    setLoadError(null); // explicit navigation re-arms failure display
    // Native: load the REAL URL in the isolated WebContentsView.
    if (!native) return;
    void ensureNativeTab(activeId).then(mainId => {
      if (mainId === null) return;
      void native.navigate(mainId, target);
    });
  }, [activeId, native, ensureNativeTab]);
  navigateRef.current = navigateTo;

  const canBack = activeTab && activeTab.index > 0;
  const canForward = activeTab && activeTab.index < activeTab.history.length - 1;

  const go = (delta: number) => {
    if (!activeTab) return;
    const next = activeTab.index + delta;
    if (next < 0 || next >= activeTab.history.length) return;
    setTabs(prev => prev.map(t => (t.id === activeId ? { ...t, index: next } : t)));
    setLoading(true);
    setLoadError(null);
    const mainId = nativeMapRef.current.get(activeId);
    if (mainId !== undefined && native) void (delta < 0 ? native.goBack(mainId) : native.goForward(mainId));
  };

  const reload = () => {
    if (!currentUrl || !native) return;
    setLoading(true);
    setLoadError(null);
    const mainId = nativeMapRef.current.get(activeId);
    if (mainId !== undefined) void native.reload(mainId);
  };

  const newTab = () => {
    const id = nextTabId;
    setNextTabId(id + 1);
    setTabs(prev => [...prev, { id, history: [], index: -1, title: "New Tab" }]);
    setActiveId(id);
    setOmnibox("");
  };

  const closeTab = (id: number) => {
    if (native) {
      const mainId = nativeMapRef.current.get(id);
      if (mainId !== undefined) {
        void native.closeTab(mainId);
        nativeMapRef.current.delete(id);
      }
    }
    const rest = tabs.filter(t => t.id !== id);
    if (rest.length === 0) {
      // Fresh replacement tab, and CONSUME its id. The old code minted the
      // replacement from nextTabId without bumping it, so the next "+"
      // minted a SECOND tab with the same id ("Encountered two children
      // with the same key: 2") and the two tabs then fought over one
      // navigation history.
      setTabs([{ id: nextTabId, history: [], index: -1, title: "New Tab" }]);
      setNextTabId(nextTabId + 1);
      if (activeId === id) setActiveId(nextTabId);
      return;
    }
    setTabs(rest);
    if (activeId === id) {
      setActiveId(rest[rest.length - 1]!.id);
    }
  };

  const isSecure = currentUrl.startsWith("https://");
  const showNewTabPage = !currentUrl;

  return (
    <div className="rp-browser">
      {/* Tab strip */}
      <div className="rp-browser-tabs">
        {tabs.map(t => {
          const tUrl = t.history[t.index] || "";
          return (
            <div
              key={t.id}
              className={`rp-browser-tab ${t.id === activeId ? "rp-browser-tab-active" : ""}`}
              onClick={() => {
                if (t.id === activeId) return;
                setActiveId(t.id);
              }}
              title={t.title}
            >
              {tUrl && faviconFor(tUrl) ? (
                <img className="rp-browser-favicon" src={faviconFor(tUrl)} alt="" width={14} height={14} />
              ) : (
                <span className="rp-browser-favicon rp-browser-favicon-empty" />
              )}
              <span className="rp-browser-tab-title">{t.title}</span>
              <button
                className="rp-browser-tab-close"
                aria-label="Close tab"
                onClick={(e) => { e.stopPropagation(); closeTab(t.id); }}
              >×</button>
            </div>
          );
        })}
        <button className="rp-browser-newtab" aria-label="New tab" onClick={newTab}>+</button>
      </div>

      {/* Toolbar */}
      <div className="rp-browser-toolbar">
        <button className="rp-browser-btn" disabled={!canBack} onClick={() => go(-1)} title="Back" aria-label="Back">←</button>
        <button className="rp-browser-btn" disabled={!canForward} onClick={() => go(1)} title="Forward" aria-label="Forward">→</button>
        <button className="rp-browser-btn" onClick={reload} title="Reload" aria-label="Reload">⟳</button>
        <button
          className="rp-browser-btn"
          onClick={() => {
            if (!currentUrl) return;
            // Hand the REAL page to the OS default browser (shell.openExternal).
            if (window.orplexDesktop?.openExternal) { window.orplexDesktop.openExternal(currentUrl); }
            else window.open(currentUrl, "_blank", "noopener");
          }}
          disabled={!currentUrl}
          title="Open this page in your real browser"
          aria-label="Open in real browser"
        >↗</button>
        <div className={`rp-browser-omnibox ${omniboxFocused ? "rp-browser-omnibox-focus" : ""}`}>
          <span
            className={`rp-browser-shield ${isSecure ? "rp-browser-shield-secure" : "rp-browser-shield-insecure"}`}
            title={isSecure ? "Connection is secure" : "Not secure"}
          >
            {isSecure ? "🔒" : "⚠"}
          </span>
          <input
            className="rp-browser-url"
            value={omnibox}
            onChange={e => setOmnibox(e.target.value)}
            onFocus={e => { setOmniboxFocused(true); e.currentTarget.select(); }}
            onBlur={() => setOmniboxFocused(false)}
            onKeyDown={e => {
              if (e.key === "Enter") {
                setOmniboxFocused(false);
                e.currentTarget.blur();
                navigateTo(omnibox);
              }
              if (e.key === "Escape") {
                setOmniboxFocused(false);
                setOmnibox(currentUrl);
                e.currentTarget.blur();
              }
            }}
            placeholder="Search the web or type a URL"
            spellCheck={false}
          />
          {agentDriven && (
            watchMode === "watch" ? (
              <button
                className="rp-preview-agent-badge rp-preview-agent-live"
                title="The agent is driving this tab — click to take over"
                onClick={() => setWatchMode("takeover")}
              >
                <span className="ms ms-sm" aria-hidden="true">smart_toy</span> agent is driving
              </button>
            ) : (
              <button
                className="rp-preview-agent-badge"
                title="You took over — click to follow the agent again"
                onClick={() => setWatchMode("watch")}
              >
                watch only
              </button>
            )
          )}
        </div>
      </div>
      {loading && <div className="rp-browser-progress" />}

      {/* Viewport */}
      <div className="rp-preview-viewport" ref={native ? viewportRef : undefined} data-native-preview={native ? "true" : undefined}>
        {!native ? (
          // Without the desktop shell there is no real browser to embed —
          // say so instead of silently rendering a broken iframe.
          <div className="rp-preview-empty">
            <div className="rp-preview-empty-icon">🖥️</div>
            <div className="rp-preview-empty-title">Desktop app required</div>
            <div className="rp-preview-empty-hint">
              The embedded browser runs on real Chromium inside the Orplex desktop app.
              Launch the app (npm run dev or the installed binary) to browse here.
            </div>
          </div>
        ) : showNewTabPage ? (
          <div className="rp-preview-empty">
            <div className="rp-preview-empty-icon"><span className="ms ms-lg">language</span></div>
            <div className="rp-preview-empty-title">Orplex Browser</div>
            <div className="rp-preview-empty-hint">Search the web or enter a URL — or let the AI open one</div>
            <div className="rp-preview-empty-ports">
              {homePorts.map(p => (
                <button key={p.url} className="rp-preview-port-btn" onClick={() => navigateTo(p.url)} title={p.live ? "Server is running" : "Nothing detected on this port yet"}>
                  {p.label}{p.live ? " •" : ""}
                </button>
              ))}
            </div>
            {homePorts.some(p => p.live) && (
              <div className="rp-preview-empty-hint" style={{ marginTop: 6 }}>
                ● = dev server detected on your machine — click to open the live preview
              </div>
            )}
          </div>
        ) : (
          <>
            {/* Native mode: the real Chromium view is layered above this
                placeholder by the main process (positioned via setBounds). */}
            <div className="rp-preview-native-placeholder" aria-hidden="true" />
            {loadError && (
              <div className="rp-preview-error" role="alert">
                <div className="rp-preview-error-icon"><span className="ms ms-lg">warning</span></div>
                <div className="rp-preview-error-title">{loadError.title}</div>
                <div className="rp-preview-error-hint">{loadError.hint}</div>
                <div className="rp-preview-error-actions">
                  <button
                    className="rp-preview-error-btn rp-preview-error-btn--primary"
                    onClick={() => {
                      setLoadError(null);
                      reload();
                    }}
                  >
                    Retry
                  </button>
                  <button
                    className="rp-preview-error-btn"
                    onClick={() => {
                      if (window.orplexDesktop?.openExternal) window.orplexDesktop.openExternal(currentUrl);
                      else window.open(currentUrl, "_blank", "noopener");
                    }}
                  >
                    Open in Chrome ↗
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};

// Module-level flag: once the browser tab has mounted (in this panel
// session), keep it mounted across tab switches so native WebContentsViews
// survive — only their visibility toggles.
// Module-scope flag: the native preview keeps its WebContentsViews alive
// across tab switches, so the panel must keep reserving space for it once it
// has ever mounted. Exported — the panel shell reads it while routing tabs.
export const mountedBrowserRef = { current: false };

/**
 * Map Chromium network error codes to honest, actionable viewport copy.
 * Only the codes users actually hit; unknown codes get a generic message.
 */
function nativeLoadFailure(code: number, url: string): { title: string; hint: string } {
  const host = (() => { try { return new URL(url).hostname; } catch { return url.slice(0, 60); } })();
  switch (code) {
    case -2: // ERR_FAILED
    case -7: // ERR_TIMED_OUT
      return { title: "This site took too long to respond", hint: `${host} did not answer in time. Retry in a moment.` };
    case -6: // ERR_FILE_NOT_FOUND
    case -20: // ERR_ABORTED (redirect chain)
      return { title: "This site can't be reached", hint: `${host} refused the connection — it may be down, or the address may be wrong.` };
    case -21: // ERR_NETWORK_CHANGED
      return { title: "Network changed during load", hint: "Your connection switched networks mid-load. Retry." };
    case -105: // ERR_NAME_NOT_RESOLVED
      return { title: "Site can't be found", hint: `DNS could not resolve ${host}. Check the address or your connection.` };
    case -106: // ERR_INTERNET_DISCONNECTED
      return { title: "You're offline", hint: "Reconnect to the internet and retry." };
    case -109: // ERR_ADDRESS_UNREACHABLE
      return { title: "This address is unreachable", hint: `Nothing answered at ${host}. For localhost: is your dev server running?` };
    case -102: // ERR_CONNECTION_REFUSED
      return { title: "Connection refused", hint: `Nothing is listening on ${host} — for localhost, is your dev server running?` };
    case -501: // ERR_INSECURE_RESPONSE
      return { title: "Insecure response", hint: `${host} served an invalid SSL certificate.` };
    default:
      return { title: "This site can't be reached", hint: `Chromium error ${code} while loading ${host}. Retry or open it in your real browser.` };
  }
}

export default function BrowserPreview({ panelActive }: { panelActive: boolean }) {
  mountedBrowserRef.current = true;
  return <BrowserPreviewInner panelActive={panelActive} />;
}
