// constants.ts — Centralized magic numbers and configuration values
// Every timeout, limit, and threshold in one place. No more guessing what 5000 means.

// === Timeouts ===
export const TIMEOUTS = {
  /** Max time to wait for a shell command (ms) */
  COMMAND_EXEC: 30_000,
  /** Max time for sandbox command execution (ms) */
  SANDBOX_EXEC: 60_000,
  /** Max time to wait for user approval of a tool call (ms) */
  APPROVAL_WAIT: 5 * 60 * 1000,
  /** Max time to wait for user answer to a question (ms) */
  QUESTION_WAIT: 5 * 60 * 1000,
  /** Max time for screenshot capture (ms) */
  SCREENSHOT: 15_000,
  /** Max time for preview page fetch (ms) */
  PREVIEW_FETCH: 15_000,
  /** Safety timeout to force-clear thinking state (ms) */
  THINKING_SAFETY: 120_000,
  /** How long to keep a completed task in memory before clearing (ms) */
  TASK_TTL_DONE: 10_000,
  /** How long to keep a failed task in memory before clearing (ms) */
  TASK_TTL_ERROR: 15_000,
  /** How long to keep a cancelled task in memory before clearing (ms) */
  TASK_TTL_CANCEL: 2_000,
  /** Polling interval for approval checks (ms) */
  APPROVAL_POLL: 2_000,
  /** Circuit breaker open duration (ms) */
  CIRCUIT_BREAKER_OPEN: 5 * 60 * 1000,
  /** Rate limit cache sweep interval (ms) */
  RATE_LIMIT_SWEEP: 60_000,
  /** Circuit breaker auto-reset interval (ms) */
  CIRCUIT_BREAKER_RESET: 60_000,
} as const;

// === Output Limits ===
export const LIMITS = {
  /** Max characters of command output to show in tool results */
  OUTPUT_TRUNCATE: 5_000,
  /** Max characters of sandbox output */
  SANDBOX_OUTPUT: 5_000,
  /** Max buffer size for exec (bytes) */
  EXEC_BUFFER: 1024 * 1024,
  /** Max buffer size for sandbox exec (bytes) */
  SANDBOX_BUFFER: 512 * 1024,
  /** Max characters of tool result to store in message content */
  TOOL_RESULT_PREVIEW: 500,
  /** Max characters of tool call args to display */
  TOOL_ARGS_DISPLAY: 40,
  /** Max characters of command to show in approval dialog */
  COMMAND_PREVIEW: 40,
  /** Max characters of command to show in status updates */
  COMMAND_STATUS: 50,
  /** Max words before collapsible text kicks in */
  COLLAPSE_WORDS: 150,
  /** Max words to show when collapsed */
  COLLAPSE_PREVIEW: 100,
  /** Max characters of queue item text to display */
  QUEUE_ITEM_TEXT: 50,
} as const;

// === Retry & Resilience ===
export const RESILIENCE = {
  /** Number of consecutive failures before circuit breaker trips */
  FAILURE_THRESHOLD: 3,
  /** Max reflection attempts in enhanced worker */
  MAX_REFLECTION_ATTEMPTS: 3,
  /** Default concurrency for eval harness */
  EVAL_CONCURRENCY: 3,
} as const;

// === Risk Classification ===
export const RISK = {
  /** Shell commands matching this pattern are considered safe (low risk) */
  SAFE_COMMAND_PATTERN: /npm\s+(run\s+)?(dev|start|build|test)|npx\s+(serve|vite|tsc|eslint)|yarn\s+(dev|start|build|test)|pnpm\s+(dev|start|build|test)|node\s+--version|tsc\s+--noEmit|git\s+(status|diff|log)\b/i,
} as const;

// === Blocked Commands ===
// Patterns that are never allowed to execute — expanded beyond the basics
export const BLOCKED_COMMANDS = [
  // Destructive filesystem
  "rm -rf /",
  "rm -rf ~",
  "rm -rf /*",
  "rm -rf .",
  "sudo rm",
  "mkfs",
  "dd if=",
  "format",
  // System-level
  "shutdown",
  "reboot",
  "halt",
  "poweroff",
  "init 0",
  "init 6",
  // Fork bomb
  ":(){ :|:& };:",
  // Network exfiltration (pipe to shell)
  "| sh",
  "| bash",
  "| zsh",
  "curl | sh",
  "wget | sh",
  "curl | bash",
  "wget | bash",
  // Privilege escalation
  "sudo su",
  "su -",
  // Database destruction
  "DROP DATABASE",
  "DROP TABLE",
  "TRUNCATE",
  // Environment destruction
  "export PATH=",
  "unset PATH",
  // Process killing
  "kill -9 1",
  "killall",
  // Disk
  "chmod -R 777 /",
  "chown -R",
] as const;

/** Check if a command matches any blocked pattern */
export function isBlockedCommand(command: string): boolean {
  const lower = command.toLowerCase();
  return BLOCKED_COMMANDS.some(blocked => lower.includes(blocked.toLowerCase()));
}

// === UI ===
export const UI = {
  /** Delay before showing fast-answer button (ms) */
  FAST_ANSWER_DELAY: 0,
  /** Number of recent chats to show in sidebar */
  RECENT_CHATS_LIMIT: 10,
} as const;
