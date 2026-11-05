"use client";

/**
 * ThoughtThread — the agent's reasoning thread above an assistant turn.
 *
 * ONE `useThoughtLine()` hook per turn (the component is mounted once per
 * assistant message, so every turn keeps its own thread and history is never
 * cleared). The transcript is the source of truth for WHAT happened; the hook
 * is the source of truth for the timings.
 *
 *   live turn    → steps appear as the transcript grows: add() the new ones,
 *                  stream() the output that landed, complete()/fail() the ones
 *                  that finished.
 *   history turn → hydrate in one shot with set(), every step finished. A
 *                  reloaded run must never look like it is still working, so
 *                  nothing stays "active".
 *
 * The PURE reasoning rows ("[THINKING]" blocks — kind "think", no glyph, no
 * error state) are NOT thread rows: they render as a single ThinkingPill with
 * the streamed reasoning in its collapsible panel. Everything else — tool
 * steps, gates, repairs, breakers, the result — stays in the ThoughtLine
 * thread exactly as before.
 */

import { useMemo, useRef, useState, useEffect } from "react";
import ThinkingPill from "./ThinkingPill";
import { ThoughtLine, useThoughtLine, type Thought } from "./ThoughtLine";
import { deriveThoughtSteps, type ThoughtStep } from "@/lib/thought-line";
import type { ContentSegment } from "@/lib/message-content";

/** One turn's worth of steps as the hook wants them. */
function toInputs(steps: ThoughtStep[]) {
  return steps.map((step) => {
    const base = {
      id: step.id,
      text: step.text,
      detail: step.detail,
      kind: step.kind,
      glyph: step.glyph,
    };
    // An active step stays active; everything else is finished. `duration`
    // is what makes set() build a finished thought.
    if (step.status === "active") return base;
    return {
      ...base,
      status: step.status === "error" ? ("error" as const) : ("done" as const),
      duration: 0,
    };
  });
}

/** A plain "[THINKING]" block: kind think, no marker glyph, never an error.
 *  These are the model's own reasoning — the ThinkingPill's domain. */
function isPlainReasoning(step: ThoughtStep): boolean {
  return step.kind === "think" && !step.glyph && step.status !== "error";
}

export default function ThoughtThread({
  segments,
  runLive = false,
}: {
  /** The turn's parsed transcript — already parsed by MessageContent. */
  segments: ContentSegment[];
  /** The turn is still running. */
  runLive?: boolean;
}) {
  const { thoughts, add, update, stream, complete, fail, set } = useThoughtLine();

  const steps = useMemo(
    () => deriveThoughtSteps(segments, { live: runLive }),
    [segments, runLive]
  );

  // Pure reasoning → the pill; everything else → the ThoughtLine thread.
  const reasoningSteps = useMemo(
    () => steps.filter(isPlainReasoning),
    [steps]
  );
  const threadSteps = useMemo(
    () => steps.filter((s) => !isPlainReasoning(s)),
    [steps]
  );

  // The pill's reasoning text: every reasoning block joined. The pill handles
  // its own open state, live caret and streaming scroll.
  const reasoningText = useMemo(
    () =>
      reasoningSteps
        .map((s) => s.detail || "")
        .filter(Boolean)
        .join("\n\n"),
    [reasoningSteps]
  );

  // While is the pill "Thinking…"? Only while the turn is live AND the model
  // is actually reasoning (the LAST step is a plain reasoning block). Once a
  // tool step takes over — or the turn ends — the pill collapses to done.
  const streamingThink = useMemo(() => {
    if (!runLive) return false;
    const last = steps[steps.length - 1];
    return !!last && isPlainReasoning(last);
  }, [steps, runLive]);

  // Mirror of the hook state so the sync effect can diff against it without
  // DEPENDING on it (depending on the thoughts would re-run the effect on
  // every render, and the effect writes to the thoughts → a loop).
  const thoughtsRef = useRef<Thought[]>(thoughts);
  thoughtsRef.current = thoughts;

  // A turn that was ever live stays live: its step timings are real. A turn
  // that mounts already finished is history and is hydrated in one shot.
  const liveEver = useRef(false);
  if (runLive) liveEver.current = true;
  const mode: "live" | "history" = liveEver.current ? "live" : "history";

  // How many thread steps the last sync produced — a SHRINK means the
  // transcript was replaced (a retry, a rewind), so the thread is re-hydrated
  // from scratch.
  const syncedCount = useRef(0);

  useEffect(() => {
    const shrank = threadSteps.length < syncedCount.current;
    syncedCount.current = threadSteps.length;

    if (mode === "history" || shrank) {
      // History (or a rewound transcript): hydrate every step as FINISHED.
      set(toInputs(threadSteps));
      return;
    }

    // Live turn: add what appeared, patch what grew, close what finished.
    const current = new Map(thoughtsRef.current.map((t) => [t.id, t]));

    for (const step of threadSteps) {
      const have = current.get(step.id);
      if (!have) {
        add({
          id: step.id,
          text: step.text,
          detail: step.detail,
          kind: step.kind,
          glyph: step.glyph,
        });
        // Close it right away, in the SAME queue position: the next add()
        // auto-completes the previous thought, and a step that must read as
        // FAILED has to be failed before that happens.
        if (step.status === "error") fail(step.id);
        else if (step.status === "done") complete(step.id);
        continue;
      }

      if (have.text !== step.text || have.kind !== step.kind || have.glyph !== step.glyph) {
        update(step.id, { text: step.text, kind: step.kind, glyph: step.glyph });
      }

      const before = have.detail || "";
      const after = step.detail || "";
      if (before !== after) {
        if (after.startsWith(before) && after.length > before.length) {
          // Output grew — stream the delta in, exactly like a live token feed.
          stream(step.id, after.slice(before.length));
        } else {
          // The start line was replaced by its result line: rewrite the body.
          update(step.id, { detail: after });
        }
      }

      if (have.status === "active") {
        if (step.status === "error") fail(step.id);
        else if (step.status === "done") complete(step.id);
      }
    }
  }, [threadSteps, mode, add, update, stream, complete, fail, set]);

  const hasThread = threadSteps.length > 0;
  const hasReasoning = reasoningSteps.length > 0;
  if (!hasThread && !hasReasoning) return null;

  return (
    <div className="thought-thread">
      {/* The model's own reasoning, collapsible (ThinkingPill). */}
      {hasReasoning && (
        <ThinkingPill reasoning={reasoningText} done={!streamingThink} />
      )}
      {/* Tools, gates, breakers and the result — unchanged thread rows. */}
      {hasThread && (
        <ThoughtLine
          thoughts={thoughts}
          className={
            mode === "live" ? "tl-thread tl-thread--live" : "tl-thread tl-thread--history"
          }
          label="Agent reasoning thread"
        />
      )}
    </div>
  );
}
