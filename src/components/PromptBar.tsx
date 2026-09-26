"use client";

import { isValidElement, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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

type AnyIcon = unknown;

const ARROW_UP = [12, 4.5, 18.5, 11, 14.25, 11, 14.25, 19.5, 9.75, 19.5, 9.75, 11, 5.5, 11];
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
    pathRef.current?.setAttribute("d", pathAt(ARROW_UP, SQUARE, v));
    const goo = reduce ? 0 : Math.sin(v * Math.PI);
    const sx = 1 - squash * goo;
    if (svgRef.current) {
      svgRef.current.style.transform = goo ? `rotate(${dir.current * tilt * goo}deg) scale(${sx}, ${1 / sx})` : "";
    }
  });

  return (
    <svg
      ref={svgRef}
      className="prompt-bar__glyph"
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="currentColor"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinejoin="round"
    >
      <path ref={pathRef} d={pathAt(ARROW_UP, SQUARE, t.get())} />
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
  // Infinite scroll for the (potentially hundreds-long) model list: render
  // 50 rows per chunk and grow as the menu scrolls near the bottom.
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
    if (open !== "model") return;
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 60) {
      setRenderLimit((c) => Math.min(c + MODEL_CHUNK, Math.max(c, list.length)));
    }
  };
  // New menu open or new search → back to the first chunk.
  useEffect(() => {
    setRenderLimit(MODEL_CHUNK);
  }, [open, modelQuery]);
  const list = useMemo<PromptBarSource[] | PromptBarCommand[] | PromptBarModel[] | PromptBarMode[]>(() => {
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
  const cursor = Math.min(active, Math.max(0, list.length - 1));
  const canSend = draft.trim().length > 0 || attachments.length > 0 || canSendExtra;
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
        setActive((cursor + (e.key === "ArrowDown" ? 1 : list.length - 1)) % list.length);
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
                        setActive((c) => (cursor + (e.key === "ArrowDown" ? 1 : list.length - 1)) % Math.max(1, list.length));
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
              {(list as (PromptBarSource & PromptBarCommand & PromptBarModel)[])
                .slice(0, open === "model" ? renderLimit : list.length)
                .map((row, i) => (
                <button
                  key={row.key}
                  ref={(el) => {
                    rowRefs.current[i] = el;
                  }}
                  type="button"
                  role="option"
                  aria-selected={i === cursor}
                  className="prompt-bar__row"
                  onMouseDown={(e) => e.preventDefault()}
                  onPointerEnter={() => setActive(i)}
                  onClick={() => pick(row)}
                >
                  {open === "at" ? <span className="prompt-bar__row-icon">{renderIcon(row.icon, 15)}</span> : null}
                  <span className="prompt-bar__row-name">{row.name}</span>
                  {row.description ? <span className="prompt-bar__row-desc">{row.description}</span> : null}
                  {open === "model" && row.detail ? <span className="prompt-bar__row-detail">{row.detail}</span> : null}
                  {open === "model" || open === "mode" ? (
                    <>
                      <span className="prompt-bar__row-tag">{row.tag}</span>
                      <span className="prompt-bar__row-check" data-on={row.key === (open === "mode" ? mode?.key : model?.key) ? "" : undefined}>
                        <HugeiconsIcon icon={Tick02Icon} size={13} strokeWidth={2.5} />
                      </span>
                    </>
                  ) : null}
                </button>
                ))}
              {open === "model" && modelsLoading ? (
                <div className="prompt-bar__model-loading" role="status" aria-live="polite">
                  <span className="prompt-bar__model-loading-spinner" aria-hidden="true" />
                  <span>Fetching verified models…</span>
                </div>
              ) : null}
              {open === "model" && list.length > renderLimit ? (
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
              className="prompt-bar__pick"
              aria-label="Choose model"
              aria-expanded={modelOpen}
              data-on={modelOpen ? "" : undefined}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setPlusOpen(false);
                setModeOpen(false);
                setEffortOpen(false);
                setModelQuery("");
                setActive(Math.max(0, models.findIndex((m) => m.key === model?.key)));
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
              <span>{model?.name}</span>
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
