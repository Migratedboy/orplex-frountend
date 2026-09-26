"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api-base";

interface CommentInputProps {
  artifactId: string;
  /** Optional pin position (0–1 fractions) captured from a screenshot click. */
  anchor?: { x: number; y: number };
  /** Called when the user dismisses a captured anchor without commenting. */
  onCancelAnchor?: () => void;
  onCommentAdded?: (comment: { id: string; content: string; createdAt: string; anchorX?: number | null; anchorY?: number | null }) => void;
}

export default function CommentInput({ artifactId, anchor, onCancelAnchor, onCommentAdded }: CommentInputProps) {
  const [content, setContent] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (!content.trim() || submitting) return;

    setSubmitting(true);
    try {
      const res = await apiFetch(`/api/agent/artifacts/${artifactId}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: content.trim(),
          ...(anchor ? { anchorX: anchor.x, anchorY: anchor.y } : {}),
        }),
      });

      if (res.ok) {
        const data = await res.json();
        setContent("");
        onCommentAdded?.(data.comment);
      }
    } catch {
      // Silent fail
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="comment-input">
      {anchor && (
        <span className="comment-input-anchor" title="Pinned to screenshot">
          📍 {Math.round(anchor.x * 100)}%, {Math.round(anchor.y * 100)}%
          <button
            type="button"
            className="comment-input-anchor-cancel"
            onClick={onCancelAnchor}
            aria-label="Remove pin"
          >
            ×
          </button>
        </span>
      )}
      <input
        type="text"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
        placeholder={anchor ? "What should change here?" : "Add feedback for the agent..."}
        className="comment-input-field"
        disabled={submitting}
        autoFocus={!!anchor}
      />
      <button
        onClick={handleSubmit}
        disabled={!content.trim() || submitting}
        className="comment-input-btn"
      >
        {submitting ? "..." : "→"}
      </button>
    </div>
  );
}
