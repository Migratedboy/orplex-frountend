"use client";

/**
 * ThinkingPill
 * A compact "model is thinking" indicator that expands to show the live reasoning text.
 * Zero dependencies, styles bundled, SSR-safe, accessible, themeable via CSS variables.
 *
 * Basic:
 *   <ThinkingPill reasoning={reasoningText} done={isDone} />
 *
 * Restoring a finished message from history:
 *   <ThinkingPill reasoning={saved.reasoning} done durationMs={saved.thinkingMs} />
 *
 * Theming (override on the element or any parent):
 *   --tp-accent  --tp-accent-2  --tp-accent-3
 *   --tp-surface --tp-surface-hover --tp-text --tp-muted --tp-border --tp-rule
 */

import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  useState,
  type HTMLAttributes,
} from "react";

export interface ThinkingPillProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  /** Reasoning text. Keep appending to it as it streams in. */
  reasoning?: string;
  /** True once thinking has finished. */
  done?: boolean;
  /** Total thinking time in ms. Use when rendering finished messages from history. */
  durationMs?: number;
  /** Open on first render. */
  defaultOpen?: boolean;
  /** Called whenever the user opens or closes the panel. */
  onOpenChange?: (open: boolean) => void;
  /** "auto" follows the OS colour scheme. */
  theme?: "light" | "dark" | "auto";
  /** Max height of the reasoning panel in px. */
  maxHeight?: number;
  /** Label while thinking (use for i18n). */
  thinkingLabel?: string;
  /** Label once finished (use for i18n). Receives whole seconds when known. */
  doneLabel?: (seconds?: number) => string;
}

const defaultDoneLabel = (s?: number) => (s ? `Thought for ${s}s` : "Thought");

const ThinkingPill = forwardRef<HTMLDivElement, ThinkingPillProps>(
  function ThinkingPill(
    {
      reasoning = "",
      done = false,
      durationMs,
      defaultOpen = false,
      onOpenChange,
      theme = "light",
      maxHeight = 240,
      thinkingLabel = "Thinking…",
      doneLabel = defaultDoneLabel,
      className = "",
      style,
      ...rest
    },
    ref
  ) {
    const uid = useId();
    const pillId = `${uid}-pill`;
    const panelId = `${uid}-panel`;

    const [open, setOpen] = useState(defaultOpen);
    const hasText = reasoning.trim().length > 0;
    const canExpand = hasText || !done;
    const isOpen = open && canExpand;

    /* ---------- timer ---------- */
    const [ms, setMs] = useState<number | undefined>(durationMs);
    const t0 = useRef<number | null>(null);

    useEffect(() => {
      if (done) {
        if (durationMs !== undefined) setMs(durationMs);
        else if (t0.current !== null) setMs(performance.now() - t0.current);
        return;
      }
      const start = performance.now();
      t0.current = start;
      setMs(0);
      const id = setInterval(() => setMs(performance.now() - start), 250);
      return () => clearInterval(id);
    }, [done, durationMs]);

    /* ---------- auto open / collapse (user choice wins until next run) ---------- */
    const touched = useRef(defaultOpen);
    const prevDone = useRef(done);
    useEffect(() => {
      if (prevDone.current && !done) touched.current = false;
      prevDone.current = done;
      if (!touched.current) setOpen(hasText && !done);
    }, [hasText, done]);

    const toggle = () => {
      if (!canExpand) return;
      touched.current = true;
      const next = !isOpen;
      setOpen(next);
      onOpenChange?.(next);
    };

    /* ---------- keep newest text in view unless the user scrolled up ---------- */
    const scroller = useRef<HTMLDivElement>(null);
    const stick = useRef(true);
    useEffect(() => {
      const el = scroller.current;
      if (el && stick.current) el.scrollTop = el.scrollHeight;
    }, [reasoning, isOpen]);

    /* ---------- labels ---------- */
    const seconds = ms === undefined ? undefined : Math.max(1, Math.round(ms / 1000));
    const label = done ? doneLabel(seconds) : thinkingLabel;
    const liveSeconds = ms === undefined ? 0 : Math.floor(ms / 1000);

    return (
      <div
        ref={ref}
        {...rest}
        className={`tp ${className}`.trim()}
        data-state={done ? "done" : "thinking"}
        data-theme={theme}
        style={style}
      >
        <style>{CSS}</style>

        <button
          type="button"
          id={pillId}
          className="tp-pill"
          disabled={!canExpand}
          aria-expanded={canExpand ? isOpen : undefined}
          aria-controls={canExpand ? panelId : undefined}
          onClick={toggle}
        >
          <span className="tp-orb" aria-hidden="true">
            <i />
            <svg viewBox="0 0 20 20" fill="none">
              <circle cx="10" cy="10" r="10" className="tp-check-bg" />
              <path
                d="M6 10.4l2.8 2.7L14 7.6"
                stroke="#fff"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>

          <span className="tp-label">
            <span key={label} className="tp-text">
              {label}
            </span>
          </span>

          {!done && (
            <span className="tp-time" aria-hidden="true">
              {liveSeconds}s
            </span>
          )}

          {canExpand && (
            <svg
              className="tp-chev"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M4 6l4 4 4-4" />
            </svg>
          )}
        </button>

        {/* announces state changes only (not the ticking timer or streamed text) */}
        <span className="tp-sr" role="status">
          {label}
        </span>

        <div
          className="tp-panel"
          id={panelId}
          role="region"
          aria-labelledby={pillId}
          data-open={isOpen}
        >
          <div>
            <div
              ref={scroller}
              className="tp-reason"
              style={{ maxHeight }}
              tabIndex={isOpen ? 0 : -1}
              onScroll={(e) => {
                const el = e.currentTarget;
                stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
              }}
            >
              {reasoning}
              {!hasText && !done && (
                <span className="tp-placeholder">Waiting for reasoning to stream…</span>
              )}
              {!done && <span className="tp-caret" aria-hidden="true" />}
            </div>
          </div>
        </div>
      </div>
    );
  }
);

export default ThinkingPill;
export { ThinkingPill };

const CSS = `
@property --tp-a { syntax: "<angle>"; initial-value: 0deg; inherits: false; }

.tp, .tp * { box-sizing: border-box; }
.tp {
  --tp-accent: #ff6a1a; --tp-accent-2: #ffb347; --tp-accent-3: #ff3d2e;
  --tp-surface: #ffffff; --tp-surface-hover: #fffaf6;
  --tp-text: #231710; --tp-muted: #7a6a5d;
  --tp-border: rgba(60,30,10,.12); --tp-rule: rgba(60,30,10,.12);
  --tp-font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  display: grid; justify-items: start; width: 100%; max-width: 520px;
  font-family: var(--tp-font); -webkit-font-smoothing: antialiased; text-size-adjust: 100%;
}
.tp[data-theme="dark"] {
  --tp-surface: #14141b; --tp-surface-hover: #1a1a23;
  --tp-text: #f1eee9; --tp-muted: #a0968c;
  --tp-border: rgba(255,255,255,.12); --tp-rule: rgba(255,255,255,.12);
}
@media (prefers-color-scheme: dark) {
  .tp[data-theme="auto"] {
    --tp-surface: #14141b; --tp-surface-hover: #1a1a23;
    --tp-text: #f1eee9; --tp-muted: #a0968c;
    --tp-border: rgba(255,255,255,.12); --tp-rule: rgba(255,255,255,.12);
  }
}

.tp-sr {
  position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden;
  clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}

/* ---------- pill ---------- */
.tp-pill {
  all: unset; box-sizing: border-box; position: relative; isolation: isolate; cursor: pointer;
  display: inline-flex; align-items: center; gap: 9px; max-width: 100%;
  height: 38px; padding: 0 14px 0 11px; border-radius: 999px;
  background: var(--tp-surface); color: var(--tp-text);
  font: 500 13.5px/1 var(--tp-font); letter-spacing: -.005em;
  box-shadow: 0 1px 2px rgba(35,23,16,.06), 0 6px 18px -8px rgba(255,106,26,.35);
  transition: background-color .2s ease, box-shadow .3s ease, transform .15s ease;
  -webkit-tap-highlight-color: transparent;
}
.tp-pill:disabled { cursor: default; }
.tp-pill:not(:disabled):hover { background: var(--tp-surface-hover); }
.tp-pill:not(:disabled):active { transform: scale(.98); }
.tp-pill:focus-visible { outline: 2px solid var(--tp-accent); outline-offset: 3px; }

/* animated gradient edge (thinking) */
.tp-pill::before {
  content: ""; position: absolute; inset: 0; border-radius: inherit; padding: 1px; z-index: -1;
  background: conic-gradient(from var(--tp-a), transparent 0 50%, var(--tp-accent), var(--tp-accent-2), var(--tp-accent-3), transparent 96%);
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor; mask-composite: exclude;
  animation: tp-spin 3s linear infinite;
}
@keyframes tp-spin { to { --tp-a: 360deg; } }

/* ---------- orb ---------- */
.tp-orb { position: relative; width: 18px; height: 18px; flex: none; border-radius: 50%; }
.tp-orb i {
  position: absolute; inset: 0; border-radius: 50%; overflow: hidden;
  background: radial-gradient(circle at 32% 28%, #fff4d6 0, var(--tp-accent-2) 26%, var(--tp-accent) 60%, var(--tp-accent-3) 100%);
  box-shadow: inset -2px -2px 4px rgba(255,61,46,.45), inset 1px 1px 2px rgba(255,255,255,.7), 0 1px 6px rgba(255,106,26,.45);
  animation: tp-breathe 2.4s ease-in-out infinite;
  transition: opacity .25s ease, transform .4s cubic-bezier(.3,1.5,.5,1);
}
.tp-orb i::before {
  content: ""; position: absolute; inset: -35%; border-radius: 50%;
  background: conic-gradient(from var(--tp-a), transparent 0, rgba(255,255,255,.65) 12%, transparent 32%, rgba(255,61,46,.5) 62%, transparent 80%);
  filter: blur(3px); animation: tp-spin 1.9s linear infinite;
}
.tp-orb i::after {
  content: ""; position: absolute; left: 3px; top: 2.5px; width: 7px; height: 4px; border-radius: 50%;
  background: rgba(255,255,255,.88); filter: blur(.6px); transform: rotate(-32deg);
}
@keyframes tp-breathe { 50% { transform: scale(.92); } }
.tp-orb svg {
  position: absolute; inset: 0; width: 100%; height: 100%;
  opacity: 0; transform: scale(.5); transition: opacity .25s ease, transform .4s cubic-bezier(.3,1.5,.5,1);
}
.tp-check-bg { fill: var(--tp-accent); }
.tp-orb path { stroke-dasharray: 18; stroke-dashoffset: 18; transition: stroke-dashoffset .45s .12s ease; }

/* ---------- label + timer ---------- */
.tp-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tp-text {
  display: inline-block; animation: tp-in .28s cubic-bezier(.2,.8,.2,1) both;
}
.tp[data-state="thinking"] .tp-text {
  background: linear-gradient(100deg, var(--tp-muted) 35%, var(--tp-text) 50%, var(--tp-muted) 65%) 100% 0 / 260% 100%;
  -webkit-background-clip: text; background-clip: text; color: transparent; -webkit-text-fill-color: transparent;
  animation: tp-in .28s cubic-bezier(.2,.8,.2,1) both, tp-shimmer 2s linear .28s infinite;
}
@keyframes tp-in { from { opacity: 0; transform: translateY(4px); filter: blur(3px); } to { opacity: 1; transform: none; filter: none; } }
@keyframes tp-shimmer { to { background-position: -60% 0; } }

.tp-time { font-size: 12px; color: var(--tp-muted); font-variant-numeric: tabular-nums; min-width: 2.2ch; text-align: right; }
.tp-chev { width: 13px; height: 13px; flex: none; color: var(--tp-muted); transition: transform .3s cubic-bezier(.3,1.2,.5,1); }
.tp-pill[aria-expanded="true"] .tp-chev { transform: rotate(180deg); }

/* ---------- done ---------- */
.tp[data-state="done"] .tp-pill { box-shadow: 0 1px 2px rgba(35,23,16,.05); color: var(--tp-muted); }
.tp[data-state="done"] .tp-pill::before { animation: none; background: var(--tp-border); }
.tp[data-state="done"] .tp-orb i { opacity: 0; transform: scale(.4); animation: none; }
.tp[data-state="done"] .tp-orb svg { opacity: 1; transform: scale(1); }
.tp[data-state="done"] .tp-orb path { stroke-dashoffset: 0; }

/* ---------- reasoning panel ---------- */
.tp-panel {
  display: grid; grid-template-rows: 0fr; width: 100%; visibility: hidden;
  transition: grid-template-rows .35s cubic-bezier(.3,.9,.3,1), visibility 0s linear .35s;
}
.tp-panel[data-open="true"] { grid-template-rows: 1fr; visibility: visible; transition-delay: 0s; }
.tp-panel > div { overflow: hidden; min-height: 0; }
.tp-reason {
  margin: 8px 0 0 17px; padding: 10px 6px 10px 16px; border-left: 1.5px solid var(--tp-rule);
  overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; scrollbar-color: var(--tp-rule) transparent;
  font-size: 13.5px; line-height: 1.65; color: var(--tp-muted);
  white-space: pre-wrap; overflow-wrap: anywhere; outline: none;
  -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 10px, #000 calc(100% - 10px), transparent 100%);
  mask-image: linear-gradient(to bottom, transparent 0, #000 10px, #000 calc(100% - 10px), transparent 100%);
}
.tp-reason:focus-visible { outline: 2px solid var(--tp-accent); outline-offset: 2px; border-radius: 4px; }
.tp-caret {
  display: inline-block; width: 2px; height: 1em; margin-left: 2px; vertical-align: text-bottom;
  background: var(--tp-accent); border-radius: 1px; animation: tp-blink 1s steps(2, start) infinite;
}
@keyframes tp-blink { to { visibility: hidden; } }

@media (prefers-reduced-motion: reduce) {
  .tp-pill::before, .tp-orb i, .tp-orb i::before, .tp-text, .tp-caret { animation: none !important; }
  .tp[data-state="thinking"] .tp-text { background: none; color: var(--tp-text); -webkit-text-fill-color: var(--tp-text); }
  .tp-panel, .tp-chev, .tp-orb svg, .tp-orb path, .tp-pill { transition-duration: .01ms !important; }
}
`;
