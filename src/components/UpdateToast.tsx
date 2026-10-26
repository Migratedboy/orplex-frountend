// UpdateToast.tsx — in-app update card (bottom-right).
//
// The app updates itself: a newer version is fetched in the background and
// the app restarts into it, so the new build takes the place of the old one.
// The card only reports what is happening:
//   available   — "Update available vX" (the download starts by itself)
//   downloading — "Downloading Orplex vX" + bar + %  [Cancel]
//   downloaded  — "Restarting to apply vX" [Restart now] [Later]
//   force       — "Update required" [Download now] (no Later; backend refuses old clients)
//   notice      — transient error line [Dismiss]
// "Later" (and agent runs in flight) postpone the restart — the downloaded
// build is applied on the next quit or the next boot.
// Mounted once in AppLayout. Renders nothing outside Electron.

"use client";

import { useEffect } from "react";
import { useAppUpdater } from "@/hooks/useAppUpdater";
import { useActiveRunCount } from "@/hooks/useActiveRunCount";

function Bar({ percent }: { percent: number }) {
  const pct = Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <div className="update-toast-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <div className="update-toast-bar-fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

export default function UpdateToast() {
  const { state, download, cancel, install, defer, arm, dismiss, isElectron } = useAppUpdater();
  const { activeRuns } = useActiveRunCount();

  // Transient notices clear themselves so a failed check doesn't linger.
  useEffect(() => {
    if (state.phase !== "notice") return;
    const t = setTimeout(dismiss, 6000);
    return () => clearTimeout(t);
  }, [state.phase, state.error, dismiss]);

  // Never restart the app out from under a running agent — postpone instead,
  // and pick the update back up as soon as the runs are done.
  useEffect(() => {
    if (state.phase !== "downloaded") return;
    if (activeRuns > 0) {
      void defer();
    } else {
      void arm();
    }
  }, [state.phase, activeRuns, defer, arm]);

  if (!isElectron) return null;
  if (state.phase === "hidden") return null;

  const v = state.version ? ` v${state.version}` : "";

  return (
    <div className="update-toast" role="status" aria-live="polite">
      {state.phase === "available" && (
        <>
          <div className="update-toast-row">
            <span className="ms" aria-hidden="true">system_update</span>
            <span className="update-toast-title">Update available{v} — downloading</span>
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
          <span className="update-toast-title">
            Update ready{v} — restarting{activeRuns > 0 ? " when your runs finish" : ""}
          </span>
          <button className="update-toast-btn" onClick={install}>Restart now</button>
          <button className="update-toast-btn update-toast-btn-quiet" onClick={() => { void defer(); dismiss(); }}>
            Later
          </button>
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
