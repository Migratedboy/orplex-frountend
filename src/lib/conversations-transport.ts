/**
 * conversations-transport.ts — transport layer for conversation CRUD.
 *
 * Desktop: routes through the Electron bridge to the on-device JSON store
 * (local-first — no network, no cloud dependency).
 * Web build (no Electron bridge): falls back to the exact cloud API calls
 * the app used before, so the deployed web app keeps behaving as today.
 *
 * Every function mirrors one backend/bridge behavior 1:1 (caps, semantics,
 * error contract) so call sites don't branch on transport.
 */

import { apiFetch } from "@/lib/api-base";

export interface ConversationMessagePayload {
  role: string;
  content: string;
}

/** Sidebar/History row shape (previews already cleaned upstream). */
export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  workspaceName?: string | null;
  messages: { content: string }[];
}

/** Full thread for the transcript view. */
export interface ConversationFull {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  workspaceName?: string | null;
  messages: Array<{ role: string; content: string; createdAt: string }>;
}

export interface SaveConversationInput {
  conversationId?: string | null;
  workspaceName?: string | null;
  messages: ConversationMessagePayload[];
}

export interface SaveConversationResult {
  conversationId?: string;
  /** Matches the cloud contract (messages cut at 50k chars). */
  truncatedMessages?: number;
  error?: string;
}

/** The Electron bridge owning the local store, or null on the web build. */
export function localConversationsBridge():
  | NonNullable<Window["orplexDesktop"]>["conversations"]
  | null {
  if (typeof window === "undefined") return null;
  return window.orplexDesktop?.conversations ?? null;
}

export function isLocalConversationMode(): boolean {
  return localConversationsBridge() !== null;
}

export async function listConversations(signal?: AbortSignal): Promise<ConversationSummary[]> {
  const bridge = localConversationsBridge();
  if (bridge) return await bridge.list();
  const res = await apiFetch("/api/conversations", { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { conversations?: ConversationSummary[] };
  return data.conversations ?? [];
}

export async function getConversation(id: string): Promise<ConversationFull | null> {
  const bridge = localConversationsBridge();
  if (bridge) return await bridge.get(id);
  const res = await apiFetch(`/api/conversations?id=${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as { conversation?: ConversationFull | null };
  return data.conversation ?? null;
}

const MAX_MESSAGE_CHARS = 50_000;

/** Cloud parity: count how many messages exceed the 50k row cap. */
function truncationCount(messages: ConversationMessagePayload[]): number {
  let n = 0;
  for (const m of messages) if (typeof m.content === "string" && m.content.length > MAX_MESSAGE_CHARS) n++;
  return n > 200 ? 200 : n;
}

export async function saveConversation(input: SaveConversationInput): Promise<SaveConversationResult> {
  const bridge = localConversationsBridge();
  if (bridge) {
    const out = await bridge.save(input);
    if ("conversationId" in out) return { conversationId: out.conversationId, truncatedMessages: truncationCount(input.messages) };
    return out; // { error }
  }
  const body: Record<string, unknown> = {};
  if (input.conversationId !== undefined) body.conversationId = input.conversationId;
  if (input.workspaceName !== undefined && input.workspaceName !== null) body.workspaceName = input.workspaceName;
  body.messages = input.messages;
  const res = await apiFetch("/api/conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { conversationId?: string; error?: string };
  if (!res.ok) return { error: `HTTP ${res.status}` };
  return { conversationId: data.conversationId, truncatedMessages: truncationCount(input.messages) };
}

export async function renameConversation(id: string, title: string): Promise<void> {
  const bridge = localConversationsBridge();
  if (bridge) {
    if (!(await bridge.rename(id, title))) throw new Error(`rename failed: ${id}`);
    return;
  }
  const res = await apiFetch(`/api/conversations/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) throw new Error(`rename failed: HTTP ${res.status}`);
}

export async function deleteConversation(id: string): Promise<void> {
  const bridge = localConversationsBridge();
  if (bridge) {
    if (!(await bridge.remove(id))) throw new Error(`delete failed: ${id}`);
    return;
  }
  const res = await apiFetch(`/api/conversations/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`delete failed: HTTP ${res.status}`);
}

/** Desktop-only (local store deep-copy). Null on the web build — fork buttons
 * hide when the bridge is absent. */
export async function forkConversation(
  id: string
): Promise<{ conversationId: string; copied: number } | null> {
  const bridge = localConversationsBridge();
  if (!bridge) return null;
  const copy = await bridge.fork(id);
  if (!copy) return null;
  return { conversationId: copy.id, copied: copy.messages.length };
}
