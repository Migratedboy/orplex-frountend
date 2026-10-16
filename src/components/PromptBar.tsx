"use client";

import { Fragment, isValidElement, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { animate, useMotionValue, useMotionValueEvent, useReducedMotion } from "motion/react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowDown01Icon,
  Attachment01Icon,
  Calendar03Icon,
  Cancel01Icon,
  ChartLineData01Icon,
  File02Icon,
  Globe02Icon,
  HelpCircleIcon,
  Mail01Icon,
  Mic01Icon,
  PlusSignIcon,
  SparklesIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import "./PromptBar.css";
import { ProviderMark, modelCreatorId, modelCreatorLabel } from "./ProviderIcons";

type AnyIcon = unknown;

// Send icon: paper plane `M3.5 3.5L21 12L3.5 20.5L7 12Z` as a 7-point closed
// polygon (4 vertices + 3 edge midpoints) so pathAt can morph it into SQUARE
// with the same point-by-point interpolation the old arrow used. Order follows
// the original path traversal: tip -> nose -> tail -> notch -> back to tip.
const PLANE = [3.5, 3.5, 12.25, 7.75, 21, 12, 12.25, 16.25, 3.5, 20.5, 7, 12, 5.25, 7.75];
// Crease line `M7 12H21` — visible in the send state, fades out as the glyph morphs to the stop square.
const CREASE = "M7 12H21";
const SQUARE = [12, 6, 18, 6, 18, 12, 18, 18, 6, 18, 6, 12, 6, 6];
const EASE_IN_OUT: [number, number, number, number] = [0.77, 0, 0.175, 1];
const LINE = 22;
const EDGE = 11;

/** Model-menu infinite scroll: rows rendered per chunk. */
const MODEL_CHUNK = 50;

export interface PromptBarSource {
  key: string;
  name: string;
  description?: string;
  icon?: AnyIcon;
  attach?: boolean;
  /** Text to insert when picked instead of the default `@Name` (e.g. "/" to open the command menu) */
  insert?: string;
}

export interface PromptBarCommand {
  key: string;
  name: string;
  description?: string;
  /** Text to insert when picked instead of the command name (e.g. a skill prompt prefix) */
  insert?: string;
}

export interface PromptBarModel {
  key: string;
  name: string;
  tag?: string;
  /** Secondary line for model rows: context size, free/free-tier or BYOK marker. */
  detail?: string;
  /** Probe health dot: "green" = answered a probe <24h ago, "amber" = aged out. */
  healthDot?: "green" | "amber";
  /** Tooltip for the health dot — last-verified time + probe latency. */
  healthTitle?: string;
}

export interface PromptBarMode {
  key: string;
  name: string;
  description?: string;
}

export interface PromptBarSendMeta {
  attachments: string[];
  model?: PromptBarModel;
  effort?: string;
  mode?: PromptBarMode;
}

const DEFAULT_SOURCES: PromptBarSource[] = [
  { key: "files", name: "Photos & files", description: "Upload from this device", icon: Attachment01Icon, attach: true },
  { key: "web", name: "Web search", description: "Live results", icon: Globe02Icon },
  { key: "sales", name: "Sales data", description: "Revenue and churn", icon: ChartLineData01Icon },
  { key: "docs", name: "Documents", description: "Specs, notes, briefs", icon: File02Icon },
  { key: "mail", name: "Mail", description: "Read and draft mail", icon: Mail01Icon },
  { key: "calendar", name: "Calendar", description: "Events and availability", icon: Calendar03Icon },
];
const DEFAULT_COMMANDS: PromptBarCommand[] = [
  { key: "summarize", name: "/summarize", description: "Digest the thread so far" },
  { key: "compare", name: "/compare", description: "Two options side by side" },
  { key: "draft", name: "/draft", description: "Write a first version" },
  { key: "explain", name: "/explain", description: "A plain-language walkthrough" },
  { key: "tasks", name: "/tasks", description: "Turn this into a to-do list" },
];
const DEFAULT_MODELS: PromptBarModel[] = [
  { key: "nova-3", name: "Nova 3", tag: "Flagship" },
  { key: "nova-mini", name: "Nova Mini", tag: "Fast" },
  { key: "nova-2", name: "Nova 2", tag: "Legacy" },
];
const DEFAULT_MODES: PromptBarMode[] = [
  { key: "ask", name: "Ask", description: "Simple chat, no file access" },
  { key: "plan", name: "Plan", description: "Analyze codebase, create plan" },
  { key: "code", name: "Code", description: "Edit files, run commands" },
];
const DEFAULT_EFFORTS = ["Low", "Medium", "High", "Extra", "Max"];

/**
 * Bucket models by CREATOR (never the hosting platform). Bucket order follows
 * each creator's first appearance and the original order is preserved inside a
 * bucket, so grouping is stable. The result replaces `list` wholesale — cursor,
 * rowRefs and keyboard nav all index it, so what's rendered and what's
 * highlighted can never drift apart.
 */
function groupByCreator(rows: PromptBarModel[]): PromptBarModel[] {
  const buckets = new Map<string, PromptBarModel[]>();
  for (const row of rows) {
    const id = modelCreatorId(row);
    const bucket = buckets.get(id);
    if (bucket) bucket.push(row);
    else buckets.set(id, [row]);
  }
  return buckets.size > 1 ? Array.from(buckets.values()).flat() : rows;
}

const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const pathAt = (a: number[], b: number[], t: number) => {
  let d = "";
  for (let i = 0; i < a.length; i += 2) {
    d += `${i ? "L" : "M"}${mix(a[i], b[i], t).toFixed(2)} ${mix(a[i + 1], b[i + 1], t).toFixed(2)}`;
  }
  return `${d}Z`;
};

const parseToken = (draft: string) => {
  const m = /(^|\s)([@/])([\w-]*)$/.exec(draft);
  if (!m) return null;
  return { kind: m[2] === "@" ? "at" : "slash", query: m[3].toLowerCase(), start: m.index + m[1].length } as {
    kind: "at" | "slash";
    query: string;
    start: number;
  };
};

const renderIcon = (icon: AnyIcon, size: number) =>
  icon == null || typeof icon === "boolean"
    ? null
    : isValidElement(icon)
      ? icon
      : typeof icon === "object"
        ? (icon as never) && <HugeiconsIcon icon={icon as never} size={size} strokeWidth={1.8} />
        : null;

function SendGlyph({ busy, morphDuration, squash, tilt }: { busy: boolean; morphDuration: number; squash: number; tilt: number }) {
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

export interface PromptBarProps {
  placeholder?: string;
  sources?: PromptBarSource[];
  commands?: PromptBarCommand[];
  models?: PromptBarModel[];
  defaultModel?: string;
  modes?: PromptBarMode[];
  defaultMode?: string;
  efforts?: string[];
  defaultEffort?: string;
  onEffortChange?: (level: string) => void;
  onModelChange?: (model: PromptBarModel) => void;
  onModeChange?: (mode: PromptBarMode) => void;
  /** Recently used models (most recent first) — shown when the model menu opens with an empty search */
  recentModels?: PromptBarModel[];
  /** True while the parent is fetching the live verified catalog — the model menu shows a small loading indicator instead of implying the short list is everything */
  modelsLoading?: boolean;
  /** The blocking indicator already gave up but the catalog is still landing. Renders a quiet note instead of a spinner. */
  modelsSettling?: boolean;
  /** Fired when the model menu opens so the parent can (re)load the verified catalog */
  onModelMenuOpened?: () => unknown;
  /** Extra condition that enables sending even with an empty draft (e.g. attached files) */
  canSendExtra?: boolean;
  busy?: boolean;
  onSend?: (text: string, meta: PromptBarSendMeta) => void;
  onStop?: () => void;
  onAttach?: (source: PromptBarSource) => unknown;
  onDictate?: () => unknown;
  /** Mirrors the draft upward so parents can queue it while busy */
  onDraftChange?: (text: string) => void;
  /** Registers a clear() so parents can empty the bar after queueing */
  onRegisterClear?: (fn: () => void) => void;
  /** Registers { clear, setText } for parents that need to inject text (skills, queue) */
  onRegisterControls?: (c: { clear: () => void; setText: (t: string) => void }) => void;
  background?: string;
  color?: string;
  menuBackground?: string;
  sparkColor?: string;
  width?: number;
  radius?: number;
  maxRows?: number;
  morphDuration?: number;
  squash?: number;
  tilt?: number;
  pressScale?: number;
  className?: string;
  style?: React.CSSProperties;
}

export default function PromptBar({
  /* eslint-disable react-hooks/preserve-manual-memoization -- the effort-sync
     effect below intentionally watches only `defaultEffort` because the
     `efforts` prop's identity is unstable (inline arrays); adding it would
     reset the user's effort choice on every parent render. The compiler
     therefore declines to preserve memoization — runtime is correct. */
  placeholder = "Ask anything",
  sources = DEFAULT_SOURCES,
  commands = DEFAULT_COMMANDS,
  models = DEFAULT_MODELS,
  defaultModel = "",
  modes = DEFAULT_MODES,
  defaultMode = "",
  efforts = DEFAULT_EFFORTS,
  defaultEffort = "",
  onEffortChange,
  canSendExtra = false,
  busy = false,
  onSend,
  onStop,
  onAttach,
  onDictate,
  onModelChange,
  onModeChange,
  recentModels,
  onModelMenuOpened,
  modelsLoading = false,
  modelsSettling = false,
  onDraftChange,
  onRegisterClear,
  onRegisterControls,
  background = undefined,
  color = undefined,
  menuBackground = undefined,
  sparkColor = undefined,
  width = undefined,
  radius = undefined,
  maxRows = 5,
  morphDuration = 240,
  squash = 0.12,
  tilt = 8,
  pressScale = undefined,
  className = "",
  style,
}: PromptBarProps) {
  const reduce = useReducedMotion();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const glowRef = useRef<HTMLSpanElement | null>(null);
  const sparkRef = useRef<HTMLCanvasElement | null>(null);
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const lastOpen = useRef<string | null>(null);
  const dictation = useRef(0);
  const latest = useRef({ onSend, onStop, onAttach, onDictate, onEffortChange, onModelChange, onModeChange, onModelMenuOpened });
  useEffect(() => {
    latest.current = { onSend, onStop, onAttach, onDictate, onEffortChange, onModelChange, onModeChange, onModelMenuOpened };
  });

  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<string[]>([]);
  const [modelKey, setModelKey] = useState(defaultModel);
  const [modeKey, setModeKey] = useState(defaultMode);
  const [plusOpen, setPlusOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [modelQuery, setModelQuery] = useState("");
  const [modeOpen, setModeOpen] = useState(false);
  const [effortOpen, setEffortOpen] = useState(false);
  const [effortIndex, setEffortIndex] = useState(() => {
    const i = efforts.indexOf(defaultEffort);
    return i >= 0 ? i : Math.max(0, Math.floor((efforts.length - 1) / 2));
  });
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(0);
  const [listening, setListening] = useState(false);
  const [pressed, setPressed] = useState(false);
  // Infinite scroll for the (potentially hundreds-long) model and slash-skill
  // lists: render 50 rows per chunk and grow as the menu scrolls near the
  // bottom.
  const [renderLimit, setRenderLimit] = useState(MODEL_CHUNK);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const model = models.find((m) => m.key === modelKey) ?? models[0];
  const mode = modes.find((m) => m.key === modeKey) ?? modes[0];
  // Keep internal picker state in sync when the parent changes the defaults
  // externally (mode/effort/model restore on conversation switch, queue replay,
  // mode buttons elsewhere in the app).
  useEffect(() => {
    setModeKey(defaultMode);
  }, [defaultMode]);
  useEffect(() => {
    if (defaultModel) setModelKey(defaultModel);
  }, [defaultModel]);
  useEffect(() => {
    const i = efforts.indexOf(defaultEffort);
    if (i >= 0) setEffortIndex(i);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultEffort]);
  const token = dismissed ? null : parseToken(draft);
  const open: "at" | "slash" | "model" | "mode" | "effort" | null = plusOpen
    ? "at"
    : token?.kind ?? (modelOpen ? "model" : modeOpen ? "mode" : effortOpen ? "effort" : null);
  const query = plusOpen ? "" : token?.query ?? "";
  // Grow the rendered chunk when the menu scrolls near the bottom (infinite
  // scroll without an IntersectionObserver dependency).
  const onMenuScroll = (e: React.UIEvent<HTMLDivElement>) => {
    if (open !== "model" && open !== "slash") return;
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 60) {
      setRenderLimit((c) => Math.min(c + MODEL_CHUNK, Math.max(c, list.length)));
    }
  };
  // New menu open or new search → back to the first chunk.
  useEffect(() => {
    setRenderLimit(MODEL_CHUNK);
  }, [open, modelQuery, query]);
  const filtered = useMemo<PromptBarSource[] | PromptBarCommand[] | PromptBarModel[] | PromptBarMode[]>(() => {
    if (open === "at") return sources.filter((s) => s.name.toLowerCase().includes(query));
    if (open === "slash") return commands.filter((c) => c.name.replace(/^\//, "").toLowerCase().startsWith(query));
    if (open === "model") {
      const q = modelQuery.trim().toLowerCase();
      if (q) {
        return models.filter(
          (m) => m.name.toLowerCase().includes(q) || m.key.toLowerCase().includes(q)
        );
      }
      // Empty search → recently used first (deduped, still verified list members)
      if (recentModels && recentModels.length > 0) {
        const seen = new Set<string>();
        const recents = recentModels.filter((m) => models.some((x) => x.key === m.key) && !seen.has(m.key) && seen.add(m.key));
        const rest = models.filter((m) => !seen.has(m.key));
        return [...recents, ...rest];
      }
      return models;
    }
    if (open === "mode") return modes;
    return [];
  }, [open, query, sources, commands, models, modes, modelQuery, recentModels]);
  // The model menu is grouped by creator; every other menu keeps its order.
  const list = useMemo<PromptBarSource[] | PromptBarCommand[] | PromptBarModel[] | PromptBarMode[]>(
    () => (open === "model" ? groupByCreator(filtered as PromptBarModel[]) : filtered),
    [filtered, open]
  );
  const cursor = Math.min(active, Math.max(0, list.length - 1));
  // Keyboard nav walks the FULL list — pull the next chunk into the DOM when
  // the cursor reaches the edge of what's rendered (model + slash menus).
  const ensureCursorRendered = (next: number) => {
    if (open !== "model" && open !== "slash") return;
    setRenderLimit((c) => (next >= c ? Math.ceil((next + 1) / MODEL_CHUNK) * MODEL_CHUNK : c));
  };
  // What actually renders: the model and slash-skill menus stream in
  // MODEL_CHUNK rows (plus one group header per creator run); every other
  // menu shows its full list. Widened to the shared shape so one row type
  // covers every menu kind.
  const chunked = open === "model" || open === "slash";
  const rows = (
    chunked ? list.slice(0, renderLimit) : list
  ) as (PromptBarSource & PromptBarCommand & PromptBarModel & PromptBarMode)[];
  const canSend = draft.trim().length > 0 || attachments.length > 0 || canSendExtra;
  // P7: the catalog streams in AFTER the menu is already open. renderLimit only
  // grew on scroll-to-bottom, so models that arrived while the user was reading
  // the top of the list were sliced out of the DOM and stayed invisible until
  // they scrolled back to the bottom. Grow to cover whatever is there now.
  useEffect(() => {
    if (!chunked) return;
    setRenderLimit((c) => (list.length > c ? list.length : c));
  }, [chunked, list.length]);
  const armed = busy || canSend;
  const level = efforts[effortIndex] ?? "";
  const maxed = efforts.length > 1 && effortIndex === efforts.length - 1;

  const focusInput = () => inputRef.current?.focus({ preventScroll: true });
  const searchRef = useRef<HTMLInputElement | null>(null);
  const closeMenus = useCallback(() => {
    setPlusOpen(false);
    setModelOpen(false);
    setModeOpen(false);
    setEffortOpen(false);
    setModelQuery("");
  }, []);

  const clearDraft = useCallback(() => {
    setDraft("");
    setAttachments([]);
    setDismissed(false);
    closeMenus();
  }, [closeMenus]);
  useEffect(() => {
    onRegisterClear?.(clearDraft);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearDraft]);
  useEffect(() => {
    onRegisterControls?.({
      clear: clearDraft,
      setText: (t: string) => {
        setDraft(t);
        setDismissed(false);
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearDraft]);

  useLayoutEffect(() => {
    const glow = glowRef.current;
    if (!glow || !open) return;
    const row = rowRefs.current[cursor];
    if (!row) {
      glow.style.opacity = "0";
      return;
    }
    // Keep the highlighted row visible when the list scrolls (model menu
    // caps its height — keyboard nav must follow the selection).
    row.scrollIntoView?.({ block: "nearest" });
    const fresh = lastOpen.current !== open;
    lastOpen.current = open;
    if (fresh) glow.style.transition = "none";
    glow.style.top = `${row.offsetTop}px`;
    glow.style.height = `${row.offsetHeight}px`;
    glow.style.opacity = "1";
    if (fresh) {
      void glow.offsetHeight;
      glow.style.transition = "";
    }
  }, [open, cursor, list]);

  useEffect(() => {
    if (!open) lastOpen.current = null;
  }, [open]);

  useEffect(() => {
    if (!plusOpen && !modelOpen && !modeOpen && !effortOpen) return undefined;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) closeMenus();
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [plusOpen, modelOpen, modeOpen, effortOpen, closeMenus]);

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "0px";
    const max = LINE * maxRows;
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  }, [draft, maxRows]);

  useEffect(() => {
    onDraftChange?.(draft);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  useEffect(
    () => () => {
      dictation.current += 1;
    },
    []
  );

  useEffect(() => {
    const canvas = sparkRef.current;
    if (!maxed || reduce || !canvas) return undefined;
    const ctx = canvas.getContext("2d");
    if (!ctx) return undefined;
    let raf = 0;
    let last = performance.now();
    let w = 0;
    let h = 0;
    let due = 0;
    const parts: { x: number; y: number; r: number; vy: number; sway: number; phase: number; life: number; span: number }[] = [];
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      w = rect.width;
      h = rect.height;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const spawn = (burst: boolean) => {
      parts.push({
        x: Math.random() * w,
        y: burst ? h * (0.2 + Math.random() * 0.8) : h + 3,
        r: 0.9 + Math.random() * 1.1,
        vy: -(7 + Math.random() * 9),
        sway: (Math.random() - 0.5) * 10,
        phase: Math.random() * Math.PI * 2,
        life: burst ? Math.random() * 1.2 : 0,
        span: 2.4 + Math.random() * 2.4,
      });
    };
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      due += dt;
      while (due > 0.14) {
        due -= 0.14;
        if (parts.length < 30) spawn(false);
      }
      ctx.clearRect(0, 0, w, h);
      const spark = sparkColor || "#b39dff";
      ctx.fillStyle = spark;
      ctx.shadowColor = spark;
      ctx.shadowBlur = 6;
      for (let i = parts.length - 1; i >= 0; i -= 1) {
        const p = parts[i];
        p.life += dt;
        if (p.life > p.span) {
          parts.splice(i, 1);
          continue;
        }
        const k = p.life / p.span;
        const twinkle = 0.7 + 0.3 * Math.sin(now / 160 + p.phase);
        p.y += p.vy * dt;
        ctx.globalAlpha = Math.sin(k * Math.PI) * 0.9 * twinkle;
        ctx.beginPath();
        ctx.arc(p.x + Math.sin(now / 900 + p.phase) * p.sway, p.y, p.r * twinkle, 0, Math.PI * 2);
        ctx.fill();
      }
      raf = requestAnimationFrame(tick);
    };
    resize();
    for (let i = 0; i < 26; i += 1) spawn(true);
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      ctx.clearRect(0, 0, w, h);
    };
  }, [maxed, reduce, sparkColor]);

  const setEffort = (i: number) => {
    const next = Math.max(0, Math.min(efforts.length - 1, i));
    if (next === effortIndex) return;
    setEffortIndex(next);
    latest.current.onEffortChange?.(efforts[next]);
  };
  const effortFromPointer = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const k = (e.clientX - rect.left - EDGE) / Math.max(1, rect.width - 2 * EDGE);
    setEffort(Math.round(k * (efforts.length - 1)));
  };
  const onEffortKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step =
      e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : 0;
    if (step) {
      e.preventDefault();
      setEffort(effortIndex + step);
    } else if (e.key === "Home") {
      e.preventDefault();
      setEffort(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setEffort(efforts.length - 1);
    } else if (e.key === "Escape") {
      setEffortOpen(false);
      focusInput();
    }
  };
  const stepAt = (i: number) => `calc(${EDGE}px + (100% - ${EDGE * 2}px) * ${i / Math.max(1, efforts.length - 1)})`;
  const fillAt = (i: number) => (i === efforts.length - 1 ? "100%" : `calc(${stepAt(i)} + 7px)`);

  const pick = (row: PromptBarSource | PromptBarCommand | PromptBarModel | PromptBarMode) => {
    if (open === "model") {
      setModelKey(row.key);
      setModelOpen(false);
      latest.current.onModelChange?.(row as PromptBarModel);
      focusInput();
      return;
    }
    if (open === "mode") {
      setModeKey(row.key);
      setModeOpen(false);
      latest.current.onModeChange?.(row as PromptBarMode);
      focusInput();
      return;
    }
    const head = token ? draft.slice(0, token.start) : draft;
    if ("attach" in row && row.attach) {
      setDraft(head);
      Promise.resolve(latest.current.onAttach?.(row as PromptBarSource)).then((files) => {
        if (!files) return;
        setAttachments((a) => [...a, ...(Array.isArray(files) ? (files as string[]) : [files as string])]);
      });
    } else if (open === "at") {
      const ins = "insert" in row && row.insert ? row.insert : `@${row.name} `;
      if (ins === "/") {
        // Insert a bare slash token so the command menu opens (needs a space
        // boundary before it for the token parser to see it).
        const head2 = head && !/\s$/.test(head) ? `${head} ` : head;
        setDraft(`${head2}/`);
        setPlusOpen(false);
        setDismissed(false);
        focusInput();
        return;
      }
      setDraft(`${head}${ins}`);
    } else {
      const ins = "insert" in row && row.insert ? row.insert : `${row.name} `;
      setDraft(`${head}${ins}`);
    }
    setPlusOpen(false);
    setDismissed(false);
    focusInput();
  };

  const send = () => {
    if ((!canSend && !canSendExtra) || busy) return;
    latest.current.onSend?.(draft.trim(), { attachments, model, effort: level, mode });
    setDraft("");
    setAttachments([]);
    setDismissed(false);
    closeMenus();
    focusInput();
  };

  const toggleListen = () => {
    if (listening) {
      dictation.current += 1;
      setListening(false);
      return;
    }
    const seq = ++dictation.current;
    setListening(true);
    Promise.resolve(latest.current.onDictate?.()).then(
      (text) => {
        if (seq !== dictation.current) return;
        setListening(false);
        if (text) setDraft((d) => (d.trim() ? `${d.trimEnd()} ${text}` : String(text)));
        focusInput();
      },
      () => {
        if (seq === dictation.current) setListening(false);
      }
    );
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (open && list.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const next = (cursor + (e.key === "ArrowDown" ? 1 : list.length - 1)) % list.length;
        setActive(next);
        ensureCursorRendered(next);
        return;
      }
      if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
        e.preventDefault();
        pick(list[cursor]);
        return;
      }
    }
    if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        setDismissed(true);
        closeMenus();
      }
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  const down = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0 || !armed) return;
    setPressed(true);
  };
  const up = () => setPressed(false);

  return (
    <div
      ref={rootRef}
      className={`prompt-bar${className ? ` ${className}` : ""}`}
      data-busy={busy ? "" : undefined}
      data-max={maxed ? "" : undefined}
      style={{
        ...(background !== undefined ? { "--pb-bg": background } : {}),
        ...(color !== undefined ? { "--pb-ink": color } : {}),
        ...(menuBackground !== undefined ? { "--pb-menu": menuBackground } : {}),
        ...(width !== undefined ? { "--pb-w": `${width}px` } : {}),
        ...(radius !== undefined ? { "--pb-radius": `${radius}px` } : {}),
        ...(sparkColor !== undefined ? { "--pb-spark": sparkColor } : {}),
        ...(pressScale !== undefined ? { "--pb-press": pressScale } : {}),
        ...style,
      } as React.CSSProperties}
    >
      {open ? (
        <div
          className="prompt-bar__menu"
          ref={menuRef}
          onScroll={onMenuScroll}
          role={open === "effort" ? "dialog" : "listbox"}
          aria-label={
            open === "at"
              ? "Sources"
              : open === "slash"
                ? "Commands"
                : open === "model"
                  ? "Models"
                  : open === "mode"
                    ? "Mode"
                    : "Effort"
          }
          data-kind={open}
        >
          {open === "effort" ? (
            <>
              <div className="prompt-bar__effort-head">
                <span className="prompt-bar__effort-title">Effort</span>
                <span className="prompt-bar__effort-level">{level}</span>
                <span className="prompt-bar__effort-help" title="Higher effort thinks longer before answering">
                  <HugeiconsIcon icon={HelpCircleIcon} size={14} strokeWidth={1.8} />
                </span>
              </div>
              <div className="prompt-bar__effort-ends">
                <span>Faster</span>
                <span>Smarter</span>
              </div>
              <div
                className="prompt-bar__effort-track"
                role="slider"
                tabIndex={0}
                aria-label="Effort"
                aria-valuemin={0}
                aria-valuemax={efforts.length - 1}
                aria-valuenow={effortIndex}
                aria-valuetext={level}
                style={{ "--pb-effort-x": stepAt(effortIndex), "--pb-effort-fill": fillAt(effortIndex) } as React.CSSProperties}
                onPointerDown={(e) => {
                  if (e.button !== 0) return;
                  try {
                    e.currentTarget.setPointerCapture(e.pointerId);
                  } catch {}
                  e.currentTarget.focus({ preventScroll: true });
                  effortFromPointer(e);
                }}
                onPointerMove={(e) => {
                  if (e.buttons & 1) effortFromPointer(e);
                }}
                onKeyDown={onEffortKey}
              >
                <span className="prompt-bar__effort-fill" />
                {efforts.map((label, i) => (
                  <i key={label} className="prompt-bar__effort-dot" style={{ left: stepAt(i) }} />
                ))}
                <span className="prompt-bar__effort-thumb" />
              </div>
            </>
          ) : (
            <>
              {open === "model" ? (
                <div className="prompt-bar__search">
                  <input
                    ref={searchRef}
                    type="text"
                    className="prompt-bar__search-input"
                    placeholder={recentModels && recentModels.length ? "Search all models…" : "Search models…"}
                    aria-label="Search models"
                    value={modelQuery}
                    onChange={(e) => {
                      setModelQuery(e.target.value);
                      setActive(0);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                        e.preventDefault();
                        const next = (cursor + (e.key === "ArrowDown" ? 1 : list.length - 1)) % Math.max(1, list.length);
                        setActive(next);
                        ensureCursorRendered(next);
                      } else if ((e.key === "Enter" || e.key === "Tab") && list.length > 0) {
                        e.preventDefault();
                        pick(list[cursor]);
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        setDismissed(true);
                        closeMenus();
                        focusInput();
                      }
                      e.stopPropagation();
                    }}
                  />
                </div>
              ) : null}
              <span ref={glowRef} className="prompt-bar__glow" aria-hidden="true" />
              {rows.map((row, i) => {
                const groupLabel = open === "model" ? modelCreatorLabel(row) : null;
                const startsGroup =
                  groupLabel !== null && (i === 0 || modelCreatorId(rows[i - 1]) !== modelCreatorId(row));
                return (
                  <Fragment key={row.key}>
                    {startsGroup ? (
                      <div className="prompt-bar__group" role="presentation">
                        {groupLabel}
                      </div>
                    ) : null}
                <button
                  type="button"
                  ref={(el) => {
                    rowRefs.current[i] = el;
                  }}
                  role="option"
                  aria-selected={i === cursor}
                  className="prompt-bar__row"
                  onMouseDown={(e) => e.preventDefault()}
                  onPointerEnter={() => setActive(i)}
                  onClick={() => pick(row)}
                >
                  {open === "at" ? <span className="prompt-bar__row-icon">{renderIcon(row.icon, 15)}</span> : null}
                  {open === "model" ? (
                    <span className="prompt-bar__provider">
                      <ProviderMark model={row} />
                    </span>
                  ) : null}
                  <span className="prompt-bar__row-name">{row.name}</span>
                  {row.description ? <span className="prompt-bar__row-desc">{row.description}</span> : null}
                  {open === "model" && row.detail ? <span className="prompt-bar__row-detail">{row.detail}</span> : null}
                  {open === "model" && row.healthDot ? (
                    <span
                      className="prompt-bar__row-health"
                      data-health={row.healthDot}
                      title={row.healthTitle ?? (row.healthDot === "green" ? "Verified recently" : "Not re-verified in the last day")}
                      aria-label={row.healthDot === "green" ? "Model verified recently" : "Model health aged — re-verification pending"}
                    />
                  ) : null}
                  {open === "model" || open === "mode" ? (
                    <>
                      <span className="prompt-bar__row-tag">{row.tag}</span>
                      <span className="prompt-bar__row-check" data-on={row.key === (open === "mode" ? mode?.key : model?.key) ? "" : undefined}>
                        <HugeiconsIcon icon={Tick02Icon} size={13} strokeWidth={2.5} />
                      </span>
                    </>
                  ) : null}
                </button>
                  </Fragment>
                );
              })}
{open === "model" && modelsLoading ? (
        <div className="prompt-bar__model-loading" role="status" aria-live="polite">
          <span className="prompt-bar__model-loading-spinner" aria-hidden="true" />
          <span>Fetching verified models…</span>
        </div>
      ) : null}
      {open === "model" && modelsSettling && !modelsLoading ? (
        // Quiet phase: the fallback trio above is usable, so don't block on a
        // spinner — just say the verified list is still growing.
        <div className="prompt-bar__model-settling" role="status" aria-live="polite">
          Still verifying models — this list will keep updating.
        </div>
      ) : null}
              {chunked && list.length > renderLimit ? (
                <button
                  type="button"
                  className="prompt-bar__row prompt-bar__more"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setRenderLimit((c) => c + MODEL_CHUNK)}
                >
                  <span className="prompt-bar__row-name">Show {Math.min(MODEL_CHUNK, list.length - renderLimit)} more…</span>
                </button>
              ) : null}
              {list.length === 0 && !modelsLoading ? <div className="prompt-bar__empty">No matches for “{query}”</div> : null}
              {list.length === 0 && modelsLoading ? <div className="prompt-bar__empty">Loading the live catalog…</div> : null}
            </>
          )}
        </div>
      ) : null}

      <div
        className="prompt-bar__field"
        role="presentation"
        data-max={maxed ? "" : undefined}
        onPointerDown={(e) => {
          if (e.target === e.currentTarget || e.target === inputRef.current) closeMenus();
        }}
        onClick={focusInput}
      >
        <canvas ref={sparkRef} className="prompt-bar__sparks" aria-hidden="true" />
        {attachments.length > 0 ? (
          <div className="prompt-bar__chips">
            {attachments.map((file, i) => (
              <span key={`${file}-${i}`} className="prompt-bar__chip">
                <HugeiconsIcon icon={File02Icon} size={12} strokeWidth={2} />
                <span className="prompt-bar__chip-name">{file}</span>
                <button
                  type="button"
                  className="prompt-bar__chip-x"
                  aria-label={`Remove ${file}`}
                  onClick={() => setAttachments((a) => a.filter((_, j) => j !== i))}
                >
                  <HugeiconsIcon icon={Cancel01Icon} size={10} strokeWidth={2.5} />
                </button>
              </span>
            ))}
          </div>
        ) : null}

        <textarea
          ref={inputRef}
          className="prompt-bar__input"
          rows={1}
          value={draft}
          placeholder={listening ? "Listening…" : placeholder}
          aria-label="Prompt"
          onChange={(e) => {
            setDraft(e.target.value);
            setDismissed(false);
            closeMenus();
            setActive(0);
          }}
          onFocus={closeMenus}
          onKeyDown={onKeyDown}
        />

        <div className="prompt-bar__bar">
          {sources.length > 0 ? (
          <button
            type="button"
            className="prompt-bar__tool"
            aria-label="Add files and sources"
            aria-expanded={plusOpen}
            data-on={plusOpen ? "" : undefined}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setModelOpen(false);
              setModeOpen(false);
              setEffortOpen(false);
              setActive(0);
              setPlusOpen((v) => !v);
              focusInput();
            }}
          >
            <HugeiconsIcon icon={PlusSignIcon} size={16} strokeWidth={2} />
          </button>
          ) : null}
          {modes.length > 0 ? (
            <button
              type="button"
              className="prompt-bar__pick prompt-bar__pick--mode"
              aria-label="Choose mode"
              aria-expanded={modeOpen}
              data-on={modeOpen ? "" : undefined}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setPlusOpen(false);
                setModelOpen(false);
                setEffortOpen(false);
                setActive(Math.max(0, modes.findIndex((m) => m.key === mode?.key)));
                setModeOpen((v) => !v);
                focusInput();
              }}
            >
              <span>{mode?.name}</span>
              <HugeiconsIcon icon={ArrowDown01Icon} size={12} strokeWidth={2.4} />
            </button>
          ) : null}
          {models.length > 0 ? (
            <button
              type="button"
              className="prompt-bar__pick prompt-bar__pick--model"
              aria-label="Choose model"
              aria-expanded={modelOpen}
              data-on={modelOpen ? "" : undefined}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setPlusOpen(false);
                setModeOpen(false);
                setEffortOpen(false);
                setModelQuery("");
                // P6: compute the active row from the MODEL LIST, not `list`.
                // `list` is derived from `filtered`, which returns [] for every
                // non-"model" branch — and at click time `modelOpen` is still
                // false, so `open` !== "model" and the lookup ALWAYS returned
                // -1. That Math.max(0, …) then pinned the keyboard cursor to
                // row 0, so opening the picker jumped away from the model you
                // had actually selected (and Enter re-picked model #1).
                const modelIdx = models.findIndex((m) => m.key === model?.key);
                setActive(modelIdx >= 0 ? modelIdx : 0);
                const opening = !modelOpen;
                setModelOpen(opening);
                if (opening) {
                  // Parent state updates must happen in the event handler, NOT
                  // inside a setState updater (React renders updater bodies).
                  latest.current.onModelMenuOpened?.();
                  // Focus the menu's search box once it renders
                  requestAnimationFrame(() => searchRef.current?.focus({ preventScroll: true }));
                } else {
                  focusInput();
                }
              }}
            >
              <span className="prompt-bar__provider">
                <ProviderMark model={model} />
              </span>
              <span className="prompt-bar__pick-label">{model?.name}</span>
              <HugeiconsIcon icon={ArrowDown01Icon} size={12} strokeWidth={2.4} />
            </button>
          ) : null}
          {efforts.length > 0 ? (
            <button
              type="button"
              className="prompt-bar__pick"
              aria-label="Choose effort"
              aria-expanded={effortOpen}
              data-on={effortOpen ? "" : undefined}
              data-max={maxed ? "" : undefined}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setPlusOpen(false);
                setModelOpen(false);
                setModeOpen(false);
                setEffortOpen((v) => !v);
                focusInput();
              }}
            >
              <HugeiconsIcon icon={SparklesIcon} size={13} strokeWidth={2} />
              <span>{level}</span>
            </button>
          ) : null}
          <span className="prompt-bar__spacer" />
          {onDictate ? (
            <button
              type="button"
              className="prompt-bar__tool"
              aria-label={listening ? "Stop dictation" : "Dictate"}
              aria-pressed={listening}
              data-on={listening ? "" : undefined}
              onMouseDown={(e) => e.preventDefault()}
              onClick={toggleListen}
            >
              {listening ? (
                <span className="prompt-bar__eq" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
              ) : (
                <HugeiconsIcon icon={Mic01Icon} size={15} strokeWidth={2} />
              )}
            </button>
          ) : null}
          <button
            type="button"
            className="prompt-bar__send"
            disabled={!armed}
            aria-label={busy ? "Stop" : "Send"}
            data-armed={armed ? "" : undefined}
            data-busy={busy ? "" : undefined}
            data-pressed={pressed ? "" : undefined}
            onMouseDown={(e) => e.preventDefault()}
            onPointerDown={down}
            onPointerUp={up}
            onPointerCancel={up}
            onPointerLeave={up}
            onClick={() => {
              if (busy) latest.current.onStop?.();
              else send();
            }}
          >
            <SendGlyph busy={busy} morphDuration={morphDuration} squash={squash} tilt={tilt} />
          </button>
        </div>
      </div>
    </div>
  );
}
