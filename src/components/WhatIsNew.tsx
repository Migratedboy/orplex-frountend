"use client";

import { useEffect, useState } from "react";

// WhatIsNew.tsx — the "What's new" modal.
//
// Two triggers:
//   1. After an update: the Electron main process records the last-run
//      version (orplex.lastVersion) and fires `orplex:whats-new` with the
//      version it upgraded to; the modal auto-opens once per version.
//   2. Any time from the Help menu / palette via `orplex:whats-new`.
//
// Changelog lives in code (WHATS_NEW) so shipping notes is a one-file diff —
// no backend round-trip, works offline, matches the installer's content.

const WHATS_NEW: Record<string, { title: string; items: string[] }> = {
  "1.1.0": {
    title: "Faster path to your first win",
    items: [
      "Starter tasks: open a folder, click one card, watch the agent work",
      "Run health strip — stuck runs and waiting approvals surface themselves",
      "Command palette now describes every capability (Ctrl+K)",
      "Errors now come with a fix, not just a stack trace",
    ],
  },
};

const EVENT = "orplex:whats-new";

/** Fire from anywhere (Help menu, palette, Electron after an update). */
export function openWhatIsNew(version?: string) {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { version } }));
}

export default function WhatIsNew() {
  const [open, setOpen] = useState(false);
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    // Auto-open after an UPDATE: the packaged app reports its real version
    // via the desktop bridge. If it differs from the one we last showed the
    // changelog for, open once and remember. (Plain-browser/dev fallback:
    // the orplex.lastVersion key set by whatever shipped the update.)
    (async () => {
      try {
        const current = (await window.orplexDesktop?.getAppVersion?.()) || localStorage.getItem("orplex.lastVersion");
        if (!current) return;
        const seen = localStorage.getItem("orplex.appVersion");
        if (seen && seen !== current) {
          setVersion(seen); // "updated from vX"
          setOpen(true);
        }
        localStorage.setItem("orplex.appVersion", current);
      } catch {}
    })();

    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { version?: string } | undefined;
      if (detail?.version) setVersion(detail.version);
      setOpen(true);
    };
    window.addEventListener(EVENT, handler);
    return () => window.removeEventListener(EVENT, handler);
  }, []);

  if (!open) return null;
  const entry = (version && WHATS_NEW[version]) || WHATS_NEW[Object.keys(WHATS_NEW)[0]];
  const seenKey = `orplex.whatsNewSeen.${version || "latest"}`;

  const dismiss = () => {
    try { localStorage.setItem(seenKey, "1"); } catch {}
    setOpen(false);
  };

  return (
    <div className="win-overlay" onClick={dismiss} role="dialog" aria-modal="true" aria-label="What's new">
      <div className="win-card" onClick={(e) => e.stopPropagation()}>
        <div className="win-header">
          <span className="ms ms-lg win-spark">auto_awesome</span>
          <div>
            <h3 className="win-title">What&apos;s new in Orplex</h3>
            {version && <p className="win-version">updated from v{version}</p>}
          </div>
          <button className="win-close" onClick={dismiss} aria-label="Close"><span className="ms">close</span></button>
        </div>
        <ul className="win-list">
          {entry.items.map((item, i) => (
            <li key={i} className="win-item">
              <span className="ms ms-sm win-check">check_circle</span>
              <span>{item}</span>
            </li>
          ))}
        </ul>
        <div className="win-footer">
          <span className="win-hint">Tips appear one at a time at the bottom of the screen — press <kbd className="win-kbd">?</kbd> anytime.</span>
          <button className="win-btn" onClick={dismiss}>Got it</button>
        </div>
      </div>
    </div>
  );
}
