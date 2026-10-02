// project-reopen.ts — Re-open a previously-opened workspace folder without
// the directory picker (Projects sidebar pass 2).
//
// The DECISION LOGIC is pure and dependency-injected so the node Jest suite
// can test every path (granted/denied/unsupported × query/prompt, missing
// handle, attach failure) with fakes. The hook (useFileSystem) supplies the
// real implementations: IndexedDB handle store, Chromium permission API, the
// shared openFolderHandle attach path, and the roster touch.

export type ReopenStatus = "ok" | "invalid" | "not-found" | "denied" | "failed";

export interface ReopenOutcome {
  status: ReopenStatus;
  name: string;
  /** Human-readable message — safe to drop straight into a toast. */
  message: string;
  /** Files available after attach (ok only). */
  fileCount?: number;
}

export interface ReopenDeps {
  /** Load the persisted FileSystemDirectoryHandle for a folder name. */
  loadHandle: (name: string) => Promise<FileSystemDirectoryHandle | null>;
  /**
   * Permission check. query=true MUST be silent (no prompt); query=false may
   * show the one-click prompt. "unsupported" = the environment has no
   * permission API (legacy FS-Access browser) — callers decide what that means.
   */
  checkPermission: (
    handle: FileSystemDirectoryHandle,
    mode: "read" | "readwrite",
    query: boolean
  ) => Promise<"granted" | "denied" | "unsupported">;
  /** Attach the handle as the active workspace (scan → state → register cwd). */
  attach: (handle: FileSystemDirectoryHandle) => Promise<{ fileCount: number }>;
  /** Roster bookkeeping on success (lastOpenedAt bump). */
  touch: (name: string) => void;
}

/**
 * Decide the permission path WITHOUT side effects. Exported for tests.
 *
 * Order: silent query first — a previously-granted session must never pop a
 * prompt. Query "denied" → exactly ONE user prompt; "granted" → go;
 * "unsupported" → best-effort go (legacy browsers never gated access here).
 * After a denied PROMPT the user said no — stop, never re-prompt.
 */
export type PermissionDecision = "go" | "prompt-then-go" | "denied";

export function decidePermissionPath(
  queryResult: "granted" | "denied" | "unsupported",
  promptResult: "granted" | "denied" | "unsupported" | "not-needed"
): PermissionDecision {
  if (queryResult === "granted" || queryResult === "unsupported") return "go";
  if (queryResult === "denied") {
    if (promptResult === "granted" || promptResult === "unsupported") return "go";
    if (promptResult === "denied") return "denied";
  }
  return "denied";
}

/**
 * Re-open a project by folder name. NEVER throws — every failure mode comes
 * back as a typed outcome so the project row stays listed and expandable.
 */
export async function reopenProject(name: string, deps: ReopenDeps): Promise<ReopenOutcome> {
  const trimmed = (name || "").trim();
  if (!trimmed) {
    return { status: "invalid", name, message: "Project name is required to reopen a workspace." };
  }

  // loadHandle hits IndexedDB — a storage failure must not reject this
  // "NEVER throws" contract (it would surface as an uncaught rejection in
  // the caller's event handler). Treat it as a failed reopen.
  let handle: FileSystemDirectoryHandle | null;
  try {
    handle = await deps.loadHandle(trimmed);
  } catch (err) {
    return {
      status: "failed",
      name: trimmed,
      message: `Could not read saved access for "${trimmed}": ${(err as Error)?.message || "storage error"}`,
    };
  }
  if (!handle) {
    return {
      status: "not-found",
      name: trimmed,
      message: `"${trimmed}" was opened on another device (or its saved access was removed). Use Open → pick the folder to re-attach it here.`,
    };
  }

  // Silent query first; only prompt when the query says not-granted. A
  // throwing permission API (SecurityError etc.) is treated as denied —
  // re-opening must never crash the caller.
  let queryResult: "granted" | "denied" | "unsupported";
  try {
    queryResult = await deps.checkPermission(handle, "readwrite", true);
  } catch {
    queryResult = "denied";
  }
  let promptResult: "granted" | "denied" | "unsupported" | "not-needed" = "not-needed";
  if (queryResult === "denied") {
    try {
      promptResult = await deps.checkPermission(handle, "readwrite", false);
    } catch {
      promptResult = "denied";
    }
  }
  const decision = decidePermissionPath(queryResult, promptResult);
  if (decision === "denied") {
    return {
      status: "denied",
      name: trimmed,
      message: `Access to "${trimmed}" was not granted. The project stays in your list — click it again to allow access.`,
    };
  }

  try {
    const { fileCount } = await deps.attach(handle);
    deps.touch(trimmed);
    return { status: "ok", name: trimmed, message: `Reopened "${trimmed}".`, fileCount };
  } catch (err) {
    return {
      status: "failed",
      name: trimmed,
      message: `Could not reopen "${trimmed}": ${(err as Error)?.message || "unknown error"}`,
    };
  }
}
