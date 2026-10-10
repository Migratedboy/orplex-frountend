// UpdateToast.tsx — Freebuff-style in-app update card (bottom-right).
//
// Persistent (never auto-dismisses mid-download), three live states plus a
// mandatory one driven by backend 426s:
//   available   — "Update available vX" [Download] [Later]
//   downloading — "Downloading Orplex vX" + bar + %  [Cancel]
//   downloaded  — "Restart to apply" [Restart now] [Later]
//   force       — "Update required" [Download now] (no Later; backend refuses old clients)
//   notice      — transient error line [Dismiss]
// Mounted once in AppLayout. Renders nothing outside Electron.

"use client";

import { useEffect } from "react";
import { useAppUpdater } from "@/hooks/useAppUpdater";

function Bar({ percent }: { percent: number }) {
  const pct = Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <div className="update-toast-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <div className="update-toast-bar-fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

export default function UpdateToast() {
  const { state, download, cancel, install, dismiss, isElectron } = useAppUpdater();

  // Transient notices clear themselves so a failed check doesn't linger.
  useEffect(() => {
    if (state.phase !== "notice") return;
    const t = setTimeout(dismiss, 6000);
    return () => clearTimeout(t);
  }, [state.phase, state.error, dismiss]);

  if (!isElectron) return null;
  if (state.phase === "hidden") return null;

  const v = state.version ? ` v${state.version}` : "";

  return (
    <div className="update-toast" role="status" aria-live="polite">
      {state.phase === "available" && (
        <>
          <div className="update-toast-row">
            <span className="ms" aria-hidden="true">system_update</span>
            <span className="update-toast-title">Update available{v}</span>
            <button className="update-toast-btn" onClick={download}>Download</button>
            <button className="update-toast-btn update-toast-btn-quiet" onClick={dismiss}>Later</button>
          </div>
          {state.notes ? <div className="update-toast-notes">{state.notes}</div> : null}
        </>
      )}
      {state.phase === "downloading" && (
        <>
          <div className="update-toast-row">
            <span className="ms" aria-hidden="true">download</span>
            <span className="update-toast-title">Downloading Orplex{v}</span>
            <button className="update-toast-btn update-toast-btn-quiet" onClick={cancel}>Cancel</button>
          </div>
          <Bar percent={state.percent ?? 0} />
          <div className="update-toast-pct">{Math.round(state.percent ?? 0)}%</div>
        </>
      )}
      {state.phase === "downloaded" && (
        <div className="update-toast-row">
          <span className="ms" aria-hidden="true">restart_alt</span>
          <span className="update-toast-title">Update downloaded{v} — restart to apply</span>
          <button className="update-toast-btn" onClick={install}>Restart now</button>
          <button className="update-toast-btn update-toast-btn-quiet" onClick={dismiss}>Later</button>
        </div>
      )}
      {state.phase === "force" && (
        <div className="update-toast-row">
          <span className="ms" aria-hidden="true">priority_high</span>
          <span className="update-toast-title">
            Update required{state.minVersion ? ` (v${state.minVersion}+)` : ""} to continue
          </span>
          <button className="update-toast-btn" onClick={download}>Download now</button>
        </div>
      )}
      {state.phase === "notice" && (
        <div className="update-toast-row">
          <span className="ms" aria-hidden="true">error</span>
          <span className="update-toast-title">{state.error || "update failed"}</span>
          <button className="update-toast-btn update-toast-btn-quiet" onClick={dismiss}>Dismiss</button>
        </div>
      )}
    </div>
  );
}

