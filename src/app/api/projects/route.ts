// /api/projects — cross-machine roster for the Projects sidebar.
//
// GET  → the user's ProjectRecord rows as wire entries (name/alias/timestamp).
// PUT  → upsert the calling device's roster batch (newer lastOpenedAt wins —
//        the merge rule the clients apply locally via mergeRosters).
//
// Wire shape is deliberately narrow: NO directory handles, NO absolute paths
// (device-bound secrets of a sort — they must not roam). Auth is the same
// next-auth session every user-scoped route reads.

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

const MAX_ENTRIES = 50; // mirrors the client roster cap
const MAX_NAME = 120;
const MAX_ALIAS = 120;

function sanitizeEntry(raw: unknown): { name: string; displayName: string | null; lastOpenedAt: Date } | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== "string" || !r.name.trim()) return null;
  return {
    name: r.name.trim().slice(0, MAX_NAME),
    displayName: typeof r.displayName === "string" && r.displayName.trim() ? r.displayName.trim().slice(0, MAX_ALIAS) : null,
    lastOpenedAt: typeof r.lastOpenedAt === "number" && Number.isFinite(r.lastOpenedAt) ? new Date(Math.max(0, r.lastOpenedAt)) : new Date(0),
  };
}

export async function GET() {
  try {
    const session = await getServerSession(jwtOnlyOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ success: false, error: "Authentication required" }, { status: 401 });
    }
    const rows = await prisma.projectRecord.findMany({
      where: { userId: session.user.id },
      orderBy: { lastOpenedAt: "desc" },
      take: MAX_ENTRIES,
    });
    return NextResponse.json({
      success: true,
      projects: rows.map((row) => ({
        name: row.name,
        displayName: row.displayName ?? undefined,
        lastOpenedAt: row.lastOpenedAt.getTime(),
      })),
    });
  } catch (error) {
    console.error("[/api/projects GET]", error);
    return NextResponse.json({ success: false, error: "Internal error" }, { status: 500 });
  }
}

// DELETE — forget one or more projects server-side so a sync pull from
// another device cannot resurrect them as ghost rows. Same one-bad-row
// tolerance as PUT. Accepts { names: string[] } (or { name: string }).
export async function DELETE(request: NextRequest) {
  try {
    const session = await getServerSession(jwtOnlyOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ success: false, error: "Authentication required" }, { status: 401 });
    }

    const body = await request.json().catch(() => null);
    const rawNames: unknown[] = Array.isArray(body?.names)
      ? body.names
      : typeof body?.name === "string"
        ? [body.name]
        : [];
    const names = rawNames
      .filter((n): n is string => typeof n === "string" && !!n.trim())
      .map((n) => n.trim().slice(0, MAX_NAME));
    if (names.length === 0) {
      return NextResponse.json({ success: false, error: "name or names required" }, { status: 400 });
    }

    let removed = 0;
    for (const name of names.slice(0, MAX_ENTRIES)) {
      try {
        const res = await prisma.projectRecord.deleteMany({ where: { userId: session.user.id, name } });
        removed += res.count;
      } catch {
        // One bad row never fails the batch.
      }
    }
    return NextResponse.json({ success: true, removed });
  } catch (error) {
    console.error("[/api/projects DELETE]", error);
    return NextResponse.json({ success: false, error: "Internal error" }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const session = await getServerSession(jwtOnlyOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ success: false, error: "Authentication required" }, { status: 401 });
    }

    const body = await request.json().catch(() => null);
    const rawProjects = body?.projects;
    if (!Array.isArray(rawProjects)) {
      return NextResponse.json({ success: false, error: "projects array required" }, { status: 400 });
    }

    const entries = rawProjects.slice(0, MAX_ENTRIES).map(sanitizeEntry).filter((e): e is NonNullable<typeof e> => e !== null);

    // Upsert batch: one row per (userId, name); newer lastOpenedAt wins so an
    // older device re-pushing a stale timestamp can't roll history back.
    let accepted = 0;
    for (const e of entries) {
      try {
        await prisma.projectRecord.upsert({
          where: { userId_name: { userId: session.user.id, name: e.name } },
          create: { userId: session.user.id, name: e.name, displayName: e.displayName, lastOpenedAt: e.lastOpenedAt },
          update: {
            displayName: e.displayName ?? undefined, // alias cleared locally stays cleared
            lastOpenedAt: e.lastOpenedAt,
          },
        });
        accepted++;
      } catch {
        // One bad row never fails the batch.
      }
    }

    const rows = await prisma.projectRecord.findMany({
      where: { userId: session.user.id },
      orderBy: { lastOpenedAt: "desc" },
      take: MAX_ENTRIES,
    });
    return NextResponse.json({
      success: true,
      accepted,
      projects: rows.map((row) => ({
        name: row.name,
        displayName: row.displayName ?? undefined,
        lastOpenedAt: row.lastOpenedAt.getTime(),
      })),
    });
  } catch (error) {
    console.error("[/api/projects PUT]", error);
    return NextResponse.json({ success: false, error: "Internal error" }, { status: 500 });
  }
}
