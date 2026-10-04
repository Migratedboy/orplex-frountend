// risk-classifier.ts — Determines approval tier for tool calls.
//
// Risk tiers:
//   low      -> auto-approved silently (read-only, additive file creation in safe dirs)
//   medium   -> user approval required, dialog marked "standard"
//   high     -> user approval required, dialog marked "elevated" with warning styling
//
// Design goal: read-only operations never interrupt the user; shell commands,
// destructive edits, and network-touching operations always do.

export type RiskLevel = "low" | "medium" | "high";

export interface RiskAssessment {
  level: RiskLevel;
  /** Machine-readable reason shown in the approval dialog */
  reason: string;
  /** Whether the caller may skip the approval dialog entirely */
  autoApprovable: boolean;
}

/**
 * Server-declared hints for MCP connector tools (spec Phase 4, conflict C6).
 * `readOnlyHint`/`destructiveHint` come from the server's own ToolAnnotations
 * on tools/list — third-party claims we only TRUST for the read-only path,
 * never as a reason to skip approval entirely.
 */
export interface McpRiskHint {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  /** Per-server user toggle: auto-approve tools the server marks read-only. */
  serverAutoApproveReadOnly?: boolean;
}

const LOW_RISK_TOOLS = new Set([
  "read_file",
  "list_files",
  "search_code",
  "code_search",
  "web_search",
  "todo_list",
  "undo_last_change",
]);

/** Shell commands that never touch state outside a build/dev/test loop */
const SAFE_COMMAND = /npm\s+(run\s+)?(dev|start|build|test)|npx\s+(serve|vite|tsc|eslint)|yarn\s+(dev|start|build|test)|pnpm\s+(dev|start|build|test)|node\s+--version|tsc\s+--noEmit|git\s+(status|diff|log)\b/i;

/** Commands that mutate anything outside the workspace or touch the network/system */
const DESTRUCTIVE_COMMAND = /rm\s+-rf|sudo|mkfs|dd\s+if=|shutdown|reboot|curl.*\|\s*(ba)?sh|wget.*\|\s*(ba)?sh|:\(\)\{|npm\s+publish|git\s+push|git\s+reset\s+--hard|chmod\s+777|>\s*\/dev\/sd/i;

/** Writing inside these directories is considered safe/additive */
const SAFE_WRITE_PREFIXES = ["src/", "app/", "components/", "lib/", "pages/", "public/", "styles/", "test/", "tests/", "__tests__/"];

/** Files where edits can break builds/infra or leak secrets */
const SENSITIVE_FILE = /(\.env|\.npmrc|\.ssh|id_rsa|credentials|secret|password|docker-compose|Dockerfile|nginx|ci|workflow|\.github[\\/]|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|prisma\/migrations)/i;

/**
 * Classify a tool call before execution. Callers pass the tool name and its
 * parsed arguments; the classifier returns the minimum tier the operation needs.
 */
export function classifyRisk(
  toolName: string,
  args: Record<string, unknown> = {},
  mcp?: McpRiskHint
): RiskAssessment {
  // 1. Read-only tools are always low risk
  if (LOW_RISK_TOOLS.has(toolName)) {
    return { level: "low", reason: "Read-only operation", autoApprovable: true };
  }

  // 2. Shell execution — always at least medium, destructive is high
  if (toolName === "run_command" || toolName === "run_in_sandbox") {
    const command = String(args.command || "");
    if (DESTRUCTIVE_COMMAND.test(command)) {
      return { level: "high", reason: "Destructive or system-level command", autoApprovable: false };
    }
    if (SAFE_COMMAND.test(command)) {
      return { level: "medium", reason: "Build/dev command (safe list)", autoApprovable: false };
    }
    return { level: "medium", reason: "Shell command execution", autoApprovable: false };
  }

  // 3. Network egress from the agent
  if (toolName === "take_screenshot" || toolName === "preview_browser") {
    return { level: "medium", reason: "External network request", autoApprovable: false };
  }

  // 4. File writes
  if (toolName === "write_file" || toolName === "write_file_chunk") {
    const path = String(args.path || "");
    const content = String(args.content || "");
    if (SENSITIVE_FILE.test(path)) {
      return { level: "high", reason: "Sensitive file (config, secrets, or CI)", autoApprovable: false };
    }
    if (isSafeWritePath(path) && !content.includes("require(") && !content.includes("eval(")) {
      return { level: "low", reason: "Additive write in workspace", autoApprovable: true };
    }
    return { level: "medium", reason: "File write", autoApprovable: false };
  }

  // 5. Edits — target text matters more than path, but path still gates
  if (toolName === "edit_file" || toolName === "batch_edit") {
    const paths = args.edits
      ? (args.edits as Array<{ path?: string }>).map(e => String(e.path || ""))
      : [String(args.path || "")];
    if (paths.some(p => SENSITIVE_FILE.test(p))) {
      return { level: "high", reason: "Sensitive file (config, secrets, or CI)", autoApprovable: false };
    }
    // Deleting large blocks (old_text >> new_text) is riskier than adding
    const oldText = String(args.old_text || "");
    const newText = String(args.new_text || "");
    if (oldText.length > 2000 && newText.length < oldText.length / 4) {
      return { level: "high", reason: "Large deletion (over 80% of the target text removed)", autoApprovable: false };
    }
    return { level: "medium", reason: "File modification", autoApprovable: false };
  }

  // 6. MCP connector tools (mcp__<server>__<tool>) — third-party code with
  //    unknown side effects. Fail closed: without a server-side read-only
  //    annotation the call is medium and needs approval (C6). The per-server
  //    auto-approve toggle only ever unlocks tools the server itself
  //    declared readOnly; destructiveHint → elevated tier.
  if (toolName.startsWith("mcp__")) {
    if (mcp?.destructiveHint) {
      return { level: "high", reason: "MCP tool declared destructive by its server", autoApprovable: false };
    }
    if (mcp?.readOnlyHint && mcp.serverAutoApproveReadOnly) {
      return { level: "low", reason: "MCP read-only tool — auto-approved for this server", autoApprovable: true };
    }
    if (mcp?.readOnlyHint) {
      return { level: "medium", reason: "MCP tool marked read-only by its server", autoApprovable: false };
    }
    return { level: "medium", reason: "MCP connector tool — external side effects", autoApprovable: false };
  }

  // 7. Unknown tool — fail closed
  return { level: "medium", reason: "Unrecognized tool — requires review", autoApprovable: false };
}

function isSafeWritePath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  return SAFE_WRITE_PREFIXES.some(prefix => normalized.startsWith(prefix));
}

/** Tier ordering helper for sorting dialogs (high first) */
export function riskRank(level: RiskLevel): number {
  return level === "high" ? 3 : level === "medium" ? 2 : 1;
}
