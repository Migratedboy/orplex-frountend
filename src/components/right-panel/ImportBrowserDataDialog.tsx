"use client";

/**
 * ImportBrowserDataDialog.tsx — Import browser data (Right Panel v2, P5).
 * Layout/behavior from the reference; every list is real: detected browsers
 * + profiles from main, real extension enumeration, real cookie import via
 * browserData IPC. Consent copy + honest counts + App-Bound Encryption (v20)
 * notice — see spec §5.5.
 */
import { useEffect, useRef, useState } from "react";
import { RIcon } from "./ref-icons";

interface BrowserOpt {
  id: string;
  name: string;
  profileLabel: string;
  cookiesDecryptable: boolean;
  cookiesBlockedReason?: string;
  extensions: Array<{ id: string; name: string; version: string }>;
}

export function ImportBrowserDataDialog({ open, initialTab, onClose, onSwitchProfileNote }: {
  open: boolean;
  initialTab?: "import" | "extensions";
  onClose: () => void;
  onSwitchProfileNote?: (msg: string) => void;
}) {
  const bridge = typeof window !== "undefined" ? window.orplexDesktop?.browserData : undefined;
  const extras = typeof window !== "undefined" ? window.orplexDesktop?.previewExtras : undefined;
  const [tab, setTab] = useState<"import" | "extensions">(initialTab ?? "import");
  const [browsers, setBrowsers] = useState<BrowserOpt[]>([]);
  const [detectError, setDetectError] = useState("");
  const [picked, setPicked] = useState(0);
  const [ddOpen, setDdOpen] = useState(false);
  const [cookies, setCookies] = useState(true);
  const [extOpen, setExtOpen] = useState(false);
  const [extPicked, setExtPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState("");
  const [summary, setSummary] = useState<{
    imported?: number; skippedProtected?: number; failed?: number;
    blockedReason?: string; extensionsCopied?: number; extensionsFailed?: number;
  } | null>(null);
  const [extResults, setExtResults] = useState<Array<{ path: string; ok: boolean; error?: string }> | null>(null);
  const [cookieFileNote, setCookieFileNote] = useState("");
  const backdropRef = useRef<HTMLDivElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  // Detect on open; keep the trigger for focus-return.
  useEffect(() => {
    if (!open) return;
    if (initialTab) setTab(initialTab);
    openerRef.current = openerRef.current ?? (document.activeElement as HTMLElement | null);
    setSummary(null);
    setExtResults(null);
    setCookieFileNote("");
    setStage("");
    if (!bridge) { setDetectError("Import needs the desktop app"); return; }
    void bridge.detect().then((r) => {
      if (r.ok && Array.isArray(r.browsers)) setBrowsers(r.browsers as unknown as BrowserOpt[]);
      else setDetectError(r.error || "Detection failed");
    });
  }, [open, bridge, initialTab]);

  useEffect(() => {
    if (!open || !bridge) return;
    const off = bridge.onEvent((ev) => {
      if (ev.type === "progress") setStage(String(ev.stage ?? "Working…"));
    });
    return off;
  }, [open, bridge]);

  // Focus return + Escape/backdrop.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { onClose(); }
      if (e.key === "Tab") {
        const root = backdropRef.current;
        if (!root) return;
        const focusables = root.querySelectorAll<HTMLElement>("button, input, select, [tabindex]");
        const list = [...focusables].filter((el) => !el.hasAttribute("disabled") && el.offsetParent !== null);
        if (list.length === 0) return;
        const first = list[0];
        const last = list[list.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      openerRef.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open || !bridge) return null;

  const browser = browsers[picked];
  const exts = browser?.extensions ?? [];

  const doImport = async () => {
    if (!browser) return;
    setBusy(true);
    setSummary(null);
    setStage("Starting…");
    try {
      const r = await bridge.import({
        browserId: browser.id,
        cookies,
        extensions: [...extPicked],
      });
      if (r.ok || r.imported !== undefined) {
        setSummary(r);
      } else {
        setSummary({ failed: undefined, blockedReason: r.error || "Import failed" });
      }
    } finally {
      setBusy(false);
      setStage("");
    }
  };

  const doCookieFile = async () => {
    setCookieFileNote("");
    try {
      const r = await bridge.importCookieFile();
      if (r.ok && r.cancelled) return;
      if (r.ok && r.imported !== undefined) {
        setSummary({ imported: r.imported, failed: r.failed });
        setCookieFileNote("");
      } else {
        setCookieFileNote(r.error || "Cookie-file import failed");
      }
    } catch (e) {
      setCookieFileNote((e as Error).message);
    }
  };

  const doExtLoad = async () => {
    if (!browser) return;
    setBusy(true);
    setExtResults(null);
    try {
      const pickedExts = exts.filter((e) => extPicked.has(e.id));
      // Re-detect gives fresh dirs; match by id from the live list.
      const fresh = (await bridge.detect()) as unknown as { browsers?: Array<{ id: string; extensions?: Array<{ id: string; dir: string }> }> };
      const freshExts = fresh.browsers?.find((b) => b.id === browser.id)?.extensions ?? [];
      const dirs = pickedExts.map((e) => freshExts.find((f) => f.id === e.id)?.dir).filter((d): d is string => !!d);
      if (dirs.length === 0) { setExtResults([]); setBusy(false); return; }
      const r = await extras?.loadExtensions(dirs);
      setExtResults(r?.results ?? []);
      setSummary({ extensionsCopied: r?.results.filter((x) => x.ok).length, extensionsFailed: r?.results.filter((x) => !x.ok).length });
    } finally {
      setBusy(false);
    }
  };

  const chk = (on: boolean) => (
    <span className={`rp-v2-ck ${on ? "on" : ""}`} aria-hidden="true">{on ? <RIcon name="check" size={13} /> : null}</span>
  );

  return (
    <div
      className="rp-v2-md"
      ref={backdropRef}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      role="presentation"
    >
      <div className="rp-v2-dlg" role="dialog" aria-modal="true" aria-label="Import browser data">
        <div className="rp-v2-mdh">
          <span aria-hidden="true"><RIcon name="download" size={22} /></span>
          <h3>Import browser data</h3>
          <button className="rp-v2-mdx" onClick={onClose} aria-label="Close dialog"><RIcon name="x" size={18} /></button>
        </div>

        <div className="rp-v2-seg" role="tablist" aria-label="Import section">
          <button role="tab" aria-selected={tab === "import"} className={tab === "import" ? "on" : ""} onClick={() => setTab("import")}>Import</button>
          <button role="tab" aria-selected={tab === "extensions"} className={tab === "extensions" ? "on" : ""} onClick={() => setTab("extensions")}>Extensions</button>
        </div>

        {detectError && <div className="rp-v2-dlg-note">{detectError}</div>}
        {!detectError && browsers.length === 0 && <div className="rp-v2-dlg-note">No supported browsers detected on this machine.</div>}

        {browsers.length > 0 && (
          <>
            <button className="rp-v2-mdsel" onClick={() => setDdOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={ddOpen}>
              <span className="rp-v2-bi" aria-hidden="true" />
              {browser?.name} — {browser?.profileLabel}
              <span className={`rp-v2-mdcv ${ddOpen ? "up" : ""}`} aria-hidden="true"><RIcon name="chevd" size={16} /></span>
            </button>
            {ddOpen && (
              <div className="rp-v2-ddl" role="listbox" aria-label="Choose browser">
                {browsers.map((b, i) => (
                  <button key={b.id} role="option" aria-selected={i === picked} onClick={() => { setPicked(i); setDdOpen(false); setExtPicked(new Set()); }}>
                    {b.name} — {b.profileLabel}
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        {browser && tab === "import" && (
          <>
            <div className="rp-v2-mdcard">
              <button className="rp-v2-mdrow" onClick={() => setCookies((c) => !c)} aria-pressed={cookies}>
                <span aria-hidden="true"><RIcon name="cookie" size={18} /></span>
                <span className="rp-v2-mdrow-t">Cookies &amp; sign-ins</span>
                {chk(cookies)}
              </button>
              <button className="rp-v2-mdrow" onClick={() => setExtOpen((o) => !o)} aria-expanded={extOpen}>
                <span aria-hidden="true"><RIcon name="puzzle" size={18} /></span>
                <span className="rp-v2-mdrow-t">Extensions</span>
                <span className={`rp-v2-mdcv ${extOpen ? "up" : ""}`} aria-hidden="true"><RIcon name="chevd" size={16} /></span>
              </button>
              {extOpen && (
                exts.length === 0 ? (
                  <div className="rp-v2-mdrow sub-none">No extensions listed for this profile</div>
                ) : (
                  exts.map((e) => (
                    <button
                      key={e.id}
                      className="rp-v2-mdrow sub"
                      onClick={() => setExtPicked((prev) => { const n = new Set(prev); if (n.has(e.id)) n.delete(e.id); else n.add(e.id); return n; })}
                      aria-pressed={extPicked.has(e.id)}
                    >
                      {chk(extPicked.has(e.id))}
                      <span className="rp-v2-mdrow-t">{e.name}</span>
                    </button>
                  ))
                )
              )}
            </div>
            {browser.cookiesBlockedReason && (
              <div className="rp-v2-dlg-note">{browser.cookiesBlockedReason}</div>
            )}
            <p className="rp-v2-consent">
              Signs you in to sites inside Orplex&apos;s browser.
              Stays on this device — nothing is uploaded anywhere.
            </p>
          </>
        )}

        {browser && tab === "extensions" && (
          <>
            <div className="rp-v2-mdcard">
              {exts.length === 0 ? (
                <div className="rp-v2-mdrow sub-none">No extensions listed for this profile</div>
              ) : (
                exts.map((e) => (
                  <button
                    key={e.id}
                    className="rp-v2-mdrow"
                    onClick={() => setExtPicked((prev) => { const n = new Set(prev); if (n.has(e.id)) n.delete(e.id); else n.add(e.id); return n; })}
                    aria-pressed={extPicked.has(e.id)}
                  >
                    {chk(extPicked.has(e.id))}
                    <span className="rp-v2-mdrow-t">{e.name}</span>
                    <span className="rp-v2-mdrow-v">v{e.version}</span>
                  </button>
                ))
              )}
            </div>
            <p className="rp-v2-consent">
              Extensions load into this browser&apos;s session as-is. Electron supports a subset of
              Chrome&apos;s APIs — some extensions will load partially or fail. Each result is reported.
            </p>
            {extResults && (
              <div className="rp-v2-dlg-note">
                {extResults.length === 0
                  ? "Nothing ticked — pick extensions to load."
                  : extResults.map((r) => (r.ok ? `✓ Loaded ${r.path}` : `✗ ${r.path}: ${r.error || "failed"}`)).join("\n")}
              </div>
            )}
          </>
        )}

        {stage && <div className="rp-v2-dlg-note" aria-live="polite">{stage}</div>}
        {cookieFileNote && <div className="rp-v2-dlg-note" aria-live="polite">{cookieFileNote}</div>}
        {summary && (
          <div className="rp-v2-summary" aria-live="polite">
            {summary.imported !== undefined && summary.imported > 0 && <div>✓ {summary.imported} cookie(s) imported.</div>}
            {summary.skippedProtected !== undefined && summary.skippedProtected > 0 && (
              <div>
                {summary.skippedProtected} cookie(s) could not be decrypted — Chrome protects these cookies.
                Export them with a cookie-export extension and use “Import cookie file…” instead.
              </div>
            )}
            {summary.failed !== undefined && summary.failed > 0 && <div>{summary.failed} item(s) failed.</div>}
            {summary.extensionsCopied !== undefined && summary.extensionsCopied > 0 && <div>{summary.extensionsCopied} extension(s) copied.</div>}
            {summary.extensionsFailed !== undefined && summary.extensionsFailed > 0 && <div>{summary.extensionsFailed} extension(s) failed to copy.</div>}
            {summary.blockedReason && <div>{summary.blockedReason}</div>}
            {summary.imported === 0 && summary.skippedProtected === 0 && summary.failed === 0 && !summary.blockedReason && <div>Nothing to import.</div>}
          </div>
        )}

        <div className="rp-v2-mdf">
          <button className="rp-v2-tbtn" onClick={() => void doCookieFile()} disabled={busy}>Import cookie file…</button>
          <button className="rp-v2-tbtn" onClick={onClose} disabled={busy}>Cancel</button>
          <button
            className="rp-v2-btn-g sm"
            onClick={() => (tab === "extensions" ? void doExtLoad() : void doImport())}
            disabled={busy || !browser}
          >
            {tab === "extensions" ? "Load" : "Import"}
          </button>
        </div>
      </div>
    </div>
  );
}

