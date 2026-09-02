"use client";

import { useMemo, useState, useCallback } from "react";
import { parseDiffHunks, filterDiffByHunks, type DiffHunk } from "@/lib/diff-hunks";
import { IconCheck, IconX, IconChevronDown } from "./Icons";

interface DiffViewProps {
  /** Raw diff text (computeDiff format) */
  diff: string;
  /** Called with the filtered diff when the user applies their hunk decisions */
  onApply?: (filteredDiff: string, acceptedIds: Set<number>, rejectedIds: Set<number>) => void;
  /** Called for inline hunk feedback — feeds the Comment model upstream */
  onHunkComment?: (hunkId: number, comment: string) => void;
  /** Read-only mode (e.g. inside the approval dialog) — no accept/reject controls */
  readOnly?: boolean;
  maxHeight?: number;
}

type HunkDecision = "accepted" | "rejected" | "undecided";

const LINE_COLOR: Record<string, { bg: string; marker: string; markerColor: string }> = {
  add: { bg: "var(--diff-add-bg, #f0fdf4)", marker: "+", markerColor: "#16a34a" },
  remove: { bg: "var(--diff-remove-bg, #fef2f2)", marker: "-", markerColor: "#dc2626" },
  context: { bg: "transparent", marker: " ", markerColor: "inherit" },
};

function Hunk({
  hunk,
  decision,
  onDecide,
  onComment,
}: {
  hunk: DiffHunk;
  decision: HunkDecision;
  onDecide: (id: number, d: HunkDecision) => void;
  onComment: (hunkId: number, comment: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [commenting, setCommenting] = useState(false);
  const [commentText, setCommentText] = useState("");

  const isDecided = decision !== "undecided";

  return (
    <div
      className={`diff-hunk ${decision === "accepted" ? "diff-hunk-accepted" : ""} ${decision === "rejected" ? "diff-hunk-rejected" : ""}`}
    >
      <div className="diff-hunk-header">
        <button className="diff-hunk-toggle" onClick={() => setCollapsed(!collapsed)} aria-expanded={!collapsed}>
          <IconChevronDown size={12} className={collapsed ? "rotated" : ""} />
          <span className="diff-hunk-meta">
            Hunk {hunk.id + 1} — <span className="diff-hunk-adds">+{hunk.added}</span>{" "}
            <span className="diff-hunk-removes">-{hunk.removed}</span>
          </span>
        </button>
        <div className="diff-hunk-actions">
          {isDecided && (
            <button
              className="diff-hunk-undo"
              onClick={() => onDecide(hunk.id, "undecided")}
              title="Reset decision"
            >Undo</button>
          )}
          <button
            className={`diff-hunk-btn diff-hunk-accept ${decision === "accepted" ? "active" : ""}`}
            onClick={() => onDecide(hunk.id, decision === "accepted" ? "undecided" : "accepted")}
            title="Accept this hunk"
          >
            <IconCheck size={11} /> Accept
          </button>
          <button
            className={`diff-hunk-btn diff-hunk-reject ${decision === "rejected" ? "active" : ""}`}
            onClick={() => onDecide(hunk.id, decision === "rejected" ? "undecided" : "rejected")}
            title="Reject this hunk"
          >
            <IconX size={11} /> Reject
          </button>
          <button
            className="diff-hunk-btn diff-hunk-comment"
            onClick={() => setCommenting(!commenting)}
            title="Comment on this hunk"
          >Comment</button>
        </div>
      </div>

      {!collapsed && (
        <div className="diff-hunk-body">
          {hunk.lines.map((line, i) => {
            const style = LINE_COLOR[line.type];
            return (
              <div
                key={i}
                className={`diff-line diff-line-${line.type}`}
                style={{ background: style.bg }}
              >
                <span className="diff-line-marker" style={{ color: style.markerColor }}>{style.marker}</span>
                <span className="diff-line-text">{line.text}</span>
              </div>
            );
          })}
        </div>
      )}

      {commenting && (
        <div className="diff-hunk-comment-box">
          <textarea
            className="diff-hunk-comment-input"
            placeholder="What should change in this hunk?"
            value={commentText}
            onChange={(e) => setCommentText(e.target.value)}
            rows={2}
          />
          <div className="diff-hunk-comment-actions">
            <button
              className="diff-hunk-btn"
              onClick={() => { setCommenting(false); setCommentText(""); }}
            >Cancel</button>
            <button
              className="diff-hunk-btn diff-hunk-accept"
              disabled={!commentText.trim()}
              onClick={() => {
                onComment(hunk.id, commentText.trim());
                setCommenting(false);
                setCommentText("");
              }}
            >Send</button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function DiffView({ diff, onApply, onHunkComment, readOnly = false, maxHeight = 420 }: DiffViewProps) {
  const hunks = useMemo(() => parseDiffHunks(diff), [diff]);
  const [decisions, setDecisions] = useState<Record<number, HunkDecision>>({});

  const decidedCount = Object.values(decisions).filter(d => d !== "undecided").length;

  const handleDecide = useCallback((id: number, d: HunkDecision) => {
    setDecisions(prev => ({ ...prev, [id]: d }));
  }, []);

  const handleApply = useCallback(() => {
    const acceptedIds = new Set(
      Object.entries(decisions).filter(([, d]) => d === "accepted").map(([id]) => Number(id))
    );
    const rejectedIds = new Set(
      Object.entries(decisions).filter(([, d]) => d === "rejected").map(([id]) => Number(id))
    );
    onApply?.(filterDiffByHunks(diff, acceptedIds), acceptedIds, rejectedIds);
  }, [decisions, diff, onApply]);

  if (hunks.length === 0) {
    return <div className="diff-view-empty">No changes to review.</div>;
  }

  return (
    <div className="diff-view" style={{ maxHeight }}>
      {hunks.map(hunk => (
        <Hunk
          key={hunk.id}
          hunk={hunk}
          decision={decisions[hunk.id] || "undecided"}
          onDecide={handleDecide}
          onComment={(id, comment) => onHunkComment?.(id, comment)}
        />
      ))}

      {!readOnly && (
        <div className="diff-view-footer">
          <span className="diff-view-summary">
            {decidedCount > 0
              ? `${decidedCount}/${hunks.length} hunk(s) reviewed`
              : "Accept or reject individual hunks, then apply."}
          </span>
          <button
            className="diff-view-apply"
            onClick={handleApply}
            disabled={decidedCount === 0}
          >
            Apply {decidedCount > 0 ? `(${decidedCount} hunk${decidedCount > 1 ? "s" : ""})` : ""}
          </button>
        </div>
      )}
    </div>
  );
}
