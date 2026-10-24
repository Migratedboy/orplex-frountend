/**
 * migrate-from-cloud — one-time cloud → local conversation import (desktop).
 *
 * The local-first cut-over stops forwarding /api/conversations to the
 * backend, which would orphan every thread the user already has in the
 * cloud. This route runs in the LOCAL Next server (it sits inside the
 * local-only /api/conversations/ prefix on purpose) and does the backend
 * loopback itself: it lists the caller's cloud threads and fetches each one
 * with FULL messages (the list endpoint only carries a 1-preview snippet),
 * so the Electron main process can import and keep them on-device.
 *
 * Idempotent by design: the store-side import skips conversation ids that
 * already exist locally, so a retry (failed mid-run, another device later)
 * can never duplicate rows. Cloud rows are never deleted — they simply stop
 * receiving writes and act as a stale backup.
 */

import { NextRequest, NextResponse } from "next/server";
import { sessionUserId } from "@/lib/server-session";

const MIGRATE_THREAD_LIMIT = 100;
const PER_THREAD_TIMEOUT_MS = 15_000;

function backendOrigin(): string | null {
  const raw = (process.env.ORPLEX_API_URL || process.env.NEXT_PUBLIC_API_BASE_URL || "")
    .trim()
    .replace(/\/+$/, "");
  return raw || null;
}

interface CloudSummary {
  id?: string;
}
interface CloudMessage {
  role?: string;
  content?: string;
  createdAt?: string;
}
interface CloudConversation {
  id?: string;
  title?: string;
  workspaceName?: string | null;
  createdAt?: string;
  updatedAt?: string;
  messages?: CloudMessage[];
}

export async function POST(request: NextRequest) {
  const imported: Array<{
    id: string;
    title: string | undefined;
    workspaceName: string | null;
    createdAt: string | undefined;
    updatedAt: string | undefined;
    messages: CloudMessage[];
  }> = [];
  let skipped = 0;

  try {
    const userId = await sessionUserId(request);
    // Signed-out: nothing to migrate — the caller records the attempt and
    // moves on (a later signed-in boot would retry, which is correct).
    if (!userId) {
      return NextResponse.json({ imported: 0, skipped: 0 });
    }

    const origin = backendOrigin();
    if (!origin) {
      return NextResponse.json({ imported: 0, skipped: 0 });
    }

    // The backend authenticates via getServerSession over the forwarded
    // session cookies — pass the caller's cookie header through untouched
    // (same mechanism proxy.ts uses for everything it forwards).
    const cookie = request.headers.get("cookie") ?? "";

    // 1) List (newest first) — one request.
    const listRes = await fetch(`${origin}/api/conversations`, {
      headers: { cookie },
      signal: AbortSignal.timeout(PER_THREAD_TIMEOUT_MS),
    });
    if (!listRes.ok) {
      return NextResponse.json({ error: `Cloud list failed (HTTP ${listRes.status})` }, { status: 502 });
    }
    const listData = (await listRes.json().catch(() => null)) as { conversations?: CloudSummary[] } | null;
    const summaries = Array.isArray(listData?.conversations) ? listData!.conversations! : [];
    const targets = summaries
      .filter((c) => typeof c?.id === "string" && c.id)
      .slice(0, MIGRATE_THREAD_LIMIT);

    // 2) Full transcript per thread (bounded loop, per-thread timeout).
    await Promise.all(
      targets.map(async (summary) => {
        try {
          const res = await fetch(
            `${origin}/api/conversations?id=${encodeURIComponent(summary.id!)}`,
            { headers: { cookie }, signal: AbortSignal.timeout(PER_THREAD_TIMEOUT_MS) }
          );
          if (!res.ok) {
            skipped++;
            return;
          }
          const data = (await res.json().catch(() => null)) as { conversation?: CloudConversation } | null;
          const conv = data?.conversation;
          if (!conv?.id) {
            skipped++;
            return;
          }
          imported.push({
            id: conv.id,
            title: conv.title,
            workspaceName: conv.workspaceName ?? null,
            createdAt: conv.createdAt,
            updatedAt: conv.updatedAt,
            messages: Array.isArray(conv.messages) ? conv.messages : [],
          });
        } catch {
          skipped++;
        }
      })
    );

    return NextResponse.json({
      importedCount: imported.length,
      conversations: imported,
      skipped,
    });
  } catch (error) {
    console.error("[conversations:migrate-from-cloud] Error:", error);
    return NextResponse.json({ error: "Migration failed" }, { status: 500 });
  }
}
