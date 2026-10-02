// notify.ts — One call, three surfaces: durable row (bell inbox), brief toast
// poll (3s, client-driven), and optional OS notification via the Electron
// tray. Server routes call notify(); the client's NotificationCenter hook
// polls /api/notifications, shows fresh items as a 3-second toast, then the
// item lives on behind the bell with an unread badge.
//
// Design rules:
//  - notify() NEVER throws — a broken notification path must never break the
//    operation that triggered it (model trials, run completion, …).
//  - Dedup window: identical (title+message) within 60s collapses to one row
//    so a burst of failing probes can't spam the inbox.

import { prisma } from "./prisma";

export type NotifyType = "info" | "success" | "error" | "warning";
export type NotifySource = "models" | "runs" | "approvals" | "system" | "keys";

export interface NotifyInput {
  type?: NotifyType;
  title: string;
  message: string;
  source?: NotifySource;
}

/** In-memory dedup: "userId:title|message-hash" → last-emitted timestamp. */
const recent = new Map<string, number>();
const DEDUP_MS = 60_000;

function dedupeKey(userId: string, input: NotifyInput): string {
  let h = 5381;
  const s = `${input.title}\u0000${input.message}`;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return `${userId}:${h.toString(36)}`;
}

/** Fire-and-forget safe: logs failures, never throws to the caller. */
export async function notify(userId: string, input: NotifyInput): Promise<void> {
  try {
    if (!userId || !input?.title || !input?.message) return;
    const key = dedupeKey(userId, input);
    const last = recent.get(key) ?? 0;
    if (Date.now() - last < DEDUP_MS) return;
    recent.set(key, Date.now());
    // Bounded map: drop stale entries past 500.
    if (recent.size > 500) {
      const now = Date.now();
      for (const [k, t] of recent) if (now - t > DEDUP_MS) recent.delete(k);
    }
    await prisma.notification.create({
      data: {
        userId,
        type: input.type ?? "info",
        title: input.title.slice(0, 120),
        message: input.message.slice(0, 2000),
        source: input.source ?? "system",
      },
    });
  } catch (err) {
    console.warn("[notify] failed to store notification:", (err as Error)?.message || err);
  }
}
