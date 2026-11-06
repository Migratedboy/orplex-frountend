"use client";

/* eslint-disable @next/next/no-img-element -- Attachment thumbnails are data: URLs, which next/image does not support at all. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useToast } from "./Toast";
import PromptBar, { type PromptBarMode, type PromptBarModel, type PromptBarSource } from "./PromptBar";
import { useFileProcessor, formatFileSize, getFileIcon } from "@/hooks/useFileProcessor";
import { SKILL_CATEGORIES, type Skill } from "@/lib/skills";
import ConnectorsPanel from "./ConnectorsPanel";
import { IconMcp } from "./Icons";
import type { AttachedFile } from "@/hooks/useFileProcessor";
import { Attachment01Icon, SparklesIcon } from "@hugeicons/core-free-icons";
import QuotaIndicator from "./QuotaIndicator";
import WalkingMascot from "./WalkingMascot";
import WorkspaceSwitcher from "./WorkspaceSwitcher";
import { QuickActions } from "./ui";
import type { AgentMode } from "./ModeSelector";
import { getConversation } from "@/lib/conversations-transport";
import { pushRecent, useModelCatalog } from "@/hooks/useModelCatalog";

import { apiFetch } from "@/lib/api-base";
interface ChatInputProps {
  onSend: (text: string, fullContent: string, textFiles: any[], imageFiles: any[], mode: AgentMode, effort?: string, model?: string) => void;
  onStop: () => void;
  loading: boolean;
  agentRunning: boolean;
  isStreaming?: boolean;
  /**
   * True for the WHOLE turn — streaming, tool running, AND the paused states
   * (awaiting_approval / waiting_for_input) where the composer stays typeable
   * and isWorking therefore blinks false. The follow-up chips generate ONLY on
   * this signal's true→false edge (the AI's response fully complete), never on
   * an isWorking flicker mid-run. Falls back to isWorking when absent.
   */
  turnActive?: boolean;
  agentMode: AgentMode;
  onModeChange: (mode: AgentMode) => void;
  onFastAnswer?: (userMessage: string) => void;
  lastUserMessage?: string;
  queue?: { id: string; text: string; addedAt: number; model?: string }[];
  onQueueAdd?: (text: string, fullContent: string, textFiles: any[], imageFiles: any[], mode: AgentMode, model?: string, effort?: string) => void;
  onQueueRemove?: (id: string) => void;
  onQueueClear?: () => void;
  /** Active conversation id — scopes picker persistence per chat */
  conversationId?: string | null;
  /** Models that failed in THIS conversation (most recent first) — arms the one-shot auto-retry swap. */
  failedModels?: string[];
  /** Clears the failure trail after the composer consumed it (one-shot). */
  clearFailedModels?: () => void;
  /** Re-arms the picker with the swapped model (persists per conversation). */
  onRetryModelSwap?: (nextModelId: string, failedModelIds: string[]) => void;
  /** True after the user pressed Stop — the composer acknowledges it without
   *  blocking the next send (the input stays live). */
  stopped?: boolean;
}

/**
 * Static, hoisted to module scope. These were inline JSX expressions, so a
 * fresh array of ~100 command objects and a fresh efforts array were built on
 * EVERY ChatInput render. `commands` is a dependency of PromptBar's `filtered`
 * memo, which feeds `list`, which feeds the scroll-into-view layout effect —
 * so the model menu scrolled on every parent render while open.
 */
const SKILL_COMMANDS = SKILL_CATEGORIES.flatMap((c) =>
  c.skills.map((s) => ({ key: s.id, name: `/${s.name}`, description: s.description, insert: s.promptPrefix }))
);
const EFFORT_TIERS = ["Low", "Medium", "High"];

const MODES: (PromptBarMode & { agentMode: AgentMode })[] = [
  { key: "ask", name: "Ask", description: "Simple chat, no file access", agentMode: "ask" },
  { key: "plan", name: "Plan", description: "Analyze codebase, create plan", agentMode: "plan" },
  { key: "code", name: "Code", description: "Edit files, run commands", agentMode: "code" },
];


const SOURCES: PromptBarSource[] = [
  { key: "files", name: "Files", description: "Upload from this device", icon: Attachment01Icon, attach: true },
  { key: "skills", name: "Skills", description: "100+ prebuilt prompt templates", icon: SparklesIcon, insert: "/" },
  { key: "mcp", name: "MCP servers", description: "Connect Supabase, Vercel, Figma, GitHub…", icon: <IconMcp size={16} />, attach: true },
];

const PLACEHOLDERS: Record<AgentMode, string> = {
  ask: "Ask anything…",
  plan: "Describe what to analyze or plan…",
  code: "Describe what you want to build or fix…",
};

const QUICK_ACTION_PROMPTS: Record<string, string> = {
  "fix-bugs": "Fix bugs in the current project",
  "add-tests": "Add tests for the current project",
  optimize: "Optimize the current project",
  export: "Export the project as a .zip",
  regenerate: "Regenerate the last response",
};

// --- Picker persistence -----------------------------------------------------
// Global last-used model/effort (survives reloads) + a per-conversation map
// (switching chats restores that chat's last-used level). Stored in
// localStorage — the composer is browser-local state.
const LS_LAST = "orplex.promptBar.last";
const LS_PER_CONVO = "orplex.promptBar.perConvo";

function readJSON<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJSON(key: string, value: unknown) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

export interface PickerState {
  modelKey?: string;
  effort?: string;
}

function loadPickers(conversationId: string | null | undefined): PickerState {
  if (conversationId) {
    const perConvo = readJSON<Record<string, PickerState>>(LS_PER_CONVO, {});
    const saved = perConvo[conversationId];
    if (saved) return saved;
  }
  return readJSON<PickerState>(LS_LAST, {});
}

function savePickers(conversationId: string | null | undefined, state: PickerState) {
  writeJSON(LS_LAST, state);
  if (conversationId) {
    const perConvo = readJSON<Record<string, PickerState>>(LS_PER_CONVO, {});
    perConvo[conversationId] = state;
    // Keep the map bounded — 50 most recent conversations.
    const keys = Object.keys(perConvo);
    if (keys.length > 50) {
      delete perConvo[keys[0]];
    }
    writeJSON(LS_PER_CONVO, perConvo);
  }
}

/**
 * Imperative bridge for files attached OUTSIDE the composer (drag-and-drop
 * onto the page). The composer owns its attachment list internally, so the
 * page-level drop zone has no other way in — same pattern as the artifact and
 * memory panel bridges in AppLayout.
 */
export const droppedFilesBridge: { add: ((files: AttachedFile[]) => void) | null } = { add: null };

export default function ChatInput({ onSend, onStop, loading, agentRunning, isStreaming = false, turnActive, agentMode, onModeChange, onFastAnswer, lastUserMessage, queue = [], onQueueAdd, onQueueRemove, onQueueClear, conversationId, failedModels, clearFailedModels, onRetryModelSwap, stopped = false }: ChatInputProps) {
  const files = useFileProcessor();
  // Publish the attach bridge (page-level drag-and-drop) and release it on unmount.
  useEffect(() => {
    droppedFilesBridge.add = files.addFiles;
    return () => {
      droppedFilesBridge.add = null;
    };
  }, [files.addFiles]);
  const [busy, setBusy] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  const clearRef = useRef<(() => void) | null>(null);
  const controlsRef = useRef<{ clear: () => void; setText: (t: string) => void } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  // === Verified model catalog + picker list (hook: src/hooks/useModelCatalog.ts) ===
  // The catalog engine (retry loop, serverless rescue, defaults merge, wake
  // promotions, recents) moved out of this component verbatim. The picker list
  // and its loading states are the hook's return values. chatInput keeps its
  // own toastRef (pasted-image / attachment errors below) — the hook mirrors
  // toast internally for provider-issue toasts.
  const { toast } = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const {
    models,
    recents,
    setRecents,
    catalogLoading,
    showBlockingSpinner,
    loadCatalog,
  } = useModelCatalog(toast);

  // --- AI follow-up chips (QuickActions) --------------------------------------
  // The chips above the composer are AI-generated from the live transcript and
  // refreshed after EVERY finished message (isWorking true→false edge below).
  // `aiSuggestions.length === 0` keeps the static utility chips — offline /
  // cold endpoint / brand-new chat never blanks the bar.
  const [aiSuggestions, setAiSuggestions] = useState<string[]>([]);
  // True while /api/chat/suggestions is generating — the chips show a 3-dot
  // wave loader in place of the text until the answer lands.
  const [aiSuggestionsLoading, setAiSuggestionsLoading] = useState(false);
  const suggestionsBusyRef = useRef(false);
  const fetchSuggestions = useCallback(async () => {
    if (suggestionsBusyRef.current) return;
    suggestionsBusyRef.current = true;
    try {
      // Anchor turn: last 6 turns from the open conversation when we have one,
      // else the just-sent user message (New Chat before the run produced an id).
      let messages: { role: "user" | "assistant"; content: string }[] = [];
      if (conversationId) {
        const convo = await getConversation(conversationId).catch(() => null);
        const all = convo?.messages ?? [];
        for (let i = all.length - 1; i >= 0 && messages.length < 6; i--) {
          const m = all[i];
          const role = m?.role === "assistant" ? "assistant" : m?.role === "user" ? "user" : null;
          const content = typeof m?.content === "string" ? m.content.trim() : "";
          if (role && content) messages.unshift({ role, content: content.slice(0, 600) });
        }
      }
      if (messages.length === 0 && lastUserMessage) {
        messages = [{ role: "user", content: lastUserMessage.slice(0, 600) }];
      }
      if (messages.length === 0) return;
      setAiSuggestionsLoading(true);
      const r = await apiFetch("/api/chat/suggestions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages }),
      });
      if (!r.ok) return;
      const j = (await r.json()) as { suggestions?: unknown };
      if (Array.isArray(j.suggestions)) {
        setAiSuggestions(
          j.suggestions.filter((s): s is string => typeof s === "string" && s.trim().length > 0).slice(0, 5)
        );
      }
    } catch {
      // Keep whatever chips are showing.
    } finally {
      suggestionsBusyRef.current = false;
      setAiSuggestionsLoading(false);
    }
  }, [conversationId, lastUserMessage]);

  const recentModels: PromptBarModel[] = useMemo(
    () => recents.map((key) => models.find((m) => m.key === key)).filter((m): m is PromptBarModel => !!m),
    [recents, models]
  );

  // Restored picker state — recomputed when the conversation changes so each
  // chat gets its own last-used model/effort (falling back to the global
  // last-used values).
  const [pickerState, setPickerState] = useState<PickerState>(() => loadPickers(conversationId));
  useEffect(() => {
    setPickerState(loadPickers(conversationId));
  }, [conversationId]);

  const isWorking = loading || agentRunning || busy;
  // The chips + bar live on the TURN lifecycle, not the composer's: awaited
  // approvals pause the run without ending the turn, and isWorking blinks
  // false during them (the composer stays typeable on purpose). turnActive
  // covers every active task state, so its true→false edge can only mean the
  // AI's response is fully complete.
  const turnLive = turnActive ?? isWorking;

  // Turn just ended (turnActive true→false): refresh the AI chips. The busy
  // ref inside fetchSuggestions collapses concurrent edges.
  const prevTurnRef = useRef(turnLive);
  useEffect(() => {
    const was = prevTurnRef.current;
    prevTurnRef.current = turnLive;
    if (was && !turnLive) void fetchSuggestions();
  }, [turnLive, fetchSuggestions]);

  const handleSkillSelected = useCallback((skill: Skill) => {
    const prefix = `${skill.promptPrefix}\n\n`;
    controlsRef.current?.setText(prefix);
  }, []);

  // Archives carry no inline text — inlining them produced an empty code
  // fence. They are still passed through so the send path can persist them
  // locally and hand the model a real path for extract_archive.
  const inlineBlocks = (textFiles: AttachedFile[]) =>
    textFiles
      .filter((f) => f.type !== "archive")
      .map(
        (f) =>
          `\n\n---\n**File: \`${f.name}\`** (${formatFileSize(f.size)})\n\`\`\`\n${f.content}\n\`\`\``
      )
      .join("");

  const emit = (msg: string, textFiles: AttachedFile[], imageFiles: { name: string; dataUrl: string; size: number }[], mode: AgentMode, effort?: string, model?: string) => {
    const contentWithFiles = msg + inlineBlocks(textFiles);
    onSend(msg, contentWithFiles, textFiles, imageFiles, mode, effort, model);
  };

  const buildContent = (draft: string, textFiles: AttachedFile[]) => {
    if (textFiles.length === 0) return draft;
    return draft + inlineBlocks(textFiles);
  };

  // === One-shot auto-retry model swap ===================================
  // A failed conversation carries its failed-model ids (useChatSession
  // records them per conversation, most recent first). The swap arms only
  // when the model about to be sent IS the one that failed (bare-id match:
  // "vendor/x" ≡ "vendor/x:free") — a model the user deliberately re-picked
  // is never overridden. It fires ONCE: the trail is cleared immediately,
  // and any later failure re-arms it with that model. With no catalog
  // (offline / still sweeping) the swap silently doesn't happen; the
  // server's sibling-id failover still applies.
  const pendingFailed = failedModels ?? [];
  const consumeFailure = useRef(false);
  const bareKey = (s: string) => s.replace(/:free$/, "");
  if (pendingFailed.length > 0) {
    const armed = pickerState.modelKey;
    consumeFailure.current = !!armed && bareKey(armed) === bareKey(pendingFailed[0]);
  }
  const swapForRetry = async (picked: PromptBarModel | undefined): Promise<PromptBarModel | undefined> => {
    if (!consumeFailure.current || pendingFailed.length === 0) return picked;
    consumeFailure.current = false;
    clearFailedModels?.();
    const currentKey = picked?.key ?? pickerState.modelKey;
    try {
      const { pickRetryModel } = await import("@/lib/model-catalog");
      const nextId = await pickRetryModel(pendingFailed, currentKey);
      if (!nextId) return picked; // nothing verified beyond the failed set — keep the pick
      const next = models.find((m) => m.key === nextId);
      if (!next) return picked;
      // Re-arm the picker + persist per conversation so the WHOLE task runs
      // on the replacement (a mid-run provider swap isn't possible).
      setPickerState({ ...pickerState, modelKey: next.key });
      savePickers(conversationId, { ...pickerState, modelKey: next.key });
      setRecents(pushRecent(next.key));
      onRetryModelSwap?.(next.key, pendingFailed);
      return next;
    } catch {
      return picked;
    }
  };

  const metaToSend = async (text: string, meta: { mode?: PromptBarMode; effort?: string; model?: PromptBarModel }) => {
    const msg = text.trim();
    const textFiles = files.getTextFiles();
    const imageFiles = files.getImageFiles().map((f) => ({ name: f.name, dataUrl: f.dataUrl!, size: f.size }));
    if (!msg && textFiles.length === 0 && imageFiles.length === 0) return;
    const mode: AgentMode = (MODES.find((m) => m.key === meta.mode?.key)?.agentMode ?? agentMode);
    // Clear BEFORE the await. swapForRetry can await a dynamic import of
    // model-catalog (hundreds of ms on a cold chunk, seconds on first load
    // after boot) and nothing disables the attach button, the file input or the
    // paste listener meanwhile — so anything attached in that window was
    // dropped by clearFiles() after the send had already snapshotted the file
    // list, and the chip vanished with no indication it had ever been added.
    files.clearFiles();
    const model = await swapForRetry(meta.model);
    emit(msg, textFiles, imageFiles, mode, meta.effort?.toLowerCase(), model?.key);
    clearRef.current?.();
  };

  const handleQueue = () => {
    if (!onQueueAdd) return;
    const draft = (document.querySelector<HTMLTextAreaElement>(".prompt-bar__input")?.value ?? "").trim();
    const textFiles = files.getTextFiles();
    const imageFiles = files.getImageFiles().map((f) => ({ name: f.name, dataUrl: f.dataUrl!, size: f.size }));
    if (!draft && !files.hasFiles) return;

    // Effort rides along so the replayed prompt runs at the level the user
    // picked (it used to be silently dropped on dequeue).
    onQueueAdd(draft, buildContent(draft, textFiles), textFiles, imageFiles, agentMode, pickerState.modelKey, pickerState.effort);
    files.clearFiles();
    clearRef.current?.();
  };

  // Model picks made in the TopBar model switcher land here — keep the
  // composer's picker (and its per-conversation persistence) in sync.
  useEffect(() => {
    const onModelChanged = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      if (!id || pickerState.modelKey === id) return;
      const next = { ...pickerState, modelKey: id };
      setPickerState(next);
      savePickers(conversationId, next);
      setRecents(pushRecent(id));
    };
    window.addEventListener("orplex:model-changed", onModelChanged);
    return () => window.removeEventListener("orplex:model-changed", onModelChanged);
    // setRecents is a useState setter (stable) returned by useModelCatalog —
    // listing it cannot change the effect's firing pattern.
  }, [pickerState, conversationId, setRecents]);

  // Skills → insert prompt prefix into the bar (dispatched by legacy popups)
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<Skill>).detail;
      if (detail) handleSkillSelected(detail);
    };
    window.addEventListener("orplex:skill-selected", handler);
    return () => window.removeEventListener("orplex:skill-selected", handler);
  }, [handleSkillSelected]);

  // Image paste → attach as image chip (text pastes flow inline into the bar)
  useEffect(() => {
    const handlePaste = async (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of Array.from(items)) {
      if (item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (!file) continue;
        e.preventDefault();
        // Same 10MB ceiling the attach button enforces via MAX_IMAGE_SIZE.
        // Paste bypassed it entirely, so pasting a huge screenshot built a
        // multi-megabyte data URL in memory and shipped it straight to the
        // provider, where it is rejected as an oversized request.
        const { MAX_IMAGE_SIZE } = await import("@/lib/file-utils");
        if (file.size > MAX_IMAGE_SIZE) {
          toastRef.current(`That image is too large (max ${formatFileSize(MAX_IMAGE_SIZE)})`, "error");
          return;
        }
        const { readFileAsDataUrl } = await import("@/lib/file-utils");
        try {
          const dataUrl = await readFileAsDataUrl(file);
          const ext = file.type.split("/")[1] || "png";
          files.addFiles([
            { name: `pasted-image.${ext}`, content: "", size: file.size, type: "image", dataUrl },
          ]);
        } catch {
          toastRef.current("Could not read the pasted image", "error");
        }
        return;
        }
      }
    };
    document.addEventListener("paste", handlePaste);
    return () => document.removeEventListener("paste", handlePaste);
  }, [files]);

  // The composer floats over the message list, so the list's bottom padding,
  // the run cards' clearance, and the empty-state hero all reserve the bar's
  // height via --composer-h. Publish the measured height (and keep it in sync
  // as chips, the queue, or extra input lines grow the bar) so that clearance
  // is exact rather than a guess.
  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const root = document.documentElement;
    const apply = () => root.style.setProperty("--composer-h", `${Math.round(el.getBoundingClientRect().height)}px`);
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.style.removeProperty("--composer-h");
    };
  }, []);

  return (
    <>
    <div className="chat-input-bar" ref={barRef}>
      <div className="chat-input-inner">
        <div className="ws-switcher-row">
          <WorkspaceSwitcher />
          <button
            type="button"
            className="mcp-chip"
            aria-label="MCP connectors"
            title="MCP connectors — Supabase, Vercel, Figma, GitHub…"
            onClick={() => setMcpOpen(true)}
          >
            <IconMcp size={14} />
            <span className="mcp-chip-label">MCP</span>
          </button>
        </div>
        {files.hasFiles && (
          <div className="file-chips">
            {files.attachedFiles.map((f, i) => (
              <div key={i} className={`file-chip ${f.type === "image" ? "file-chip-image" : ""} ${f.name.startsWith("pasted-") ? "file-chip-pasted" : ""}`}>
                {f.type === "image" && f.dataUrl ? (
                  <img src={f.dataUrl} alt={f.name} className="file-chip-thumb" />
                ) : (
                  <span className="file-chip-icon">{getFileIcon(f.name)}</span>
                )}
                <div className="file-chip-info">
                  <span className="file-chip-name">{f.name}</span>
                  {f.name.startsWith("pasted-") && f.content ? (
                    <span className="file-chip-preview">{f.content.slice(0, 80)}{f.content.length > 80 ? "…" : ""}</span>
                  ) : (
                    <span className="file-chip-size">({formatFileSize(f.size)})</span>
                  )}
                </div>
                <button onClick={() => files.removeFile(i)} className="file-chip-remove">&times;</button>
              </div>
            ))}
          </div>
        )}
        <QuickActions
          onAction={(action) => {
            controlsRef.current?.setText(QUICK_ACTION_PROMPTS[action] ?? action);
            document.querySelector<HTMLTextAreaElement>(".prompt-bar__input")?.focus();
          }}
          hasFiles={files.hasFiles}
          isRunning={turnLive}
          suggestions={aiSuggestions}
          loadingSuggestions={aiSuggestionsLoading}
        />
        <div className="chat-input-wrapper prompt-bar-wrapper" style={{ position: "relative" }}>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={async (e) => {
              const fileList = e.target.files;
              if (!fileList || fileList.length === 0) return;
      const { processFileListDetailed } = await import("@/lib/file-utils");
      const { picked, rejected } = await processFileListDetailed(fileList);
      if (picked.length > 0) files.addFiles(picked);
      // Never swallow a refusal: a file that vanished with no message is what
      // made "the AI ignores my files" look like a model problem.
      for (const r of rejected) {
        toastRef.current(`Skipped ${r.name} — ${r.reason}`, "error");
      }
              if (fileInputRef.current) fileInputRef.current.value = "";
            }}
          />
          {isWorking && onQueueAdd && (
            <button className="chat-queue-btn" title="Queue this prompt" aria-label="Queue next prompt" onClick={handleQueue}>
              <span style={{ fontSize: 11, fontWeight: 600 }}>Q</span>
            </button>
          )}
          <PromptBar
            placeholder={PLACEHOLDERS[agentMode]}
            modes={MODES}
            defaultMode={agentMode}
            sources={SOURCES}
            commands={SKILL_COMMANDS}
            models={models}
            recentModels={recentModels}
            modelsLoading={showBlockingSpinner}
        modelsSettling={catalogLoading && !showBlockingSpinner}
            onModelMenuOpened={loadCatalog}
            defaultModel={pickerState.modelKey ?? models[0].key}
            efforts={EFFORT_TIERS}
            defaultEffort={pickerState.effort
              ? pickerState.effort.charAt(0).toUpperCase() + pickerState.effort.slice(1)
              : "Medium"}
            onModelChange={(m) => {
              const next = { ...pickerState, modelKey: m.key };
              setPickerState(next);
              savePickers(conversationId, next);
              setRecents(pushRecent(m.key));
              window.dispatchEvent(new CustomEvent("orplex:model-changed", { detail: m.key }));
            }}
            onEffortChange={(level) => {
              const next = { ...pickerState, effort: level.toLowerCase() };
              setPickerState(next);
              savePickers(conversationId, next);
            }}
            busy={isWorking}
            onSend={metaToSend}
            onModeChange={(m) => {
              const am = MODES.find((x) => x.key === m.key)?.agentMode;
              if (am) onModeChange(am);
            }}
            onStop={() => { onStop(); setBusy(false); }}
            onAttach={(source) => {
              if (source.key === "mcp") {
                setMcpOpen(true);
                return;
              }
              fileInputRef.current?.click();
            }}
            onRegisterClear={(fn) => { clearRef.current = fn; }}
            onRegisterControls={(c) => { controlsRef.current = c; }}
            className="prompt-bar--chat"
          />
          {/* Fresh-chat patrol: until the first user message lands, the mascot
              walks the border of the prompt bar (WalkingMascot.tsx). */}
          {!lastUserMessage && <WalkingMascot />}
        </div>
        {stopped && !isWorking && (
          <div className="chat-stop-note" role="status">
            <span className="ms ms-sm" aria-hidden="true">stop_circle</span>
            <span>Stopped</span>
            <span className="chat-stop-note-hint">Send again to continue</span>
          </div>
        )}
        {queue.length > 0 && (
          <div className="queue-indicator">
            <div className="queue-header">
              <span className="queue-count"><span className="ms ms-sm">format_list_bulleted</span> Queue ({queue.length})</span>
              <button className="queue-clear-btn" onClick={onQueueClear}>Clear all</button>
            </div>
            <div className="queue-list">
              {queue.map((item, i) => (
                <div key={item.id} className="queue-item">
                  <span className="queue-item-drag" title="Drag to reorder">⋮⋮</span>
                  <span className="queue-item-num">{i + 1}</span>
                  <div className="queue-item-content">
                    <span className="queue-item-text">{item.text.slice(0, 60)}{item.text.length > 60 ? "…" : ""}</span>
                    <span className="queue-item-meta">
                      {item.text.length} chars • added {new Date(item.addedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </span>
                  </div>
                  <button className="queue-item-remove" onClick={() => onQueueRemove?.(item.id)} title="Remove from queue">×</button>
                </div>
              ))}
            </div>
          </div>
        )}
        <QuotaIndicator />
        <p className="chat-disclaimer">Orplex Agent can make mistakes. Verify important information.</p>
        {onFastAnswer && lastUserMessage && isStreaming && (
          <div className="fast-answer-bar">
            <button
              className="fast-answer-btn"
              onClick={() => onFastAnswer(lastUserMessage)}
              title="Get a quick answer from a faster model"
            >
              <span>Answer Now</span>
              <span className="fast-answer-hint">— quick reply from a faster model</span>
            </button>
          </div>
        )}
      </div>
    </div>
    {/* The connectors dialog is a fixed, full-screen overlay. The bar now
        carries a backdrop-filter, which would make the bar the containing
        block for that overlay (clamping it to the composer) — so it renders
        as a sibling of the bar instead. Same tree depth for the rest of the
        app, and the bar's filtered box never contains a fixed layer. */}
    <ConnectorsPanel open={mcpOpen} onClose={() => setMcpOpen(false)} />
    </>
  );
}
