"use client";

/**
 * send-glyph.tsx — the morphing send/stop icon, extracted verbatim from
 * PromptBar.tsx (Operation Modularity). The paper-plane path interpolates
 * point-by-point into the stop square so the icon morphs instead of
 * cross-fading; the crease line fades out as the morph completes.
 */
import { useEffect, useRef } from "react";
import { animate, useMotionValue, useMotionValueEvent, useReducedMotion } from "motion/react";

// Send icon: paper plane `M3.5 3.5L21 12L3.5 20.5L7 12Z` as a 7-point closed
// polygon (4 vertices + 3 edge midpoints) so pathAt can morph it into SQUARE
// with the same point-by-point interpolation the old arrow used. Order follows
// the original path traversal: tip -> nose -> tail -> notch -> back to tip.
const PLANE = [3.5, 3.5, 12.25, 7.75, 21, 12, 12.25, 16.25, 3.5, 20.5, 7, 12, 5.25, 7.75];
// Crease line `M7 12H21` — visible in the send state, fades out as the glyph morphs to the stop square.
const CREASE = "M7 12H21";
const SQUARE = [12, 6, 18, 6, 18, 12, 18, 18, 6, 18, 6, 12, 6, 6];
const EASE_IN_OUT: [number, number, number, number] = [0.77, 0, 0.175, 1];

const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const pathAt = (a: number[], b: number[], t: number) => {
  let d = "";
  for (let i = 0; i < a.length; i += 2) {
    d += `${i ? "L" : "M"}${mix(a[i], b[i], t).toFixed(2)} ${mix(a[i + 1], b[i + 1], t).toFixed(2)}`;
  }
  return `${d}Z`;
};

export function SendGlyph({ busy, morphDuration, squash, tilt }: { busy: boolean; morphDuration: number; squash: number; tilt: number }) {
  const reduce = useReducedMotion();
  const svgRef = useRef<SVGSVGElement | null>(null);
  const pathRef = useRef<SVGPathElement | null>(null);
  const creaseRef = useRef<SVGPathElement | null>(null);
  const dir = useRef(busy ? 1 : -1);
  const t = useMotionValue(busy ? 1 : 0);

  useEffect(() => {
    const target = busy ? 1 : 0;
    dir.current = busy ? 1 : -1;
    if (t.get() === target) return undefined;
    const controls = animate(
      t,
      target,
      reduce ? { duration: 0 } : { duration: morphDuration / 1000, ease: EASE_IN_OUT }
    );
    return () => controls.stop();
  }, [busy, morphDuration, reduce, t]);

  useMotionValueEvent(t, "change", (v: number) => {
    pathRef.current?.setAttribute("d", pathAt(PLANE, SQUARE, v));
    // Send state renders the icon as a pure outline (fill:none); the stop square
    // fills in as the morph completes so the stop button keeps its solid look.
    pathRef.current?.setAttribute("fill-opacity", v.toFixed(3));
    creaseRef.current?.setAttribute("stroke-opacity", (1 - v).toFixed(3));
    const goo = reduce ? 0 : Math.sin(v * Math.PI);
    const sx = 1 - squash * goo;
    if (svgRef.current) {
      svgRef.current.style.transform = goo ? `rotate(${dir.current * tilt * goo}deg) scale(${sx}, ${1 / sx})` : "";
    }
  });

  const v0 = t.get();
  return (
    <svg
      ref={svgRef}
      className="prompt-bar__glyph"
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="currentColor"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
      strokeLinecap="round"
    >
      <path ref={pathRef} d={pathAt(PLANE, SQUARE, v0)} fillOpacity={v0} />
      <path ref={creaseRef} d={CREASE} fill="none" strokeOpacity={1 - v0} />
    </svg>
  );
}
