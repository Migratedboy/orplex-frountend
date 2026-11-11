/**
 * shortcuts.ts — the single-source keyboard shortcut registry (Decision D4).
 *
 * One place defines every global shortcut, resolves the ACTIVE binding for an
 * id (default or the user's override), and dispatches it. The Settings →
 * Keyboard shortcuts page (phase 6) edits the same registry through
 * load/saveOverrides; the shell's dispatcher consumes it via useShortcuts.
 *
 * Defaults are exactly what was wired before the shell refactor (palette
 * Ctrl+K, panel Ctrl+B, terminal Ctrl+T, tabs Ctrl+1…6, sidebar Ctrl+\,
 * new chat Ctrl+N, stop Esc, send Ctrl+Enter, help "?", theme Ctrl+.).
 * "send" stays display-only here — the composer owns its own keydown.
 */
import { useEffect, useRef } from "react";

export interface ShortcutDef {
  id: string;
  label: string;
  group: "General" | "Panels" | "Chat" | "View";
  /** Canonical default binding, e.g. "Ctrl+K", "Escape", "?". */
  keys: string;
  /** Plain-key shortcuts must not fire while typing into an input. */
  guardTyping?: boolean;
  /** Display-only entries (handled inside a component) get no global action. */
  displayOnly?: boolean;
}

export const SHORTCUT_DEFS: ShortcutDef[] = [
  { id: "palette", label: "Command palette", group: "General", keys: "Ctrl+K" },
  { id: "help", label: "Keyboard shortcuts", group: "General", keys: "?", guardTyping: true },
  { id: "panel", label: "Toggle right panel", group: "Panels", keys: "Ctrl+B" },
  { id: "terminal", label: "Open the Terminal tab", group: "Panels", keys: "Ctrl+T" },
  { id: "tab-queue", label: "Go to Queue tab", group: "Panels", keys: "Ctrl+1" },
  { id: "tab-changes", label: "Go to Changes tab", group: "Panels", keys: "Ctrl+2" },
  { id: "tab-files", label: "Go to Files tab", group: "Panels", keys: "Ctrl+3" },
  { id: "tab-browser", label: "Go to Browser tab", group: "Panels", keys: "Ctrl+4" },
  { id: "tab-terminal", label: "Go to Terminal tab", group: "Panels", keys: "Ctrl+5" },
  { id: "tab-scratch", label: "Go to Scratch tab", group: "Panels", keys: "Ctrl+6" },
  { id: "new-chat", label: "New chat", group: "Chat", keys: "Ctrl+N" },
  { id: "stop", label: "Stop the agent", group: "Chat", keys: "Escape" },
  { id: "send", label: "Send message", group: "Chat", keys: "Ctrl+Enter", displayOnly: true },
  { id: "sidebar", label: "Toggle sidebar", group: "View", keys: "Ctrl+\\" },
  { id: "theme", label: "Toggle dark / light", group: "View", keys: "Ctrl+." },
];

/** id → canonical combo string. */
export type ShortcutOverrides = Record<string, string>;

const OVERRIDES_KEY = "orplex.shortcutOverrides";

export function loadOverrides(): ShortcutOverrides {
  try {
    const raw = JSON.parse(localStorage.getItem(OVERRIDES_KEY) ?? "{}") as unknown;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const out: ShortcutOverrides = {};
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof v === "string") out[k] = v;
      }
      return out;
    }
  } catch {}
  return {};
}

export function saveOverrides(overrides: ShortcutOverrides): void {
  try { localStorage.setItem(OVERRIDES_KEY, JSON.stringify(overrides)); } catch {}
}

/** Set (or clear with "") one override. Returns the resulting map. */
export function setOverride(id: string, combo: string): ShortcutOverrides {
  const next = loadOverrides();
  if (combo) next[id] = combo;
  else delete next[id];
  saveOverrides(next);
  window.dispatchEvent(new CustomEvent("orplex:shortcut-changed", { detail: { id, keys: combo } }));
  return next;
}

/** The active binding for a def id (override wins). */
export function bindingFor(id: string): string {
  const def = SHORTCUT_DEFS.find((d) => d.id === id);
  if (!def) return "";
  try { return loadOverrides()[id] ?? def.keys; } catch { return def.keys; }
}

/**
 * Canonical combo string for a keyboard event, e.g. "Ctrl+Shift+\\".
 * Modifiers in fixed order (Ctrl, Alt, Shift, Meta) + the key; null for pure
 * modifier presses and clicks.
 */
export function comboFromEvent(e: KeyboardEvent): string | null {
  const key = e.key;
  if (!key || ["Control", "Alt", "Shift", "Meta", "CapsLock", "NumLock", "ScrollLock"].includes(key)) {
    return null;
  }
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey) parts.push("Meta");
  parts.push(normalizeKey(key));
  return parts.join("+");
}

function normalizeKey(key: string): string {
  if (key === " ") return "Space";
  if (key.length === 1) {
    // Letters arrive lowercase without Shift; canonical form is uppercase.
    return key.toUpperCase();
  }
  return key;
}

export interface ShortcutHandlers {
  [id: string]: (() => void) | undefined;
}

/**
 * Global dispatcher. Mirrors the pre-shell behavior: document-level capture,
 * matched Ctrl/Alt combos preventDefault, "?" guarded from text inputs,
 * Escape fires everywhere (abort is a no-op when nothing runs).
 */
export function useShortcuts(handlers: ShortcutHandlers): void {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const combo = comboFromEvent(e);
      if (!combo || e.repeat) return;
      const overrides = loadOverrides();
      const def = SHORTCUT_DEFS.find(
        (d) => !d.displayOnly && (overrides[d.id] ?? d.keys) === combo
      );
      if (!def) return;
      const action = ref.current[def.id];
      if (!action) return;
      const target = e.target as HTMLElement | null;
      const typing = !!(
        target &&
        (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
      );
      if (typing && def.guardTyping) return;
      if (combo.includes("Ctrl") || combo.includes("Alt") || combo.includes("Meta")) {
        e.preventDefault();
      }
      action();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, []);
}
