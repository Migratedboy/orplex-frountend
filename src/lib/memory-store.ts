// memory-store.ts — Persistent markdown "memory" virtual filesystem.
//
// Storage shape (per spec): a row per file in the local JSON engine
// (.orplex/db/memoryFile.json), with `path` (unique), `content` (markdown incl.
// frontmatter), `version` (optimistic-lock token) and `updatedAt`.
//
// Paths are validated against the allowed roots so the model can't escape into
// arbitrary locations:
//   /profile.md
//   /preferences.md
//   /topics/<slug>.md
//   /areas/<slug>.md
//   /people/<slug>.md
//
// All writes require `if_version` ("new" for create, else the integer version
// returned by a read). On conflict we return the current content + version so
// the caller can merge and retry in the same turn.

import { prisma } from "./prisma";

export type MemoryVersion = number | "new";

export interface MemoryFile {
  path: string;
  content: string;
  version: number;
  updatedAt: string;
  createdAt: string;
}

export interface MemoryFrontmatter {
  name: string;
  description: string;
  sources: string[];
  aliases: string[];
}

const ALLOWED_ROOTS = ["profile.md", "preferences.md"];

function isValidPath(p: string): boolean {
  if (typeof p !== "string" || !p.startsWith("/")) return false;
  const rel = p.slice(1);
  if (rel.includes("..") || rel.includes("\\") || rel.includes("\0")) return false;
  if (ALLOWED_ROOTS.includes(rel)) return true;
  const m = rel.match(/^(topics|areas|people)\/[a-z0-9][a-z0-9-]*\.md$/);
  return !!m;
}

export function validatePath(p: string): string {
  if (!isValidPath(p)) throw new Error(`invalid memory path: ${p}`);
  return p;
}

export function parseFrontmatter(content: string): { fm: MemoryFrontmatter; body: string } {
  const m = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) {
    return { fm: { name: "", description: "", sources: ["chat"], aliases: [] }, body: content };
  }
  const head = m[1];
  const body = m[2] ?? "";
  const get = (key: string): string => {
    const mm = head.match(new RegExp(`^${key}:\\s*(.*)$`, "m"));
    return mm ? mm[1].trim() : "";
  };
  const name = get("name");
  const description = get("description");
  const sourcesRaw = get("sources");
  const aliasesRaw = get("aliases");
  const parseList = (s: string): string[] => {
    const t = s.replace(/^\[/, "").replace(/\]$/, "").trim();
    if (!t) return [];
    return t.split(",").map((x) => x.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  };
  return {
    fm: {
      name: name || "",
      description: description.slice(0, 150),
      sources: sourcesRaw ? parseList(sourcesRaw) : ["chat"],
      aliases: aliasesRaw ? parseList(aliasesRaw) : [],
    },
    body,
  };
}

export function buildFrontmatter(fm: Partial<MemoryFrontmatter> & { name: string; description: string }): string {
  const sources = (fm.sources && fm.sources.length ? fm.sources : ["chat"]).join(", ");
  const aliases = (fm.aliases && fm.aliases.length ? fm.aliases : []).join(", ");
  return [
    "---",
    `name: ${fm.name}`,
    `description: ${fm.description.slice(0, 150)}`,
    `sources: [${sources}]`,
    `aliases: [${aliases}]`,
    "---",
    "",
  ].join("\n");
}

export async function memoryList(prefix?: string): Promise<Array<{ path: string; name: string; description: string; aliases: string[] }>> {
  const rows = (await prisma.memoryFile.findMany({})) as Array<{ path: string; content: string }>;
  const out: Array<{ path: string; name: string; description: string; aliases: string[] }> = [];
  for (const r of rows) {
    if (prefix && !r.path.startsWith(prefix)) continue;
    const { fm } = parseFrontmatter(r.content);
    out.push({ path: r.path, name: fm.name || r.path.split("/").pop()!.replace(/\.md$/, ""), description: fm.description, aliases: fm.aliases });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export async function memoryRead(paths: string | string[]): Promise<Array<{ path: string; content: string; version: number }>> {
  const list = Array.isArray(paths) ? paths : [paths];
  const out: Array<{ path: string; content: string; version: number }> = [];
  for (const p of list) {
    const v = validatePath(p);
    const row = (await prisma.memoryFile.findUnique({ where: { path: v } })) as { path: string; content: string; version: number } | null;
    if (row) out.push({ path: row.path, content: row.content, version: row.version });
  }
  return out;
}

export interface WriteResult {
  ok: boolean;
  version?: number;
  conflict?: boolean;
  current?: { content: string; version: number };
}

async function upsertWithLock(path: string, content: string, ifVersion: MemoryVersion): Promise<WriteResult> {
  const v = validatePath(path);
  const existing = (await prisma.memoryFile.findUnique({ where: { path: v } })) as { path: string; content: string; version: number } | null;

  if (ifVersion === "new") {
    if (existing) {
      return { ok: false, conflict: true, current: { content: existing.content, version: existing.version } };
    }
    const created = (await prisma.memoryFile.create({ data: { path: v, content, version: 1 } })) as { version: number };
    return { ok: true, version: created.version };
  }

  const expected = typeof ifVersion === "number" ? ifVersion : parseInt(String(ifVersion), 10);
  if (!existing) {
    // file gone — treat as conflict with "new" semantics: allow create at version 1
    const created = (await prisma.memoryFile.create({ data: { path: v, content, version: 1 } })) as { version: number };
    return { ok: true, version: created.version };
  }
  if (existing.version !== expected) {
    return { ok: false, conflict: true, current: { content: existing.content, version: existing.version } };
  }
  const updated = (await prisma.memoryFile.update({ where: { path: v }, data: { content, version: existing.version + 1 } })) as { version: number };
  return { ok: true, version: updated.version };
}

export async function memoryWrite(path: string, content: string, ifVersion: MemoryVersion): Promise<WriteResult> {
  return upsertWithLock(path, content, ifVersion);
}

export async function memoryStrReplace(path: string, oldStr: string, newStr: string, ifVersion: MemoryVersion): Promise<WriteResult & { replaced?: boolean; reason?: string }> {
  const v = validatePath(path);
  const existing = (await prisma.memoryFile.findUnique({ where: { path: v } })) as { content: string; version: number } | null;
  if (!existing) return { ok: false, conflict: true, reason: "file not found" };
  if (ifVersion !== "new" && existing.version !== (typeof ifVersion === "number" ? ifVersion : parseInt(String(ifVersion), 10))) {
    return { ok: false, conflict: true, current: { content: existing.content, version: existing.version } };
  }
  const count = existing.content.split(oldStr).length - 1;
  if (count === 0) return { ok: false, reason: "old_str not found" };
  if (count > 1) return { ok: false, reason: "old_str matches multiple locations — make it more specific" };
  const content = existing.content.replace(oldStr, newStr);
  const updated = (await prisma.memoryFile.update({ where: { path: v }, data: { content, version: existing.version + 1 } })) as { version: number };
  return { ok: true, version: updated.version, replaced: true };
}

export async function memoryAppend(path: string, content: string, ifVersion: MemoryVersion): Promise<WriteResult> {
  const v = validatePath(path);
  const existing = (await prisma.memoryFile.findUnique({ where: { path: v } })) as { content: string; version: number } | null;
  if (!existing) {
    // create new
    const created = (await prisma.memoryFile.create({ data: { path: v, content, version: 1 } })) as { version: number };
    return { ok: true, version: created.version };
  }
  if (ifVersion !== "new" && existing.version !== (typeof ifVersion === "number" ? ifVersion : parseInt(String(ifVersion), 10))) {
    return { ok: false, conflict: true, current: { content: existing.content, version: existing.version } };
  }
  const newContent = existing.content.endsWith("\n") ? existing.content + content : existing.content + "\n" + content;
  const updated = (await prisma.memoryFile.update({ where: { path: v }, data: { content: newContent, version: existing.version + 1 } })) as { version: number };
  return { ok: true, version: updated.version };
}

export async function memoryDelete(path: string, ifVersion: MemoryVersion): Promise<WriteResult> {
  const v = validatePath(path);
  const existing = (await prisma.memoryFile.findUnique({ where: { path: v } })) as { version: number } | null;
  if (!existing) return { ok: false, reason: "not found" } as WriteResult;
  if (ifVersion !== "new" && existing.version !== (typeof ifVersion === "number" ? ifVersion : parseInt(String(ifVersion), 10))) {
    const full = (await prisma.memoryFile.findUnique({ where: { path: v } })) as { content: string; version: number };
    return { ok: false, conflict: true, current: { content: full.content, version: full.version } };
  }
  await prisma.memoryFile.delete({ where: { path: v } });
  return { ok: true };
}

export async function memorySettingGet(userId: string): Promise<{ enabled: boolean; incognito: boolean }> {
  const row = (await prisma.memorySetting.findUnique({ where: { userId } })) as { enabled: boolean; incognito: boolean } | null;
  return row ? { enabled: row.enabled, incognito: row.incognito } : { enabled: true, incognito: false };
}

export async function memorySettingSet(userId: string, patch: { enabled?: boolean; incognito?: boolean }): Promise<void> {
  const existing = (await prisma.memorySetting.findUnique({ where: { userId } })) as { userId: string } | null;
  if (existing) {
    await prisma.memorySetting.update({ where: { userId }, data: patch });
  } else {
    await prisma.memorySetting.create({ data: { userId, enabled: patch.enabled ?? true, incognito: patch.incognito ?? false } });
  }
}

// Context injection helpers
export async function loadMemoryContext(userId: string): Promise<{ profile: string; preferences: string; listing: string } | null> {
  const setting = await memorySettingGet(userId);
  if (!setting.enabled || setting.incognito) return null;
  const files = await memoryList();
  const profileRow = files.find((f) => f.path === "/profile.md");
  const prefRow = files.find((f) => f.path === "/preferences.md");
  const profileRead = profileRow ? await memoryRead("/profile.md") : [];
  const prefRead = prefRow ? await memoryRead("/preferences.md") : [];
  const profile = profileRead[0]?.content ?? "";
  const preferences = prefRead[0]?.content ?? "";
  const listing = files.map((f) => `- ${f.path} — ${f.description}${f.aliases.length ? ` (aliases: ${f.aliases.join(", ")})` : ""}`).join("\n");
  return { profile, preferences, listing };
}
