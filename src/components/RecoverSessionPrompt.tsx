"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

// RecoverSessionPrompt.tsx — "Recover previous session?" after a crash.
//
// The Electron main process tracks whether the last session exited cleanly
// (session-state.json in userData). After a crash/force-kill, this prompt
// appears once on the next launch. "Recover" takes the user to the Manager
// board where the run ledger shows every run from before the crash — the
// backend, not local memory, is the source of truth, so nothing was lost by
// restarting. "Start fresh" just dismisses it.

const KEY = "orplex.recoverPromptShown";

export default function RecoverSessionPrompt() {
  const [show, setShow] = useState(false);
  const router = useRouter();

  useEffect(() => {
    let alive = true;
    // Electron only; plain browsers have no bridge and nothing to recover.
    const crashed = window.orplexDesktop?.lastSessionCrashed?.();
    Promise.resolve(crashed)
      .then((wasCrashed) => {
        if (!alive || !wasCrashed) return;
        try {
          if (sessionStorage.getItem(KEY) === "1") return;
          sessionStorage.setItem(KEY, "1");
        } catch {}
        setShow(true);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  if (!show) return null;

  return (
    <div className="recover-strip" role="alertdialog" aria-label="Recover previous session">
      <span className="recover-strip-icon"><span className="ms ms-sm">history</span></span>
      <span className="recover-strip-text">
        Orplex didn&apos;t shut down cleanly last time. Your agent runs are safe on the server — pick up where you left off?
      </span>
      <button className="recover-strip-btn" onClick={() => { setShow(false); router.push("/manager"); }}>
        Recover session
      </button>
      <button className="recover-strip-btn recover-strip-btn--ghost" onClick={() => setShow(false)}>
        Start fresh
      </button>
      <button className="recover-strip-close" onClick={() => setShow(false)} aria-label="Dismiss">
        <span className="ms ms-sm">close</span>
      </button>
    </div>
  );
}
