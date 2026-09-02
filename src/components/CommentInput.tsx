"use client";

import { useState } from "react";

interface CommentInputProps {
  artifactId: string;
  onCommentAdded?: (comment: { id: string; content: string; createdAt: string }) => void;
}

export default function CommentInput({ artifactId, onCommentAdded }: CommentInputProps) {
  const [content, setContent] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (!content.trim() || submitting) return;

    setSubmitting(true);
    try {
      const res = await fetch(`/api/agent/artifacts/${artifactId}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: content.trim() }),
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
      <input
        type="text"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
        placeholder="Add feedback for the agent..."
        className="comment-input-field"
        disabled={submitting}
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
