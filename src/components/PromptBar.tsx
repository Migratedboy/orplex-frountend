"use client";

import { Fragment, isValidElement, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon, File02Icon, HelpCircleIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import "./PromptBar.css";
import { ProviderMark, modelCreatorId, modelCreatorLabel } from "./ProviderIcons";
import { positionPromptMenu, type PromptMenuAlignment } from "@/lib/prompt-menu-position";

type AnyIcon = unknown;
type MenuKind = "sources" | "commands" | "model" | "mode" | "effort" | null;
type MenuRow = PromptBarSource | PromptBarCommand | PromptBarModel | PromptBarMode;
type ToolIcon = "globe" | "file" | "pencil" | "term" | "plug";

interface PromptToolCall {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  startedAt?: number;
}

interface RecentTool {
  id: string;
  icon: ToolIcon;
  verb: string;
  detail: string;
  startedAt: number;
}

const RECENT_TOOL_MS = 5000;

function hasIcon(row: MenuRow): row is PromptBarSource {
  return "icon" in row;
}

function hasDescription(row: MenuRow): row is PromptBarSource | PromptBarCommand | PromptBarMode {
  return "description" in row;
}

const LINE = 22;
const MODEL_CHUNK = 50;
const DEFAULT_SOURCES: PromptBarSource[] = [];
const DEFAULT_COMMANDS: PromptBarCommand[] = [];
const DEFAULT_MODELS: PromptBarModel[] = [];
const DEFAULT_MODES: PromptBarMode[] = [
  { key: "ask", name: "Ask", description: "Questions and quick answers" },
  { key: "code", name: "Code", description: "Build and edit code" },
  { key: "plan", name: "Plan", description: "Plan first, then build" },
];
const DEFAULT_EFFORTS = ["Low", "Medium", "High"];

export interface PromptBarSource {
  key: string;
  name: string;
  description?: string;
  icon?: AnyIcon;
  attach?: boolean;
  insert?: string;
}

export interface PromptBarCommand {
  key: string;
  name: string;
  description?: string;
  insert?: string;
}

export interface PromptBarModel {
  key: string;
  name: string;
  tag?: string;
  detail?: string;
  healthDot?: "green" | "amber";
  healthTitle?: string;
  group?: string;
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

export interface PromptBarProps {
  placeholder?: string;
  conversationState?: "initial" | "chat" | "thinking";
  footerProject?: ReactNode;
  quotaIndicator?: ReactNode;
  onOpenConnectors?: () => void;
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
  recentModels?: PromptBarModel[];
  modelsLoading?: boolean;
  modelsSettling?: boolean;
  onModelMenuOpened?: () => unknown;
  canSendExtra?: boolean;
  busy?: boolean;
  statusPhase?: "thinking" | "writing";
  requestStartedAt?: number;
  activeToolCall?: PromptToolCall | null;
  onSend?: (text: string, meta: PromptBarSendMeta) => void;
  onStop?: () => void;
  onAttach?: (source: PromptBarSource) => unknown;
  onDictate?: () => unknown;
  onDraftChange?: (text: string) => void;
  onRegisterClear?: (fn: () => void) => void;
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

const MODE_PLACEHOLDERS: Record<string, { initial: string; chat: string }> = {
  ask: {
    initial: "How can I help you today?",
    chat: "Write a message...",
  },
  code: {
    initial: "What do you want to build?",
    chat: "Describe the change...",
  },
  plan: {
    initial: "What should we plan?",
    chat: "Add to the plan...",
  },
};

const SYMBOL_PATHS: Record<string, ReactNode> = {
  plus: <path d="M12 5v14M5 12h14" />,
  check: <path d="M20 6 9 17l-5-5" />,
  down: <path d="m6 9 6 6 6-6" />,
  right: <path d="m9 18 6-6-6-6" />,
  mic: <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v3" />,
  enter: <path d="M20 4v7a4 4 0 0 1-4 4H4M9 10l-5 5 5 5" />,
  stop: <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none" />,
  spark: <path d="M12 2l2.4 7.6L22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4z" fill="currentColor" stroke="none" />,
  ask: <path d="M21 12a8 8 0 0 1-11.6 7.1L3 21l1.9-5.4A8 8 0 1 1 21 12z" />,
  code: <path d="m16 18 6-6-6-6M8 6l-6 6 6 6" />,
  plan: <path d="M9 6h12M9 12h12M9 18h12M3 6l1 1 2-2M3 12l1 1 2-2M3 18l1 1 2-2" />,
  plug: <path d="M12 22v-5M9 8V2M15 8V2M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8z" />,
  globe: <><circle cx="12" cy="12" r="10" /><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" /></>,
  file: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6M8 13h8M8 17h8" /></>,
  pencil: <><path d="m16 4 4 4M4 20l4-.8L19 8a2.8 2.8 0 0 0-4-4L4 15z" /></>,
  term: <><path d="m4 17 6-6-6-6M12 19h8" /></>,
};

function describeToolCall(tool: string, args: Record<string, unknown>) {
  const name = tool.toLowerCase();
  const detail = Object.entries(args).find(([key, value]) =>
    /path|file|query|command|url|target/i.test(key) && typeof value === "string" && value.trim()
  )?.[1];
  const shortDetail = typeof detail === "string" ? detail.trim() : "";

  if (/search_code|search_file|grep|find_files/.test(name)) {
    return { icon: "file" as const, verb: "Searching", detail: shortDetail };
  }
  if (/web|browse|fetch|navigate|screenshot|verify_app|record_page/.test(name)) {
    return { icon: "globe" as const, verb: /search/.test(name) ? "Searching the web" : "Browsing", detail: shortDetail };
  }
  if (/read|list_files|inspect/.test(name)) {
    return { icon: "file" as const, verb: /list/.test(name) ? "Listing" : "Reading", detail: shortDetail };
  }
  if (/write|edit|patch|create|delete/.test(name)) {
    return { icon: "pencil" as const, verb: "Editing", detail: shortDetail };
  }
  if (/command|terminal|shell|npm|run/.test(name)) {
    return { icon: "term" as const, verb: "Running", detail: shortDetail };
  }
  if (/mcp|connector|server/.test(name)) {
    return { icon: "plug" as const, verb: "Calling", detail: shortDetail || tool };
  }
  return { icon: "file" as const, verb: "Working", detail: shortDetail || tool };
}

function Icon({ name, className = "i" }: { name: string; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      {SYMBOL_PATHS[name]}
    </svg>
  );
}

function parseToken(draft: string) {
  const match = /(^|\s)([@/])([\w-]*)$/.exec(draft);
  if (!match) return null;
  return {
    kind: match[2] === "@" ? "sources" as const : "commands" as const,
    query: match[3].toLowerCase(),
    start: match.index + match[1].length,
  };
}

function dedupeModels(models: PromptBarModel[]) {
  const seen = new Set<string>();
  return models.filter((model) => !seen.has(model.key) && !!seen.add(model.key));
}

const renderIcon = (icon: AnyIcon) =>
  icon == null || typeof icon === "boolean"
    ? null
    : isValidElement(icon)
      ? icon
      : typeof icon === "object"
        ? <HugeiconsIcon icon={icon as never} size={16} strokeWidth={1.8} />
        : null;

export default function PromptBar({
  placeholder = "Write a message...",
  conversationState,
  footerProject,
  quotaIndicator,
  onOpenConnectors,
  sources = DEFAULT_SOURCES,
  commands = DEFAULT_COMMANDS,
  models = DEFAULT_MODELS,
  defaultModel = "",
  modes = DEFAULT_MODES,
  defaultMode = "ask",
  efforts = DEFAULT_EFFORTS,
  defaultEffort = "Medium",
  onEffortChange,
  onModelChange,
  onModeChange,
  recentModels,
  onModelMenuOpened,
  modelsLoading = false,
  modelsSettling = false,
  canSendExtra = false,
  busy = false,
  statusPhase = "thinking",
  requestStartedAt,
  activeToolCall,
  onSend,
  onStop,
  onAttach,
  onDictate,
  onDraftChange,
  onRegisterClear,
  onRegisterControls,
  background,
  color,
  menuBackground,
  sparkColor,
  width,
  radius,
  maxRows = 5,
  pressScale,
  className = "",
  style,
}: PromptBarProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const permissionMenuRef = useRef<HTMLDivElement | null>(null);
  const permissionTriggerRef = useRef<HTMLButtonElement | null>(null);
  const menuPortalRef = useRef<HTMLDivElement | null>(null);
  const menuAnchorRef = useRef<HTMLElement | null>(null);
  const modelTriggerRef = useRef<HTMLButtonElement | null>(null);
  const effortTriggerRef = useRef<HTMLButtonElement | null>(null);
  const recentToolIdRef = useRef<string | null>(null);
  const requestStartedAtRef = useRef<number | null>(null);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<string[]>([]);
  const [modelKey, setModelKey] = useState(defaultModel);
  const [modeKey, setModeKey] = useState(defaultMode);
  const [effort, setEffort] = useState(defaultEffort);
  const [menu, setMenu] = useState<MenuKind>(null);
  const [modelQuery, setModelQuery] = useState("");
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [listening, setListening] = useState(false);
  const [pressed, setPressed] = useState(false);
  const [permission, setPermission] = useState<"Manual" | "Auto">("Manual");
  const [permissionOpen, setPermissionOpen] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [statusNow, setStatusNow] = useState(0);
  const [recentTool, setRecentTool] = useState<RecentTool | null>(null);
  const [renderLimit, setRenderLimit] = useState(MODEL_CHUNK);
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const latest = useRef({ onSend, onStop, onAttach, onDictate, onEffortChange, onModelChange, onModeChange, onModelMenuOpened });
  latest.current = { onSend, onStop, onAttach, onDictate, onEffortChange, onModelChange, onModeChange, onModelMenuOpened };

  const model = models.find((item) => item.key === modelKey) ?? models[0];
  const mode = modes.find((item) => item.key === modeKey) ?? modes[0];
  const uiState = conversationState ?? (busy ? "thinking" : "chat");
  const modeCopy = MODE_PLACEHOLDERS[mode?.key ?? "ask"] ?? MODE_PLACEHOLDERS.ask;
  const token = dismissed ? null : parseToken(draft);
  const openMenu: MenuKind = token?.kind ?? menu;
  const query = token?.query ?? "";
  let filtered: MenuRow[] = [];
  if (openMenu === "sources") {
    filtered = sources.filter((source) => source.name.toLowerCase().includes(query));
  } else if (openMenu === "commands") {
    filtered = commands.filter((command) => command.name.replace(/^\//, "").toLowerCase().startsWith(query));
  } else if (openMenu === "mode") {
    filtered = modes;
  } else if (openMenu === "model") {
    const search = modelQuery.trim().toLowerCase();
    const matches = search
      ? models.filter((item) => item.name.toLowerCase().includes(search) || item.key.toLowerCase().includes(search))
      : models;
    if (!search && recentModels?.length) {
      const recentIds = new Set(recentModels.map((item) => item.key));
      filtered = dedupeModels([...recentModels.filter((item) => models.some((candidate) => candidate.key === item.key)), ...matches.filter((item) => !recentIds.has(item.key))]);
    } else {
      filtered = dedupeModels(matches);
    }
  }

  const rows = openMenu === "model" ? filtered.slice(0, renderLimit) : filtered;
  const cursor = Math.min(active, Math.max(0, filtered.length - 1));
  const canSend = draft.trim().length > 0 || attachments.length > 0 || canSendExtra;
  const armed = busy || canSend;
  const placeholderText = listening
    ? "Listening..."
    : uiState === "thinking"
      ? "Reply..."
      : modeCopy[uiState] ?? placeholder;
  const statusText = statusPhase === "writing" ? "Writing" : "Thinking";
  const promptStyle = {
    ...(background !== undefined ? { "--pb-bg": background } : {}),
    ...(color !== undefined ? { "--pb-ink": color } : {}),
    ...(menuBackground !== undefined ? { "--pb-menu": menuBackground } : {}),
    ...(width !== undefined ? { "--pb-w": `${width}px` } : {}),
    ...(radius !== undefined ? { "--pb-radius": `${radius}px` } : {}),
    ...(sparkColor !== undefined ? { "--pb-spark": sparkColor } : {}),
    ...(pressScale !== undefined ? { "--pb-press": pressScale } : {}),
    ...style,
  } as React.CSSProperties;

  const closeMenus = useCallback(() => {
    setMenu(null);
    setPermissionOpen(false);
    setModelQuery("");
  }, [setMenu, setPermissionOpen, setModelQuery]);

  const clearDraft = useCallback(() => {
    setDraft("");
    setAttachments([]);
    setDismissed(false);
    closeMenus();
  }, [closeMenus, setDraft, setAttachments, setDismissed]);

  useEffect(() => setModeKey(defaultMode), [defaultMode]);
  useEffect(() => {
    if (defaultModel) setModelKey(defaultModel);
  }, [defaultModel]);
  useEffect(() => setEffort(defaultEffort), [defaultEffort]);
  useEffect(() => {
    onRegisterClear?.(clearDraft);
    onRegisterControls?.({
      clear: clearDraft,
      setText: (text) => {
        setDraft(text);
        setDismissed(false);
      },
    });
  }, [clearDraft, onRegisterClear, onRegisterControls]);
  useEffect(() => {
    onDraftChange?.(draft);
  }, [draft, onDraftChange]);
  useEffect(() => {
    const onPrefill = (event: Event) => {
      const text = (event as CustomEvent<{ text?: string }>).detail?.text;
      if (!text) return;
      setDraft(text);
      setDismissed(false);
      requestAnimationFrame(() => inputRef.current?.focus());
    };
    window.addEventListener("orplex:prefill-prompt", onPrefill);
    return () => window.removeEventListener("orplex:prefill-prompt", onPrefill);
  }, []);
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !menuPortalRef.current?.contains(target)) closeMenus();
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [closeMenus]);
  useEffect(() => {
    if (!busy) {
      requestStartedAtRef.current = null;
      setElapsedSeconds(0);
      setRecentTool(null);
      recentToolIdRef.current = null;
      return;
    }
    const startedAt = requestStartedAt ?? requestStartedAtRef.current ?? Date.now();
    requestStartedAtRef.current = startedAt;
    const update = () => {
      const now = Date.now();
      setStatusNow(now);
      setElapsedSeconds(Math.floor((now - startedAt) / 1000));
    };
    update();
    const timer = window.setInterval(update, 250);
    return () => window.clearInterval(timer);
  }, [busy, requestStartedAt]);
  const pushTool = useCallback((icon: ToolIcon, verb: string, detail: string, id: string, startedAt?: number) => {
    recentToolIdRef.current = id;
    setRecentTool({ id, icon, verb, detail, startedAt: startedAt ?? Date.now() });
  }, []);
  useEffect(() => {
    if (!busy || !activeToolCall || recentToolIdRef.current === activeToolCall.id) return;
    const description = describeToolCall(activeToolCall.tool, activeToolCall.args);
    pushTool(description.icon, description.verb, description.detail, activeToolCall.id, activeToolCall.startedAt);
  }, [activeToolCall, busy, pushTool]);
  const renderStatus = () => {
    if (!recentTool) return { tool: null, fading: false };
    const age = statusNow - recentTool.startedAt;
    return {
      tool: age < RECENT_TOOL_MS ? recentTool : null,
      fading: age >= RECENT_TOOL_MS - 700,
    };
  };
  const status = renderStatus();
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = "0px";
    const maximum = LINE * maxRows;
    input.style.height = `${Math.min(input.scrollHeight, maximum)}px`;
    input.style.overflowY = input.scrollHeight > maximum ? "auto" : "hidden";
  }, [draft, maxRows]);
  useEffect(() => {
    setRenderLimit(MODEL_CHUNK);
  }, [openMenu, modelQuery, query]);
  const alignment: PromptMenuAlignment =
    permissionOpen || openMenu === "model" || openMenu === "effort" ? "end" : "start";
  useLayoutEffect(() => {
    const menuElement = permissionOpen ? permissionMenuRef.current : menuRef.current;
    if (!menuElement) return;
    const anchor = permissionOpen
      ? permissionTriggerRef.current
      : token?.kind === openMenu
        ? inputRef.current
        : menuAnchorRef.current?.isConnected
          ? menuAnchorRef.current
          : openMenu === "effort"
            ? effortTriggerRef.current ?? modelTriggerRef.current
            : modelTriggerRef.current;
    const reposition = (recalculatePlacement = false) =>
      positionPromptMenu(anchor, menuElement, alignment, !recalculatePlacement);
    const onWindowScroll = (event: Event) => {
      if (event.target instanceof Node && menuElement.contains(event.target)) return;
      reposition();
    };
    reposition();
    const onResize = () => reposition(true);
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onWindowScroll, true);
    const observer = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => reposition());
    if (observer) {
      if (anchor) observer.observe(anchor);
    }
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onWindowScroll, true);
      observer?.disconnect();
    };
  // Keep the dependency tuple at eight slots so Fast Refresh can update
  // already-mounted instances without tripping React's dependency-size check.
  }, [alignment, filtered.length, modelQuery, openMenu, permissionOpen, query, renderLimit, token?.kind]);
  useEffect(() => {
    if (openMenu !== "model" || filtered.length <= renderLimit) return;
    const menuElement = menuRef.current;
    if (!menuElement) return;
    const onScroll = () => {
      if (menuElement.scrollHeight - menuElement.scrollTop - menuElement.clientHeight < 60) {
        setRenderLimit((limit) => Math.min(limit + MODEL_CHUNK, filtered.length));
      }
    };
    menuElement.addEventListener("scroll", onScroll);
    return () => menuElement.removeEventListener("scroll", onScroll);
  }, [filtered.length, openMenu, renderLimit]);

  const focusInput = () => inputRef.current?.focus({ preventScroll: true });
  const focusRow = (index: number) => {
    if (openMenu === "model" && index >= renderLimit) {
      setRenderLimit(Math.ceil((index + 1) / MODEL_CHUNK) * MODEL_CHUNK);
    }
    requestAnimationFrame(() => {
      const row = rowRefs.current[index];
      row?.focus({ preventScroll: true });
      row?.scrollIntoView?.({ block: "nearest" });
    });
  };

  const onMenuRowKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number, row: MenuRow) => {
    const go = (next: number) => {
      event.preventDefault();
      const wrapped = (next + filtered.length) % filtered.length;
      setActive(wrapped);
      focusRow(wrapped);
    };
    if (event.key === "ArrowDown") go(index + 1);
    else if (event.key === "ArrowUp") go(index - 1);
    else if (event.key === "Home") go(0);
    else if (event.key === "End") go(filtered.length - 1);
    else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      pick(row);
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeMenus();
      focusInput();
    } else if (event.key === "Tab") {
      closeMenus();
    } else if (event.key.length === 1 && /\S/.test(event.key)) {
      const character = event.key.toLowerCase();
      const next = [...filtered.slice(index + 1), ...filtered.slice(0, index + 1)]
        .findIndex((item) => item.name.trim().toLowerCase().startsWith(character));
      if (next >= 0) {
        const absolute = (index + 1 + next) % filtered.length;
        setActive(absolute);
        focusRow(absolute);
      }
    }
  };

  const pick = (row: MenuRow) => {
    if (openMenu === "model") {
      const next = row as PromptBarModel;
      setModelKey(next.key);
      closeMenus();
      latest.current.onModelChange?.(next);
      focusInput();
      return;
    }
    if (openMenu === "mode") {
      const next = row as PromptBarMode;
      setModeKey(next.key);
      closeMenus();
      latest.current.onModeChange?.(next);
      focusInput();
      return;
    }
    const head = token ? draft.slice(0, token.start) : draft;
    if ("attach" in row && row.attach) {
      setDraft(head);
      Promise.resolve(latest.current.onAttach?.(row as PromptBarSource)).then((result) => {
        if (!result) return;
        setAttachments((items) => [...items, ...(Array.isArray(result) ? result : [String(result)])]);
      });
    } else {
      const insertion = "insert" in row && row.insert
        ? row.insert
        : openMenu === "sources"
          ? `@${row.name} `
          : `${row.name} `;
      setDraft(`${head}${insertion}`);
    }
    closeMenus();
    setDismissed(false);
    focusInput();
  };

  const send = () => {
    if ((!canSend && !canSendExtra) || busy) return;
    latest.current.onSend?.(draft.trim(), { attachments, model, effort, mode });
    setDraft("");
    setAttachments([]);
    setDismissed(false);
    closeMenus();
    focusInput();
  };

  const toggleListening = () => {
    if (!latest.current.onDictate) return;
    if (listening) {
      setListening(false);
      return;
    }
    setListening(true);
    Promise.resolve(latest.current.onDictate()).then(
      (text) => {
        setListening(false);
        if (typeof text === "string" && text) {
          setDraft((current) => current.trim() ? `${current.trimEnd()} ${text}` : text);
        }
        focusInput();
      },
      () => setListening(false)
    );
  };

  const onInputKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (openMenu && filtered.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      const next = (cursor + (event.key === "ArrowDown" ? 1 : filtered.length - 1)) % filtered.length;
      setActive(next);
      focusRow(next);
      return;
    }
    if (openMenu && filtered.length && event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      pick(filtered[cursor]);
      return;
    }
    if (event.key === "Escape") {
      if (openMenu || permissionOpen) {
        event.preventDefault();
        setDismissed(true);
        closeMenus();
      }
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  };

  const showMenu = (kind: Exclude<MenuKind, null>, anchor?: HTMLElement | null) => {
    const opening = menu !== kind;
    setDismissed(false);
    setPermissionOpen(false);
    menuAnchorRef.current = anchor ?? (
      kind === "effort" ? effortTriggerRef.current ?? modelTriggerRef.current : null
    );
    setModelQuery("");
    setActive(kind === "model"
      ? Math.max(0, models.findIndex((item) => item.key === model?.key))
      : kind === "mode"
        ? Math.max(0, modes.findIndex((item) => item.key === mode?.key))
        : 0);
    setMenu(opening ? kind : null);
    if (kind === "model" && opening) {
      latest.current.onModelMenuOpened?.();
      requestAnimationFrame(() => searchRef.current?.focus({ preventScroll: true }));
    } else if (opening) {
      focusInput();
    }
  };

  const chooseEffort = (level: string) => {
    setEffort(level);
    latest.current.onEffortChange?.(level);
    closeMenus();
  };

  const renderMenu = () => {
    if (!openMenu) return null;
    return (
      <div
        ref={menuRef}
        className="prompt-bar__menu menu"
        role="menu"
        aria-label={openMenu === "model" ? "Models" : openMenu === "mode" ? "Mode" : openMenu === "effort" ? "Effort" : openMenu === "commands" ? "Commands" : "Sources"}
        data-kind={openMenu}
      >
        {openMenu === "model" ? (
          <div className="prompt-bar__search">
            <input
              ref={searchRef}
              className="prompt-bar__search-input"
              type="search"
              value={modelQuery}
              placeholder="Search models..."
              aria-label="Search models"
              onChange={(event) => {
                setModelQuery(event.target.value);
                setActive(0);
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  const next = (cursor + (event.key === "ArrowDown" ? 1 : filtered.length - 1)) % Math.max(1, filtered.length);
                  setActive(next);
                  focusRow(next);
                } else if (event.key === "Enter" && filtered.length) {
                  event.preventDefault();
                  pick(filtered[cursor]);
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  closeMenus();
                  focusInput();
                }
              }}
            />
          </div>
        ) : null}
        {openMenu === "model" ? (
          model ? (
            <>
            <div className="prompt-bar__model-current">
              <span className="prompt-bar__provider"><ProviderMark model={model} /></span>
              <span className="prompt-bar__current-copy">
                <b>{model.name}</b>
                {model.detail ? <small>{model.detail}</small> : null}
              </span>
              <Icon name="check" className="i chk" />
            </div>
            <button type="button" className="prompt-bar__effort-link" role="menuitem" onClick={(event) => showMenu("effort", effortTriggerRef.current ?? modelTriggerRef.current ?? event.currentTarget)}>
              <span>Effort</span><span className="val">{effort}</span><Icon name="right" />
            </button>
            <hr />
            </>
          ) : null
        ) : null}
        {openMenu === "effort" ? (
          <>
            <div className="prompt-bar__effort-head">
              <span className="prompt-bar__effort-title">Effort</span>
              <span className="prompt-bar__effort-level">{effort}</span>
              <span className="prompt-bar__effort-help" title="Higher effort spends longer reasoning before answering">
                <HugeiconsIcon icon={HelpCircleIcon} size={14} strokeWidth={1.8} />
              </span>
            </div>
            {efforts.map((level) => (
              <button
                type="button"
                key={level}
                role="menuitemradio"
                aria-checked={level === effort}
                className="prompt-bar__row"
                onClick={() => chooseEffort(level)}
              >
                <span className="prompt-bar__row-name">{level}</span>
                {level === effort ? <Icon name="check" className="i chk" /> : null}
              </button>
            ))}
          </>
        ) : null}
        {rows.map((row, index) => {
          const currentModelGroup = openMenu === "model" ? modelCreatorLabel(row as PromptBarModel) : null;
          const previousModelGroup = index > 0 && openMenu === "model" ? modelCreatorId(rows[index - 1] as PromptBarModel) : null;
          const startsGroup = currentModelGroup && currentModelGroup !== previousModelGroup;
          const selected = openMenu === "model" ? row.key === model?.key : openMenu === "mode" ? row.key === mode?.key : false;
          return (
            <Fragment key={row.key}>
              {startsGroup ? <div className="prompt-bar__group hd">{currentModelGroup}</div> : null}
              <button
                type="button"
                ref={(element) => { rowRefs.current[index] = element; }}
                role={openMenu === "mode" || openMenu === "model" ? "menuitemradio" : "menuitem"}
                aria-checked={openMenu === "mode" || openMenu === "model" ? selected : undefined}
                aria-selected={index === cursor}
                tabIndex={-1}
                className="prompt-bar__row"
                onMouseDown={(event) => event.preventDefault()}
                onPointerEnter={(event) => {
                  setActive(index);
                  if (event.pointerType !== "touch") event.currentTarget.focus({ preventScroll: true });
                }}
                onKeyDown={(event) => onMenuRowKeyDown(event, index, row)}
                onClick={() => pick(row)}
              >
                {openMenu === "sources" && hasIcon(row) ? <span className="prompt-bar__row-icon">{renderIcon(row.icon)}</span> : null}
                {openMenu === "model" ? <span className="prompt-bar__provider"><ProviderMark model={row as PromptBarModel} /></span> : null}
                {openMenu === "mode" ? <Icon name={row.key} className="i prompt-bar__mode-icon" /> : null}
                <span className="prompt-bar__row-name">{row.name}</span>
                {hasDescription(row) && row.description ? <span className="prompt-bar__row-desc">{row.description}</span> : null}
                {openMenu === "model" && (row as PromptBarModel).detail ? <span className="prompt-bar__row-detail">{(row as PromptBarModel).detail}</span> : null}
                {openMenu === "model" && (row as PromptBarModel).healthDot ? (
                  <span className="prompt-bar__row-health" data-health={(row as PromptBarModel).healthDot} title={(row as PromptBarModel).healthTitle} />
                ) : null}
                {openMenu === "model" && (row as PromptBarModel).tag ? <span className="prompt-bar__row-tag">{(row as PromptBarModel).tag}</span> : null}
                {selected ? <Icon name="check" className="i chk" /> : null}
              </button>
            </Fragment>
          );
        })}
        {openMenu === "model" && modelsLoading ? (
          <div className="prompt-bar__model-loading" role="status">Loading available models...</div>
        ) : null}
        {openMenu === "model" && modelsSettling && !modelsLoading ? (
          <div className="prompt-bar__model-settling" role="status">More verified models are still loading.</div>
        ) : null}
        {openMenu === "model" && filtered.length > rows.length ? (
          <button type="button" className="prompt-bar__row prompt-bar__more" onClick={() => setRenderLimit((limit) => limit + MODEL_CHUNK)}>
            Show {Math.min(MODEL_CHUNK, filtered.length - renderLimit)} more
          </button>
        ) : null}
        {filtered.length === 0 ? <div className="prompt-bar__empty">{openMenu === "model" && modelsLoading ? "Loading available models..." : "No results found."}</div> : null}
      </div>
    );
  };

  const styleVars = promptStyle as React.CSSProperties;
  return (
    <div
      ref={rootRef}
      className={`prompt-bar${className ? ` ${className}` : ""}`}
      data-state={uiState}
      data-md={mode?.key ?? "ask"}
      data-busy={busy ? "" : undefined}
      data-has-text={draft.trim() ? "" : undefined}
      style={styleVars}
    >
      {typeof document !== "undefined" && (openMenu || permissionOpen) ? createPortal(
        <div
          ref={menuPortalRef}
          className="prompt-bar prompt-bar__floating-layer"
          data-md={mode?.key ?? "ask"}
          style={styleVars}
        >
          {renderMenu()}
          {permissionOpen ? (
            <div ref={permissionMenuRef} className="menu prompt-bar__permission-menu" role="menu" aria-label="Permission">
              {(["Manual", "Auto"] as const).map((level) => (
                <button
                  type="button"
                  key={level}
                  className="prompt-bar__row"
                  role="menuitemradio"
                  aria-checked={permission === level}
                  onClick={() => {
                    setPermission(level);
                    setPermissionOpen(false);
                  }}
                >
                  <span className="prompt-bar__row-name">{level}</span>
                  <span className="prompt-bar__row-desc">{level === "Manual" ? "Ask before each action" : "Run without asking"}</span>
                  {permission === level ? <Icon name="check" className="i chk" /> : null}
                </button>
              ))}
            </div>
          ) : null}
        </div>,
        document.body
      ) : null}
      <div
        className="box prompt-bar__box"
        data-max={draft.split("\n").length >= maxRows ? "" : undefined}
        onClick={(event) => {
          if (event.target === event.currentTarget) focusInput();
        }}
      >
        {uiState === "thinking" ? (
          <div className="status" aria-live="polite">
            <Icon name="spark" className="i spark" />
            {status.tool ? (
              <span className={`tool${status.fading ? " old" : ""}`}>
                <Icon name={status.tool.icon} className="i" />
                <b>{status.tool.verb}</b>
                {status.tool.detail ? <span>{status.tool.detail}</span> : null}
              </span>
            ) : (
              <span className="shim">{statusText}</span>
            )}
            <span className="dots" aria-hidden="true"><i /><i /><i /></span>
            <span className="tm">{elapsedSeconds}s</span>
          </div>
        ) : null}
        {attachments.length > 0 ? (
          <div className="prompt-bar__chips">
            {attachments.map((file, index) => (
              <span key={`${file}-${index}`} className="prompt-bar__chip">
                <HugeiconsIcon icon={File02Icon} size={12} strokeWidth={2} />
                <span className="prompt-bar__chip-name">{file}</span>
                <button type="button" className="prompt-bar__chip-x" aria-label={`Remove ${file}`} onClick={() => setAttachments((items) => items.filter((_, i) => i !== index))}>
                  <HugeiconsIcon icon={Cancel01Icon} size={10} strokeWidth={2.5} />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <div className="rel plus">
          <button
            type="button"
            className="ib"
            aria-label="Add content"
            aria-haspopup="menu"
            aria-expanded={openMenu === "sources"}
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => showMenu("sources", event.currentTarget)}
          >
            <Icon name="plus" />
          </button>
        </div>
        <div className="rel modewrap">
          <button
            type="button"
            className="chip mchip"
            aria-label="Mode"
            aria-haspopup="menu"
            aria-expanded={openMenu === "mode"}
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => showMenu("mode", event.currentTarget)}
          >
            <Icon name={mode?.key ?? "ask"} />
            <span>{mode?.name}</span>
            <Icon name="down" />
          </button>
        </div>
        <textarea
          ref={inputRef}
          className="prompt-bar__input"
          rows={1}
          value={draft}
          placeholder={placeholderText}
          aria-label="Message"
          onChange={(event) => {
            setDraft(event.target.value);
            setDismissed(false);
            setMenu(null);
            setActive(0);
          }}
          onKeyDown={onInputKeyDown}
        />
        <div className="right">
          {onDictate ? (
            <button
              type="button"
              className="ib"
              aria-label={listening ? "Stop dictation" : "Dictate"}
              aria-pressed={listening}
              onMouseDown={(event) => event.preventDefault()}
              onClick={toggleListening}
            >
              <Icon name="mic" />
            </button>
          ) : null}
          <button
            type="button"
            className={`ib send${armed ? " on" : ""}${busy ? " stop" : ""}`}
            disabled={!armed}
            aria-label={busy ? "Stop response" : "Send message"}
            onMouseDown={(event) => event.preventDefault()}
            onPointerDown={(event) => {
              if (event.button === 0 && armed) setPressed(true);
            }}
            onPointerUp={() => setPressed(false)}
            onPointerCancel={() => setPressed(false)}
            onPointerLeave={() => setPressed(false)}
            onClick={() => busy ? latest.current.onStop?.() : send()}
            data-pressed={pressed ? "" : undefined}
          >
            <Icon name={busy ? "stop" : "enter"} />
          </button>
        </div>
      </div>
      <div className="foot">
        {uiState === "initial" && footerProject ? <div className="rel init-only proj">{footerProject}</div> : null}
        {quotaIndicator ? <div className="prompt-bar__quota">{quotaIndicator}</div> : null}
        <div className="rel">
          <button type="button" className="chip prompt-bar__connector" onClick={() => onOpenConnectors?.()} aria-label="Open MCP connectors">
            <Icon name="plug" />
            <span className="cl">MCP</span>
            <Icon name="down" />
          </button>
        </div>
        {(models.length > 0 || efforts.length > 0) ? (
          <div className="rel prompt-bar__model-pill">
            {models.length > 0 ? (
              <button
                type="button"
                className="chip pill prompt-bar__model-trigger"
                ref={modelTriggerRef}
                aria-label="Choose model"
                aria-haspopup="menu"
                aria-expanded={openMenu === "model"}
                onMouseDown={(event) => event.preventDefault()}
                onClick={(event) => showMenu("model", event.currentTarget)}
              >
                {model ? <ProviderMark model={model} /> : null}
                <b>{model?.name}</b>
                <Icon name="down" />
              </button>
            ) : null}
            {efforts.length > 0 ? (
              <button
                type="button"
                className="chip pill prompt-bar__effort-trigger"
                ref={effortTriggerRef}
                aria-haspopup="menu"
                aria-expanded={openMenu === "effort"}
                onMouseDown={(event) => event.preventDefault()}
                onClick={(event) => showMenu("effort", event.currentTarget)}
              >
                <span>{effort}</span>
              </button>
            ) : null}
          </div>
        ) : null}
        {uiState === "initial" ? (
          <div className="rel init-only">
            <button
              ref={permissionTriggerRef}
              type="button"
              className="chip lite"
              aria-haspopup="menu"
              aria-expanded={permissionOpen}
              onClick={() => {
                closeMenus();
                menuAnchorRef.current = null;
                setPermissionOpen(!permissionOpen);
              }}
            >
              <span>{permission}</span><Icon name="down" />
            </button>
          </div>
        ) : null}
        {uiState === "initial" ? (
          <p className="disc">Orplex Agent can make mistakes. Verify important information.</p>
        ) : null}
      </div>
    </div>
  );
}
