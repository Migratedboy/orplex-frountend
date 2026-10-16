// types.ts — Advanced TypeScript type utilities for Orplex
// Uses branded types, discriminated unions, conditional types, and type guards

// === Branded Types (nominal typing for IDs) ===
// Prevents mixing up userId with conversationId at compile time

type Brand<T, B extends string> = T & { readonly __brand: B };

export type UserId = Brand<string, "UserId">;
export type ConversationId = Brand<string, "ConversationId">;
export type TaskId = Brand<string, "TaskId">;
export type MessageId = Brand<string, "MessageId">;

// Helper to create branded IDs (use when reading from DB/API)
export function asUserId(id: string): UserId { return id as UserId; }
export function asConversationId(id: string): ConversationId { return id as ConversationId; }
export function asTaskId(id: string): TaskId { return id as TaskId; }
export function asMessageId(id: string): MessageId { return id as MessageId; }

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

// Type guard functions
export function isTextEvent(event: AgentEvent): event is { type: "text"; content: string } {
  return event.type === "text";
}

export function isToolCallEvent(event: AgentEvent): event is { type: "tool_call"; tool: string; args: Record<string, unknown> } {
  return event.type === "tool_call";
}

export function isToolResultEvent(event: AgentEvent): event is { type: "tool_result"; tool: string; result: string; success: boolean } {
  return event.type === "tool_result";
}

export function isErrorEvent(event: AgentEvent): event is { type: "error"; content: string } {
  return event.type === "error";
}

export function isDoneEvent(event: AgentEvent): event is { type: "done" } {
  return event.type === "done";
}

// === Tool Name Literal Types ===
// Prevents typos in tool names at compile time

export type ToolName = "read_file" | "write_file" | "edit_file" | "list_files" | "search_code" | "run_command" | "launch_and_screenshot" | "check_console_errors" | "record_page";

export type ToolPermission = "read" | "write" | "execute" | "git";

// Tool arguments — each tool has its own required args shape
export type ToolArgs<T extends ToolName> =
  T extends "read_file" ? { path: string } :
  T extends "write_file" ? { path: string; content: string } :
  T extends "edit_file" ? { path: string; old_text: string; new_text: string } :
  T extends "list_files" ? { path?: string } :
  T extends "search_code" ? { query: string; path?: string } :
  T extends "run_command" ? { command: string; cwd?: string } :
  T extends "launch_and_screenshot" ? { port: number; page_path?: string } :
  T extends "check_console_errors" ? { port: number; page_path?: string } :
  T extends "record_page" ? { port: number; page_path?: string; duration_ms?: number } :
  never;

// === Message Content Types ===

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type MessageContent = string | ContentPart[];

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

// Type guard for API responses
export function isSuccessResponse<T>(response: ApiResponse<T>): response is ApiSuccessResponse<T> {
  return response.success === true;
}

export function isErrorResponse(response: ApiResponse<unknown>): response is ApiErrorResponse {
  return response.success === false;
}

// === Validation Result Types ===

export type ValidationResult<T> =
  | { valid: true; data: T }
  | { valid: false; errors: string[] };

// === Chat Types ===

export type MessageRole = "user" | "assistant";

export type AgentMode = "ask" | "plan" | "code";

export interface ChatMessage {
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

export interface ProviderConfig {
  name: ProviderName;
  apiKey: string;
  model: string;
}

// === Permission Types ===

export type PermissionLevel = "auto" | "ask" | "deny";

export interface PermissionRule {
  tool: ToolName;
  permission: PermissionLevel;
  reason?: string;
}

// === Utility Types ===

// Make specific properties required
export type RequireKeys<T, K extends keyof T> = T & Required<Pick<T, K>>;

// Make specific properties optional
export type OptionalKeys<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

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
