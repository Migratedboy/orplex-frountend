"use client";

// OnboardingTour.tsx — the real guided tour (coach marks): a dimming
// spotlight over one live target per step, a clamped, position-adaptive
// tooltip, a click shield over everything (a click lands in neither the
// highlighted control nor the tooltip), and repositioning on every layout
// shift via a poll loop that re-measures the target rect.
//
// Shown once per account (the host persists completion in localStorage via
// onComplete). Esc or Skip ends the tour. A step whose target can't be
// resolved within TARGET_WAIT is skipped automatically, so a different
// viewport or a late-mounted panel can never leave a floating card behind.

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { TUTORIAL_STEPS } from "../tutorial/tutorial-steps";

const POLL_MS = 250; // re-measure: tracks resize, scroll, HMR, late mounts
const TARGET_WAIT = 9000; // how long a step waits for a late-mounted target
const EDGE = 10; // viewport clamp margin
const GAP = 14; // tooltip-to-target distance
const SHIELD_Z = 300;
const CARD_Z = 310;

/** Tooltip preference side (flips automatically when it would overflow). */
type Position = "top" | "bottom" | "left" | "right";

interface OnboardingTourProps {
  onComplete: () => void;
}

export default function OnboardingTour({ onComplete }: OnboardingTourProps) {
  const [idx, setIdx] = useState(0);
  // Viewport rect of the resolved target this tick; null while unresolved.
  const [targetRect, setTargetRect] = useState<DOMRect | null>(null);
  // The card's own rect (for clamped placement); null until measured.
  const [cardRect, setCardRect] = useState<DOMRect | null>(null);
  // "givenUp" = the step's target never resolved within the wait window.
  const [stage, setStage] = useState<"measuring" | "givenUp">("measuring");
  const cardRef = useRef<HTMLDivElement | null>(null);
  const step = TUTORIAL_STEPS[idx];

  const finish = useCallback(() => onComplete(), [onComplete]);
  const next = useCallback(() => {
    if (idx < TUTORIAL_STEPS.length - 1) setIdx(idx + 1);
    else finish();
  }, [idx, finish]);

  // Esc anywhere skips the whole tour.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        finish();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [finish]);

  // Arriving at a step scrolls its target into view.
  useEffect(() => {
    step?.resolve?.()?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [idx, step]);

  // The measurement loop doubles as the repositioning loop: target rects are
  // viewport-relative, so re-reading them every POLL_MS tracks scroll and
  // window changes without bespoke listeners — and doubles as the wait
  // window for late-mounted targets.
  useEffect(() => {
    let cancelled = false;
    let seen = false;
    let iv: ReturnType<typeof setInterval> | undefined;
    const start = performance.now();
    setStage("measuring"); // arriving at a step restarts the wait window
    const tick = () => {
      if (cancelled) return;
      const el = step?.resolve?.();
      const r = el?.getBoundingClientRect() ?? null;
      if (r && r.width + r.height > 0) {
        seen = true;
        setTargetRect(r);
      } else {
        setTargetRect(null);
        if (!seen && performance.now() - start > TARGET_WAIT) {
          cancelled = true;
          if (iv) clearInterval(iv);
          setStage("givenUp");
        }
      }
    };
    iv = setInterval(tick, POLL_MS);
    tick();
    return () => {
      cancelled = true;
      if (iv) clearInterval(iv);
    };
  }, [idx, step]);

  // Measure the card after each step change so the clamp math knows its size,
  // and clear the stale measurement so the card hides until re-landed.
  useEffect(() => {
    setCardRect(null);
    setCardRect(cardRef.current?.getBoundingClientRect() ?? null);
  }, [idx, step]);

  // Target never showed up → skip past the step (or finish on the last one).
  useEffect(() => {
    if (stage !== "givenUp") return;
    next();
  }, [stage, next]);

  const isCentered = step?.resolve == null;
  const last = idx === TUTORIAL_STEPS.length - 1;

  // Targeted card hides until measured, so its first paint doesn't flash at
  // the fallback position before the clamp math has run.
  const settled = isCentered || cardRect != null || targetRect != null;

  return (
    <>
      {/* Click shield — swallows every click outside the card. */}
      <div style={{ position: "fixed", inset: 0, zIndex: SHIELD_Z }} aria-hidden="true" />
      {/* Spotlight — a rounded hole with a page-wide dim via box-shadow. */}
      {targetRect && !isCentered && (
        <div
          style={{
            position: "fixed",
            zIndex: SHIELD_Z + 1,
            top: targetRect.top - 5,
            left: targetRect.left - 5,
            width: targetRect.width + 10,
            height: targetRect.height + 10,
            borderRadius: 10,
            border: "2px solid var(--brand-vivid, #ff6b00)",
            boxShadow: "0 0 0 9999px rgba(5,5,12,0.66)",
            pointerEvents: "none",
            transition: "top .18s cubic-bezier(.2,.8,.3,1), left .18s cubic-bezier(.2,.8,.3,1), width .18s cubic-bezier(.2,.8,.3,1), height .18s cubic-bezier(.2,.8,.3,1)",
          }}
          aria-hidden="true"
        />
      )}
      <div
        ref={cardRef}
        role="dialog"
        aria-label={`Tour: ${step?.title ?? ""}`}
        className="tour-card"
        data-centered={isCentered ? "" : undefined}
        style={{ ...cardPlacement(step, isCentered, targetRect, cardRect), zIndex: CARD_Z, visibility: settled ? "visible" : "hidden" }}
      >
        <div className="tour-top">
          <span className="tour-step">Step {idx + 1} of {TUTORIAL_STEPS.length}</span>
          <button onClick={finish} className="tour-skip">Skip</button>
        </div>
        <h3 className="tour-title">{step.title}</h3>
        <p className="tour-desc">{step.body}</p>
        <div className="tour-actions">
          {idx > 0 && (
            <button onClick={() => setIdx(idx - 1)} className="tour-btn">Back</button>
          )}
          <button onClick={next} className="tour-btn--primary">
            {last ? "Start building" : "Next"}
          </button>
        </div>
      </div>
    </>
  );
}

/**
 * Where the card goes. Prefers `step.position` relative to the target rect,
 * flips to the opposite side when the preferred side would overflow, then
 * clamps to the viewport. No target → centered.
 */
function cardPlacement(
  step: (typeof TUTORIAL_STEPS)[number] | undefined,
  isCentered: boolean,
  targetRect: DOMRect | null,
  cardRect: DOMRect | null
): CSSProperties {
  if (isCentered || !targetRect) {
    return { left: "50%", top: "50%", transform: "translate(-50%, -50%)" };
  }
  // First-measure guess: the card is ~340×190; refined next paint.
  const cw = cardRect?.width ?? 340;
  const ch = cardRect?.height ?? 190;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const clampX = (x: number) => Math.max(EDGE, Math.min(vw - cw - EDGE, x));
  const clampY = (y: number) => Math.max(EDGE, Math.min(vh - ch - EDGE, y));

  const prefer: Position = step?.position ?? "bottom";
  const cx = targetRect.left + targetRect.width / 2;
  const cy = targetRect.top + targetRect.height / 2;

  let left: number;
  let top: number;
  if (prefer === "bottom") {
    left = clampX(cx - cw / 2);
    top = targetRect.bottom + GAP;
    if (top + ch > vh - EDGE && targetRect.top - GAP - ch >= EDGE) top = targetRect.top - GAP - ch;
  } else if (prefer === "top") {
    left = clampX(cx - cw / 2);
    top = targetRect.top - GAP - ch;
    if (top < EDGE && targetRect.bottom + GAP + ch <= vh - EDGE) top = targetRect.bottom + GAP;
  } else if (prefer === "left") {
    left = targetRect.left - GAP - cw;
    top = clampY(cy - ch / 2);
    if (left < EDGE && targetRect.right + GAP + cw <= vw - EDGE) left = targetRect.right + GAP;
  } else {
    left = targetRect.right + GAP;
    top = clampY(cy - ch / 2);
    if (left + cw > vw - EDGE && targetRect.left - GAP - cw >= EDGE) left = targetRect.left - GAP - cw;
  }
  left = clampX(left);
  top = clampY(top);
  return { left, top, transform: "none" };
}
