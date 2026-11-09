"use client";
import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion, type TargetAndTransition, type Transition } from "framer-motion";

/**
 * WalkingMascot.tsx — the Orplex mascot patrols the border of the prompt bar,
 * only in a fresh chat (no user message yet — ChatInput mounts this until the
 * first user message lands).
 *
 * IMPORTANT: /logo.svg is NOT a static image — it already carries its own
 * pixel robot with blocky orange legs, waving claws and idle CSS animations.
 * A plain <img> of it is an opaque document, so React can't animate its legs.
 * That's why the creature is INLINED here (same markup) with its `.leg`
 * shuffle re-implemented on framer motion, so the REAL legs do the walking:
 *
 * - A rAF engine advances an arc-length position `s` along the rounded
 *   rectangle of the bar (clockwise, matching --pb-radius: 14px corners).
 * - Each frame positions the walker imperatively (translate + facing flip via
 *   style.transform) — zero React re-renders, so the composer stays cheap.
 * - The four SVG legs walk in the creature's diagonal pixel gait (front-left
 *   with rear-right), lifting into the air exactly like the logo's own
 *   shuffle — while the body bobs once per stride.
 * - The path includes the corner ARCS: the mascot walks to each corner,
 *   then PAUSES, SITS DOWN (legs tuck, body squats) and carries on after a
 *   random 0.7–1.6s rest.
 * - MOONWALK: once per lap one horizontal edge is picked at random to be
 *   moonwalked — gliding at half speed, body facing backwards, legs barely
 *   lifting (that heel-slide look).
 *
 * Honors prefers-reduced-motion: renders nothing (the bar stays clean).
 */

const STEP_SPEED = 30; // patrolling speed, px per second (moonwalk halves it)
const SIT_MIN = 700; // corner rest, shortest (ms)
const SIT_VAR = 900; // corner rest, additional random (ms)

type PathPoint = { x: number; y: number; dir: -1 | 0 | 1; seg: number };
// Straight segments: 0 top edge →, 2 right edge ↓, 4 bottom edge ←, 6 left edge ↑.
const MOON_SEGS = [0, 4]; // moonwalk relaxed only on horizontal edges

/** Center line used to ride the border stroke: the creature's middle
 *  (screen x = 50% of viewBox width) sits on the outline, half in / half out. */
const FEET_PCT = 50;

/** The inlined creature — same geometry as public/logo.svg, but the `.leg`
 *  groups are motion elements so the real legs step, and the arms are back:
 *  pincer arms that swing with the stride and WAVE on spawn / while sitting.
 *  Internal CSS animation block keeps eyes/claws/antenna/scanline alive;
 *  leg/bob/pop are driven by framer instead (they belong to the walking
 *  state machine). */
function MascotFigure({ sit, moonwalk, wave }: { sit: boolean; moonwalk: boolean; wave: boolean }) {
  const legPose = (phase: 0 | 1): { animate: TargetAndTransition; transition: Transition } => {
    if (sit) {
      return { animate: { y: -8 }, transition: { duration: 0.25, ease: "easeOut" } };
    }
    if (moonwalk) {
      // Glide: legs barely lift, alternating, slow.
      return phase === 0
        ? { animate: { y: [0, 0, -3, -3] }, transition: { duration: 0.9, times: [0, 0.45, 0.55, 1], ease: "linear", repeat: Infinity } }
        : { animate: { y: [-3, -3, 0, 0] }, transition: { duration: 0.9, times: [0, 0.45, 0.55, 1], ease: "linear", repeat: Infinity } };
    }
    // Diagonal gait, pixel steps: slight quick-hop keyframes that snap.
    // Phase A: hold, snap up mid-cycle, hold, drop at wrap.
    // Phase B: the anti-phase circular shift of A.
    return phase === 0
      ? { animate: { y: [0, 0, -8, -8] }, transition: { duration: 0.55, times: [0, 0.49, 0.51, 1], ease: "linear", repeat: Infinity } }
      : { animate: { y: [-8, -8, 0, 0] }, transition: { duration: 0.55, times: [0, 0.49, 0.51, 1], ease: "linear", repeat: Infinity } };
  };
  const bodyPose = sit
    ? {
        animate: { scaleY: 0.85, y: 6, rotate: 0 },
        transition: { duration: 0.25, ease: "easeOut" } as Transition,
      }
    : moonwalk
      ? {
          animate: { scaleY: 1, y: 0, rotate: 0 },
          transition: { duration: 0.2 } as Transition,
        }
      : {
          animate: { scaleY: 1, y: [0, 0, -3, -3], rotate: 0 },
          transition: { duration: 0.55, times: [0, 0.45, 0.55, 1], ease: "linear", repeat: Infinity } as Transition,
        };

  // Arms. Origins are the shoulders in viewBox coordinates (same points the
  // logo's own CSS uses: armL 60px 150px, armR 260px 150px). The waving arm
  // is the RIGHT one (its pincer flails big), the other rests; while walking
  // both swing gently in anti-phase with the stride; moonwalking: freeze.
  const restArm = (side: 0 | 1) =>
    moonwalk
      ? { animate: { rotate: 0 } as TargetAndTransition, transition: { duration: 0.2 } as Transition }
      : {
          animate: { rotate: side === 0 ? [-9, 9] : [9, -9] } as TargetAndTransition,
          transition: { duration: 0.55, repeat: Infinity, repeatType: "reverse", ease: "linear" } as Transition,
        };
  const armWave = wave
    ? { animate: { rotate: [18, -30] } as TargetAndTransition, transition: { duration: 0.38, repeat: Infinity, repeatType: "reverse", ease: "easeInOut" } as Transition }
    : restArm(1);
  const armRest = wave
    ? { animate: { rotate: 0 } as TargetAndTransition, transition: { duration: 0.2 } as Transition }
    : restArm(0);

  return (
    <svg
      className="walking-mascot__svg"
      width="30"
      height="30"
      viewBox="0 -18 320 320"
      role="img"
      aria-label="Orplex"
      style={{ overflow: "visible" }}
    >
      <defs>
        <clipPath id="mascotBodyClip">
          <path d="M80 90H240V110H260V200H240V220H80V200H60V110H80Z" />
        </clipPath>
      </defs>
      <motion.g
        style={{ transformBox: "fill-box", transformOrigin: "50% 100%" }}
        animate={bodyPose.animate}
        transition={bodyPose.transition}
      >
        {/* antenna */}
        <rect x="150" y="62" width="20" height="28" fill="#EA580C" />
        <rect x="140" y="38" width="40" height="24" fill="#FDBA74" />

        {/* legs — four in the creature's own diagonal gait (0+2 together, 1+3 together) */}
        <g>
          <motion.g {...legPose(0)}>
            <rect x="84" y="220" width="24" height="30" fill="#EA580C" />
            <rect x="78" y="248" width="36" height="10" fill="#C2410C" />
          </motion.g>
          <motion.g {...legPose(1)}>
            <rect x="128" y="220" width="24" height="30" fill="#EA580C" />
            <rect x="122" y="248" width="36" height="10" fill="#C2410C" />
          </motion.g>
          <motion.g {...legPose(0)}>
            <rect x="172" y="220" width="24" height="30" fill="#EA580C" />
            <rect x="166" y="248" width="36" height="10" fill="#C2410C" />
          </motion.g>
          <motion.g {...legPose(1)}>
            <rect x="216" y="220" width="24" height="30" fill="#EA580C" />
            <rect x="210" y="248" width="36" height="10" fill="#C2410C" />
          </motion.g>
        </g>

        {/* body (notched corners) */}
        <path d="M80 90H240V110H260V200H240V220H80V200H60V110H80Z" fill="#F97316" />
        {/* shading */}
        <rect x="80" y="90" width="160" height="20" fill="#FB923C" />
        <rect x="80" y="90" width="160" height="8" fill="#FDBA74" />
        <rect x="60" y="110" width="14" height="90" fill="#FB923C" />
        <rect x="246" y="110" width="14" height="90" fill="#EA580C" />
        <rect x="80" y="200" width="160" height="20" fill="#EA580C" />
        <rect x="80" y="212" width="160" height="8" fill="#C2410C" />

        {/* left arm + pincer — swings/waves around its shoulder */}
        <motion.g
          style={{ transformBox: "view-box", transformOrigin: "60px 150px" }}
          animate={armRest.animate}
          transition={armRest.transition}
        >
          <rect x="30" y="140" width="32" height="28" fill="#EA580C" />
          <rect x="14" y="122" width="22" height="24" fill="#F97316" />
          <rect x="14" y="162" width="22" height="24" fill="#C2410C" />
        </motion.g>
        {/* right arm + pincer — the waving hand during sit/spawn */}
        <motion.g
          style={{ transformBox: "view-box", transformOrigin: "260px 150px" }}
          animate={armWave.animate}
          transition={armWave.transition}
        >
          <rect x="258" y="140" width="32" height="28" fill="#EA580C" />
          <rect x="284" y="122" width="22" height="24" fill="#F97316" />
          <rect x="284" y="162" width="22" height="24" fill="#C2410C" />
        </motion.g>

        {/* eyes */}
        <rect x="98" y="124" width="26" height="38" fill="#1A1210" />
        <rect x="102" y="128" width="8" height="8" fill="#FFF3E0" />
        <rect x="196" y="124" width="26" height="38" fill="#1A1210" />
        <rect x="200" y="128" width="8" height="8" fill="#FFF3E0" />

        {/* terminal belly */}
        <rect x="116" y="170" width="88" height="30" fill="#1A1210" />
        <rect x="116" y="170" width="88" height="3" fill="#000" opacity=".5" />
        <g fill="#F97316">
          <rect x="124" y="178" width="6" height="6" />
          <rect x="130" y="184" width="6" height="6" />
          <rect x="124" y="190" width="6" height="6" />
        </g>
        <rect x="140" y="184" width="26" height="6" fill="#FDBA74" />
        <rect x="172" y="181" width="8" height="12" fill="#FFF3E0" />
      </motion.g>
    </svg>
  );
}

export default function WalkingMascot() {
  const prefersReducedMotion = useReducedMotion();
  const layerRef = useRef<HTMLDivElement>(null); // absolute inset-0 over the bar
  const walkerRef = useRef<HTMLDivElement>(null); // moves along the border
  const flipRef = useRef<HTMLDivElement>(null); // faces the travel direction
  const stRef = useRef({ w: 0, h: 0, r: 14, s: 0, paused: false, sitUntil: 0, moonSeg: -1, lastDir: 1, ox: 0, oy: 0 });
  // Pose state — set only when it CHANGES (a few times per lap), so React
  // doesn't re-render every frame; positions stay imperative.
  const [sit, setSit] = useState(false);
  const [moonwalk, setMoonwalk] = useState(false);
  // Hello wave: the mascot waves for a couple seconds when it spawns in a
  // fresh chat, then waves again at every corner-sit.
  const [spawnWave, setSpawnWave] = useState(true);
  useEffect(() => {
    if (prefersReducedMotion) return;
    const t = setTimeout(() => setSpawnWave(false), 2200 + Math.random() * 900);
    return () => clearTimeout(t);
  }, [prefersReducedMotion]);

  useEffect(() => {
    if (prefersReducedMotion || !layerRef.current) return;
    const layer = layerRef.current;
    const walker = walkerRef.current;
    const flip = flipRef.current;
    if (!walker || !flip) return;
    const st = stRef.current;
    // Mirrors of the React pose state so the rAF loop doesn't touch setState
    // more than when the pose actually flips.
    let sitOn = false;
    let moonOn = false;

    const measure = () => {
      // Patrol the VISIBLE prompt-box outline, not the whole prompt-bar
      // wrapper (the wrapper also spans the footer controls, which put the
      // bottom edge below the box — on the disclaimer text). Rects are used
      // instead of offsetLeft: the two agree only when they share the same
      // offsetParent, which is not guaranteed inside this overlay tree.
      // The layer is a SIBLING of the prompt bar (both live in the relative
      // wrapper) — query the wrapper, never the layer itself.
      const box = layer.parentElement?.querySelector<HTMLElement>(".prompt-bar__box");
      if (box) {
        const lr = layer.getBoundingClientRect();
        const br = box.getBoundingClientRect();
        st.w = box.clientWidth;
        st.h = box.clientHeight;
        st.ox = br.left - lr.left;
        st.oy = br.top - lr.top;
      } else {
        st.w = layer.clientWidth;
        st.h = layer.clientHeight;
        st.ox = 0;
        st.oy = 0;
      }
      // Corner radius: never exceed what the bar's box can hold.
      st.r = Math.min(14, st.w / 3, st.h / 3);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(layer);
    const boxEl = layer.parentElement?.querySelector<HTMLElement>(".prompt-bar__box");
    if (boxEl) ro.observe(boxEl);

    // Perimeter walk, clockwise, starting mid-top-edge. Each segment returns
    // the feet position (x, y in layer space), horizontal travel direction
    // (1 right / -1 left / 0 vertical) and the segment index.
    const pointAt = (s: number): PathPoint => {
      const { w: W, h: H, r: R } = st;
      const top = Math.max(0, W - 2 * R);
      const side = Math.max(0, H - 2 * R);
      const arc = (Math.PI / 2) * R;
      const total = 2 * top + 2 * side + 2 * Math.PI * R;
      const cr = Math.PI / 2; // quarter turn per corner
      const segs: { len: number; f: (t: number) => PathPoint }[] = [
        { len: top, f: (t) => ({ x: R + t * top, y: 0, dir: 1, seg: 0 }) },
        { len: arc, f: (t) => { const a = -cr + t * cr; return { x: W - R + Math.cos(a) * R, y: R + Math.sin(a) * R, dir: 1, seg: 1 }; } },
        { len: side, f: (t) => ({ x: W, y: R + t * side, dir: 0, seg: 2 }) },
        { len: arc, f: (t) => { const a = t * cr; return { x: W - R + Math.cos(a) * R, y: H - R + Math.sin(a) * R, dir: -1, seg: 3 }; } },
        { len: top, f: (t) => ({ x: W - R - t * top, y: H, dir: -1, seg: 4 }) },
        { len: arc, f: (t) => { const a = cr + t * cr; return { x: R + Math.cos(a) * R, y: H - R + Math.sin(a) * R, dir: -1, seg: 5 }; } },
        { len: side, f: (t) => ({ x: 0, y: H - R - t * side, dir: 0, seg: 6 }) },
        { len: arc, f: (t) => { const a = Math.PI + t * cr; return { x: R + Math.cos(a) * R, y: R + Math.sin(a) * R, dir: 1, seg: 7 }; } },
      ];
      let rem = ((s % total) + total) % total;
      for (const seg of segs) {
        if (rem <= seg.len) {
          const p = seg.f(rem / Math.max(seg.len, 1e-6));
          return { ...p, x: p.x + st.ox, y: p.y + st.oy };
        }
        rem -= seg.len;
      }
      const p0 = segs[0].f(0);
      return { ...p0, x: p0.x + st.ox, y: p0.y + st.oy };
    };

    const cornerAt = (s: number): boolean => {
      const { w: W, h: H, r: R } = st;
      const top = Math.max(0, W - 2 * R);
      const side = Math.max(0, H - 2 * R);
      const arc = (Math.PI / 2) * R;
      const total = 2 * top + 2 * side + 2 * Math.PI * R;
      const lens = [top, arc, side, arc, top, arc, side, arc];
      let rem = ((s % total) + total) % total;
      for (let i = 0; i < lens.length; i++) {
        if (rem <= lens[i]) return i % 2 === 1; // odd segments are corner arcs
        rem -= lens[i];
      }
      return false;
    };

    const setPose = (nextSit: boolean, nextMoon: boolean) => {
      if (nextSit !== sitOn) { sitOn = nextSit; setSit(nextSit); }
      if (nextMoon !== moonOn) { moonOn = nextMoon; setMoonwalk(nextMoon); }
    };

    let raf = 0;
    let last = performance.now();
    let prevCorner = false;
    // First lap gets a moonwalk edge too, picked right away.
    st.moonSeg = MOON_SEGS[Math.floor(Math.random() * MOON_SEGS.length)];
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const was = st.s;
      if (!st.paused) st.s += (moonOn ? STEP_SPEED / 2 : STEP_SPEED) * dt;
      // Wrapped a lap → roll a new moonwalk edge for the next lap.
      if (st.s < was) st.moonSeg = MOON_SEGS[Math.floor(Math.random() * MOON_SEGS.length)];
      const p = pointAt(st.s);
      const atCorner = cornerAt(st.s);
      // Arrived at a corner → sit down and rest a random beat.
      if (atCorner && !prevCorner) {
        st.paused = true;
        st.sitUntil = now + SIT_MIN + Math.random() * SIT_VAR;
        setPose(true, false);
      } else if (st.paused) {
        if (now >= st.sitUntil) { st.paused = false; setPose(false, false); }
      } else {
        setPose(false, p.seg === st.moonSeg);
      }
      prevCorner = atCorner;
      // Anchor the walker so its CENTER (50% down the SVG) rides the
      // border stroke — half the creature in, half out, on the outline.
      walker.style.transform = `translate(${p.x}px, ${p.y}px)`;
      // Moonwalk: body faces AWAY from travel (that's the glide look).
      const dir = p.dir !== 0 ? p.dir : st.lastDir;
      if (p.dir !== 0) st.lastDir = p.dir;
      const face = moonOn ? -dir : dir;
      flip.style.transform = `translate(-50%, -${FEET_PCT}%) scaleX(${face})`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [prefersReducedMotion]);

  if (prefersReducedMotion) return null;

  return (
    <div ref={layerRef} className="walking-mascot-layer" aria-hidden="true">
      <div ref={walkerRef} className="walking-mascot" style={{ transform: "translate(0,0)" }}>
        <div ref={flipRef} className="walking-mascot__flip">
          <MascotFigure sit={sit} moonwalk={moonwalk} wave={sit || spawnWave} />
        </div>
      </div>
    </div>
  );
}
