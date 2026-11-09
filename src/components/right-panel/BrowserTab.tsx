"use client";

/**
 * BrowserTab.tsx — the Local browser tab of the right panel: real Chromium
 * WebContentsViews owned by the main process over `preview:*` IPC.
 *
 * Right Panel v2 (P4):
 * - Toolbar + omnibox: Back/Forward disabled state and omnibox text come from
 *   REAL `did-navigate` events (main emits canGoBack/canGoForward in every
 *   `navigated` payload — DECISIONS D15), never local renderer history.
 * - Omnibox input goes RAW to `preview:navigate` — the main process owns the
 *   Chrome-style normalization (search → Google, bare host → https, localhost
 *   → http; preview-logic.ts). No renderer-side reimplementation (D3).
 * - Native bounds run through useNativeViewBounds (B23); DOM overlays
 *   (menu/popover/dialog) freeze the view behind a capturePage snapshot
 *   (useOverlayFreeze — spec §2.2).
 * - Empty state ("Start browsing"): breathing globe + live dev-server port
 *   chips, polled only while the empty state is visible (B6/B7).
 *   The settings menu + Import dialog arrive in P5.
 *
 * Preserved from v1: per-tab views/history (native), favicons, target=_blank
 * → new preview tab, Agent Browser mirror tab, failure surfaces, Retry /
 * Open-in-Chrome, watch/takeover agent badge, unmount destroys views.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api-base";
import { useNativeViewBounds } from "./hooks/useNativeViewBounds";
import { useOverlayFreeze } from "./hooks/useOverlayFreeze";
import { IconBack, IconArrowRight, IconRefresh, IconOpenExternal, IconGlobe } from "../Icons";

const AGENT_TAB_ID = 999999;
/** Dev-server ports probed for the new-tab page (same 8 as ARCHITECTURE §2). */
const PROBE_PORTS = [3000, 5173, 8080, 4200, 3001, 8000, 5000, 4000];

interface BrowserTab {
  id: number;
  currentUrl: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  error: { title: string; hint: string } | null;
}

function faviconFor(u: string): string | null {
  try {
    const host = new URL(u).hostname;
    if (!host) return null;
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`;
  } catch {
    return null;
  }
}

/** Trim an omnibox display string to a readable form (query kept, long tails cut). */
function displayUrl(u: string): string {
  try {
    const parsed = new URL(u);
    const path = parsed.pathname === "/" ? "" : parsed.pathname;
    const shown = `${parsed.protocol}//${parsed.host}${path}`;
    return shown.length > 120 ? shown.slice(0, 117) + "…" : shown;
  } catch {
    return u;
  }
}

/** Map Chromium network error codes to honest, actionable viewport copy. */
function nativeLoadFailure(code: number, url: string): { title: string; hint: string } {
  const host = (() => { try { return new URL(url).hostname; } catch { return url.slice(0, 60); } })();
  switch (code) {
    case -2: case -7:
      return { title: "This site took too long to respond", hint: `${host} did not answer in time. Retry in a moment.` };
    case -6: case -20:
      return { title: "This site can't be reached", hint: `${host} refused the connection — it may be down, or the address may be wrong.` };
    case -21:
      return { title: "Network changed during load", hint: "Your connection switched networks mid-load. Retry." };
    case -105:
      return { title: "Site can't be found", hint: `DNS could not resolve ${host}. Check the address or your connection.` };
    case -106:
      return { title: "You're offline", hint: "Reconnect to the internet and retry." };
    case -109:
      return { title: "This address is unreachable", hint: `Nothing answered at ${host}. For localhost: is your dev server running?` };
    case -102:
      return { title: "Connection refused", hint: `Nothing is listening on ${host} — for localhost, is your dev server running?` };
    case -501:
      return { title: "Insecure response", hint: `${host} served an invalid SSL certificate.` };
    default:
      return { title: "This site can't be reached", hint: `Chromium error ${code} while loading ${host}. Retry or open it in your real browser.` };
  }
}

function BrowserPreviewInner({ panelActive, overlayOpen }: { panelActive: boolean; overlayOpen?: boolean }) {
  const [tabs, setTabs] = useState<BrowserTab[]>([{ id: 1, currentUrl: "", title: "New Tab", canGoBack: false, canGoForward: false, loading: false, error: null }]);
  const [activeId, setActiveId] = useState(1);
  const [omnibox, setOmnibox] = useState("");
  const [omniboxFocused, setOmniboxFocused] = useState(false);
  const [agentDriven, setAgentDriven] = useState(false);
  const [watchMode, setWatchMode] = useState<"watch" | "takeover">("watch");
  const watchModeRef = useRef(watchMode);
  watchModeRef.current = watchMode;
  const [nextTabId, setNextTabId] = useState(2);
  const [livePorts, setLivePorts] = useState<number[]>([]);

  const activeTab = tabs.find(t => t.id === activeId) ?? tabs[0];
  const currentUrl = activeTab?.currentUrl ?? "";
  const isSecure = currentUrl.startsWith("https://");
  const showNewTabPage = !currentUrl && !activeTab?.error;

  // === NATIVE PREVIEW (Electron) ===
  const native = typeof window !== "undefined" ? window.orplexDesktop?.preview ?? null : null;
  const nativeMapRef = useRef<Map<number, number>>(new Map()); // renderer tabId -> main view id
  const viewportRef = useRef<HTMLDivElement>(null);
  const [agentViewId, setAgentViewId] = useState<number | null>(null);
  const agentViewIdRef = useRef<number | null>(null);
  agentViewIdRef.current = agentViewId;
  const agentTabIdRef = useRef<number | null>(null);

  // Latest navigate for subscriptions that must always act on the active tab.
  const navigateRef = useRef<(raw: string) => void>(() => {});
  const activeIdRef = useRef(1);
  activeIdRef.current = activeId;

  // Port probe — gated to the empty state (poll only while visible, §2.8).
  useEffect(() => {
    if (!showNewTabPage) return;
    let alive = true;
    const probe = () => {
      apiFetch("/api/localhost-probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ports: PROBE_PORTS }),
      })
        .then((r) => r.json())
        .then((d) => { if (alive && Array.isArray(d?.live)) setLivePorts(d.live); })
        .catch(() => {});
    };
    probe();
    const iv = setInterval(probe, 10_000);
    return () => { alive = false; clearInterval(iv); };
  }, [showNewTabPage]);

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

  const patchTab = useCallback((tabId: number, patch: Partial<BrowserTab>) => {
    setTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, ...patch } : t)));
  }, []);

  /**
   * Core navigation: RAW input goes to main (which normalizes). URL/title/nav
   * state land back via `navigated` events — never predicted locally.
   */
  const navigateTo = useCallback((raw: string) => {
    const target = raw.trim();
    if (!target) return;
    setTabs((prev) => prev.map((t) => (t.id === activeIdRef.current ? { ...t, error: null } : t)));
    if (!native) return;
    void ensureNativeTab(activeIdRef.current).then((mainId) => {
      if (mainId === null) return;
      void native.navigate(mainId, target);
    });
  }, [native, ensureNativeTab]);
  navigateRef.current = navigateTo;

  const openExternal = () => {
    if (!currentUrl) return;
    if (window.orplexDesktop?.openExternal) void window.orplexDesktop.openExternal(currentUrl);
    else window.open(currentUrl, "_blank", "noopener");
  };

  // Omnibox mirrors the current page URL unless the user is editing it.
  useEffect(() => {
    if (!omniboxFocused) setOmnibox(displayUrl(currentUrl));
  }, [currentUrl, omniboxFocused]);

  // Live agent preview: when the agent drives, navigate the ACTIVE tab to
  // its URL (unless the user took over).
  useEffect(() => {
    let unsubscribe: (() => void) | null = null;
    let alive = true;
    import("@/lib/background-worker").then(({ onPreviewEvent }) => {
      if (!alive) return;
      unsubscribe = onPreviewEvent((event) => {
        setAgentDriven(true);
        if (watchModeRef.current === "watch") navigateRef.current(event.url);
      });
    }).catch(() => {});
    return () => { alive = false; unsubscribe?.(); };
  }, []);

  // The worker's browser tools announce the agent view id + ask to show it.
  useEffect(() => {
    if (!native) return;
    const handler = async () => {
      try {
        const viewId = await window.orplexDesktop!.agentBrowser!.getId();
        setAgentViewId(viewId);
        setTabs((prev) => {
          if (prev.find((t) => t.id === AGENT_TAB_ID)) return prev;
          return [...prev, { id: AGENT_TAB_ID, currentUrl: "", title: "Agent Browser", canGoBack: false, canGoForward: false, loading: false, error: null }];
        });
        setActiveId(AGENT_TAB_ID);
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
      // Attribute by view id: the agent view's events go to the AGENT tab;
      // everything else to the active tab.
      const isAgent = agentViewIdRef.current !== null && event.viewId === agentViewIdRef.current;
      const tabId = isAgent ? AGENT_TAB_ID : activeIdRef.current;
      switch (event.type) {
        case "navigated": {
          const url = String(event.url || "");
          if (!url || url === "about:blank") return;
          patchTab(tabId, {
            currentUrl: url,
            title: displayUrl(url),
            error: null,
            canGoBack: event.canGoBack === true,
            canGoForward: event.canGoForward === true,
          });
          break;
        }
        case "loading": {
          const loading = Boolean(event.loading);
          patchTab(tabId, { loading });
          break;
        }
        case "did-fail-load": {
          const code = Number(event.errorCode);
          if (code === -3) break; // ERR_ABORTED — superseded, not a failure
          patchTab(tabId, { error: nativeLoadFailure(code, String(event.url || "")), loading: false });
          break;
        }
        case "title-updated": {
          const title = String(event.title || "").slice(0, 40);
          if (title) patchTab(tabId, { title });
          break;
        }
        case "window-open": {
          // target=_blank → a new preview tab (like a real browser).
          const url = String(event.url || "");
          if (url) {
            const id = nextTabId;
            setNextTabId(id + 1);
            setTabs((prev) => [...prev, { id, currentUrl: "", title: "New Tab", canGoBack: false, canGoForward: false, loading: false, error: null }]);
            setActiveId(id);
            void (async () => {
              const mainId = await native.createTab();
              nativeMapRef.current.set(id, mainId);
              void native.navigate(mainId, url);
            })();
          }
          break;
        }
      }
    });
    return off;
  }, [native, nextTabId, patchTab]);

  // Keep the native view positioned over the viewport placeholder (B23).
  useNativeViewBounds(
    native,
    viewportRef,
    useCallback(() => nativeMapRef.current.get(activeIdRef.current), [])
  );

  // Overlay freeze: snapshot while an overlay is open (spec §2.2).
  const activeMainId = nativeMapRef.current.get(activeId);
  const screenshotCb = useCallback(
    (tabId: number) => (native ? native.screenshot(tabId) : Promise.resolve(null)),
    [native]
  );
  const freeze = useOverlayFreeze(!!overlayOpen, activeMainId, screenshotCb);
  const hideView = !panelActive || !!overlayOpen;

  // Show/hide native views: visible only while the browser tab is active,
  // the whole panel is open, and no overlay is freezing above it.
  useEffect(() => {
    if (!native) return;
    const mainId = nativeMapRef.current.get(activeId);
    void native.showTab(hideView ? null : mainId ?? null);
  }, [native, activeId, hideView, tabs]);

  // Destroy all native views when the component unmounts (panel teardown).
  useEffect(() => {
    if (!native) return;
    const map = nativeMapRef.current;
    return () => {
      for (const mainId of map.values()) void native.closeTab(mainId);
      map.clear();
    };
  }, [native]);

  const go = (direction: -1 | 1) => {
    const mainId = nativeMapRef.current.get(activeId);
    if (mainId === undefined || !native) return;
    void (direction < 0 ? native.goBack(mainId) : native.goForward(mainId));
  };

  const reload = () => {
    const mainId = nativeMapRef.current.get(activeId);
    if (mainId !== undefined && native) void native.reload(mainId);
  };

  const newTab = () => {
    const id = nextTabId;
    setNextTabId(id + 1);
    setTabs((prev) => [...prev, { id, currentUrl: "", title: "New Tab", canGoBack: false, canGoForward: false, loading: false, error: null }]);
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
    const rest = tabs.filter((t) => t.id !== id);
    if (rest.length === 0) {
      // Fresh replacement tab; CONSUME its id so the next "+" can't collide.
      setTabs([{ id: nextTabId, currentUrl: "", title: "New Tab", canGoBack: false, canGoForward: false, loading: false, error: null }]);
      setNextTabId(nextTabId + 1);
      if (activeId === id) setActiveId(nextTabId);
      return;
    }
    setTabs(rest);
    if (activeId === id) setActiveId(rest[rest.length - 1]!.id);
  };

  const canBack = !!activeTab?.canGoBack;
  const canForward = !!activeTab?.canGoForward;

  return (
    <div className="rp-v2-br">
      {/* Per-view tab strip */}
      {tabs.length > 1 && (
        <div className="rp-v2-br-tabs">
          {tabs.map((t) => (
            <div
              key={t.id}
              className={`rp-v2-br-tab ${t.id === activeId ? "active" : ""}`}
              onClick={() => { if (t.id !== activeId) setActiveId(t.id); }}
              title={t.title}
            >
              {t.currentUrl && faviconFor(t.currentUrl) ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img className="rp-v2-br-favicon" src={faviconFor(t.currentUrl) ?? ""} alt="" width={14} height={14} />
              ) : (
                <span className="rp-v2-br-favicon rp-v2-br-favicon-empty" aria-hidden="true" />
              )}
              <span className="rp-v2-br-tab-title">{t.title}</span>
              <button
                className="rp-v2-br-tab-close"
                aria-label="Close browser tab"
                onClick={(e) => { e.stopPropagation(); closeTab(t.id); }}
              >×</button>
            </div>
          ))}
          <button className="rp-v2-br-newtab" aria-label="New browser tab" onClick={newTab}>+</button>
        </div>
      )}

      {/* Toolbar (reference .br-bar): back / forward / reload / omnibox / external */}
      <div className="rp-v2-br-bar">
        <button className="rp-v2-br-ib" disabled={!canBack} onClick={() => go(-1)} title="Back" aria-label="Back"><IconBack size={18} /></button>
        <button className="rp-v2-br-ib" disabled={!canForward} onClick={() => go(1)} title="Forward" aria-label="Forward"><IconArrowRight size={18} /></button>
        <button className="rp-v2-br-ib" onClick={reload} title="Reload" aria-label="Reload"><IconRefresh size={18} /></button>
        <div className="rp-v2-br-url-wrap">
          <span className={`rp-v2-br-shield ${isSecure ? "secure" : ""}`} aria-hidden="true">
            {isSecure ? "🔒" : "⚠"}
          </span>
          <input
            className="rp-v2-br-url"
            value={omnibox}
            onChange={(e) => setOmnibox(e.target.value)}
            onFocus={(e) => { setOmniboxFocused(true); e.currentTarget.select(); }}
            onBlur={() => setOmniboxFocused(false)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                setOmniboxFocused(false);
                e.currentTarget.blur();
                navigateTo(omnibox);
              }
              if (e.key === "Escape") {
                setOmniboxFocused(false);
                setOmnibox(displayUrl(currentUrl));
                e.currentTarget.blur();
              }
            }}
            placeholder="Search the web or enter a URL"
            spellCheck={false}
            aria-label="Browse address"
          />
          {agentDriven && (
            <button
              className={`rp-v2-br-agent ${watchMode === "watch" ? "live" : ""}`}
              title={watchMode === "watch" ? "The agent is driving this tab — click to take over" : "You took over — click to follow the agent again"}
              onClick={() => setWatchMode(watchMode === "watch" ? "takeover" : "watch")}
            >
              <span className="ms ms-sm" aria-hidden="true">smart_toy</span>
              {watchMode === "watch" ? "agent is driving" : "watch only"}
            </button>
          )}
        </div>
        <button className="rp-v2-br-ib" disabled={!currentUrl} onClick={openExternal} title="Open this page in your real browser" aria-label="Open in real browser"><IconOpenExternal size={17} /></button>
      </div>
      {activeTab?.loading && <div className="rp-v2-br-progress" />}

      {/* Viewport */}
      <div
        className="rp-v2-br-body"
        ref={native ? viewportRef : undefined}
        data-native-preview={native ? "true" : undefined}
      >
        {/* Overlay-freeze snapshot (spec §2.2): paints where the hidden
            native view would, so the DOM overlay never flashes through. */}
        {freeze.snapshot && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={freeze.snapshot} alt="" className="rp-v2-br-freeze" aria-hidden="true" />
        )}
        {!native ? (
          <div className="rp-v2-br-empty">
            <div className="rp-v2-br-empty-icon"><IconGlobe size={32} /></div>
            <div className="rp-v2-br-empty-title">Desktop app required</div>
            <div className="rp-v2-br-empty-hint">
              The embedded browser runs on real Chromium inside the Orplex desktop app.
              Launch the app (npm run dev or the installed binary) to browse here.
            </div>
          </div>
        ) : showNewTabPage ? (
          <div className="rp-v2-br-empty">
            <div className="rp-v2-br-empty-icon breathing"><IconGlobe size={34} /></div>
            <h3 className="rp-v2-br-empty-h">Start browsing</h3>
            {livePorts.length > 0 && (
              <div className="rp-v2-br-ports">
                {livePorts.map((p) => (
                  <button key={p} className="rp-v2-br-port" onClick={() => navigateTo(`http://localhost:${p}`)} title={`Dev server live on :${p} — click to open`}>
                    :{p}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <>
            <div className="rp-v2-br-native-placeholder" aria-hidden="true" />
            {activeTab?.error && (
              <div className="rp-v2-br-error" role="alert">
                <div className="rp-v2-br-error-icon"><span className="ms ms-lg" aria-hidden="true">warning</span></div>
                <div className="rp-v2-br-error-title">{activeTab.error.title}</div>
                <div className="rp-v2-br-error-hint">{activeTab.error.hint}</div>
                <div className="rp-v2-br-error-actions">
                  <button
                    className="rp-v2-br-error-btn primary"
                    onClick={() => {
                      patchTab(activeId, { error: null });
                      reload();
                    }}
                  >
                    Retry
                  </button>
                  <button className="rp-v2-br-error-btn" onClick={openExternal}>
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
}

/**
 * Default export wrapper: BrowserPreview takes panelActive + overlayOpen.
 * The native view visibility is driven by preview:showTab; closing a tab
 * hides it without destroying (mounted panel shell keeps this mounted).
 */
export default function BrowserPreview(props: { panelActive: boolean; overlayOpen?: boolean }) {
  return <BrowserPreviewInner {...props} />;
}
