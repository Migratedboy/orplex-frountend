/**
 * fs-ops-validate.ts — pure validation for Files-tab writes (Right Panel v2,
 * P3; spec §5.3): Windows reserved names, illegal characters, MAX_PATH_LENGTH,
 * and path-jail decisions. Used by /api/agent/fs (and mirrored in tests).
 */

export const MAX_PATH_LENGTH = 500;

const RESERVED = new Set([
  "con", "prn", "aux", "nul",
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

/** A single entry name (file or folder) the user typed. */
export function validateEntryName(name: string): { ok: boolean; reason?: string } {
  if (typeof name !== "string") return { ok: false, reason: "Name must be text" };
  const n = name.trim();
  if (!n) return { ok: false, reason: "Name is empty" };
  if (/[<>:"|?*\x00-\x1f]/.test(n)) return { ok: false, reason: "Name contains illegal characters (< > : \" | ? *)" };
  if (n.includes("/") || n.includes("\\")) return { ok: false, reason: "Use a plain file name, not a path" };
  if (n.endsWith(".") || n.endsWith(" ")) return { ok: false, reason: "Name cannot end with a dot or space" };
  const stem = n.split(".")[0].toLowerCase();
  if (RESERVED.has(stem)) return { ok: false, reason: `"${n.split(".")[0]}" is a reserved Windows name` };
  return { ok: true };
}

/**
 * A workspace-relative path. Returns normalized forward-slash path or null.
 * Rejects absolute paths, `..` escapes, empty segments, oversize paths, and
 * any entry name that fails validateEntryName.
 */
export function normalizeRelPath(p: string): string | null {
  if (typeof p !== "string" || !p.trim()) return null;
  if (/^[a-zA-Z]:/.test(p) || p.startsWith("/") || p.startsWith("\\")) return null; // absolute
  const parts = p.replace(/\\/g, "/").split("/").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.some((s) => s === "." || s === "..")) return null;
  for (const part of parts) {
    if (!validateEntryName(part).ok) return null;
  }
  const joined = parts.join("/");
  if (joined.length > MAX_PATH_LENGTH) return null;
  return joined;
}
