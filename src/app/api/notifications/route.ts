import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions as authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * Parse a `?since=` value into a Date, or null when unusable.
 * Accepts ISO-8601 and bare epoch-ms (clients commonly store Date.now() as
 * their last-poll marker). An unparseable value returns null → the filter is
 * omitted entirely. NEVER let it throw or produce an Invalid Date: feeding
 * one to Prisma throws, and the old catch-all answered that with an empty
 * 200 list — indistinguishable from a wiped history.
 */
function parseSince(raw: string | null): Date | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return Number.isFinite(n) ? new Date(n) : null;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * GET /api/notifications — The durable notification center feed.
 *
 * Returns the user's stored notifications (newest first, capped), the unread
 * count for the bell badge, and `now` so the client can compute "fresh"
 * items (created within the last 15s → toast for 3s on arrival).
 *
 * ?since=<ISO|epoch-ms> — pollers fetch only new rows (toasts for fresh
 *                 arrivals). Malformed values are IGNORED and the full
 *                 history is served — a bad `since` must never collapse the
 *                 feed into an empty list (that once read as a "wiped"
 *                 notification history right after the bell's mark-all-read).
 */
export async function GET(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, notifications: [], unread: 0 }, { status: 401 });
  }
  const userId = session.user.id;
  const limit = Math.min(parseInt(request.nextUrl.searchParams.get("limit") || "30", 10) || 30, 100);
  const since = parseSince(request.nextUrl.searchParams.get("since"));

  try {
    const [notifications, unread] = await Promise.all([
      prisma.notification.findMany({
        where: {
          userId,
          ...(since ? { createdAt: { gt: since } } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: limit,
      }),
      prisma.notification.count({ where: { userId, readAt: null } }),
    ]);

    return NextResponse.json({
      success: true,
      notifications: notifications.map((n) => ({
        id: n.id,
        type: n.type,
        title: n.title,
        message: n.message,
        source: n.source,
        read: n.readAt !== null,
        createdAt: n.createdAt.toISOString(),
      })),
      unread,
      now: new Date().toISOString(),
    });
  } catch (err) {
    // A backend hiccup must NOT present as an empty history (clients render
    // "0 notifications" and it reads as a wipe) — fail loudly instead so
    // the client's error path keeps whatever it already had on screen.
    console.error("[notifications] GET failed:", (err as Error)?.message || err);
    return NextResponse.json({ success: false, notifications: [], unread: 0 }, { status: 503 });
  }
}

/** POST /api/notifications — create one (client-visible system events). */
export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, error: "Authentication required" }, { status: 401 });
  }
  const body = await request.json().catch(() => null);
  const title = typeof body?.title === "string" ? body.title.trim() : "";
  const message = typeof body?.message === "string" ? body.message.trim() : "";
  if (!title || !message) {
    return NextResponse.json({ success: false, error: "title and message required" }, { status: 400 });
  }
  const type = ["info", "success", "error", "warning"].includes(body?.type) ? body.type : "info";
  const source = ["models", "runs", "approvals", "system", "keys"].includes(body?.source) ? body.source : "system";

  const n = await prisma.notification
    .create({
      data: {
        userId: session.user.id,
        type,
        title: title.slice(0, 120),
        message: message.slice(0, 2000),
        source,
      },
    })
    .catch(() => null);

  if (!n) return NextResponse.json({ success: false, error: "Could not store notification" }, { status: 500 });
  return NextResponse.json({ success: true, id: n.id });
}

/** PATCH /api/notifications — mark read. Body: { id } | { all: true } */
export async function PATCH(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, error: "Authentication required" }, { status: 401 });
  }
  const body = await request.json().catch(() => ({}));
  const userId = session.user.id;

  try {
    if (body?.all === true) {
      await prisma.notification.updateMany({
        where: { userId, readAt: null },
        data: { readAt: new Date() },
      });
      return NextResponse.json({ success: true });
    }
    if (typeof body?.id === "string") {
      await prisma.notification.updateMany({
        where: { id: body.id, userId, readAt: null },
        data: { readAt: new Date() },
      });
      return NextResponse.json({ success: true });
    }
    return NextResponse.json({ success: false, error: "id or all required" }, { status: 400 });
  } catch {
    return NextResponse.json({ success: false, error: "Update failed" }, { status: 500 });
  }
}

/** DELETE /api/notifications — clear history. Body: { all: true } | { id } */
export async function DELETE(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, error: "Authentication required" }, { status: 401 });
  }
  const body = await request.json().catch(() => ({}));
  try {
    if (body?.all === true) {
      await prisma.notification.deleteMany({ where: { userId: session.user.id } });
      return NextResponse.json({ success: true });
    }
    if (typeof body?.id === "string") {
      await prisma.notification.deleteMany({ where: { id: body.id, userId: session.user.id } });
      return NextResponse.json({ success: true });
    }
    return NextResponse.json({ success: false, error: "id or all required" }, { status: 400 });
  } catch {
    return NextResponse.json({ success: false, error: "Delete failed" }, { status: 500 });
  }
}
