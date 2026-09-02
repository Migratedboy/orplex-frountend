"use client";

import { useState, useEffect } from "react";
import CommentInput from "./CommentInput";

// === Types ===

interface Artifact {
  id: string;
  kind: string;
  name: string;
  content: string;
  mediaType: string;
  createdAt: string;
}

interface Comment {
  id: string;
  content: string;
  userId: string;
  createdAt: string;
}

// === Kind Config ===

const KIND_CONFIG: Record<string, { icon: string; label: string; color: string }> = {
  plan: { icon: "PLAN", label: "Plan", color: "soft-gold" },
  diff: { icon: "DIFF", label: "Diff", color: "primary-container" },
  screenshot: { icon: "IMG", label: "Screenshot", color: "teal" },
  console_check: { icon: "LOG", label: "Console Check", color: "teal" },
  code_output: { icon: "CODE", label: "Code Output", color: "primary-container" },
  research_output: { icon: "DOC", label: "Research", color: "soft-gold" },
  test_output: { icon: "TEST", label: "Tests", color: "emerald-500" },
  learning: { icon: "LEARN", label: "Learning", color: "purple" },
};

// === Component ===

export default function ArtifactCard({ artifact }: { artifact: Artifact }) {
  const [comments, setComments] = useState<Comment[]>([]);
  const [showComments, setShowComments] = useState(false);
  const [loadingComments, setLoadingComments] = useState(false);

  const config = KIND_CONFIG[artifact.kind] || { icon: "FILE", label: artifact.kind, color: "on-surface-variant" };

  // Fetch comments when expanded
  useEffect(() => {
    if (showComments && comments.length === 0) {
      setLoadingComments(true);
      fetch(`/api/agent/artifacts/${artifact.id}/comments`)
        .then((res) => res.json())
        .then((data) => setComments(data.comments || []))
        .catch(() => {})
        .finally(() => setLoadingComments(false));
    }
  }, [showComments, artifact.id, comments.length]);

  const handleCommentAdded = (comment: { id: string; content: string; createdAt: string }) => {
    setComments((prev) => [...prev, comment as Comment]);
  };

  return (
    <div className="artifact-card">
      {/* Header */}
      <div
        className="artifact-card-header"
        onClick={() => setShowComments(!showComments)}
      >
        <div className="artifact-card-info">
          <span className="artifact-card-icon">{config.icon}</span>
          <span className={`artifact-card-label text-${config.color}`}>
            {config.label}
          </span>
          <span className="artifact-card-name">{artifact.name}</span>
        </div>
        <div className="artifact-card-meta">
          <span className="artifact-card-time">
            {new Date(artifact.createdAt).toLocaleTimeString()}
          </span>
          <span className="artifact-card-chevron">
            {showComments ? "▾" : "▸"}
          </span>
        </div>
      </div>

      {/* Content Preview */}
      <div className="artifact-card-content">
        {artifact.kind === "screenshot" ? (
          <div className="artifact-card-screenshot">
            <span className="text-on-surface-variant text-[11px]">
              Screenshot saved to: {artifact.content}
            </span>
          </div>
        ) : artifact.kind === "diff" ? (
          <pre className="artifact-card-code">
            {artifact.content.slice(0, 500)}
            {artifact.content.length > 500 && "..."}
          </pre>
        ) : (
          <div className="artifact-card-text">
            {artifact.content.slice(0, 300)}
            {artifact.content.length > 300 && "..."}
          </div>
        )}
      </div>

      {/* Comments Section */}
      {showComments && (
        <div className="artifact-card-comments">
          {loadingComments ? (
            <div className="artifact-card-comments-loading">Loading comments...</div>
          ) : (
            <>
              {comments.map((comment) => (
                <div key={comment.id} className="artifact-comment">
                  <span className="artifact-comment-content">{comment.content}</span>
                  <span className="artifact-comment-time">
                    {new Date(comment.createdAt).toLocaleTimeString()}
                  </span>
                </div>
              ))}
              {comments.length === 0 && (
                <div className="artifact-card-comments-empty">
                  No feedback yet. Add a comment below.
                </div>
              )}
            </>
          )}
          <CommentInput
            artifactId={artifact.id}
            onCommentAdded={handleCommentAdded}
          />
        </div>
      )}
    </div>
  );
}
