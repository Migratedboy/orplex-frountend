"use client";

import { motion, useReducedMotion } from "framer-motion";
import type { CSSProperties } from "react";

/*
  3x3 pixel grid, built from measurements of the Freebuff loader:
    - sharp, almost-square cells (tiny corner radius)
    - hairline gap (~7% of the grid size)
    - flat gray #878786 on #1c1d1c, no glow
    - motion is SCALE based: cells shrink to nothing and pop back, and the
      shrink travels diagonally. One full cycle spans the diagonal, so the top-left
      and bottom-right cells are at their smallest at the same time.

  variant="original"  → exact gray look from the screenshot
  variant="wave"      → same geometry/motion, but the cells flash orange → white
*/

export type DotGridLoaderVariant = "original" | "wave";
export type WaveDirection = "diagonal" | "horizontal" | "vertical";

export type DotGridLoaderProps = {
  variant?: DotGridLoaderVariant;
  /** total width/height in px */
  size?: number;
  /** gap between cells in px (defaults to ~7% of size) */
  gap?: number;
  /** resting / base cell color (default depends on variant) */
  color?: string;
  /** wave variant: orange part of the flash */
  colorWave?: string;
  /** wave variant: white peak */
  colorPeak?: string;
  /** seconds for one full cycle */
  speed?: number;
  /** which way the pulse travels */
  direction?: WaveDirection;
  /** wave variant only: tight glow on the flash */
  glow?: boolean;
  /** optional text next to the grid, e.g. "Thinking…" */
  label?: string;
  className?: string;
  style?: CSSProperties;
};

function phaseOf(index: number, direction: WaveDirection) {
  const row = Math.floor(index / 3);
  const col = index % 3;
  if (direction === "horizontal") return col / 2; // 0 → 1
  if (direction === "vertical") return row / 2; // 0 → 1
  return (row + col) / 4; // diagonal, 0 → 1
}

export function DotGridLoader({
  variant = "wave",
  size = 33,
  gap,
  color,
  colorWave = "#ff7a1a",
  colorPeak = "#ffffff",
  speed = 1.4,
  direction = "diagonal",
  glow = true,
  label,
  className,
  style,
}: DotGridLoaderProps) {
  const reduce = useReducedMotion();
  const duration = reduce ? speed * 2.5 : speed;
  const g = gap ?? Math.max(1, Math.round(size * 0.07));
  const blur = Math.max(2, size * 0.17);
  const isOriginal = variant === "original";
  const base = color ?? "#878786";

  const animate = isOriginal
    ? {
        // all cells sit at full size, then dip to ~nothing as the pulse passes
        scale: [1, 0.85, 0.04, 0.85, 1],
      }
    : {
        scale: [0.55, 1, 1.06, 1, 0.55],
        backgroundColor: [base, colorWave, colorPeak, colorWave, base],
        boxShadow: glow
          ? [
              `0 0 0px ${colorWave}`,
              `0 0 ${blur * 0.6}px ${colorWave}`,
              `0 0 ${blur}px ${colorWave}`,
              `0 0 ${blur * 0.6}px ${colorWave}`,
              `0 0 0px ${colorWave}`,
            ]
          : undefined,
      };

  const grid = (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.2 }}
      role={label ? undefined : "status"}
      aria-label={label ? undefined : "Loading"}
      className={label ? undefined : className}
      style={{
        width: size,
        height: size,
        display: "grid",
        gridTemplateColumns: "repeat(3, 1fr)",
        gridTemplateRows: "repeat(3, 1fr)",
        gap: g,
        flex: "none",
        ...(label ? undefined : style),
      }}
    >
      {Array.from({ length: 9 }, (_, i) => (
        <motion.i
          key={i}
          style={{
            display: "block",
            borderRadius: "6%",
            willChange: "transform",
            backgroundColor: base,
            scale: isOriginal ? 1 : 0.55,
          }}
          animate={animate}
          transition={{
            duration,
            times: [0, 0.3, 0.5, 0.7, 1],
            ease: "easeInOut",
            repeat: Infinity,
            // one full cycle across the grid, like the original
            delay: phaseOf(i, direction) * duration * (isOriginal ? 1 : 0.4),
          }}
        />
      ))}
    </motion.div>
  );

  if (!label) return grid;

  return (
    <div
      role="status"
      aria-label={label}
      className={className}
      style={{ display: "inline-flex", alignItems: "center", gap: 10, ...style }}
    >
      {grid}
      <span style={{ fontSize: 14, lineHeight: 1, color: "#a3a3a2" }}>{label}</span>
    </div>
  );
}

export default DotGridLoader;

/*
  USAGE

  npm i framer-motion

  import DotGridLoader from "@/components/DotGridLoader";

  // exact match of the screenshot (flat gray, scale pulse)
  <DotGridLoader variant="original" />

  // orange → white wave, same shape and motion (default)
  <DotGridLoader />

  // chat "thinking" state
  {isThinking && <DotGridLoader variant="original" size={20} label="Thinking…" />}

  // full-panel loading state
  {isLoading ? (
    <div style={{ display: "grid", placeItems: "center", height: "100%" }}>
      <DotGridLoader size={44} />
    </div>
  ) : (
    <Content />
  )}
*/
