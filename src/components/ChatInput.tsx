"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import PromptBar, { type PromptBarMode, type PromptBarModel, type PromptBarSource } from "./PromptBar";
import { useFileProcessor, formatFileSize, getFileIcon } from "@/hooks/useFileProcessor";
import { SKILL_CATEGORIES, type Skill } from "@/lib/skills";
import type { AttachedFile } from "@/hooks/useFileProcessor";
import { Attachment01Icon, SparklesIcon } from "@hugeicons/core-free-icons";
import QuotaIndicator from "./QuotaIndicator";
import WorkspaceSwitcher from "./WorkspaceSwitcher";
import type { AgentMode } from "./ModeSelector";
import { listProviderDefs } from "@/lib/provider-registry";

import { apiFetch } from "@/lib/api-base";
interface ChatInputProps {
  onSend: (text: string, fullContent: string, textFiles: any[], imageFiles: any[], mode: AgentMode, effort?: string, model?: string) => void;
  onStop: () => void;
  loading: boolean;
  agentRunning: boolean;
  isStreaming?: boolean;
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
}

const MODES: (PromptBarMode & { agentMode: AgentMode })[] = [
  { key: "ask", name: "Ask", description: "Simple chat, no file access", agentMode: "ask" },
  { key: "plan", name: "Plan", description: "Analyze codebase, create plan", agentMode: "plan" },
  { key: "code", name: "Code", description: "Edit files, run commands", agentMode: "code" },
];

// Fallback trio shown only if the live catalog can't be fetched. Tagged
// "checking" — NOT verified: these ride the server's failover chain rather
// than a passed probe, and a throttled free tier can leave them silent.
// Honesty beats a pretty picker: once the catalog lands these are replaced.
const FALLBACK_MODELS: PromptBarModel[] = [
  { key: "openai/gpt-oss-120b", name: "GPT-OSS 120B", tag: "Groq", detail: "checking availability…" },
  { key: "qwen/qwen3.8-27b:free", name: "Qwen 3.8 27B", tag: "OpenRouter", detail: "checking availability…" },
  { key: "nvidia/nemotron-3-super-120b-a12b:free", name: "Nemotron Super", tag: "OpenRouter", detail: "checking availability…" },
];

// Registry labels as picker tags, so a new registry provider shows up here
// with zero component changes.
const PROVIDER_TAG: Record<string, string> = Object.fromEntries(
  listProviderDefs().map((d) => [d.id, d.label])
);

// Verified-catalog + recents state (module scope shared hook below).
const LS_RECENTS = "orplex.promptBar.recentModels";

function readRecents(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(LS_RECENTS);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string").slice(0, 8) : [];
  } catch {
    return [];
  }
}

function pushRecent(key: string): string[] {
  const next = [key, ...readRecents().filter((k) => k !== key)].slice(0, 8);
  try {
    window.localStorage.setItem(LS_RECENTS, JSON.stringify(next));
  } catch {}
  return next;
}

const SOURCES: PromptBarSource[] = [
  { key: "files", name: "Files", description: "Upload from this device", icon: Attachment01Icon, attach: true },
  { key: "skills", name: "Skills", description: "100+ prebuilt prompt templates", icon: SparklesIcon, insert: "/" },
];

const PLACEHOLDERS: Record<AgentMode, string> = {
  ask: "Ask anything…",
  plan: "Describe what to analyze or plan…",
  code: "Describe what you want to build or fix…",
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

export default function ChatInput({ onSend, onStop, loading, agentRunning, isStreaming = false, agentMode, onModeChange, onFastAnswer, lastUserMessage, queue = [], onQueueAdd, onQueueRemove, onQueueClear, conversationId, failedModels, clearFailedModels, onRetryModelSwap }: ChatInputProps) {
  const files = useFileProcessor();
  const [busy, setBusy] = useState(false);
  const clearRef = useRef<(() => void) | null>(null);
  const controlsRef = useRef<{ clear: () => void; setText: (t: string) => void } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // === Verified model catalog (fetched when the model menu opens) + recents ===
  const [catalogModels, setCatalogModels] = useState<PromptBarModel[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [recents, setRecents] = useState<string[]>(() => readRecents());
  // Mirror for use inside loadCatalog's closure without re-creating it.
  const userModelsRef = useRef<PromptBarModel[]>([]);
  const catalogInFlight = useRef(false);
  // BYOK models (from the user's stored keys' model listings) + the keys
  // revision marker that tells us when to refetch (new/removed keys).
  const [userModels, setUserModels] = useState<PromptBarModel[]>([]);
  const keysRevRef = useRef<string>("");

  const loadCatalog = useCallback(() => {
    if (catalogInFlight.current) return;
    catalogInFlight.current = true;
    setCatalogLoading(true);
    const finish = () => {
      catalogInFlight.current = false;
      setCatalogLoading(false);
    };
    const tryFetch = (attempt: number) => {
      apiFetch("/api/models/available")
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((j: {
          success?: boolean;
          models?: { id: string; name: string; provider: string; contextWindow?: number; free?: boolean }[];
          health?: Record<string, { health?: "green" | "amber"; lastVerifiedAt?: string; probeLatencyMs?: number }>;
          coldModelIds?: string[];
          userModels?: { id: string; name: string; provider: string; contextWindow?: number; free?: boolean }[];
          keysRev?: string;
        }) => {
          // Picker contract: ONLY models proven to answer are rendered.
          //  - throttledModels are never sent by the picker endpoint anymore
          //    (they never replied to a probe — the old "throttled" tag rows
          //    were exactly the dead-feeling picks being reported);
          //  - cold models (probe timed out on NVIDIA build.farm warm-up) are
          //    hidden here and woken by the background engine — once a wake
          //    probe answers, the model lands here WITHOUT the cold flag and
          //    appears on the next fetch.
          const coldIds = new Set(j.coldModelIds ?? []);
          const health = j.health ?? {};
          const list = (j.models ?? [])
            .filter((m) => !coldIds.has(m.id))
            .map((m) => ({
              key: m.id,
              name: m.name || m.id,
              tag: PROVIDER_TAG[m.provider] || m.provider,
              // Probe health dot: green = answered <24h ago; amber = proof of
              // life has aged out. Latency (when known) rides in the tooltip.
              healthDot: health[m.id]?.health ?? "amber",
              healthTitle: health[m.id]?.lastVerifiedAt
                ? `Last verified ${new Date(health[m.id].lastVerifiedAt!).toLocaleString()}${
                    health[m.id].probeLatencyMs ? ` · probe ${(health[m.id].probeLatencyMs! / 1000).toFixed(1)}s` : ""
                  }`
                : undefined,
              detail: [
                m.free ? "free" : undefined,
                m.contextWindow ? `${Math.round(m.contextWindow / 1024)}k` : undefined,
              ]
                .filter(Boolean)
                .join(" · ") || undefined,
            }));
          const userList = (j.userModels ?? []).map((m) => ({
            key: m.id,
            name: m.name || m.id,
            tag: PROVIDER_TAG[m.provider] || m.provider,
            detail: ["🔑", m.free ? "free" : undefined, m.contextWindow ? `${Math.round(m.contextWindow / 1024)}k` : undefined]
              .filter(Boolean)
              .join(" "),
          }));
          // New/changed keys invalidate the memo → merge the fresh BYOK list.
          const rev = j.keysRev ?? "";
          if (rev !== keysRevRef.current || userList.length !== userModelsRef.current.length) {
            keysRevRef.current = rev;
            setUserModels(userList);
            userModelsRef.current = userList;
          }
          if (list.length > 0) {
            setCatalogModels(list);
            finish();
            return;
          }
          // The server answers instantly but returns an empty list while its
          // probe sweep runs in the background — keep polling until the real
          // catalog lands (a full sweep can take ~10 minutes). Every poll
          // re-kicks the sweep in case the server cold-started without one.
          if (attempt < 120) {
            apiFetch("/api/models/warm", { method: "POST" }).catch(() => {});
            window.setTimeout(() => tryFetch(attempt + 1), 5000);
          } else finish();
        })
        .catch(() => {
          // Network/auth hiccup: a few retries, then keep the fallback list.
          if (attempt < 3) window.setTimeout(() => tryFetch(attempt + 1), 5000);
          else finish();
        });
    };
    tryFetch(0);
  }, []);

  // Verified models first, then BYOK models the user can reach with their
  // own keys, deduped by id (a BYOK listing proves the same id the platform
  // catalog verified — keep the verified row's tag).
  const models = (() => {
    if (catalogModels.length === 0) return userModels.length > 0 ? userModels : FALLBACK_MODELS;
    if (userModels.length === 0) return catalogModels;
    const seen = new Set(catalogModels.map((m) => m.key));
    return [...catalogModels, ...userModels.filter((m) => !seen.has(m.key) && seen.add(m.key))];
  })();
  const recentModels: PromptBarModel[] = recents
    .map((key) => models.find((m) => m.key === key))
    .filter((m): m is PromptBarModel => !!m);

  // Restored picker state — recomputed when the conversation changes so each
  // chat gets its own last-used model/effort (falling back to the global
  // last-used values).
  const [pickerState, setPickerState] = useState<PickerState>(() => loadPickers(conversationId));
  useEffect(() => {
    setPickerState(loadPickers(conversationId));
  }, [conversationId]);

  const isWorking = loading || agentRunning || busy;

  const handleSkillSelected = useCallback((skill: Skill) => {
    const prefix = `${skill.promptPrefix}\n\n`;
    controlsRef.current?.setText(prefix);
  }, []);

  const emit = (msg: string, textFiles: AttachedFile[], imageFiles: { name: string; dataUrl: string; size: number }[], mode: AgentMode, effort?: string, model?: string) => {
    let contentWithFiles = msg;
    if (textFiles.length > 0) {
      const fileBlocks = textFiles.map((f) =>
        `\n\n---\n**File: \`${f.name}\`** (${formatFileSize(f.size)})\n\`\`\`\n${f.content}\n\`\`\``
      ).join("");
      contentWithFiles = msg + fileBlocks;
    }
    onSend(msg, contentWithFiles, textFiles, imageFiles, mode, effort, model);
  };

  const buildContent = (draft: string, textFiles: AttachedFile[]) => {
    if (textFiles.length === 0) return draft;
    const fileBlocks = textFiles.map((f) =>
      `\n\n---\n**File: \`${f.name}\`** (${formatFileSize(f.size)})\n\`\`\`\n${f.content}\n\`\`\``
    ).join("");
    return draft + fileBlocks;
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
    const model = await swapForRetry(meta.model);
    emit(msg, textFiles, imageFiles, mode, meta.effort?.toLowerCase(), model?.key);
    files.clearFiles();
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
          const { readFileAsDataUrl } = await import("@/lib/file-utils");
          try {
            const dataUrl = await readFileAsDataUrl(file);
            const ext = file.type.split("/")[1] || "png";
            files.addFiles([
              { name: `pasted-image.${ext}`, content: "", size: file.size, type: "image", dataUrl },
            ]);
          } catch {}
          return;
        }
      }
    };
    document.addEventListener("paste", handlePaste);
    return () => document.removeEventListener("paste", handlePaste);
  }, [files]);

  return (
    <div className="chat-input-bar">
      <div className="chat-input-inner">
        <div className="ws-switcher-row">
          <WorkspaceSwitcher />
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
        <div className="chat-input-wrapper prompt-bar-wrapper">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={async (e) => {
              const fileList = e.target.files;
              if (!fileList || fileList.length === 0) return;
              const { processFileList } = await import("@/lib/file-utils");
              const picked = await processFileList(fileList);
              if (picked.length > 0) files.addFiles(picked);
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
            commands={SKILL_CATEGORIES.flatMap((c) => c.skills.map((s) => ({ key: s.id, name: `/${s.name}`, description: s.description, insert: s.promptPrefix })))}
            models={models}
            recentModels={recentModels}
            modelsLoading={catalogLoading}
            onModelMenuOpened={loadCatalog}
            defaultModel={pickerState.modelKey ?? models[0].key}
            efforts={["Low", "Medium", "High"]}
            defaultEffort={pickerState.effort
              ? pickerState.effort.charAt(0).toUpperCase() + pickerState.effort.slice(1)
              : "Medium"}
            onModelChange={(m) => {
              const next = { ...pickerState, modelKey: m.key };
              setPickerState(next);
              savePickers(conversationId, next);
              setRecents(pushRecent(m.key));
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
            onAttach={() => { fileInputRef.current?.click(); }}
            onRegisterClear={(fn) => { clearRef.current = fn; }}
            onRegisterControls={(c) => { controlsRef.current = c; }}
            className="prompt-bar--chat"
          />
        </div>
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
  );
}
