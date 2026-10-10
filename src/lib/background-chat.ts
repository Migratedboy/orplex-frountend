// background-chat.ts — Global singleton chat store
// Survives page navigation — the tool-calling loop keeps running in the background
// When the user returns to the chat page, the UI reattaches and shows current state

import { trackTaskStart, trackTaskEnd } from "./run-sync";
import { normalizeThinkingBlocks } from "./stream-reader";
import { clearPlanLatch } from "./plan-gate";

// === Types ===

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  time: string;
}

export type TaskStatus = "idle" | "streaming" | "tool_executing" | "awaiting_approval" | "waiting_for_input" | "done" | "error";

export interface BackgroundTask {
  id: string;
  conversationId: string | null;
  userMessage: string;
  messages: ChatMessage[];
  displayContent: string;
  status: TaskStatus;
  statusDetail: string;
  error?: string;
  startedAt: number;
  completedAt?: number;
  todos: TodoItem[];
  question: PendingQuestion | null;
  /** Clarifications asked this run — powers the ">2 = rephrase" hint on the card. */
  clarificationCount?: number;
  /** Rendered scratchpad block mirror for the Scratch panel (UI-only). */
  scratchpad?: string;
  /** True when the user pressed Stop — worker must exit without failing */
  aborted?: boolean;
  /** Aggregate outcome stats — powers actionable completion notifications */
  stats: TaskStats;
  /** Chat mode this task ran under ("ask" | "code" | "plan") — gates run persistence */
  mode: string;
  /**
   * Model id this task was sent to (prompt-bar pick), if any. Feeds the
   * auto-retry: after a model failure the picker swaps to the next verified
   * model once — it needs to know WHICH model failed.
   */
  model?: string;
}

export interface TaskStats {
  filesChanged: number;
  commandsRun: number;
  toolCalls: number;
  /** Markers of trouble the user should review on return */
  rejectedActions: number;
  failedSteps: number;
}

export interface TodoItem {
  text: string;
  done: boolean;
}

export interface PendingQuestion {
  question: string;
  options: string[];
  allowFreeText: boolean;
  answered: boolean;
  answer?: string;
  /** "question" (legacy ask_question / safety prompt) | "clarification" (ask_clarification card). */
  kind?: "question" | "clarification";
  /** One line telling the user WHY the agent needs this — shown above the question. */
  context?: string;
}

/**
 * Answer sentinel the clarification card sends on Escape/dismiss. The tool
 * handler converts it to the skip wording the model sees; it never travels
 * past the store → handler boundary.
 */
export const CLARIFICATION_SKIP = "__orplex_clarification_skip__";

type Listener = (task: BackgroundTask | null) => void;

// === Singleton state ===

let currentTask: BackgroundTask | null = null;
const listeners = new Set<Listener>();
let taskIdCounter = 0;
let generationCounter = 0; // Increments each time a new task starts — stale async checks this

// Abort control for the in-flight agent stream. Cancel/Stop aborts this so the
// worker's fetch and read loop terminate immediately (no wasted provider tokens).
let abortController: AbortController | null = null;

export function getTaskAbortSignal(): AbortSignal | null {
  return abortController?.signal ?? null;
}

// === Reload snapshot ===
// The worker loop lives in browser memory, so a page reload kills an in-flight
// task mid-stream. To avoid silently losing the partial work, the task state is
// mirrored (throttled) into sessionStorage while in-flight, then flushed on
// pagehide. After reload, the app re-reads it and rebuilds the visible exchange
// as an explicitly "interrupted" pair. Terminal tasks clear the snapshot — they
// are already written back + saved through the normal subscriber path.

export interface TaskSnapshot {
  version: 1;
  id: string;
  conversationId: string | null;
  userMessage: string;
  displayContent: string;
  status: string;
  statusDetail: string;
  startedAt: number;
  mode: string;
  model?: string;
}

const SNAPSHOT_KEY = "orplex:bg-task-snapshot";
const SNAPSHOT_THROTTLE_MS = 300;
const SNAPSHOT_MAX_CHARS = 200000;
let lastSnapshotWrite = 0;
let snapshotPageHideAdded = false;

function hasTaskStorage(): boolean {
  try {
    return typeof window !== "undefined" && typeof window.sessionStorage !== "undefined" && !!window.sessionStorage;
  } catch {
    return false;
  }
}

function isInFlightStatus(status: string): boolean {
  return status === "streaming" || status === "tool_executing" || status === "awaiting_approval" || status === "waiting_for_input";
}

// === Run phase (UI-facing view of the task) ================================
// The chat UI never keeps its own run-state store — every surface (tail
// indicator, sidebar card, composer Stop, tool chips) derives from THIS task.
export type RunPhase = "idle" | "thinking" | "running_tool" | "streaming" | "done" | "error" | "stopped";

/**
 * Is the tail of the display content a reasoning block? The worker writes the
 * turn's [THINKING]…[/THINKING] block CLOSED and then appends answer text (or
 * folds it before running tools) — so "ends with reasoning" means the model is
 * thinking RIGHT NOW. Checked with indexOf only (no regex over a transcript
 * that can be hundreds of KB and updates ~8×/second).
 */
function reasoningIsStreaming(content: string): boolean {
  const tail = content.trimEnd();
  if (tail.endsWith("[/THINKING]")) return true;
  const open = tail.lastIndexOf("[THINKING]");
  const close = tail.lastIndexOf("[/THINKING]");
  return open > close;
}

/** Map the task store onto the per-turn phases the UI renders. */
export function deriveRunPhase(task: BackgroundTask | null): RunPhase {
  if (!task) return "idle";
  switch (task.status) {
    case "streaming":
      // Empty content, or content whose last produced thing is the reasoning
      // block, is still the thinking state — on a later turn the transcript
      // already holds the PREVIOUS answer, so "has content" alone would mislabel
      // live reasoning as streaming.
      if (!task.displayContent.trim() || reasoningIsStreaming(task.displayContent)) {
        return "thinking";
      }
      return "streaming";
    case "tool_executing":
    case "awaiting_approval":
    // Waiting on the user's clarification is still "the run is parked mid-tool"
    // — the tail spinner is suppressed by the card itself (MessageList), and
    // the status detail ("Waiting for input") carries the real label.
    case "waiting_for_input":
      return "running_tool";
    case "done":
      return "done";
    case "error":
      return task.aborted ? "stopped" : "error";
    case "idle":
    default:
      return "idle";
  }
}

/** Human label for a phase — used when the task carries no detail yet. */
export function runPhaseLabel(phase: RunPhase): string {
  switch (phase) {
    case "thinking": return "Thinking…";
    case "running_tool": return "Working…";
    case "streaming": return "Responding…";
    case "done": return "Done";
    case "error": return "Failed";
    case "stopped": return "Stopped";
    default: return "";
  }
}

/** Write the current task to sessionStorage so a reload can restore it. */
export function persistTaskSnapshot(force = false): void {
  if (!hasTaskStorage() || !currentTask) return;

  // Only in-flight tasks are worth restoring — terminal ones were already
  // handled by the subscriber (write-back + conversation save).
  if (!isInFlightStatus(currentTask.status)) {
    clearTaskSnapshot();
    return;
  }

  const now = Date.now();
  if (!force && now - lastSnapshotWrite < SNAPSHOT_THROTTLE_MS) return;
  lastSnapshotWrite = now;
  ensurePageHideFlush();

  try {
    const snap: TaskSnapshot = {
      version: 1,
      id: currentTask.id,
      conversationId: currentTask.conversationId,
      userMessage: currentTask.userMessage,
      displayContent: currentTask.displayContent.slice(0, SNAPSHOT_MAX_CHARS),
      status: currentTask.status,
      statusDetail: currentTask.statusDetail,
      startedAt: currentTask.startedAt,
      mode: currentTask.mode,
      model: currentTask.model,
    };
    window.sessionStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snap));
  } catch {
    // Quota exceeded / private mode — best-effort only
  }
}

/** Read + remove the saved snapshot (restore consumes it exactly once). */
export function readTaskSnapshot(): TaskSnapshot | null {
  if (!hasTaskStorage()) return null;
  try {
    const raw = window.sessionStorage.getItem(SNAPSHOT_KEY);
    if (!raw) return null;
    const snap = JSON.parse(raw) as TaskSnapshot;
    if (!snap || snap.version !== 1 || typeof snap.userMessage !== "string") return null;
    return snap;
  } catch {
    return null;
  }
}

export function clearTaskSnapshot(): void {
  if (!hasTaskStorage()) return;
  try {
    window.sessionStorage.removeItem(SNAPSHOT_KEY);
  } catch {
    /* ignore */
  }
}

// Grab the freshest state when the tab is about to go away (throttle may have
// skipped the last few chunks). Registered lazily to keep Node/SSR safe.
function ensurePageHideFlush(): void {
  if (snapshotPageHideAdded || typeof window === "undefined") return;
  snapshotPageHideAdded = true;
  window.addEventListener("pagehide", () => persistTaskSnapshot(true));
}

// === Subscribe / notify ===

export function subscribeBackgroundChat(listener: Listener): () => void {
  listeners.add(listener);
  // Emit current state immediately
  listener(currentTask);
  return () => { listeners.delete(listener); };
}

function notify() {
  // Hand listeners a FRESH shallow copy on every event. The module mutates
  // currentTask in place across chunks, so passing the same reference would
  // make React bail out of re-rendering (setState with an Object.is-equal
  // value is a no-op) — streamed content would only appear when the task
  // finished instead of growing live in the bubble.
  const snapshot = currentTask ? { ...currentTask } : null;
  for (const listener of listeners) {
    listener(snapshot);
  }
  lastNotifiedDisplay = currentTask?.displayContent ?? "";
  // Keep the reload snapshot fresh while a task is running (throttled writes)
  persistTaskSnapshot();
}

// === Display-content render coalescing (UI-freeze fix) ======================
// Streaming fires hundreds of notify() calls per task; each one synchronously
// ran setState in EVERY subscriber, and each React render re-parsed +
// re-highlighted the whole growing message. Combined with the per-chunk text
// repair passes that saturated the main thread — every button (Stop included)
// froze until the agent finished. The fix: display-content-only updates are
// coalesced to ~8 frames. State mutations stay SYNCHRONOUS (getCurrentTask,
// tests, and the Stop path are unaffected); only the subscriber fan-out is
// batched. Anything that changes task identity/status (start, complete,
// fail, cancel) notifies immediately so Stop never waits for a frame.
const NOTIFY_FRAME_MS = 125;
let notifyScheduled = false;
let lastNotifiedDisplay = "";

function notifyThrottled() {
  if (!currentTask) return;
  if (currentTask.displayContent === lastNotifiedDisplay) return;
  if (notifyScheduled) return;
  notifyScheduled = true;
  const frame = () => {
    notifyScheduled = false;
    // Only fan out if another (immediate) notify hasn't already delivered a
    // newer displayContent — and the task is still the one being streamed.
    if (currentTask && currentTask.displayContent !== lastNotifiedDisplay) {
      notify();
    }
  };
  // Plain timer (not rAF): rAF pauses in background tabs, which would stall
  // display updates; a timer keeps coalescing at the same cadence. unref so
  // browser-task housekeeping never holds a Node process/Jest worker open.
  setTimeout(frame, NOTIFY_FRAME_MS).unref?.();
}

// === Stats tracking (for actionable notifications) ===

export function bumpStat(key: keyof Omit<TaskStats, "filesChanged">) {
  if (!currentTask) return;
  currentTask.stats[key]++;
}

export function setFilesChanged(count: number) {
  if (!currentTask) return;
  currentTask.stats.filesChanged = count;
}

export function getTaskStats(): TaskStats | null {
  return currentTask?.stats ?? null;
}

// === Getters ===

export function getCurrentTask(): BackgroundTask | null {
  return currentTask;
}

export function getGeneration(): number {
  return generationCounter;
}

/** Check if the current task is still the one we started */
export function isCurrentTask(taskId: string): boolean {
  return currentTask?.id === taskId;
}

export function isBackgroundTaskRunning(): boolean {
  return currentTask !== null && currentTask.status !== "done" && currentTask.status !== "error";
}

// === Mutations ===

export function startTask(
  conversationId: string | null,
  userMessage: string,
  initialMessages: ChatMessage[],
  mode: string = "code",
  /** Model id the task is sent to (prompt-bar pick) — feeds auto-retry. */
  model?: string
): string {
  const id = `bg-${++taskIdCounter}`;
  generationCounter++;
  // Fresh abort controller for this task — any prior cancel must not affect it
  abortController = new AbortController();
  currentTask = {
    id,
    conversationId,
    userMessage,
    messages: initialMessages,
    displayContent: "",
    status: "streaming",
    statusDetail: "Thinking…",
    startedAt: Date.now(),
    todos: [],
    question: null,
    clarificationCount: 0,
    mode,
    ...(model ? { model } : {}),
    stats: { filesChanged: 0, commandsRun: 0, toolCalls: 0, rejectedActions: 0, failedSteps: 0 },
  };
  // New task — notify immediately and reset the coalescing state so stale
  // bookkeeping from a previous task can never swallow this task's updates.
  notifyScheduled = false;
  lastNotifiedDisplay = "";
  notify();
  // Mirror this task into a durable AgentRun row (browser only, best-effort)
  trackTaskStart(currentTask);
  return id;
}

export function updateTaskStatus(status: TaskStatus, detail?: string) {
  if (!currentTask) return;
  currentTask.status = status;
  if (detail !== undefined) currentTask.statusDetail = detail;
  notify();
}

export function setTodos(items: unknown[]) {
  if (!currentTask) return;
  currentTask.todos = items.map(item => {
    // The LLM sometimes sends the raw call object instead of a string
    const text = typeof item === "string"
      ? item
      : typeof item === "object" && item !== null
        ? (item as any).items
          ? (item as any).items.map((i: any) => typeof i === "string" ? i : JSON.stringify(i)).join(", ")
          : JSON.stringify(item)
        : String(item);
    return { text, done: false };
  });
  notify();
}

export function completeTodo(index: number) {
  if (!currentTask) return;
  if (index >= 0 && index < currentTask.todos.length) {
    currentTask.todos[index].done = true;
    notify();
  }
}

export function clearTodos() {
  if (!currentTask) return;
  currentTask.todos = [];
  notify();
}

/** Mirror the agent's scratchpad into the task for the Scratch panel. */
export function setScratchpad(text: string) {
  if (!currentTask) return;
  currentTask.scratchpad = text;
  notify();
}

export interface QuestionMeta {
  /** Why the agent needs this — shown as the muted line on the clarification card. */
  context?: string;
  /** "clarification" routes the UI to the message-stream card, not the legacy QuestionCard. */
  kind?: "question" | "clarification";
}

export function setQuestion(question: unknown, options: unknown, allowFreeText: boolean, meta?: QuestionMeta) {
  if (!currentTask) return;
  // Validate: LLM can send objects instead of strings
  const q = typeof question === "string" ? question : JSON.stringify(question ?? "");
  const opts = Array.isArray(options)
    ? options.map(o => typeof o === "string" ? o : JSON.stringify(o))
    : [];
  currentTask.question = {
    question: q,
    options: opts,
    allowFreeText,
    answered: false,
    ...(meta?.kind ? { kind: meta.kind } : {}),
    ...(meta?.context ? { context: meta.context } : {}),
  };
  if (meta?.kind === "clarification") {
    currentTask.clarificationCount = (currentTask.clarificationCount ?? 0) + 1;
  }
  notify();
}

export function answerQuestion(answer: string) {
  if (!currentTask || !currentTask.question) return;
  currentTask.question.answered = true;
  currentTask.question.answer = answer;
  notify();
}

export function appendToDisplayContent(text: string) {
  if (!currentTask) return;
  currentTask.displayContent += text;
  notifyThrottled();
}

export function setDisplayContent(content: string) {
  if (!currentTask) return;
  currentTask.displayContent = content;
  notifyThrottled();
}

export function addAssistantMessage(content: string) {
  if (!currentTask) return;
  currentTask.messages.push({
    role: "assistant",
    content,
    time: new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false }),
  });
  notify();
}

export function completeTask(finalContent?: string) {
  if (!currentTask) return;
  if (finalContent !== undefined) {
    currentTask.displayContent = finalContent;
  }
  currentTask.status = "done";
  currentTask.statusDetail = "Complete";
  currentTask.completedAt = Date.now();
  const completedId = currentTask.id;
  const completedTask = currentTask;
  // Status change — flush any pending display update IMMEDIATELY so the
  // final answer lands in one render and the UI unblocks at once.
  notifyScheduled = false;
  notify();

  // Persist the terminal state to the run record (best-effort, browser only)
  trackTaskEnd(completedTask).catch(() => {});

  // Actionable notification: lead with what happened, not just "done".
  // Both surfaces fire: the OS notification (when granted) and the durable
  // bell inbox (3s toast on arrival, then stored with an unread badge).
  const summary = buildCompletionSummary(completedTask);
  sendNotification("Orplex Agent", summary);
  void import("./notify-client")
    .then(({ notifyUser }) =>
      notifyUser({
        type: "success",
        title: "Agent task completed",
        message: `${completedTask.userMessage.slice(0, 80)} — ${summary}`,
        source: "runs",
      })
    )
    .catch(() => {});

  // Clear task after a delay — but only if no new task has started.
  // unref so browser-task housekeeping never holds a Node process/Jest worker open.
  const cleanupTimer = setTimeout(() => {
    if (currentTask && currentTask.id === completedId && currentTask.status === "done") {
      currentTask = null;
      notify();
    }
  }, 10000);
  cleanupTimer.unref?.();
}

export function failTask(error: string) {
  if (!currentTask) return;
  currentTask.status = "error";
  currentTask.statusDetail = error;
  currentTask.error = error;
  // Raw reasoning must never bleed into the response text on a failed task
  // either — normalize markers so the ThinkingCard still renders it collapsed.
  currentTask.displayContent = normalizeThinkingBlocks(currentTask.displayContent);
  currentTask.completedAt = Date.now();
  const failedId = currentTask.id;
  const failedTask = currentTask;
  // Plan latch must not outlive the task — task ids never repeat, so an
  // uncleared latch is pure map growth for the session lifetime.
  try { clearPlanLatch(failedId); } catch {}
  // Report to error tracker (Bugsink/console) — never breaks the fail path.
  void import("./error-tracking")
    .then(({ reportError }) =>
      reportError(new Error(error), { component: "background-worker", action: "failTask" })
    )
    .catch(() => {});
  // Status change — flush any pending display update IMMEDIATELY.
  notifyScheduled = false;
  notify();

  // Persist the terminal state to the run record (best-effort, browser only)
  trackTaskEnd(failedTask).catch(() => {});

  const { filesChanged, commandsRun } = currentTask.stats;
  const progress = filesChanged > 0 || commandsRun > 0
    ? ` (${filesChanged} file(s) changed, ${commandsRun} command(s) run before failure — check the Changes panel)`
    : "";
  sendNotification("Orplex Agent", `Task failed: ${error}${progress}`);
  // Durable bell notification for the failure too — same 3s-toast-then-badge
  // flow as completions, so run outcomes are always visible in the inbox.
  void import("./notify-client")
    .then(({ notifyUser }) =>
      notifyUser({
        type: "error",
        title: "Agent task failed",
        message: `${failedTask.userMessage.slice(0, 80)} — ${error.slice(0, 200)}${progress}`,
        source: "runs",
      })
    )
    .catch(() => {});

  const failCleanupTimer = setTimeout(() => {
    if (currentTask && currentTask.id === failedId && currentTask.status === "error") {
      currentTask = null;
      notify();
    }
  }, 15000);
  failCleanupTimer.unref?.();
}

export function cancelTask(options: { abort?: boolean } = {}) {
  if (!currentTask) return;

  const cancelledId = currentTask.id;
  // Same latch hygiene as failTask — cancelled plan tasks must not leak.
  try { clearPlanLatch(cancelledId); } catch {}

  if (options.abort) {
    // User pressed Stop (or New Chat while running) — kill the in-flight
    // request so the worker stops burning provider tokens immediately.
    currentTask.aborted = true;
    abortController?.abort();
  }

  currentTask.status = "error";
  currentTask.statusDetail = "Cancelled";
  // Stop pressed mid-think: normalize reasoning blocks NOW, before the
  // terminal notification reaches the subscriber (which writes displayContent
  // into the message store). Markers get repaired instead of removed, so the
  // ThinkingCard still renders — only the raw-as-answer bleed is prevented.
  currentTask.displayContent = normalizeThinkingBlocks(currentTask.displayContent);
  currentTask.completedAt = Date.now();
  const cancelledTask = currentTask;
  // Status change (user pressed Stop) — flush IMMEDIATELY, never on a timer:
  // the UI must react to Stop in the same tick.
  notifyScheduled = false;
  notify();

  // Persist the cancelled state to the run record (best-effort, browser only)
  trackTaskEnd(cancelledTask).catch(() => {});

  // Clear from state shortly after — but never clear a NEWER task that
  // started in the meantime (user sent another message right after Stop).
  const cancelCleanupTimer = setTimeout(() => {
    if (currentTask && currentTask.id === cancelledId) {
      currentTask = null;
      notify();
    }
  }, 2000);
  cancelCleanupTimer.unref?.();
}

/** Convenience for callers that always mean "stop the current agent now" */
export function abortCurrentTask() {
  cancelTask({ abort: true });
}

// === Notification summaries ===

/**
 * Build a notification body that tells the user what to review when they
 * return: files touched, commands run, and anything that needs attention.
 */
function buildCompletionSummary(task: BackgroundTask): string {
  const { stats, todos } = task;
  const parts: string[] = [];

  if (stats.filesChanged > 0) {
    parts.push(`${stats.filesChanged} file${stats.filesChanged > 1 ? "s" : ""} changed`);
  }
  if (stats.commandsRun > 0) {
    parts.push(`${stats.commandsRun} command${stats.commandsRun > 1 ? "s" : ""} run`);
  }
  if (parts.length === 0) {
    const done = todos.filter(t => t.done).length;
    if (done > 0) parts.push(`${done} step${done > 1 ? "s" : ""} completed`);
  }
  if (parts.length === 0) parts.push("Response ready");

  const attention: string[] = [];
  if (stats.failedSteps > 0) attention.push(`${stats.failedSteps} step${stats.failedSteps > 1 ? "s" : ""} failing`);
  if (stats.rejectedActions > 0) attention.push(`${stats.rejectedActions} action${stats.rejectedActions > 1 ? "s" : ""} rejected`);

  if (attention.length > 0) {
    return `${parts.join(", ")} — ${attention.join(", ")}. Review now.`;
  }
  return `${parts.join(", ")} — review now.`;
}

async function sendNotification(title: string, body: string) {
  // Never throws: callers fire-and-forget this, so a denial or a throw
  // would surface as an unhandled rejection.
  try {
    // Request permission if not granted
    if (typeof window !== "undefined" && "Notification" in window) {
      if (Notification.permission === "default") {
        await Notification.requestPermission();
      }
      if (Notification.permission === "granted") {
        new Notification(title, {
          body,
          icon: "/logo.png",
          badge: "/logo.png",
          tag: "orplex-agent",
        });
      }
    }
  } catch {
    // OS notifications are best-effort; the bell inbox is the durable path.
  }
}
