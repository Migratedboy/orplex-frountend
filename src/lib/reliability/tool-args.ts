/**
 * reliability/tool-args.ts — zod schemas for the EXISTING tool arguments,
 * generated from one registry (plan §8.2 / deviation D-3: "generate the Zod
 * schemas FROM the registry so the 6 name-lists get one source of truth as a
 * side effect").
 *
 * The product keeps its tool-name lists by hand in at least six places —
 * plan-gate.ts WRITE_TOOLS, native-tools.ts's ask-mode and no-fs lists,
 * background-worker.ts's write counters, contract/tools.ts
 * STATE_CHANGING_TOOLS, loop-detect.ts READ_ONLY_TOOLS, master-prompt's
 * category regex — and they have already drifted (plan-gate was missing
 * batch_edit/write_file_chunk until it was fixed from its own registry;
 * finding §5.5 shows move_file/delete_file gated while extract_archive was
 * not). TOOL_REGISTRY below is the single table; the sets and the schema map
 * are DERIVED from it, so adding a tool is one edit.
 *
 * Validation contract:
 *  - unknown tool names return { ok: true } — a new tool (or an MCP tool this
 *    module has not seen) must never hard-break dispatch;
 *  - when a schema exists it validates the published shape (tool-definitions
 *    required fields), and is otherwise permissive: unknown keys are stripped,
 *    never rejected, so validation never fails a call the dispatcher accepts.
 *
 * Nothing here gates anything by itself. The wiring call site decides when
 * validateToolArgs runs and what a failure does (see REPORT notes in the
 * phase doc): the flag (reliabilityEditOpsEnabled) decides whether the
 * stricter path is on at all.
 */
import { z } from "zod";
import { EDIT_OPS_TOOL_NAME, editOpSchema } from "./edit-ops";
import { formatZodError } from "./zod-errors";

/**
 * One registry row. `writes`/`mutating` drive the exported name sets:
 *  - writes: can change the workspace — files directly, or anything a
 *    spawned command does. Superset of plan-gate.ts's WRITE_TOOLS (which
 *    includes run_command for exactly this reason) plus the ones it misses
 *    (run_in_sandbox, extract_archive, the structured-edit tool).
 *  - mutating: approval/streak-relevant state changes — everything that
 *    writes, plus browser actions and mcp_call. Superset of
 *    contract/tools.ts STATE_CHANGING_TOOLS. Deliberately EXCLUDES the
 *    read-only tools (loop-detect READ_ONLY_TOOLS), the in-app note tools
 *    (todo_list/scratchpad_update/ask_*), and the verification tools
 *    (preview_browser/verify_app) — gating those would change behaviour the
 *    product does not want gated.
 */
interface ToolSpec {
  schema: z.ZodTypeAny;
  writes: boolean;
  mutating: boolean;
}

const pathArg = z.string().min(1, "path required");
const queryArg = z.string().min(1, "query required");

const fileEditItemSchema = z.object({
  path: pathArg,
  old_text: z.string().min(1, "old_text required"),
  new_text: z.string(),
});

const TOOL_REGISTRY: Record<string, ToolSpec> = {
  // ── workspace file tools ──────────────────────────────────────────────
  write_file: {
    schema: z.object({ path: pathArg, content: z.string() }),
    writes: true,
    mutating: true,
  },
  write_file_chunk: {
    schema: z.object({ path: pathArg, content: z.string() }),
    writes: true,
    mutating: true,
  },
  edit_file: {
    schema: z.object({ path: pathArg, old_text: z.string().min(1, "old_text required"), new_text: z.string() }),
    writes: true,
    mutating: true,
  },
  batch_edit: {
    schema: z.object({ edits: z.array(fileEditItemSchema) }),
    writes: true,
    mutating: true,
  },
  [EDIT_OPS_TOOL_NAME]: {
    // The Phase 3 structured surface (edit-ops.ts) — validated with the same
    // union applyEditOpsAtomic consumes.
    schema: editOpSchema,
    writes: true,
    mutating: true,
  },
  move_file: {
    schema: z.object({ from: pathArg, to: pathArg }),
    writes: true,
    mutating: true,
  },
  delete_file: {
    schema: z.object({ path: pathArg }),
    writes: true,
    mutating: true,
  },
  undo_last_change: {
    schema: z.object({ path: pathArg }),
    writes: true,
    mutating: true,
  },
  extract_archive: {
    schema: z.object({ path: pathArg, dest: z.string().optional() }),
    writes: true,
    mutating: true,
  },

  // ── command tools (workspace-changing via a shell) ────────────────────
  run_command: {
    schema: z.object({ command: z.string().min(1, "command required") }),
    writes: true,
    mutating: true,
  },
  run_in_sandbox: {
    schema: z.object({ command: z.string().min(1, "command required"), timeout: z.number().optional() }),
    writes: true,
    mutating: true,
  },

  // ── read / search tools ───────────────────────────────────────────────
  read_file: {
    // offset/limit are the paged-read path the dispatcher already supports.
    schema: z.object({ path: pathArg, offset: z.number().optional(), limit: z.number().optional() }),
    writes: false,
    mutating: false,
  },
  list_files: {
    schema: z.object({ path: z.string().optional() }),
    writes: false,
    mutating: false,
  },
  search_code: {
    // contract/tools.ts accepts query OR pattern.
    schema: z
      .object({ query: queryArg.optional(), pattern: queryArg.optional() })
      .refine((v) => Boolean(v.query || v.pattern), { message: "query required" }),
    writes: false,
    mutating: false,
  },
  code_search: {
    schema: z.object({ query: queryArg, context: z.number().optional() }),
    writes: false,
    mutating: false,
  },
  web_search: {
    schema: z.object({ query: queryArg }),
    writes: false,
    mutating: false,
  },
  playbook_search: {
    schema: z.object({ query: queryArg }),
    writes: false,
    mutating: false,
  },
  session_search: {
    schema: z.object({ query: queryArg }),
    writes: false,
    mutating: false,
  },
  take_screenshot: {
    schema: z.object({ url: queryArg }),
    writes: false,
    mutating: false,
  },

  // ── in-app note / conversation tools (never gated) ────────────────────
  todo_list: {
    schema: z.object({
      action: z.enum(["create", "update", "complete", "clear"]),
      items: z.array(z.string()).optional(),
      completed_index: z.number().optional(),
    }),
    writes: false,
    mutating: false,
  },
  scratchpad_update: {
    schema: z.object({
      section: z.enum(["plan", "hypotheses", "findings", "next"]),
      content: z.string(),
    }),
    writes: false,
    mutating: false,
  },
  ask_question: {
    schema: z.object({
      question: queryArg,
      options: z.array(z.string()),
      allow_free_text: z.boolean().optional(),
    }),
    writes: false,
    mutating: false,
  },
  ask_clarification: {
    schema: z.object({
      question: queryArg,
      context: queryArg,
      options: z.array(z.string()).optional(),
      allow_freetext: z.boolean().optional(),
    }),
    writes: false,
    mutating: false,
  },
  skill_create: {
    // Accepts `text` (published) or `content` (legacy dispatcher fallback).
    schema: z
      .object({
        title: queryArg,
        text: z.string().min(1).optional(),
        content: z.string().min(1).optional(),
      })
      .refine((v) => Boolean(v.text || v.content), { message: "text required" }),
    writes: false,
    mutating: true,
  },

  // ── preview / verification (must stay frictionless) ───────────────────
  preview_browser: {
    schema: z.object({ url: queryArg }),
    writes: false,
    mutating: false,
  },
  verify_app: {
    schema: z.object({
      path: z.string().optional(),
      dev_command: z.string().optional(),
      port: z.number().optional(),
      interactions: z
        .array(
          z.object({
            action: z.string().optional(),
            selector: z.string().optional(),
            value: z.union([z.string(), z.number()]).optional(),
          }),
        )
        .optional(),
    }),
    writes: false,
    mutating: false,
  },

  // ── browser tools ─────────────────────────────────────────────────────
  browser_navigate: {
    schema: z.object({ url: queryArg }),
    writes: false,
    mutating: true,
  },
  browser_read: {
    schema: z.object({}),
    writes: false,
    mutating: false,
  },
  browser_click: {
    schema: z
      .object({ selector: z.string().optional(), ref: z.string().optional() })
      .refine((v) => Boolean(v.selector || v.ref), { message: "selector or ref required" }),
    writes: false,
    mutating: true,
  },
  browser_type: {
    schema: z
      .object({ selector: z.string().optional(), ref: z.string().optional(), text: z.string() })
      .refine((v) => Boolean(v.selector || v.ref), { message: "selector or ref required" }),
    writes: false,
    mutating: true,
  },
  browser_press: {
    schema: z.object({ key: queryArg }),
    writes: false,
    mutating: true,
  },
  browser_scroll: {
    schema: z.object({ amount: z.number().optional() }),
    writes: false,
    mutating: true,
  },
  browser_console: {
    schema: z.object({}),
    writes: false,
    mutating: false,
  },
  browser_screenshot: {
    schema: z.object({ fullPage: z.boolean().optional(), viewpoint: z.string().optional() }),
    writes: false,
    mutating: false,
  },
  browser_find: {
    schema: z.object({ text: z.string().optional(), role: z.string().optional() }),
    writes: false,
    mutating: false,
  },
  browser_wait_for: {
    schema: z
      .object({
        text: z.string().optional(),
        selector: z.string().optional(),
        time: z.number().optional(),
        timeoutMs: z.number().optional(),
      })
      .refine((v) => v.text !== undefined || v.selector !== undefined || v.time !== undefined, {
        message: "text, selector or time required",
      }),
    writes: false,
    mutating: false,
  },
  browser_hover: {
    schema: z
      .object({ selector: z.string().optional(), ref: z.string().optional() })
      .refine((v) => Boolean(v.selector || v.ref), { message: "selector or ref required" }),
    writes: false,
    mutating: true,
  },
  browser_select: {
    schema: z
      .object({
        selector: z.string().optional(),
        ref: z.string().optional(),
        value: z.union([z.string(), z.number()]).optional(),
      })
      .refine((v) => Boolean(v.selector || v.ref) && v.value !== undefined, {
        message: "selector or ref, and value, required",
      }),
    writes: false,
    mutating: true,
  },
  browser_tabs: {
    schema: z.object({ action: z.string().optional(), url: z.string().optional(), index: z.number().optional() }),
    writes: false,
    mutating: false,
  },
  browser_network: {
    schema: z.object({}),
    writes: false,
    mutating: false,
  },
  browser_evaluate: {
    schema: z.object({ code: queryArg }),
    writes: false,
    mutating: true,
  },

  // ── MCP ───────────────────────────────────────────────────────────────
  mcp_call: {
    // arguments is the remote tool's own object — validated by that server,
    // not here.
    schema: z.object({ serverId: queryArg, tool: queryArg, arguments: z.unknown().optional() }),
    writes: false,
    mutating: true,
  },
};

/** schema per tool name — derived from TOOL_REGISTRY, never hand-listed. */
export const TOOL_ARG_SCHEMAS: Record<string, z.ZodTypeAny> = {};
/** tools that can change the workspace (plan-gate surface). */
export const WRITE_TOOL_NAMES: Set<string> = new Set();
/** tools that change files, run code, drive the page, or write durable state. */
export const MUTATING_TOOL_NAMES: Set<string> = new Set();

for (const [name, spec] of Object.entries(TOOL_REGISTRY)) {
  TOOL_ARG_SCHEMAS[name] = spec.schema;
  if (spec.writes) WRITE_TOOL_NAMES.add(name);
  if (spec.mutating) MUTATING_TOOL_NAMES.add(name);
}

/**
 * Validate one tool call's args against the registry. Unknown tools pass
 * through untouched ({ ok: true }) so a tool this module does not know about
 * can never hard-break dispatch; known tools must match their schema.
 */
export function validateToolArgs(
  toolName: string,
  args: unknown,
): { ok: true } | { ok: false; error: string } {
  const spec = TOOL_REGISTRY[toolName];
  if (!spec) return { ok: true };
  const parsed = spec.schema.safeParse(args ?? {});
  if (parsed.success) return { ok: true };
  return { ok: false, error: `${toolName}: ${formatZodError(parsed.error)}` };
}
