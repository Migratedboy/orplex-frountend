// background-chat.ts — Global singleton chat store
// Survives page navigation — the tool-calling loop keeps running in the background
// When the user returns to the chat page, the UI reattaches and shows current state

// === Types ===

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  time: string;
}

export type TaskStatus = "idle" | "streaming" | "tool_executing" | "awaiting_approval" | "done" | "error";

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
  /** Aggregate outcome stats — powers actionable completion notifications */
  stats: TaskStats;
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
}

type Listener = (task: BackgroundTask | null) => void;

// === Singleton state ===

let currentTask: BackgroundTask | null = null;
const listeners = new Set<Listener>();
let taskIdCounter = 0;
let generationCounter = 0; // Increments each time a new task starts — stale async checks this

// === Subscribe / notify ===

export function subscribeBackgroundChat(listener: Listener): () => void {
  listeners.add(listener);
  // Emit current state immediately
  listener(currentTask);
  return () => { listeners.delete(listener); };
}

function notify() {
  for (const listener of listeners) {
    listener(currentTask);
  }
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
  initialMessages: ChatMessage[]
): string {
  const id = `bg-${++taskIdCounter}`;
  generationCounter++;
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
    stats: { filesChanged: 0, commandsRun: 0, toolCalls: 0, rejectedActions: 0, failedSteps: 0 },
  };
  notify();
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

export function setQuestion(question: unknown, options: unknown, allowFreeText: boolean) {
  if (!currentTask) return;
  // Validate: LLM can send objects instead of strings
  const q = typeof question === "string" ? question : JSON.stringify(question ?? "");
  const opts = Array.isArray(options)
    ? options.map(o => typeof o === "string" ? o : JSON.stringify(o))
    : [];
  currentTask.question = { question: q, options: opts, allowFreeText, answered: false };
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
  notify();
}

export function setDisplayContent(content: string) {
  if (!currentTask) return;
  currentTask.displayContent = content;
  notify();
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
  notify();

  // Actionable notification: lead with what happened, not just "done"
  sendNotification("Orplex Agent", buildCompletionSummary(currentTask));

  // Clear task after a delay — but only if no new task has started
  setTimeout(() => {
    if (currentTask && currentTask.id === completedId && currentTask.status === "done") {
      currentTask = null;
      notify();
    }
  }, 10000);
}

export function failTask(error: string) {
  if (!currentTask) return;
  currentTask.status = "error";
  currentTask.statusDetail = error;
  currentTask.error = error;
  currentTask.completedAt = Date.now();
  const failedId = currentTask.id;
  notify();

  const { filesChanged, commandsRun } = currentTask.stats;
  const progress = filesChanged > 0 || commandsRun > 0
    ? ` (${filesChanged} file(s) changed, ${commandsRun} command(s) run before failure — check the Changes panel)`
    : "";
  sendNotification("Orplex Agent", `Task failed: ${error}${progress}`);

  setTimeout(() => {
    if (currentTask && currentTask.id === failedId && currentTask.status === "error") {
      currentTask = null;
      notify();
    }
  }, 15000);
}

export function cancelTask() {
  if (!currentTask) return;
  currentTask.status = "error";
  currentTask.statusDetail = "Cancelled";
  currentTask.completedAt = Date.now();
  notify();

  setTimeout(() => {
    currentTask = null;
    notify();
  }, 2000);
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
}
