// notify-client.ts — Browser-side helper to store a durable notification
// (the bell inbox). The worker runs in the browser and must go through the
// API — same discipline as workspace-memory-client.ts and run-ledger.ts:
// the server route owns Prisma, the client never touches the DB.
//
// notifyUser is fire-and-forget safe: it never throws and never blocks the
// caller (a broken notifications path must never break a task outcome).

import { apiFetch } from "@/lib/api-base";

export type NotifyUserType = "info" | "success" | "error" | "warning";
export type NotifyUserSource = "models" | "runs" | "approvals" | "system" | "keys";

export interface NotifyUserInput {
  type?: NotifyUserType;
  title: string;
  message: string;
  source?: NotifyUserSource;
}

/** Store a notification in the user's bell inbox. Best-effort, never throws. */
export async function notifyUser(input: NotifyUserInput): Promise<void> {
  try {
    if (!input?.title || !input?.message) return;
    await apiFetch("/api/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: input.type ?? "info",
        title: input.title,
        message: input.message,
        source: input.source ?? "system",
      }),
    });
  } catch {
    // Swallow: notifications are cosmetic for the operation at hand.
  }
}
