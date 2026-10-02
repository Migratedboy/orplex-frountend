// user-hooks.ts — User-authored process hooks (.orplex/hooks.json).
//
// Escalates tool-hooks.ts's declarative deny/notify rules to optional
// COMMAND hooks, Claude Code style, but spec-safe by construction:
// every hook command runs through exec-guard (isCommandAllowed), with a
// hard timeout, output cap, and ORPLEX_HOOK_* env context — never a raw
// shell escape for arbitrary payloads.
//
// .orplex/hooks.json:
//   {
//     "hooks": [
//       { "event": "pre-tool",  "match": "run_command", "command": "echo tool ${ORPLEX_TOOL} ran" },
//       { "event": "post-run",  "command": "npm run deploy-preview" }
//     ]
//   }
//
// Events: pre-tool | post-tool | post-run | on-fail
// pre-tool exit code 2 BLOCKS the tool call (agent sees the stderr).
// Opt-in via .env: ORPLEX_USER_HOOKS=1 (default off — desktop hygiene).

import { spawn } from "child_process";
import { platform } from "os";
import { readFile } from "fs/promises";
import { join } from "path";
import { isCommandAllowed } from "./exec-guard";
import { recordRuntimeLog } from "./runtime-log";

export type HookEvent = "pre-tool" | "post-tool" | "post-run" | "on-fail";

export interface HookEntry {
  event: HookEvent;
  /** Optional tool-name or substring matcher (pre/post-tool only). */
  match?: string;
  command: string;
}

export interface ParsedHooks {
  hooks: HookEntry[];
  errors: string[];
}

const MAX_HOOKS = 20;
const HOOK_TIMEOUT_MS = 10_000;
const OUTPUT_CAP = 4_000;

export function parseUserHooks(raw: unknown): ParsedHooks {
  const errors: string[] = [];
  const hooks: HookEntry[] = [];
  const list = (raw as { hooks?: unknown } | null)?.hooks;
  if (!Array.isArray(list)) return { hooks, errors };
  for (const [i, entry] of list.slice(0, MAX_HOOKS).entries()) {
    if (!entry || typeof entry !== "object") {
      errors.push(`hooks[${i}]: not an object`);
      continue;
    }
    const e = entry as Record<string, unknown>;
    const event = e.event;
    if (event !== "pre-tool" && event !== "post-tool" && event !== "post-run" && event !== "on-fail") {
      errors.push(`hooks[${i}]: unknown event "${String(event).slice(0, 40)}"`);
      continue;
    }
    if (typeof e.command !== "string" || !e.command.trim()) {
      errors.push(`hooks[${i}]: command required`);
      continue;
    }
    if (e.command.length > 500) {
      errors.push(`hooks[${i}]: command too long (max 500)`);
      continue;
    }
    hooks.push({
      event,
      match: typeof e.match === "string" ? e.match.slice(0, 100) : undefined,
      command: e.command,
    });
  }
  return { hooks, errors };
}

const cache = new Map<string, { at: number; parsed: ParsedHooks }>();
const CACHE_MS = 60_000;

/** Test hook. */
export function clearUserHookCache(): void {
  cache.clear();
}

/** Load + parse .orplex/hooks.json for a workDir. Cached 60s. Never throws. */
export async function loadUserHooks(workDir: string): Promise<ParsedHooks> {
  const cached = cache.get(workDir);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.parsed;
  let parsed: ParsedHooks = { hooks: [], errors: [] };
  try {
    const raw = await readFile(join(workDir, ".orplex", "hooks.json"), "utf8");
    parsed = parseUserHooks(JSON.parse(raw));
  } catch {
    // missing/unreadable → no hooks
  }
  cache.set(workDir, { at: Date.now(), parsed });
  return parsed;
}

export interface HookRunResult {
  ran: boolean;
  blocked: boolean;
  output: string;
}

/**
 * Run all hooks for an event. Sequential (deterministic ordering), each
 * through exec-guard, 10s timeout, output cap. Never throws. pre-tool
 * exit 2 → blocked.
 */
export async function runUserHooks(
  workDir: string,
  event: HookEvent,
  context: { tool?: string } = {}
): Promise<HookRunResult> {
  if (process.env.ORPLEX_USER_HOOKS !== "1") return { ran: false, blocked: false, output: "" };

  const { hooks } = await loadUserHooks(workDir);
  const matching = hooks.filter(
    (h) => h.event === event && (!h.match || !context.tool || context.tool.toLowerCase().includes(h.match.toLowerCase()))
  );
  if (matching.length === 0) return { ran: false, blocked: false, output: "" };

  let output = "";
  let blocked = false;

  for (const hook of matching) {
    const guard = isCommandAllowed(hook.command);
    if (!guard.allowed) {
      output += `[hook refused by exec-guard: ${guard.reason}]\n`;
      continue;
    }
    const res = await new Promise<{ code: number | null; out: string }>((resolve) => {
      // Hook commands are single-line, user-authored, exec-guard-screened
      // strings — they need a shell to run, but explicitly chosen per
      // platform (the portability-guide pattern) rather than `shell: true`,
      // which silently hands cmd.exe parsing surprises on Windows.
      const isWin = platform() === "win32";
      const child = spawn(
        isWin ? "cmd.exe" : "/bin/sh",
        isWin ? ["/d", "/s", "/c", hook.command] : ["-c", hook.command],
        {
          cwd: workDir,
          env: {
            ...process.env,
            ORPLEX_HOOK_EVENT: event,
            ORPLEX_TOOL: context.tool ?? "",
            ORPLEX_WORKSPACE: workDir,
          },
          windowsHide: true,
        },
      );
      let out = "";
      const timer = setTimeout(() => child.kill(), HOOK_TIMEOUT_MS);
      timer.unref?.();
      child.stdout?.on("data", (d: Buffer) => {
        if (out.length < OUTPUT_CAP) out += d.toString();
      });
      child.stderr?.on("data", (d: Buffer) => {
        if (out.length < OUTPUT_CAP * 2) out += d.toString();
      });
      child.on("error", () => {
        clearTimeout(timer);
        resolve({ code: -1, out: out + "\n[hook failed to start]" });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? -1, out: out.slice(0, OUTPUT_CAP) });
      });
    });
    output += res.out ? `${res.out}\n` : "";
    if (event === "pre-tool" && res.code === 2) {
      blocked = true;
      recordRuntimeLog("workspace", "warn", `pre-tool hook blocked ${context.tool ?? "call"}: ${res.out.slice(0, 120)}`);
      break;
    }
  }

  return { ran: true, blocked, output: output.slice(0, OUTPUT_CAP) };
}
