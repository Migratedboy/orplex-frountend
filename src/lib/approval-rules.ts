// approval-rules.ts — persistent "Always allow" rules for command approvals.
//
// Scope is deliberately narrow and conservative: a rule matches ONE exact
// command string, in ONE workspace. There is no prefix/head matching (the old
// SDK store keyed rules on the first two words, so an "npm test" rule also
// approved "npm test --anything"), and dangerous commands can never produce a
// rule at all.
//
// Storage: localStorage on this device, next to the other per-device app
// settings. That matches ARCHITECTURE.md's local-first line — approval rules
// are a property of this machine's workspaces, not of the cloud account, and
// the agent loop (the SDK approval store) runs in this same renderer realm.

import { classifyRisk } from "./risk-classifier";

export interface AlwaysAllowRule {
  /** The exact command text (trimmed), never a prefix. */
  command: string;
  /** Workspace folder identity, normalized by normalizeWorkspace(). */
  workspace: string;
  /** Epoch ms when the rule was created. */
  addedAt: number;
}

export const RULES_STORAGE_KEY = "orplex:approval-rules:v1";
/** The SDK store's old rule bag. Command entries are migrated, then removed. */
export const LEGACY_ALWAYS_KEY = "orplex:always-allow";
export const RULES_CHANGED_EVENT = "orplex:approval-rules-changed";
export const NO_WORKSPACE = "(no workspace)";

/** Workspace identity: last path segment, lower-cased (Windows paths are case-insensitive). */
export function normalizeWorkspace(workspace?: string | null): string {
  const raw = String(workspace ?? "").trim().replace(/[\\/]+$/, "");
  if (!raw) return NO_WORKSPACE;
  const segment = raw.split(/[\\/]/).filter(Boolean).pop() || raw;
  return segment.toLowerCase();
}

export function normalizeCommand(command: unknown): string {
  return typeof command === "string" ? command.trim() : "";
}

/**
 * Commands that must never become an auto-approved rule.
 *
 * The first line of defence is the app's own classifier (classifyRisk →
 * "high": rm -rf, sudo, git push, curl | sh, writes to sensitive files…).
 * The patterns below cover the cases that classifier does not name: pipe to a
 * shell/interpreter in other spellings, redirects OUTSIDE the workspace
 * (except the /dev/null sink), leaving the workspace directory, and disk /
 * account-level operations.
 */
const EXTRA_DANGEROUS: RegExp[] = [
  /(^|[;&|]\s*)(sudo|doas|pkexec|su)\b/i,
  /\|\s*(?:ba|z|k|da)?sh\b/i,
  /\|\s*(?:iex|invoke-expression|powershell|pwsh)\b/i,
  />\s*(?:\/(?!dev\/null\b)|~|\$HOME|%USERPROFILE%|[a-z]:[\\/])/i,
  /\bcd\s+(?:\.\.|~|\/|[a-z]:[\\/])/i,
  /\b(?:format|diskpart|mkfs|shutdown|reboot|reg\s+delete|schtasks)\b/i,
  /\.ssh\b|id_rsa|\.aws[\\/]credentials|\/etc\//i,
];

/** True when the app's risk rules (plus the extra screens above) say never auto-approve. */
export function isDangerousCommand(command: string): boolean {
  const cmd = normalizeCommand(command);
  if (!cmd) return false;
  if (classifyRisk("run_command", { command: cmd }).level === "high") return true;
  return EXTRA_DANGEROUS.some((re) => re.test(cmd));
}

/** Whether "Always allow" may be offered/stored for this command. */
export function canAlwaysAllow(command: string): boolean {
  const cmd = normalizeCommand(command);
  if (!cmd) return false;
  return !isDangerousCommand(cmd);
}

/** One-line risk copy for the approval card. */
export function describeCommandRisk(level: string, reason: string): string {
  const label = level === "high" ? "High" : level === "low" ? "Low" : "Medium";
  const detail = reason.trim().replace(/\.+$/, "");
  return detail ? `${label} risk. ${detail}.` : `${label} risk.`;
}

function storage(): Storage | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

function isRule(value: unknown): value is AlwaysAllowRule {
  if (!value || typeof value !== "object") return false;
  const rule = value as Partial<AlwaysAllowRule>;
  return (
    typeof rule.command === "string" &&
    rule.command.trim().length > 0 &&
    typeof rule.workspace === "string" &&
    rule.workspace.length > 0 &&
    typeof rule.addedAt === "number" &&
    Number.isFinite(rule.addedAt)
  );
}

function notify(): void {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new CustomEvent(RULES_CHANGED_EVENT));
  } catch {
    /* no window/CustomEvent — nothing is listening anyway */
  }
}

function saveRules(rules: AlwaysAllowRule[]): void {
  const store = storage();
  if (!store) throw new Error("Allow rules can only be saved inside the app.");
  try {
    store.setItem(RULES_STORAGE_KEY, JSON.stringify(rules));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not save the allow rule: ${detail}`);
  }
  notify();
}

/** Rules for this device, newest first. Dangerous leftovers are dropped on read. */
export function listRules(): AlwaysAllowRule[] {
  const store = storage();
  if (!store) return [];
  let raw: string | null = null;
  try {
    raw = store.getItem(RULES_STORAGE_KEY);
  } catch {
    return [];
  }
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter(isRule)
    .filter((rule) => canAlwaysAllow(rule.command))
    .map((rule) => ({ command: rule.command.trim(), workspace: rule.workspace, addedAt: rule.addedAt }))
    .sort((a, b) => b.addedAt - a.addedAt);
}

/** The rule that covers this exact command in this workspace, if any. */
export function findRule(command: string, workspace?: string | null): AlwaysAllowRule | null {
  const cmd = normalizeCommand(command);
  if (!cmd) return null;
  const ws = normalizeWorkspace(workspace);
  return listRules().find((rule) => rule.command === cmd && rule.workspace === ws) ?? null;
}

export function addRule(command: string, workspace?: string | null, addedAt: number = Date.now()): AlwaysAllowRule {
  const cmd = normalizeCommand(command);
  if (!cmd) throw new Error("There is no command to allow.");
  if (!canAlwaysAllow(cmd)) {
    throw new Error("This command is too dangerous to allow automatically.");
  }
  const rule: AlwaysAllowRule = { command: cmd, workspace: normalizeWorkspace(workspace), addedAt };
  const rules = listRules();
  const existing = rules.find((r) => r.command === rule.command && r.workspace === rule.workspace);
  if (existing) return existing;
  saveRules([...rules, rule]);
  return rule;
}

/** Really deletes the rule. Returns true when a stored rule was removed. */
export function removeRule(command: string, workspace?: string | null): boolean {
  const cmd = normalizeCommand(command);
  const ws = normalizeWorkspace(workspace);
  const rules = listRules();
  const next = rules.filter((rule) => !(rule.command === cmd && rule.workspace === ws));
  if (next.length === rules.length) return false;
  saveRules(next);
  return true;
}

/**
 * One-time migration of the SDK store's command rules into the scoped store.
 *
 * The old bag keyed commands on their first two words and had no workspace, so
 * those entries are re-created as exact commands for the ACTIVE workspace
 * (users re-add anything bootstrapped elsewhere). Dangerous leftovers are
 * dropped rather than migrated, and non-command entries (write/edit paths)
 * stay in the legacy bag untouched — that UI is not part of this change.
 */
export function migrateLegacyCommandRules(workspace?: string | null, now: number = Date.now()): number {
  const store = storage();
  if (!store) return 0;
  let raw: string | null = null;
  try {
    raw = store.getItem(LEGACY_ALWAYS_KEY);
  } catch {
    return 0;
  }
  if (!raw) return 0;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    try {
      store.removeItem(LEGACY_ALWAYS_KEY);
    } catch {
      /* nothing else we can do */
    }
    return 0;
  }
  if (!Array.isArray(parsed)) return 0;

  const ws = normalizeWorkspace(workspace);
  const rules = listRules();
  const keep: unknown[] = [];
  let migrated = 0;
  let changed = false;

  for (const entry of parsed) {
    const type = entry && typeof entry === "object" ? (entry as { type?: unknown }).type : undefined;
    if (type !== "run_command") {
      keep.push(entry);
      continue;
    }
    changed = true;
    const key = normalizeCommand(entry && typeof entry === "object" ? (entry as { key?: unknown }).key : "");
    if (!key || !canAlwaysAllow(key)) continue;
    if (rules.some((rule) => rule.command === key && rule.workspace === ws)) continue;
    rules.push({ command: key, workspace: ws, addedAt: now });
    migrated += 1;
  }

  if (!changed) return 0;

  if (migrated > 0) saveRules(rules);
  try {
    if (keep.length > 0) store.setItem(LEGACY_ALWAYS_KEY, JSON.stringify(keep));
    else store.removeItem(LEGACY_ALWAYS_KEY);
  } catch {
    /* leaving the legacy bag in place is safe: commands were already migrated */
  }
  return migrated;
}

/** Re-render helper for the Settings list; fires on local writes and cross-tab changes. */
export function subscribeRules(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onChange = () => listener();
  window.addEventListener(RULES_CHANGED_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(RULES_CHANGED_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}
