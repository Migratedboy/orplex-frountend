// Sync hub — pull endpoint. Peers fetch entries newer than their cursor,
// streamed back as a gzip sync envelope. Only the requesting user's entries
// are returned, and entries from the requesting machine itself are skipped
// (a peer never needs its own writes echoed back).

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jwtOnlyOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  encodeEnvelope,
  MAX_SYNC_ENTRIES_PER_PULL,
  SYNC_WIRE_VERSION,
  type SyncEnvelope,
} from "@/lib/sync-transport";

export async function GET(request: NextRequest) {
  try {
    const session = await getServerSession(jwtOnlyOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (!process.env.ORPLEX_SYNC_HUB_SECRET) {
      return NextResponse.json({ error: "Sync hub not enabled" }, { status: 503 });
    }

    const userId = (session.user as { id?: string }).id || "unknown";
    const url = new URL(request.url);
    const selfMachine = (url.searchParams.get("machine") || "").slice(0, 64);
    const cursor = (url.searchParams.get("cursor") || "").slice(0, 128);
    // Clamp both directions: negative/NaN/Infinity take values throw in
    // Prisma (500) instead of returning rows.
    const rawLimit = Number(url.searchParams.get("limit"));
    const limit = Math.min(
      MAX_SYNC_ENTRIES_PER_PULL,
      Number.isFinite(rawLimit) ? Math.max(1, Math.floor(rawLimit)) : MAX_SYNC_ENTRIES_PER_PULL
    );

    const rows = await prisma.syncEvent.findMany({
      where: { userId, ...(cursor ? { id: { gt: cursor } } : {}) },
      orderBy: { id: "asc" },
      take: limit,
    });

    const entries = rows
      .filter((r) => r.machineId !== selfMachine) // never echo a peer's own writes
      .map((r) => {
        try {
          return JSON.parse(r.payload);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    const env: SyncEnvelope = {
      version: SYNC_WIRE_VERSION,
      machineId: "hub",
      cursor: rows.length > 0 ? rows[rows.length - 1].id : cursor,
      entries,
    };

    const body = encodeEnvelope(env);
    return new NextResponse(new Uint8Array(body), {
      status: 200,
      headers: { "Content-Type": "application/octet-stream", "Content-Encoding": "gzip" },
    });
  } catch (err) {
    return NextResponse.json({ error: "Sync pull failed" }, { status: 500 });
  }
}
