"use client";
import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion, type TargetAndTransition } from "framer-motion";

// MascotLogo — the Orplex mascot with idle random movements.
// A library of 32 hand-tuned twitch moves (tilts, bobs, wiggles, shakes,
// squashes, peeks, zooms, hops...). Every 0.9–4s a random move plays and
// springs back to neutral, so the mascot feels alive instead of sitting
// perfectly still. Honors prefers-reduced-motion: falls back to a static logo.

type Move = {
  name: string;
  duration: number; // seconds
  anim: TargetAndTransition;
};

// Neutral pose = rotate/x/y/skew 0, scale 1 — every move's keyframes end here
// so the mascot always settles back before the next random choice.
const MOVES: Move[] = [
  // --- tilts & leans ---
  { name: "tiltLeft",   duration: 0.7, anim: { rotate: [0, -7, 0], y: [0, -1.5, 0] } },
  { name: "tiltRight",  duration: 0.7, anim: { rotate: [0, 7, 0], y: [0, -1.5, 0] } },
  { name: "leanLeft",   duration: 0.8, anim: { skewX: [0, -6, -5, 0], rotate: [0, -2, -1, 0] } },
  { name: "leanRight",  duration: 0.8, anim: { skewX: [0, 6, 5, 0], rotate: [0, 2, 1, 0] } },
  { name: "bowLeft",    duration: 1.0, anim: { rotate: [0, -9, -9, -4, 0], y: [0, 2, 2, 1, 0] } },
  { name: "bowRight",   duration: 1.0, anim: { rotate: [0, 9, 9, 4, 0], y: [0, 2, 2, 1, 0] } },

  // --- bobs & hops ---
  { name: "bobUp",      duration: 0.7, anim: { y: [0, -3, 0] } },
  { name: "settleDown", duration: 0.7, anim: { y: [0, 2.5, 0], scaleY: [1, 0.96, 1] } },
  { name: "bobBig",     duration: 0.9, anim: { y: [0, -5, 2, 0] } },
  { name: "hop",        duration: 0.8, anim: { y: [0, -7, 0], scaleY: [1, 1.12, 0.92, 1], scaleX: [1, 0.94, 1.06, 1] } },
  { name: "springBounce",duration: 1.1, anim: { y: [0, -6, -2, -4, -0.5, 0] } },
  { name: "pounce",     duration: 0.9, anim: { scale: [1, 0.85, 1.15, 1], y: [0, 2, -4, 0] } },

  // --- squashes & stretches ---
  { name: "squash",     duration: 0.6, anim: { scaleY: [1, 0.9, 1], scaleX: [1, 1.08, 1] } },
  { name: "stretch",    duration: 0.6, anim: { scaleY: [1, 1.1, 1], scaleX: [1, 0.95, 1] } },
  { name: "tiltySquash", duration: 0.8, anim: { rotate: [0, 6, 0], scaleY: [1, 0.92, 1] } },
  { name: "tiltyStretch",duration: 0.8, anim: { rotate: [0, -6, 0], scaleY: [1, 1.08, 1] } },

  // --- pulses & zooms ---
  { name: "heartbeat",  duration: 0.9, anim: { scale: [1, 1.12, 0.98, 1.08, 1] } },
  { name: "pulse",      duration: 1.0, anim: { scale: [1, 1.08, 1.01, 1.05, 1] } },
  { name: "zoomIn",     duration: 0.9, anim: { scale: [1, 1.12, 1.06, 1.1, 1] } },
  { name: "zoomOut",    duration: 0.9, anim: { scale: [1, 0.9, 0.96, 0.92, 1] } },

  // --- shakes & wiggles ---
  { name: "shake",      duration: 0.8, anim: { x: [0, -2.5, 2.5, -2, 2, -1, 1, 0] } },
  { name: "shiver",     duration: 0.5, anim: { rotate: [0, -2, 2, -2, 2, 0], x: [0, -1, 1, -0.5, 0.5, 0] } },
  { name: "jitter",     duration: 0.6, anim: { x: [0, -1, 1, -0.5, 0.5, 0], rotate: [0, -1.5, 1.5, -1, 1, 0] } },
  { name: "waggle",     duration: 0.9, anim: { rotate: [0, -5, 5, -4, 4, 0] } },
  { name: "bigWiggle",  duration: 1.2, anim: { rotate: [0, -10, 10, -7, 7, -3, 0] } },
  { name: "wobble",     duration: 1.2, anim: { rotate: [0, -8, -3, 3, 8, 3, -2, 0] } },
  { name: "nod",        duration: 0.9, anim: { y: [0, 3, 1, 3, 0], scaleY: [1, 0.96, 1, 0.96, 1] } },

  // --- peeks & sways ---
  { name: "peekLeft",   duration: 0.9, anim: { x: [0, -4, -3, 0], rotate: [0, -4, -3, 0] } },
  { name: "peekRight",  duration: 0.9, anim: { x: [0, 4, 3, 0], rotate: [0, 4, 3, 0] } },
  { name: "sway",       duration: 1.3, anim: { rotate: [0, -6, 6, -4, 3, 0], x: [0, -2, 2, -1.5, 1, 0] } },

  // --- floats ---
  { name: "floatUpLeft",  duration: 1.0, anim: { x: [0, -3, -3, 0], y: [0, -3, -3, 0] } },
  { name: "floatUpRight", duration: 1.0, anim: { x: [0, 3, 3, 0], y: [0, -3, -3, 0] } },
  { name: "hoverBob",     duration: 1.4, anim: { y: [0, -4, -4, -2, 0], rotate: [0, -2, -2, -1, 0] } },
];

export default function MascotLogo({
  className,
  size = 40,
  alt = "Orplex",
}: {
  className?: string;
  /** Rendered width/height; the img also keeps its CSS size via className. */
  size?: number;
  alt?: string;
}) {
  const prefersReducedMotion = useReducedMotion();
  const [move, setMove] = useState<Move | null>(null);
  const lastIdxRef = useRef(-1);

  useEffect(() => {
    if (prefersReducedMotion) return;
    let timer: ReturnType<typeof setTimeout>;
    const strike = () => {
      // Pick a random move, never the same one twice in a row.
      let idx = Math.floor(Math.random() * MOVES.length);
      if (idx === lastIdxRef.current) idx = (idx + 1) % MOVES.length;
      lastIdxRef.current = idx;
      const next = MOVES[idx];
      setMove(next);
      // Play to the end, then idle (resting at neutral) before the next move.
      timer = setTimeout(strike, next.duration * 1000 + 900 + Math.random() * 2200);
    };
    // Idle a beat before the first move so it doesn't twitch on load.
    timer = setTimeout(strike, 700 + Math.random() * 1500);
    return () => clearTimeout(timer);
  }, [prefersReducedMotion]);

  if (prefersReducedMotion) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- SVG logo: next/image cannot optimize SVG without dangerouslyAllowSVG, which Next.js advises against
      <img src="/logo.svg" alt={alt} className={className} width={size} height={size} />
    );
  }

  return (
    <motion.img
      key={move?.name ?? "idle"}
      src="/logo.svg"
      alt={alt}
      className={className}
      width={size}
      height={size}
      initial={{ rotate: 0, x: 0, y: 0, scaleX: 1, scaleY: 1, skewX: 0 }}
      animate={move?.anim ?? { rotate: 0, x: 0, y: 0, scaleX: 1, scaleY: 1, skewX: 0 }}
      transition={
        move
          ? { duration: move.duration, ease: "easeInOut" }
          : { duration: 0.3 }
      }
    />
  );
}
