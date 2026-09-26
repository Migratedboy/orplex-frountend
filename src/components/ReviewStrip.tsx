"use client";

// ReviewStrip — the human verdict bar on an artifact card. Shows the review
// status as a colored chip, lets the reviewer leave a short note, and posts
// the verdict to PATCH /api/agent/artifacts/:id. When every chain artifact
// is approved the server emits `artifact-chain-approved` (Approve & Merge).

import { useState } from "react";
import { apiJson } from "@/lib/api-base";

export type ReviewStatus = "draft" | "reviewed" | "approved" | "rejected";

const STATUS_STYLE: Record<ReviewStatus, { label: string; className: string }> = {
  draft: { label: "Draft", className: "pm-chip-muted" },
  reviewed: { label: "Reviewed", className: "pm-chip" },
  approved: { label: "Approved", className: "pm-chip-success" },
  rejected: { label: "Rejected", className: "pm-chip-danger" },
};

export function ReviewStrip({
  artifactId,
  runId,
  initialStatus,
  initialNote,
  onVerdict,
}: {
  artifactId: string;
  runId?: string;
  initialStatus?: string | null;
  initialNote?: string | null;
  onVerdict?: (status: ReviewStatus) => void;
}) {
  void runId; // reserved for run-scoped review actions (merge-all shortcut) {
  const [status, setStatus] = useState<ReviewStatus>(
    (initialStatus as ReviewStatus) || "draft"
  );
  const [note, setNote] = useState(initialNote || "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function submit(next: ReviewStatus) {
    setBusy(true);
    setErr("");
    try {
      const { ok, error } = await apiJson(
        `/api/agent/artifacts/${artifactId}`,
        { method: "PATCH", body: JSON.stringify({ status: next, reviewNote: note || undefined }) }
      );
      if (!ok) {
        setErr(error || "Review failed");
      } else {
        setStatus(next);
        onVerdict?.(next);
      }
    } catch {
      setErr("Review failed");
    } finally {
      setBusy(false);
    }
  }

  const style = STATUS_STYLE[status] || STATUS_STYLE.draft;

  return (
    <div className="review-strip">
      <span className={`review-chip ${style.className}`}>{style.label}</span>
      <input
        className="review-note"
        type="text"
        placeholder="Review note (optional)"
        value={note}
        maxLength={500}
        onChange={(e) => setNote(e.target.value)}
        disabled={busy}
      />
      <button
        type="button"
        className="review-btn review-approve"
        disabled={busy || status === "approved"}
        onClick={() => submit("approved")}
        title="Approve this artifact"
      >
        Approve
      </button>
      <button
        type="button"
        className="review-btn review-reject"
        disabled={busy || status === "rejected"}
        onClick={() => submit("rejected")}
        title="Reject this artifact"
      >
        Reject
      </button>
      {err ? <span className="review-error">{err}</span> : null}
    </div>
  );
}

export default ReviewStrip;
