// types.ts — Advanced TypeScript type utilities for Orplex
// Uses branded types, discriminated unions, conditional types, and type guards

// === Branded Types (nominal typing for IDs) ===
// Prevents mixing up userId with conversationId at compile time

type Brand<T, B extends string> = T & { readonly __brand: B };

export type UserId = Brand<string, "UserId">;
export type ConversationId = Brand<string, "ConversationId">;
export type TaskId = Brand<string, "TaskId">;
export type MessageId = Brand<string, "MessageId">;

// === Discriminated Unions for Agent Events ===
// Each event type has its own shape — type narrowing works automatically

export type AgentEvent =
  | { type: "text"; content: string }
  | { type: "tool_call"; tool: string; args: Record<string, unknown> }
  | { type: "tool_result"; tool: string; result: string; success: boolean }
  | { type: "plan"; content: string }
  | { type: "thinking"; content: string }
  | { type: "done" }
  | { type: "error"; content: string }
  /**
   * The context was summarized to stay under the token budget. A system
   * event, not a message — the timeline renders a collapsible marker for it
   * (see ContextCompactedDivider). `tokensBefore`/`tokensAfter` are ESTIMATES
   * (the app sizes context with a chars/4 heuristic), which is why the label
   * renders them "~"-prefixed.
   */
  | {
      type: "compacted";
      tokensBefore: number;
      tokensAfter: number;
      mode: "automatic" | "manual";
      summary?: string;
    };

export function isCompactionEvent(
  event: AgentEvent
): event is {
  type: "compacted";
  tokensBefore: number;
  tokensAfter: number;
  mode: "automatic" | "manual";
  summary?: string;
} {
  return event.type === "compacted";
}

export function isToolCallEvent(event: AgentEvent): event is { type: "tool_call"; tool: string; args: Record<string, unknown> } {
  return event.type === "tool_call";
}

export function isToolResultEvent(event: AgentEvent): event is { type: "tool_result"; tool: string; result: string; success: boolean } {
  return event.type === "tool_result";
}

// === Tool Name Literal Types ===
// Prevents typos in tool names at compile time

export type ToolName = "read_file" | "write_file" | "edit_file" | "list_files" | "search_code" | "run_command" | "launch_and_screenshot" | "check_console_errors" | "record_page";

// === Message Content Types ===

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

 type MessageContent = string | ContentPart[];

// === API Response Types ===

export interface ApiSuccessResponse<T = unknown> {
  success: true;
  data: T;
}

export interface ApiErrorResponse {
  success: false;
  error: {
    message: string;
    code?: string;
    details?: unknown;
  };
}

export type ApiResponse<T = unknown> = ApiSuccessResponse<T> | ApiErrorResponse;

// === Validation Result Types ===

 type ValidationResult<T> =
  | { valid: true; data: T }
  | { valid: false; errors: string[] };

// === Chat Types ===

export type MessageRole = "user" | "assistant";

export type AgentMode = "ask" | "plan" | "code";

 interface ChatMessage {
  role: MessageRole;
  content: string;
  time: string;
  files?: AttachedFile[];
  images?: ImageAttachment[];
}

export interface AttachedFile {
  name: string;
  content: string;
  size: number;
  type: "text" | "image";
  dataUrl?: string;
}

export interface ImageAttachment {
  name: string;
  dataUrl: string;
  size: number;
}

// === Provider Types ===

export type ProviderName = "openrouter" | "nvidia" | "in-memory";

 interface ProviderConfig {
  name: ProviderName;
  apiKey: string;
  model: string;
}

// === Permission Types ===

export type PermissionLevel = "auto" | "ask" | "deny";

// Extract only the synchronous properties from a type
export type SyncProps<T> = {
  [K in keyof T as T[K] extends (...args: any[]) => any ? never : K]: T[K];
};

// Make a type deeply readonly
export type DeepReadonly<T> = {
  readonly [P in keyof T]: T[P] extends object ? DeepReadonly<T[P]> : T[P];
};

// Non-nullable version of a type
export type NonNull<T> = Exclude<T, null | undefined>;
