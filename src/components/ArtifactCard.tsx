"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import CommentInput from "./CommentInput";
import MarkdownRenderer from "./MarkdownRenderer";
import DiffView from "./DiffView";
import ReviewStrip from "./ReviewStrip";
import { apiFetch } from "@/lib/api-base";
import { walkthroughNarration } from "@/lib/walkthrough";

// === Types ===

interface Artifact {
  id: string;
  runId?: string;
  kind: string;
  name: string;
  content: string;
  mediaType: string;
  createdAt: string;
  // Review-chain fields (optional: pre-schema payloads)
  status?: string | null;
  reviewNote?: string | null;
  sequence?: number | null;
}

interface Comment {
  id: string;
  content: string;
  userId: string;
  createdAt: string;
  anchorX?: number | null;
  anchorY?: number | null;
}

interface TimelineStep {
  action: string;
  detail?: string;
  screenshotPath?: string;
  consoleErrorsAtStep: number;
  atMs: number;
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
  timeline: { icon: "TIME", label: "Timeline", color: "teal" },
  walkthrough: { icon: "REPLAY", label: "Walkthrough", color: "teal" },
};

/**
 * Artifact content → path usable by /api/workspace-file. Absolute paths
 * (as written by the verify route) are passed through normalized — the
 * route's containment check only serves them if they live under the
 * registered workspace root.
 */
function artifactFilePath(p: string): string {
  return p.replace(/\\/g, "/");
}

// === Component ===

export default function ArtifactCard({ artifact }: { artifact: Artifact }) {
  const [comments, setComments] = useState<Comment[]>([]);
  const [showComments, setShowComments] = useState(false);
  const [loadingComments, setLoadingComments] = useState(false);
  const [pendingAnchor, setPendingAnchor] = useState<{ x: number; y: number } | null>(null);
  const [applyState, setApplyState] = useState<"idle" | "sent">("idle");
  const imgWrapRef = useRef<HTMLDivElement>(null);
  const isScreenshot = artifact.kind === "screenshot";
  const isTimeline = artifact.kind === "timeline";

  const config = KIND_CONFIG[artifact.kind] || { icon: "FILE", label: artifact.kind, color: "on-surface-variant" };

  const fetchComments = useCallback(() => {
    setLoadingComments(true);
    apiFetch(`/api/agent/artifacts/${artifact.id}/comments`)
      .then((res) => res.json())
      .then((data) => setComments(data.comments || []))
      .catch(() => {})
      .finally(() => setLoadingComments(false));
  }, [artifact.id]);

  // Fetch comments when expanded
  useEffect(() => {
    if (showComments && comments.length === 0) {
      fetchComments();
    }
  }, [showComments, comments.length, fetchComments]);

  const handleCommentAdded = (comment: { id: string; content: string; createdAt: string; anchorX?: number | null; anchorY?: number | null }) => {
    setComments((prev) => [...prev, comment as Comment]);
    setPendingAnchor(null);
  };

  /** Click on the screenshot → capture normalized pin position. */
  const handleScreenshotClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isScreenshot) return;
    const rect = imgWrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const y = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
    setPendingAnchor({ x, y });
    setShowComments(true);
  };

  const handleTimelineStepClick = (step: TimelineStep) => {
    if (step.screenshotPath) {
      window.open(`/api/workspace-file?path=${encodeURIComponent(step.screenshotPath)}`, "_blank");
    }
  };

  /** Send all pinned comments to the agent as an actionable visual brief. */
  const handleApplyWithAgent = () => {
    const pinned = comments.filter((c) => c.anchorX != null && c.anchorY != null);
    if (pinned.length === 0) return;
    const lines = pinned.map((c, i) =>
      `${i + 1}. At (${Math.round((c.anchorX || 0) * 100)}%, ${Math.round((c.anchorY || 0) * 100)}%): "${c.content}"`
    );
    const brief =
      `[VISUAL FEEDBACK] The user reviewed a screenshot of the running app ` +
      `(${artifact.name}) and left ${pinned.length} pinned annotation(s):\n\n${lines.join("\n")}\n\n` +
      `Each annotation gives a position on the rendered UI plus the change the user wants there. ` +
      `Find the corresponding element/component in the workspace and make the change.`;

    window.dispatchEvent(
      new CustomEvent("orplex:apply-annotations", {
        detail: { prompt: brief, artifactId: artifact.id },
      })
    );
    setApplyState("sent");
    setTimeout(() => setApplyState("idle"), 4000);
  };

  const pinnedCount = comments.filter((c) => c.anchorX != null && c.anchorY != null).length;
  const shotPath = isScreenshot && artifact.content ? artifactFilePath(artifact.content) : null;

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
        {isScreenshot && shotPath ? (
          <div
            ref={imgWrapRef}
            className={`artifact-card-screenshot-imgwrap${pendingAnchor ? " pinning" : ""}`}
            onClick={handleScreenshotClick}
            title="Click anywhere to pin a comment"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`/api/workspace-file?path=${encodeURIComponent(shotPath)}`}
              alt={artifact.name}
              className="artifact-card-screenshot-img"
              draggable={false}
            />
            {comments
              .filter((c) => c.anchorX != null && c.anchorY != null)
              .map((c, i) => (
                <span
                  key={c.id}
                  className="artifact-pin"
                  style={{ left: `${(c.anchorX || 0) * 100}%`, top: `${(c.anchorY || 0) * 100}%` }}
                  title={c.content}
                >
                  {i + 1}
                </span>
              ))}
            {pendingAnchor && (
              <span
                className="artifact-pin artifact-pin-pending"
                style={{ left: `${pendingAnchor.x * 100}%`, top: `${pendingAnchor.y * 100}%` }}
              >
                +
              </span>
            )}
          </div>
        ) : isTimeline ? (
          <TimelineView content={artifact.content} onStepClick={handleTimelineStepClick} />
        ) : artifact.kind === "walkthrough" ? (
          // Replayable browser-verification walkthrough: frame player + steps
          <WalkthroughView content={artifact.content} />
        ) : artifact.kind === "diff" ? (
          <pre className="artifact-card-code">
            {artifact.content.slice(0, 500)}
            {artifact.content.length > 500 && "..."}
          </pre>
        ) : artifact.kind === "patch" ? (
          // Unified diff of the run's branch — full reviewable rendering
          <DiffView diff={artifact.content} readOnly maxHeight={320} />
        ) : artifact.kind === "report" ? (
          // Model-written run summary — render as markdown, not raw text
          <div className="artifact-card-markdown">
            <MarkdownRenderer content={artifact.content.slice(0, 20_000)} />
          </div>
        ) : artifact.kind === "log" ? (
          <pre className="artifact-card-code">{artifact.content.slice(0, 2000)}{artifact.content.length > 2000 && "..."}</pre>
        ) : (
          <div className="artifact-card-text">
            {artifact.content.slice(0, 300)}
            {artifact.content.length > 300 && "..."}
          </div>
        )}
      </div>

      {/* Review verdict bar (approve/reject chain) */}
      <ReviewStrip
        artifactId={artifact.id}
        runId={artifact.runId}
        initialStatus={artifact.status}
        initialNote={artifact.reviewNote}
      />

      {/* Apply-with-agent action */}
      {isScreenshot && pinnedCount > 0 && (
        <div className="artifact-card-apply">
          <button className="artifact-apply-btn" onClick={handleApplyWithAgent} disabled={applyState === "sent"}>
            {applyState === "sent" ? "Sent to agent ✓" : `Apply ${pinnedCount} annotation${pinnedCount > 1 ? "s" : ""} with agent`}
          </button>
        </div>
      )}

      {/* Comments Section */}
      {showComments && (
        <div className="artifact-card-comments">
          {loadingComments ? (
            <div className="artifact-card-comments-loading">Loading comments...</div>
          ) : (
            <>
              {comments.length === 0 && (
                <div className="artifact-card-comments-empty">
                  {isScreenshot ? "Click the screenshot to pin feedback where it matters." : "No feedback yet."}
                </div>
              )}
              {comments.map((comment, i) => (
                <div key={comment.id} className="artifact-comment">
                  {comment.anchorX != null && comment.anchorY != null && (
                    <span className="artifact-comment-pin">
                      📍 {Math.round(comment.anchorX * 100)}%, {Math.round(comment.anchorY * 100)}%
                    </span>
                  )}
                  <span className="artifact-comment-content">{comment.content}</span>
                  <span className="artifact-comment-time">
                    {new Date(comment.createdAt).toLocaleTimeString()}
                  </span>
                  <span className="sr-only">{i}</span>
                </div>
              ))}
              <CommentInput
                artifactId={artifact.id}
                anchor={pendingAnchor ?? undefined}
                onCancelAnchor={() => setPendingAnchor(null)}
                onCommentAdded={handleCommentAdded}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}

// === Timeline view (step-through of what the agent's browser did) ===

function TimelineView({
  content,
  onStepClick,
}: {
  content: string;
  onStepClick: (step: TimelineStep) => void;
}) {
  let steps: TimelineStep[] = [];
  let url = "";
  try {
    const parsed = JSON.parse(content);
    steps = Array.isArray(parsed.steps) ? parsed.steps : [];
    url = parsed.url || "";
  } catch {
    // fall through with empty steps
  }

  if (steps.length === 0) {
    return <div className="artifact-card-text">Empty timeline.</div>;
  }

  const totalErrors = steps[steps.length - 1]?.consoleErrorsAtStep ?? 0;

  return (
    <div className="artifact-timeline">
      <div className="artifact-timeline-url" title={url}>
        {url} · {steps.length} step{steps.length > 1 ? "s" : ""} ·{" "}
        {totalErrors === 0 ? <><span className="ms ms-sm">check</span> no console errors</> : <><span className="ms ms-sm">error</span> {totalErrors} console error(s)</>}
      </div>
      <ol className="artifact-timeline-steps">
        {steps.map((s, i) => (
          <li
            key={i}
            className={`artifact-timeline-step${s.screenshotPath ? " clickable" : ""}${
              s.consoleErrorsAtStep > 0 ? " has-errors" : ""
            }`}
            onClick={() => onStepClick(s)}
            title={s.screenshotPath ? "Open step screenshot" : undefined}
          >
            <span className="artifact-timeline-step-num">{i + 1}</span>
            <span className="artifact-timeline-step-action">{s.action}</span>
            {s.detail && <span className="artifact-timeline-step-detail">{String(s.detail).slice(0, 60)}</span>}
            <span className="artifact-timeline-step-errors">
              {s.consoleErrorsAtStep > 0 ? <><span className="ms ms-sm">warning</span> {s.consoleErrorsAtStep}</> : <span className="ms ms-sm">check</span>}
            </span>
            <span className="artifact-timeline-step-time">+{(s.atMs / 1000).toFixed(1)}s</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * WalkthroughView — replay player for the browser-verification walkthrough
 * artifact (kind: "walkthrough", JSON per lib/walkthrough.ts).
 *
 * Frame images are served through /api/workspace-file, whose containment
 * check only ever serves files under the user's registered workspace — the
 * server executor preserves frames there before its worktrees are deleted.
 */
function WalkthroughView({ content }: { content: string }) {
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [playTimer, setPlayTimer] = useState<ReturnType<typeof setInterval> | null>(null);

  // Clear the interval whenever it changes and on unmount. (Empty deps would
  // capture the initial null forever and leak the timer until it self-clears.)
  // Lives ABOVE the early return below — conditional hooks are illegal.
  useEffect(() => () => { if (playTimer) clearInterval(playTimer); }, [playTimer]);

  let wt: {
    url?: string;
    pageTitle?: string;
    httpStatus?: number;
    success?: boolean;
    durationMs?: number;
    frames?: Array<{
      i: number;
      action: string;
      detail?: string;
      framePath?: string | null;
      errorsAtStep: number;
      newErrors: number;
      atMs: number;
    }>;
    consoleErrors?: string[];
    framesPreserved?: boolean;
  } | null = null;
  try {
    wt = JSON.parse(content);
  } catch {
    // fall through
  }

  const frames = wt?.frames ?? [];
  if (frames.length === 0) {
    return <div className="artifact-card-text">Empty walkthrough.</div>;
  }

  const step = frames[Math.min(idx, frames.length - 1)];

  // Narration + error-delta summary (computed once per content change)
  let narration = "";
  let totalNewErrors = 0;
  try {
    if (wt) {
      narration = walkthroughNarration(wt as Parameters<typeof walkthroughNarration>[0]);
      totalNewErrors = (wt.frames ?? []).reduce((n, f) => n + (f.newErrors || 0), 0);
    }
  } catch {
    // narration is cosmetic — never break the replay player
  }

  const play = () => {
    if (playing) {
      if (playTimer) clearInterval(playTimer);
      setPlayTimer(null);
      setPlaying(false);
      return;
    }
    setIdx(0);
    setPlaying(true);
    const t = setInterval(() => {
      setIdx((prev) => {
        if (prev >= frames.length - 1) {
          clearInterval(t);
          setPlaying(false);
          return prev;
        }
        return prev + 1;
      });
    }, 1400);
    setPlayTimer(t);
  };

  const frameUrl = step?.framePath
    ? `/api/workspace-file?path=${encodeURIComponent(artifactFilePath(step.framePath))}`
    : null;
  const newErrorsHere = step?.newErrors ?? 0;

  return (
    <div className="artifact-walkthrough">
      {/* Header */}
      <div className="artifact-timeline-url" title={wt?.url || undefined}>
        <span className="ms ms-sm">{wt?.success === false ? "cancel" : "check_circle"}</span> {wt?.url || "verification session"} ·{" "}
        {frames.length} step{frames.length > 1 ? "s" : ""} ·{" "}
        {(wt?.durationMs ?? 0) >= 1000 ? `${((wt?.durationMs ?? 0) / 1000).toFixed(1)}s` : `${wt?.durationMs ?? 0}ms`}
        {(wt?.consoleErrors?.length ?? 0) > 0 && ` · ${wt!.consoleErrors!.length} console error(s)`}
      </div>

      {/* Narration — plain-language summary of the session (deterministic) */}
      {narration && (
        <div className="artifact-walkthrough-narration">{narration}</div>
      )}

      {/* Error-delta bar — shows exactly when console errors appeared */}
      {totalNewErrors > 0 && (
        <div className="artifact-walkthrough-deltas" aria-hidden>
          {frames.map((f) => (
            <span
              key={f.i}
              className={`artifact-walkthrough-delta${f.newErrors > 0 ? " hot" : ""}${f.i === step.i ? " current" : ""}`}
              style={{ flexGrow: Math.max(1, Math.round(f.atMs / 500)) }}
              title={f.newErrors > 0 ? `+${f.newErrors} error(s) at +${(f.atMs / 1000).toFixed(1)}s` : undefined}
              onClick={() => setIdx(f.i)}
            />
          ))}
        </div>
      )}

      {/* Frame viewer */}
      <div className="artifact-walkthrough-frame">
        {frameUrl ? (
          <img
            src={frameUrl}
            alt={`Step ${step.i + 1}: ${step.action}`}
            className="artifact-card-screenshot-img"
            loading="lazy"
          />
        ) : (
          <div className="artifact-walkthrough-noframe">
            (no frame captured for this step)
          </div>
        )}
      </div>

      {/* Transport */}
      <div className="artifact-walkthrough-transport">
        <button
          className="artifact-walkthrough-btn"
          onClick={() => setIdx(Math.max(0, (step?.i ?? 0) - 1))}
          disabled={(step?.i ?? 0) === 0}
          title="Previous step"
        >
          ‹ Prev
        </button>
        <span className="artifact-walkthrough-pos">
          Step {step.i + 1} / {frames.length}
        </span>
        <button
          className="artifact-walkthrough-btn"
          onClick={() => setIdx(Math.min(frames.length - 1, (step?.i ?? 0) + 1))}
          disabled={(step?.i ?? 0) >= frames.length - 1}
          title="Next step"
        >
          Next ›
        </button>
        <button
          className={`artifact-walkthrough-btn${playing ? " active" : ""}`}
          onClick={play}
          title="Replay from the start"
        >
          {playing ? <><span className="ms ms-sm">pause</span> Stop</> : <><span className="ms ms-sm">play_arrow</span> Replay</>}
        </button>
      </div>

      {/* Step caption */}
      <div className={`artifact-walkthrough-caption${newErrorsHere > 0 ? " has-errors" : ""}`}>
        <span className="artifact-timeline-step-action">{step.action}</span>
        {step.detail && <span className="artifact-timeline-step-detail">{String(step.detail).slice(0, 80)}</span>}
        <span className="artifact-walkthrough-caption-time">+{(step.atMs / 1000).toFixed(1)}s</span>
        {newErrorsHere > 0 && (
          <span className="artifact-walkthrough-caption-errors">⚠ +{newErrorsHere} console error{newErrorsHere > 1 ? "s" : ""} here</span>
        )}
      </div>

      {/* Step list — click to jump */}
      <ol className="artifact-timeline-steps">
        {frames.map((f) => (
          <li
            key={f.i}
            className={`artifact-timeline-step clickable${f.i === step.i ? " current" : ""}${f.errorsAtStep > 0 ? " has-errors" : ""}`}
            onClick={() => setIdx(f.i)}
            title={f.detail || f.action}
          >
            <span className="artifact-timeline-step-num">{f.i + 1}</span>
            <span className="artifact-timeline-step-action">{f.action}</span>
            {f.detail && <span className="artifact-timeline-step-detail">{String(f.detail).slice(0, 60)}</span>}
            <span className="artifact-timeline-step-errors">
              {f.newErrors > 0 ? <><span className="ms ms-sm">warning</span> +{f.newErrors}</> : f.errorsAtStep > 0 ? <><span className="ms ms-sm">warning</span> {f.errorsAtStep}</> : <span className="ms ms-sm">check</span>}
            </span>
            <span className="artifact-timeline-step-time">+{(f.atMs / 1000).toFixed(1)}s</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
