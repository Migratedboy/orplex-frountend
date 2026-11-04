"use client";

/**
 * changes-tab.tsx — the Changes tab of the right panel, extracted verbatim
 * from RightPanel.tsx (Operation Modularity). Self-contained block: change
 * list, diff expansion, apply/refresh actions. The panel shell keeps tab
 * routing and the error boundary.
 */
import { useState, useEffect } from "react";
import DiffView from "../DiffView";
import { apiFetch } from "@/lib/api-base";
import { ChangesPanelSkeleton } from "../PanelSkeletons";

// === Changes Tab ===
interface ChangeItem {
  path: string;
  timestamp: number;
  isNew: boolean;
  diff: string;
  lineCount: number;
}

export function ChangesTab() {
  const [changes, setChanges] = useState<ChangeItem[]>([]);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [appliedNote, setAppliedNote] = useState<string | null>(null);
  // Distinguishes "still fetching the first page" from "fetched, and there is
  // genuinely nothing yet" — without it the empty state flashes before the
  // first poll resolves.
  const [changesLoaded, setChangesLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const res = await apiFetch("/api/agent/changes");
        const data = await res.json();
        if (alive && data.changes) setChanges(data.changes);
      } catch {}
      finally {
        // Must be in `finally`: a failed first poll would otherwise leave the
        // skeleton on screen forever instead of falling through to the empty
        // state.
        if (alive) setChangesLoaded(true);
      }
    };
    poll();
    const interval = setInterval(poll, 3000); // poll every 3s
    return () => { alive = false; clearInterval(interval); };
  }, []);

  if (!changesLoaded) {
    return <ChangesPanelSkeleton />;
  }

  if (changes.length === 0) {
    return <div className="rp-empty">No file changes yet — changes appear here as the agent writes files</div>;
  }

  return (
    <div className="rp-changes">
      {changes.map((c, i) => {
        const timeAgo = getTimeAgo(c.timestamp);
        const isExpanded = expanded === i;
        return (
          <div key={i} className="rp-change-card">
            <div className="rp-change-header" onClick={() => setExpanded(isExpanded ? null : i)}>
              <span className={`rp-change-badge ${c.isNew ? "rp-change-new" : "rp-change-mod"}`}>
                {c.isNew ? "+" : "M"}
              </span>
              <span className="rp-change-path" title={c.path}>{c.path.split("/").pop()}</span>
              <span className="rp-change-meta">{c.lineCount}L</span>
              <span className="rp-change-time">{timeAgo}</span>
              <span className="rp-change-expand">{isExpanded ? "-" : "+"}</span>
            </div>
            {isExpanded && (
              <div className="rp-change-diff-wrap">
                <DiffView
                  diff={c.diff}
                  readOnly={false}
                  maxHeight={320}
                  onApply={async (filteredDiff, accepted, rejected) => {
                    // Trigger automatic rollback via file-history when hunks are rejected
                    const { applyHunkDecisions } = window as any;
                    await applyHunkDecisions?.(c.path, filteredDiff, [...accepted], [...rejected]);
                    const fileName = c.path.split("/").pop();
                    if (rejected.size > 0) {
                      setAppliedNote(
                        `Rolled back ${fileName} — ${rejected.size} hunk(s) rejected`
                      );
                    } else {
                      setAppliedNote(
                        `Applied ${accepted.size} hunk(s) to ${fileName}`
                      );
                    }
                    setTimeout(() => setAppliedNote(null), 4000);
                  }}
                  onHunkComment={(hunkId, comment) => {
                    const { submitHunkComment } = window as any;
                    submitHunkComment?.(c.path, hunkId, comment);
                  }}
                />
                {appliedNote && <div className="rp-change-applied">{appliedNote}</div>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function getTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 5) return "now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}
