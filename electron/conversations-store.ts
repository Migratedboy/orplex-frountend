/**
 * conversations-store.ts — local-first conversation storage for the Electron
 * main process.
 *
 * Conversations become ON-DEVICE data in the desktop app: the JSON file in
 * userData is the source of truth, written atomically (temp file + rename)
 * behind a short debounce so a burst of saves costs one disk write. The cloud
 * backend is explicitly NOT deleted — after the one-time import the backend
 * rows simply stop receiving writes and act as a stale backup.
 *
 * No `electron` imports on purpose: this module is plain Node so jest can
 * exercise the exact code the main process runs. `main.ts` takes the file
 * path from app.getPath("userData") and passes it in.
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface StoredMessage {
  role: string; // "user" | "assistant" | "system"
  content: string;
  createdAt: string; // ISO
}

export interface StoredConversation {
  id: string;
  title: string;
  /** Workspace folder NAME this thread belongs to (null = Ungrouped). */
  workspaceName: string | null;
  createdAt: string;
  updatedAt: string;
  messages: StoredMessage[];
}

interface StoreFile {
  version: 1;
  conversations: StoredConversation[];
}

const FILE_VERSION: 1 = 1;
/** Same cap the cloud API enforces when a message row is written. */
const MAX_MESSAGE_CHARS = 50_000;
/** Same cap the cloud POST endpoint enforces per save call. */
const MAX_MESSAGES_PER_SAVE = 200;
/** Sidebar/History previews cap — mirrors the backend title derivation. */
const TITLE_MAX = 60;

/**
 * Strip internal display markers for list previews — ported 1:1 from the
 * backend's cleanSnippet (src/app/api/conversations/route.ts) so local and
 * cloud previews look identical in the Sidebar and History page.
 */
export function cleanSnippet(content: string | null | undefined): string {
  if (!content) return "";
  let text = content
    .replace(/\[THINKING\][\s\S]*?(\[\/THINKING\]|$)/gi, " ")
    .replace(/^\[(?:OK|FAIL|BLOCKED|SUCCESS|ERROR)\][^\n]*$/gim, " ")
    .replace(/<\/?tool_(?:call|result)[^>]*>[\s\S]*?(?:<\/tool_(?:call|result)>|$)/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) {
    text = content.replace(/\[(?:THINKING|\/THINKING)\]/gi, "").replace(/\s+/g, " ").trim();
  }
  return text;
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeIncomingMessage(m: { role?: unknown; content?: unknown }): StoredMessage | null {
  const role = m.role === "user" || m.role === "assistant" || m.role === "system" ? m.role : null;
  if (!role || typeof m.content !== "string") return null;
  return {
    role,
    content: m.content.slice(0, MAX_MESSAGE_CHARS),
    createdAt: nowIso(),
  };
}

function titleFromMessages(messages: StoredMessage[], fallback = "New Chat"): string {
  const first = messages.find((m) => m.role === "user");
  return first && first.content ? first.content.slice(0, TITLE_MAX) : fallback;
}

export interface LocalConversationStore {
  /** Sidebar/History shape: conv meta + the CLEANED latest message preview. */
  list(): Array<Omit<StoredConversation, "messages"> & { messages: { content: string }[] }>;
  /** Full transcript for the message list; deep copy so the renderer can't
   * mutate main's in-memory store through the IPC bridge. */
  get(id: string): StoredConversation | null;
  /** Backend POST parity: append to an existing thread or create a new one. */
  save(input: {
    conversationId?: string | null;
    workspaceName?: string | null;
    messages: Array<{ role?: unknown; content?: unknown }>;
  }): { conversationId: string } | { error: string };
  rename(id: string, title: string): boolean;
  remove(id: string): boolean;
  /** One-time cloud import: merge externally-shaped conversations in. Rows
   * with an id that already exists locally are skipped (never overwritten). */
  importAll(
    conversations: Array<{
      id?: unknown;
      title?: unknown;
      workspaceName?: unknown;
      createdAt?: unknown;
      updatedAt?: unknown;
      messages?: unknown;
    }>
  ): { imported: number; skipped: number };
  /** Fork (Phase 2): deep-copy a local thread under a fresh id. */
  fork(id: string): StoredConversation | null;
  flush(): void;
}

export function createConversationStore(opts?: {
  /** Absolute path of the JSON file. Required in production wiring. */
  file?: string;
  /** Injectable clock for tests. */
  now?: () => Date;
  /** Debounce window for disk writes (ms). */
  writeDelayMs?: number;
}): LocalConversationStore {
  const now = opts?.now ?? (() => new Date());
  const file = opts?.file;
  const writeDelayMs = opts?.writeDelayMs ?? 250;

  let conversations: StoredConversation[] = [];
  let loaded = false;
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function load(): void {
    if (loaded) return;
    loaded = true;
    if (!file || !fs.existsSync(file)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as StoreFile;
      if (parsed && Array.isArray(parsed.conversations)) {
        conversations = parsed.conversations.filter(
          (c) => c && typeof c.id === "string" && Array.isArray(c.messages)
        );
      }
    } catch (e) {
      // Corrupted store: rename it aside instead of losing the user's history
      // to an unrecoverable parse error, then start fresh.
      try {
        fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
      } catch {}
      if (process.env.ORPLEX_VERBOSE) {
        console.warn("[conversations-store] could not parse store file:", e);
      }
    }
  }

  function writeNow(): boolean {
    if (!file || !dirty) return true;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const payload = JSON.stringify({ version: FILE_VERSION, conversations } satisfies StoreFile);
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, payload, "utf8");
      // Atomic swap: a crash mid-write leaves the old file intact.
      fs.renameSync(tmp, file);
      dirty = false;
      return true;
    } catch (e) {
      console.warn("[conversations-store] write failed:", e);
      return false;
    }
  }

  function markDirty(): void {
    dirty = true;
    if (!file) return; // test mode without a file: nothing to persist
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      writeNow();
    }, writeDelayMs);
  }

  function indexOf(id: string): number {
    return conversations.findIndex((c) => c.id === id);
  }

  const store: LocalConversationStore = {
    list() {
      load();
      return [...conversations]
        .sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : b.updatedAt < a.updatedAt ? -1 : 0))
        .map((c) => {
          const latest = c.messages[c.messages.length - 1];
          const { messages: _m, ...meta } = c;
          void _m;
          return { ...meta, messages: latest ? [{ content: cleanSnippet(latest.content) }] : [] };
        });
    },

    get(id) {
      load();
      const found = conversations.find((c) => c.id === id);
      return found ? JSON.parse(JSON.stringify(found)) as StoredConversation : null;
    },

    save(input) {
      load();
      if (!Array.isArray(input.messages) || input.messages.length === 0) {
        return { error: "Messages required" };
      }
      if (input.messages.length > MAX_MESSAGES_PER_SAVE) {
        return { error: "Too many messages" };
      }
      const incoming = input.messages
        .map(normalizeIncomingMessage)
        .filter((m): m is StoredMessage => m !== null);
      if (incoming.length === 0) return { error: "No valid messages" };

      const ts = now().toISOString();
      const ws =
        input.workspaceName === undefined
          ? undefined
          : String(input.workspaceName || "").trim()
          ? String(input.workspaceName!).trim().slice(0, 120)
          : null;

      const existingId = typeof input.conversationId === "string" ? input.conversationId : null;
      if (existingId) {
        const idx = indexOf(existingId);
        if (idx === -1) return { error: "Conversation not found" };
        const conv = conversations[idx];
        conv.messages.push(...incoming);
        conv.updatedAt = ts;
        // Match cloud semantics: a save without a workspace passed never wipes
        // an existing folder tag (undefined = keep, null/""-after-trim = clear).
        if (ws !== undefined) conv.workspaceName = ws;
        markDirty();
        return { conversationId: conv.id };
      }

      const created: StoredConversation = {
        id: `local-${randomUUID()}`,
        title: titleFromMessages(incoming),
        workspaceName: ws ?? null,
        createdAt: ts,
        updatedAt: ts,
        messages: [...incoming],
      };
      conversations.push(created);
      markDirty();
      return { conversationId: created.id };
    },

    rename(id, title) {
      load();
      const idx = indexOf(id);
      if (idx === -1) return false;
      const clean = String(title || "").slice(0, TITLE_MAX);
      if (!clean) return false;
      conversations[idx].title = clean;
      conversations[idx].updatedAt = now().toISOString();
      markDirty();
      return true;
    },

    remove(id) {
      load();
      const idx = indexOf(id);
      if (idx === -1) return false;
      conversations.splice(idx, 1);
      markDirty();
      return true;
    },

    importAll(incomingList) {
      load();
      let imported = 0;
      let skipped = 0;
      for (const raw of incomingList) {
        try {
          if (typeof raw.id !== "string" || !raw.id || indexOf(raw.id) !== -1) {
            skipped++;
            continue;
          }
          const msgs = Array.isArray(raw.messages) ? raw.messages : [];
          const messages = msgs
            .map((m) => {
              const norm = m as { role?: unknown; content?: unknown; createdAt?: unknown };
              const role =
                norm.role === "user" || norm.role === "assistant" || norm.role === "system"
                  ? norm.role
                  : "user";
              return {
                role,
                content: typeof norm.content === "string" ? norm.content.slice(0, MAX_MESSAGE_CHARS) : "",
                createdAt: typeof norm.createdAt === "string" ? norm.createdAt : nowIso(),
              };
            })
            .filter((m) => m.content !== "");
          conversations.push({
            id: raw.id,
            title: typeof raw.title === "string" && raw.title ? raw.title.slice(0, TITLE_MAX) : "New Chat",
            workspaceName:
              typeof raw.workspaceName === "string" && raw.workspaceName
                ? raw.workspaceName.slice(0, 120)
                : null,
            createdAt: typeof raw.createdAt === "string" ? raw.createdAt : nowIso(),
            updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : nowIso(),
            messages,
          });
          imported++;
        } catch {
          skipped++;
        }
      }
      markDirty();
      return { imported, skipped };
    },

    fork(id) {
      load();
      const source = conversations.find((c) => c.id === id);
      if (!source) return null;
      const ts = now().toISOString();
      const copy: StoredConversation = {
        ...JSON.parse(JSON.stringify(source)),
        id: `local-${randomUUID()}`,
        // Forking a fork must not stack "(fork) (fork)" — one suffix, always.
        title: source.title.replace(/ \(fork\)$/, "").slice(0, TITLE_MAX - 6) + " (fork)",
        createdAt: ts,
        updatedAt: ts,
      };
      conversations.push(copy);
      markDirty();
      return JSON.parse(JSON.stringify(copy)) as StoredConversation;
    },

    flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      writeNow();
    },
  };

  return store;
}
