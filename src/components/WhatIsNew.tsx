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
  "1.0.11": {
    title: "Desktop sign-in that actually works",
    items: [
      "Google and GitHub sign-in no longer stall on “Taking you to …”",
      "You stay signed in after the browser hand-off — no bounce back to the login screen",
      "A second sign-in attempt works instead of failing with “Sign-in could not start”",
      "Sign-in codes are stateless (HMAC + AES-GCM), so nothing is lost between server instances",
    ],
  },
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

/** "1.0.9" < "1.0.10" < "1.1.0" — plain numeric segment compare. */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

const EVENT = "orplex:whats-new";

/** Fire from anywhere (Help menu, palette, Electron after an update). */
export function openWhatIsNew(version?: string) {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { version } }));
}

export default function WhatIsNew() {
  const [open, setOpen] = useState(false);
  const [version, setVersion] = useState<string | null>(null);
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);

  useEffect(() => {
    // Auto-open after an UPDATE: the packaged app reports its real version
    // via the desktop bridge. If it differs from the one we last showed the
    // changelog for, open once and remember. (Plain-browser/dev fallback:
    // the orplex.lastVersion key set by whatever shipped the update.)
    (async () => {
      try {
        const current = (await window.orplexDesktop?.getAppVersion?.()) || localStorage.getItem("orplex.lastVersion");
        if (!current) return;
        setCurrentVersion(current);
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
      if (detail?.version) setCurrentVersion(detail.version);
      setOpen(true);
    };
    window.addEventListener(EVENT, handler);
    return () => window.removeEventListener(EVENT, handler);
  }, []);

  if (!open) return null;
  const known = Object.keys(WHATS_NEW).sort(compareVersions);
  const entry = (currentVersion && WHATS_NEW[currentVersion]) || WHATS_NEW[known[known.length - 1]];
  const seenKey = `orplex.whatsNewSeen.${currentVersion || "latest"}`;

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
